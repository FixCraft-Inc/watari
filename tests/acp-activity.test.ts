import { expect, test } from "bun:test";

import { lineDiff, normalizeActivityEvent } from "../src/watari/activity/normalize.ts";
import type { ActivityRecord } from "../src/watari/activity/types.ts";
import { permissionsDecision } from "../src/watari/agents/codex.ts";
import type { AgentEvent } from "../src/watari/models.ts";

function acpEvent(kind: AgentEvent["kind"], update: Record<string, unknown>, timestamp = 1_000): AgentEvent {
  return {
    agent: "qwen",
    kind,
    timestamp,
    summary: "tool",
    rawType: kind === "tool_start" ? "session/update/tool_call" : "session/update/tool_call_update",
    providerEventId: "call-1",
    payload: { sessionId: "s", update },
  };
}

function replay(events: readonly AgentEvent[]): ActivityRecord | null {
  let record: ActivityRecord | null = null;
  for (const event of events) record = normalizeActivityEvent(event, record) ?? record;
  return record;
}

test("an ACP edit named by base name keeps the full path from its start", () => {
  const record = replay([
    acpEvent("tool_start", {
      sessionUpdate: "tool_call",
      toolCallId: "call-1",
      kind: "edit",
      status: "pending",
      locations: [{ path: "/repo/src/app.ts" }],
    }),
    // Qwen's result carries the diff but not the kind or the locations.
    acpEvent("tool_end", {
      sessionUpdate: "tool_call_update",
      toolCallId: "call-1",
      status: "completed",
      content: [{ type: "diff", path: "app.ts", oldText: "a\nb\nc", newText: "a\nB\nc" }],
    }, 2_000),
  ]);
  expect(record?.summary).toMatchObject({ kind: "file_change", state: "completed", preview: "/repo/src/app.ts" });
  expect(record?.detail).toMatchObject({
    kind: "file_change",
    files: [{ path: "/repo/src/app.ts", kind: "update", additions: 1, deletions: 1 }],
  });
});

test("an ACP command keeps its input and fails on a non-zero exit", () => {
  const record = replay([
    acpEvent("tool_start", {
      sessionUpdate: "tool_call",
      toolCallId: "call-1",
      kind: "execute",
      status: "pending",
      rawInput: { command: "bun test", cwd: "/repo" },
    }),
    acpEvent("tool_output", {
      sessionUpdate: "tool_call_update",
      toolCallId: "call-1",
      status: "in_progress",
      content: [{ type: "content", content: { type: "text", text: "running" } }],
    }, 1_500),
    acpEvent("tool_end", {
      sessionUpdate: "tool_call_update",
      toolCallId: "call-1",
      status: "completed",
      rawOutput: { output: "1 fail", metadata: { exit: 1 } },
    }, 3_000),
  ]);
  expect(record?.summary).toMatchObject({ kind: "command", state: "failed", preview: "bun test" });
  expect(record?.detail).toMatchObject({ kind: "command", command: "bun test", cwd: "/repo", stdout: "1 fail", exitCode: 1, durationMs: 2_000 });
});

test("reads, searches, and bookkeeping stay compact rows", () => {
  expect(normalizeActivityEvent(acpEvent("tool_start", {
    sessionUpdate: "tool_call",
    toolCallId: "call-1",
    kind: "read",
    status: "pending",
    locations: [{ path: "/repo/a.ts" }],
  }), null)).toBeNull();
});

test("a whole-file before and after becomes one small hunk", () => {
  const before = ["1", "2", "3", "4", "5", "6", "7", "8", "9"].join("\n");
  const after = ["1", "2", "3", "4", "five", "6", "7", "8", "9"].join("\n");
  expect(lineDiff(before, after)).toBe(["@@ -2,7 +2,7 @@", " 2", " 3", " 4", "-5", "+five", " 6", " 7", " 8"].join("\n"));
  expect(lineDiff("", "new")).toBe("@@ -1,0 +1,1 @@\n+new");
  expect(lineDiff("same", "same")).toBe("");
});

test("accepting a Codex permission request grants what was asked for the turn", () => {
  const params = { permissions: { network: { enabled: true }, fileSystem: null } };
  expect(permissionsDecision(params, "accept")).toEqual({ permissions: { network: { enabled: true } }, scope: "turn" });
  expect(permissionsDecision(params, "decline")).toEqual({ permissions: {}, scope: "turn" });
});
