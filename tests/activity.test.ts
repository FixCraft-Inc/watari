import { afterEach, describe, expect, test } from "bun:test";

import { boundedActivityDetail } from "../src/watari/activity/mcp-view.ts";
import { normalizeActivityEvent } from "../src/watari/activity/normalize.ts";
import {
  MAX_ACTIVITY_DETAIL_BYTES,
  MAX_MCP_DETAIL_BYTES,
  retainActivityText,
} from "../src/watari/activity/retention.ts";
import { ActivityTracker, type ActivityRepository } from "../src/watari/activity/tracker.ts";
import type { ActivityRecord, CommandActivityDetail } from "../src/watari/activity/types.ts";
import type { AgentEvent, AgentId } from "../src/watari/models.ts";

const originalSecret = process.env["WATARI_ACTIVITY_TEST_SECRET"];

afterEach(() => {
  if (originalSecret === undefined) delete process.env["WATARI_ACTIVITY_TEST_SECRET"];
  else process.env["WATARI_ACTIVITY_TEST_SECRET"] = originalSecret;
});

describe("activity retention", () => {
  test("redacts secrets, strips terminal controls, and obeys exact byte caps", () => {
    process.env["WATARI_ACTIVITY_TEST_SECRET"] = "activity-super-secret";
    const source = `head activity-super-secret \u001b[31mred\u001b[0m ${"界".repeat(200)} tail`;

    for (const maximumBytes of [0, 1, 8, 32, 128, 257]) {
      const retained = retainActivityText(source, maximumBytes);
      expect(Buffer.byteLength(retained.text, "utf8")).toBeLessThanOrEqual(maximumBytes);
      expect(retained.retention.retainedBytes).toBe(Buffer.byteLength(retained.text, "utf8"));
      expect(retained.text).not.toContain("activity-super-secret");
      expect(retained.text).not.toContain("\u001b");
      expect(Buffer.from(retained.text, "utf8").toString("utf8")).toBe(retained.text);
    }

    const useful = retainActivityText(source, 128);
    expect(useful.text).toContain("head");
    expect(useful.text).toContain("tail");
    expect(useful.text).toContain("WATARI OMITTED");
    expect(useful.retention).toMatchObject({ truncated: true });
    expect(useful.retention.omittedBytes).toBeGreaterThan(0);
  });

  test("bounds the complete command detail and MCP projection", () => {
    const event = agentEvent({
      kind: "tool_end",
      rawType: "item/completed",
      providerEventId: "cmd-large",
      summary: "bash  generate output",
      payload: {
        type: "commandExecution",
        command: "printf output",
        cwd: "/work/project",
        status: "completed",
        stdout: `HEAD\n${"x".repeat(MAX_ACTIVITY_DETAIL_BYTES * 2)}\nTAIL`,
        stderr: `ERR\n${"y".repeat(32 * 1024)}`,
        exitCode: 0,
      },
    });
    const record = normalizeActivityEvent(event, null);
    expect(record?.detail.kind).toBe("command");
    const detail = record!.detail as CommandActivityDetail;
    expect(Buffer.byteLength(detail.stdout, "utf8") + Buffer.byteLength(detail.stderr, "utf8"))
      .toBeLessThanOrEqual(MAX_ACTIVITY_DETAIL_BYTES);
    expect(detail.retention.truncated).toBe(true);

    const projected = boundedActivityDetail(detail, MAX_MCP_DETAIL_BYTES) as CommandActivityDetail;
    const projectedBytes = [projected.command, projected.cwd ?? "", projected.stdout, projected.stderr]
      .reduce((total, value) => total + Buffer.byteLength(value, "utf8"), 0);
    expect(projectedBytes).toBeLessThanOrEqual(MAX_MCP_DETAIL_BYTES);
    expect(projected.retention.truncated).toBe(true);
  });
});

