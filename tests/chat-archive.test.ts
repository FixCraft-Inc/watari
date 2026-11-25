import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { normalizeActivityEvent } from "../src/watari/activity/normalize.ts";
import { ChatArchive } from "../src/watari/state/chat-archive.ts";
import type { TeamSnapshot } from "../src/watari/state/types.ts";

describe("v2 chat archives", () => {
  test("adds canonical activity details only at finalization and preserves v1 files", () => {
    const directory = mkdtempSync(join(tmpdir(), "watari-chat-archive-"));
    const legacyPath = join(directory, "legacy-v1.jsonl");
    const legacy = '{"recordType":"chat","schemaVersion":1}\n';
    writeFileSync(legacyPath, legacy);
    try {
      const activity = normalizeActivityEvent({
        agent: "codex",
        kind: "tool_end",
        rawType: "item/completed",
        providerEventId: "archive-command",
        summary: "bash  printf secret",
        timestamp: 2,
        payload: {
          type: "commandExecution",
          command: "printf ok",
          status: "completed",
          aggregatedOutput: "ok",
          exitCode: 0,
        },
      }, null)!;
      const snapshot: TeamSnapshot = {
        questions: [{ id: crypto.randomUUID(), agent: "codex", createdAt: 1,
          fields: [{ id: "scope", header: "Scope", question: "transient native input form", options: [], multiSelect: false, allowOther: true, required: true }],
        }],
        schemaVersion: 2,
        agents: [],
        activeGoal: null,
        messages: [],
        claims: [],
        findings: [],
        events: [],
        activities: [activity.summary],
      };
      const archive = new ChatArchive(directory);
      const info = archive.activate(1);

      archive.write(snapshot);
      expect(readFileSync(info.jsonPath, "utf8")).not.toContain("transient native input form");
      expect(JSON.parse(readFileSync(info.jsonPath, "utf8")).questions).toBeUndefined();
      expect(readFileSync(info.jsonlPath, "utf8")).not.toContain('"recordType":"activity"');

      archive.finish(snapshot, [activity]);
      const records = readFileSync(info.jsonlPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      expect(records[0]).toMatchObject({ recordType: "chat", schemaVersion: 2 });
      expect(records[1]).toMatchObject({
        recordType: "activity",
        summary: { id: activity.summary.id },
        detail: { kind: "command", command: "printf ok", stdout: "ok" },
      });
      expect(JSON.parse(readFileSync(info.jsonPath, "utf8")).activityDetails).toEqual([activity]);
      expect(readFileSync(legacyPath, "utf8")).toBe(legacy);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
