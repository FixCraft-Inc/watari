import type { Database } from "bun:sqlite";

import type { AgentEvent, AgentId } from "../models.ts";
import { ActivityDetailSchema } from "./schemas.ts";
import { normalizeActivityEvent } from "./normalize.ts";
import type { ActivityDetail, ActivityRecord, ActivitySummary } from "./types.ts";

/**
 * Shares SQLite's single `user_version` counter with `TeamStore`'s own repair.
 *
 * The store migrates first and stamps a lower number, so an old database runs
 * the transcript compaction and then this backfill in that order. Anything that
 * raises the store's version must stay below this one, or stamping the higher
 * number first would make the other repair believe it had already run.
 */
const ACTIVITY_BACKFILL_VERSION = 4;
const MAX_ACTIVITY_HISTORY = 400;
type SqlRow = Record<string, unknown>;

/** Owns canonical activity persistence and its non-destructive v1 backfill. */
export class SqliteActivityRepository {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
    this.#migrate();
  }

  reset(): void {
    this.#database.exec("DELETE FROM activities");
  }

  findByProvider(agent: AgentId, providerEventId: string): ActivityRecord | null {
    const row = this.#database
      .query("SELECT * FROM activities WHERE agent = $agent AND provider_event_id = $providerEventId")
      .get({ agent, providerEventId }) as SqlRow | null;
    return row ? activityRecordFromRow(row) : null;
  }

  record(id: string): ActivityRecord | null {
    const row = this.#database.query("SELECT * FROM activities WHERE id = $id").get({ id }) as SqlRow | null;
    return row ? activityRecordFromRow(row) : null;
  }

  records(): readonly ActivityRecord[] {
    const rows = this.#database
      .query("SELECT * FROM activities ORDER BY updated_at, id")
      .all() as SqlRow[];
    return rows.map(activityRecordFromRow);
  }

  detail(id: string): ActivityDetail | null {
    return this.record(id)?.detail ?? null;
  }

  summaries(): readonly ActivitySummary[] {
    const rows = this.#database
      .query("SELECT * FROM activities ORDER BY updated_at DESC, id DESC LIMIT $limit")
      .all({ limit: MAX_ACTIVITY_HISTORY }) as SqlRow[];
    return rows.reverse().map(activitySummaryFromRow);
  }

  save(record: ActivityRecord): void {
    const summary = record.summary;
    this.#database
      .query(`
        INSERT INTO activities(
          id, agent, kind, state, title, preview, provider_event_id,
          revision, started_at, updated_at, detail_json
        ) VALUES (
          $id, $agent, $kind, $state, $title, $preview, $providerEventId,
          $revision, $startedAt, $updatedAt, $detailJson
        )
        ON CONFLICT(id) DO UPDATE SET
          state = excluded.state,
          title = excluded.title,
          preview = excluded.preview,
          revision = excluded.revision,
          updated_at = excluded.updated_at,
          detail_json = excluded.detail_json
        WHERE excluded.revision >= activities.revision
      `)
      .run({
        id: summary.id,
        agent: summary.agent,
        kind: summary.kind,
        state: summary.state,
        title: summary.title,
        preview: summary.preview,
        providerEventId: summary.providerEventId,
        revision: summary.revision,
        startedAt: summary.startedAt,
        updatedAt: summary.updatedAt,
        detailJson: JSON.stringify(record.detail),
      });
  }

  #migrate(): void {
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS activities(
        id TEXT PRIMARY KEY,
        agent TEXT NOT NULL,
        kind TEXT NOT NULL,
        state TEXT NOT NULL,
        title TEXT NOT NULL,
        preview TEXT NOT NULL,
        provider_event_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        started_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        detail_json TEXT NOT NULL,
        UNIQUE(agent, provider_event_id)
      );
      CREATE INDEX IF NOT EXISTS idx_activities_updated ON activities(updated_at, id);
    `);
    this.#backfill();
  }

  /** Recovers structured detail from redacted provider payloads written by v1. */
  #backfill(): void {
    if (databaseVersion(this.#database) >= ACTIVITY_BACKFILL_VERSION) return;
    const agents = new Map(
      (this.#database.query("SELECT id, provider, backend FROM agents WHERE configured = 1").all() as SqlRow[])
        .map((row) => [asString(row.id), {
          provider: asString(row.provider),
          backend: asString(row.backend),
        }]),
    );
    const rows = this.#database
      .query(`
        SELECT * FROM events
        WHERE provider_event_id IS NOT NULL
          AND payload_json IS NOT NULL
          AND type IN ('tool_start', 'tool_end', 'tool_output', 'edit')
        ORDER BY id
      `)
      .all() as SqlRow[];
    this.#database.transaction(() => {
      for (const row of rows) {
        const agent = asNullableString(row.agent) as AgentId | null;
        const providerEventId = asNullableString(row.provider_event_id);
        if (!agent || !providerEventId) continue;
        const registered = agents.get(agent);
        // ACP payloads are only recognized with their raw type, which the
        // backfill does not have, so those harnesses keep their compact rows.
        if (registered?.backend.endsWith("-acp")) continue;
        const previous = this.findByProvider(agent, providerEventId);
        const record = normalizeActivityEvent({
          agent,
          kind: asString(row.type) as AgentEvent["kind"],
          summary: asNullableString(row.summary) ?? "",
          timestamp: asNumber(row.created_at),
          providerEventId,
          payload: parseJson(asString(row.payload_json)),
        }, previous);
        if (record) this.save(record);
      }
      this.#database.exec(`PRAGMA user_version = ${ACTIVITY_BACKFILL_VERSION}`);
    })();
  }
}

function activitySummaryFromRow(row: SqlRow): ActivitySummary {
  return {
    id: asString(row.id),
    agent: asString(row.agent) as AgentId,
    kind: asString(row.kind) as ActivitySummary["kind"],
    state: asString(row.state) as ActivitySummary["state"],
    title: asString(row.title),
    preview: asString(row.preview),
    providerEventId: asString(row.provider_event_id),
    revision: asNumber(row.revision),
    startedAt: asNumber(row.started_at),
    updatedAt: asNumber(row.updated_at),
    hasDetail: asString(row.detail_json) !== "",
  };
}

function activityRecordFromRow(row: SqlRow): ActivityRecord {
  const detail = ActivityDetailSchema.safeParse(parseJson(asString(row.detail_json)));
  if (!detail.success) throw new Error(`activity ${asString(row.id)} has invalid persisted detail`);
  return { summary: activitySummaryFromRow(row), detail: detail.data as ActivityDetail };
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function databaseVersion(database: Database): number {
  return (database.query("PRAGMA user_version").get() as { user_version?: number } | null)?.user_version ?? 0;
}

function asString(value: unknown): string {
  if (typeof value !== "string") throw new Error("expected SQLite text column");
  return value;
}

function asNullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : asString(value);
}

function asNumber(value: unknown): number {
  if (typeof value !== "number") throw new Error("expected SQLite numeric column");
  return value;
}
