import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { redactUnknown } from "../security/redaction.ts";
import type { ActivityRecord } from "../activity/types.ts";
import type { TeamSnapshot } from "./types.ts";

export interface ChatArchiveInfo {
  readonly id: string;
  readonly jsonPath: string;
  readonly jsonlPath: string;
}

/** A lazy, provider-neutral chat archive owned by Watari. */
export class ChatArchive {
  readonly #directory: string;
  #info: ChatArchiveInfo | null = null;

  constructor(directory: string) {
    this.#directory = directory;
  }

  get active(): boolean {
    return this.#info !== null;
  }

  /** The open chat's archive id, which is its file name. */
  get id(): string | null {
    return this.#info?.id ?? null;
  }

  /** Continues writing an existing archive, for a chat restored from it. */
  adopt(id: string): ChatArchiveInfo {
    mkdirSync(this.#directory, { recursive: true, mode: 0o700 });
    this.#info = {
      id,
      jsonPath: join(this.#directory, `${id}.json`),
      jsonlPath: join(this.#directory, `${id}.jsonl`),
    };
    return this.#info;
  }

  /**
   * Names the archive for a chat. A `stableKey` gives the same name every time,
   * so a chat that continues after a service restart keeps writing one file.
   */
  activate(at = Date.now(), stableKey?: string): ChatArchiveInfo {
    if (this.#info) return this.#info;
    mkdirSync(this.#directory, { recursive: true, mode: 0o700 });
    chmodSync(this.#directory, 0o700);
    const timestamp = new Date(at).toISOString().replaceAll(":", "-");
    const suffix = stableKey
      ? createHash("sha256").update(stableKey).digest("hex").slice(0, 8)
      : crypto.randomUUID().slice(0, 8);
    const id = `${timestamp}-${suffix}`;
    this.#info = {
      id,
      jsonPath: join(this.#directory, `${id}.json`),
      jsonlPath: join(this.#directory, `${id}.jsonl`),
    };
    return this.#info;
  }

  write(snapshot: TeamSnapshot, activities: readonly ActivityRecord[] = []): ChatArchiveInfo | null {
    return this.#write(snapshot, activities);
  }

  #write(snapshot: TeamSnapshot, activities: readonly ActivityRecord[]): ChatArchiveInfo | null {
    const info = this.#info;
    if (!info) return null;
    // Native callbacks cannot be resumed from a portable archive.
    const { questions: _questions, ...durable } = snapshot;
    const safe = redactUnknown(durable) as TeamSnapshot;
    const safeActivities = redactUnknown(activities) as readonly ActivityRecord[];
    atomicWrite(info.jsonPath, `${JSON.stringify({
      chatId: info.id,
      ...safe,
      activityDetails: safeActivities,
    }, null, 2)}\n`);
    const records = [
      { recordType: "chat", chatId: info.id, schemaVersion: safe.schemaVersion },
      ...safe.messages.map((message) => ({ recordType: "message", ...message })),
      ...safe.events.map((event) => ({ recordType: "event", ...event })),
      ...safe.claims.map((claim) => ({ recordType: "claim", ...claim })),
      ...safe.findings.map((finding) => ({ recordType: "finding", ...finding })),
      ...safeActivities.map((activity) => ({ recordType: "activity", ...activity })),
    ];
    atomicWrite(info.jsonlPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
    return info;
  }

  finish(snapshot: TeamSnapshot, activities: readonly ActivityRecord[] = []): ChatArchiveInfo | null {
    const info = this.#write(snapshot, activities);
    this.#info = null;
    return info;
  }
}

function atomicWrite(path: string, content: string): void {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}