describe("provider activity normalization", () => {
  test("keeps a background harness task visible until its notification", () => {
    const started = normalizeActivityEvent(agentEvent({
      kind: "tool_start",
      rawType: "system/task_started",
      providerEventId: "task-1",
      summary: "background remote test",
      payload: { type: "commandExecution", command: "remote test", status: "running", background: true },
    }), null);
    expect(started).toMatchObject({ summary: { state: "running" }, detail: { kind: "command", command: "remote test" } });
    const finished = normalizeActivityEvent(agentEvent({
      kind: "tool_end",
      rawType: "system/task_notification",
      providerEventId: "task-1",
      summary: "background remote test complete",
      payload: { type: "commandExecution", command: "remote test", status: "completed", exitCode: 0, background: true },
    }), started);
    expect(finished).toMatchObject({ summary: { state: "completed" }, detail: { kind: "command", exitCode: 0 } });
  });

  test("merges Codex command deltas and treats completion as authoritative", () => {
    const started = normalizeActivityEvent(agentEvent({
      kind: "tool_start",
      rawType: "item/started",
      providerEventId: "cmd-1",
      timestamp: 10,
      summary: "bash  bun test",
      payload: { type: "commandExecution", command: "bun test", cwd: "/work", status: "inProgress" },
    }), null);
    const firstDelta = normalizeActivityEvent(agentEvent({
      kind: "tool_output",
      rawType: "item/commandExecution/outputDelta",
      providerEventId: "cmd-1",
      timestamp: 20,
      summary: "Codex command output",
      payload: { delta: "partial " },
    }), started);
    const secondDelta = normalizeActivityEvent(agentEvent({
      kind: "tool_output",
      rawType: "item/commandExecution/outputDelta",
      providerEventId: "cmd-1",
      timestamp: 30,
      summary: "Codex command output",
      payload: { delta: "stream" },
    }), firstDelta);
    const completed = normalizeActivityEvent(agentEvent({
      kind: "tool_end",
      rawType: "item/completed",
      providerEventId: "cmd-1",
      timestamp: 40,
      summary: "bash  bun test",
      payload: {
        type: "commandExecution",
        command: "bun test",
        cwd: "/work",
        status: "completed",
        aggregatedOutput: "authoritative output",
        exitCode: 0,
        durationMs: 1250,
      },
    }), secondDelta);

    expect(started?.summary).toMatchObject({ state: "running", revision: 1, startedAt: 10 });
    expect((secondDelta?.detail as CommandActivityDetail).stdout).toBe("partial stream");
    expect(completed?.summary).toMatchObject({ state: "completed", revision: 4, startedAt: 10, updatedAt: 40 });
    expect(completed?.detail).toMatchObject({
      kind: "command",
      command: "bun test",
      outputMode: "combined",
      stdout: "authoritative output",
      stderr: "",
      exitCode: 0,
      durationMs: 1250,
      interrupted: false,
    });
  });

  test("preserves split failures and interruptions", () => {
    const failed = normalizeActivityEvent(agentEvent({
      kind: "tool_end",
      providerEventId: "cmd-failed",
      summary: "bash  false  failed",
      payload: { command: "false", stdout: "out", stderr: "boom", exit_code: 7, status: "failed" },
    }), null);
    const interrupted = normalizeActivityEvent(agentEvent({
      kind: "tool_end",
      providerEventId: "cmd-interrupted",
      summary: "bash  sleep 10",
      payload: { command: "sleep 10", stdout: "", stderr: "", interrupted: true },
    }), null);

    expect(failed?.summary.state).toBe("failed");
    expect(failed?.detail).toMatchObject({ kind: "command", outputMode: "split", exitCode: 7, stderr: "boom" });
    expect(interrupted?.summary.state).toBe("interrupted");
    expect(interrupted?.detail).toMatchObject({ kind: "command", interrupted: true });
  });

  test("normalizes Codex file changes and malformed diffs without throwing", () => {
    const record = normalizeActivityEvent(agentEvent({
      kind: "edit",
      rawType: "item/completed",
      providerEventId: "edit-1",
      summary: "edit  two files",
      payload: {
        type: "fileChange",
        status: "completed",
        changes: [
          { path: "src/a.ts", kind: "update", diff: "@@ -1,2 +1,2 @@\n-old\n+new\n same" },
          { path: "src/b.ts", kind: { type: "create" }, diff: "not a hunk\n+created\n--- header" },
        ],
      },
    }), null);

    expect(record?.summary).toMatchObject({ kind: "file_change", state: "completed", hasDetail: true });
    expect(record?.detail).toMatchObject({
      kind: "file_change",
      files: [
        { path: "src/a.ts", kind: "update", additions: 1, deletions: 1 },
        { path: "src/b.ts", kind: "add", additions: 1, deletions: 0 },
      ],
    });
  });

  test("merges a Claude structured patch start with its completion", () => {
    const started = normalizeActivityEvent(agentEvent({
      agent: "claude",
      kind: "tool_start",
      rawType: "tool_use",
      providerEventId: "tool-1",
      timestamp: 100,
      summary: "edit  src/app.ts",
      payload: {
        filePath: "src/app.ts",
        structuredPatch: [{ oldStart: 2, oldLines: 1, newStart: 2, newLines: 1, lines: ["-old", "+new"] }],
      },
    }), null);
    const completed = normalizeActivityEvent(agentEvent({
      agent: "claude",
      kind: "tool_end",
      rawType: "tool_result",
      providerEventId: "tool-1",
      timestamp: 120,
      summary: "edit  src/app.ts",
      payload: { status: "completed" },
    }), started);

    expect(started?.summary.state).toBe("running");
    expect(completed?.summary).toMatchObject({ state: "completed", revision: 2, startedAt: 100 });
    expect(completed?.detail).toMatchObject({
      kind: "file_change",
      files: [{ path: "src/app.ts", additions: 1, deletions: 1 }],
    });
    expect(JSON.stringify(completed?.detail)).toContain("@@ -2,1 +2,1 @@");
  });

  test("keeps Claude file changes running until their structured result arrives", () => {
    const started = normalizeActivityEvent(agentEvent({
      agent: "claude",
      kind: "tool_start",
      rawType: "tool_use",
      providerEventId: "tool-edit-progress",
      timestamp: 100,
      summary: "edit  src/app.ts",
      payload: {
        file_path: "src/app.ts",
        old_string: "before",
        new_string: "after",
      },
    }), null);
    const progressing = normalizeActivityEvent(agentEvent({
      agent: "claude",
      kind: "tool_output",
      rawType: "tool_progress",
      providerEventId: "tool-edit-progress",
      timestamp: 110,
      summary: "Edit is running",
      payload: { elapsedSeconds: 1 },
    }), started);

    expect(progressing?.summary.state).toBe("running");
  });

  test("keeps OpenCode ACP work summary-only until it has a dedicated normalizer", () => {
    expect(normalizeActivityEvent(agentEvent({
      agent: "opencode",
      kind: "tool_start",
      rawType: "session/update/tool_call",
      providerEventId: "tool-opencode",
      summary: "edit  fixture",
      payload: { kind: "edit", status: "pending" },
    }), null)).toBeNull();
    expect(normalizeActivityEvent(agentEvent({
      agent: "opencode",
      kind: "diff",
      rawType: "session/update/tool_diff",
      providerEventId: "tool-opencode",
      summary: "fixture.ts: 3 → 4 chars",
      payload: { type: "diff", path: "fixture.ts", oldText: "old", newText: "new" },
    }), null)).toBeNull();
  });

  test("records omitted bytes when a file change exceeds the file-count cap", () => {
    const record = normalizeActivityEvent(agentEvent({
      kind: "edit",
      rawType: "item/completed",
      providerEventId: "edit-many",
      summary: "edit  many files",
      payload: {
        type: "fileChange",
        status: "completed",
        changes: Array.from({ length: 513 }, (_value, index) => ({
          path: `src/${index}.ts`,
          kind: "update",
          diff: "+x",
        })),
      },
    }), null);
    expect(record?.detail).toMatchObject({
      kind: "file_change",
      files: { length: 512 },
      retention: { truncated: true, omittedBytes: 2 },
    });
  });
});

