import type { AgentEvent, AgentId } from "../models.ts";
import { normalizeActivityEvent } from "./normalize.ts";
import type { ActivityRecord, ActivitySummary } from "./types.ts";

const STREAM_PERSIST_INTERVAL_MS = 100;

export interface ActivityRepository {
  findActivityByProvider(agent: AgentId, providerEventId: string): ActivityRecord | null;
  saveActivity(record: ActivityRecord): void;
}

export interface ActivityTrackerOptions {
  readonly repository: ActivityRepository;
  readonly onUpsert?: (summary: ActivitySummary) => void;
  readonly onDetailChanged?: (id: string, revision: number) => void;
}

/** Correlates provider starts, deltas, and completions without exposing payloads. */
export class ActivityTracker {
  readonly #repository: ActivityRepository;
  readonly #onUpsert: (summary: ActivitySummary) => void;
  readonly #onDetailChanged: (id: string, revision: number) => void;
  readonly #records = new Map<string, ActivityRecord>();
  readonly #lastPersistedAt = new Map<string, number>();
  readonly #pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(options: ActivityTrackerOptions) {
    this.#repository = options.repository;
    this.#onUpsert = options.onUpsert ?? (() => undefined);
    this.#onDetailChanged = options.onDetailChanged ?? (() => undefined);
  }

  consume(event: AgentEvent): ActivityRecord | null {
    const providerEventId = event.providerEventId;
    if (!providerEventId) return null;
    const key = `${event.agent}\0${providerEventId}`;
    const previous = this.#records.get(key) ?? this.#repository.findActivityByProvider(event.agent, providerEventId);
    const record = normalizeActivityEvent(event, previous);
    if (!record) return null;
    this.#records.set(key, record);

    const streaming = event.kind === "tool_output";
    const lastPersisted = this.#lastPersistedAt.get(key) ?? 0;
    if (streaming && event.timestamp - lastPersisted < STREAM_PERSIST_INTERVAL_MS) {
      this.#schedulePersist(key, STREAM_PERSIST_INTERVAL_MS - (event.timestamp - lastPersisted));
      return record;
    }
    this.#cancelPending(key);
    this.#persist(key, record);
    return record;
  }

  reset(agent: AgentId): void {
    for (const key of [...this.#records.keys()]) {
      if (key.startsWith(`${agent}\0`)) this.#records.delete(key);
    }
    for (const key of [...this.#lastPersistedAt.keys()]) {
      if (key.startsWith(`${agent}\0`)) this.#lastPersistedAt.delete(key);
    }
    for (const key of [...this.#pendingTimers.keys()]) {
      if (key.startsWith(`${agent}\0`)) this.#cancelPending(key);
    }
  }

  flush(agent?: AgentId): void {
    for (const key of [...this.#pendingTimers.keys()]) {
      if (agent && !key.startsWith(`${agent}\0`)) continue;
      this.#cancelPending(key);
      const record = this.#records.get(key);
      if (record) this.#persist(key, record);
    }
  }

  close(): void {
    this.flush();
  }

  #persist(key: string, record: ActivityRecord): void {
    this.#repository.saveActivity(record);
    this.#lastPersistedAt.set(key, record.summary.updatedAt);
    this.#onUpsert(record.summary);
    this.#onDetailChanged(record.summary.id, record.summary.revision);
  }

  #schedulePersist(key: string, delayMs: number): void {
    if (this.#pendingTimers.has(key)) return;
    const timer = setTimeout(() => {
      this.#pendingTimers.delete(key);
      const record = this.#records.get(key);
      if (record) this.#persist(key, record);
    }, Math.max(1, delayMs));
    timer.unref?.();
    this.#pendingTimers.set(key, timer);
  }

  #cancelPending(key: string): void {
    const timer = this.#pendingTimers.get(key);
    if (!timer) return;
    clearTimeout(timer);
    this.#pendingTimers.delete(key);
  }
}