describe("activity tracker", () => {
  test("flushes the latest throttled delta instead of losing it", () => {
    const repository = new MemoryActivityRepository();
    const summaries: number[] = [];
    const tracker = new ActivityTracker({
      repository,
      onUpsert: (summary) => summaries.push(summary.revision),
    });
    tracker.consume(agentEvent({
      kind: "tool_start",
      providerEventId: "cmd-stream",
      timestamp: 1_000,
      summary: "bash  stream",
      payload: { command: "stream", status: "running" },
    }));
    tracker.consume(agentEvent({
      kind: "tool_output",
      providerEventId: "cmd-stream",
      timestamp: 1_010,
      summary: "command output",
      payload: { delta: "a" },
    }));
    tracker.consume(agentEvent({
      kind: "tool_output",
      providerEventId: "cmd-stream",
      timestamp: 1_020,
      summary: "command output",
      payload: { delta: "b" },
    }));

    expect(repository.saved).toHaveLength(1);
    tracker.flush();
    expect(repository.saved).toHaveLength(2);
    expect((repository.saved.at(-1)?.detail as CommandActivityDetail).stdout).toBe("ab");
    expect(summaries).toEqual([1, 3]);
    tracker.close();
  });
});

function agentEvent(overrides: Partial<AgentEvent> & Pick<AgentEvent, "kind" | "summary">): AgentEvent {
  return {
    agent: "codex",
    timestamp: 1,
    ...overrides,
  };
}

class MemoryActivityRepository implements ActivityRepository {
  readonly saved: ActivityRecord[] = [];

  findActivityByProvider(agent: AgentId, providerEventId: string): ActivityRecord | null {
    return this.saved.findLast(
      (record) => record.summary.agent === agent && record.summary.providerEventId === providerEventId,
    ) ?? null;
  }

  saveActivity(record: ActivityRecord): void {
    this.saved.push(record);
  }
}
