import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { normalizeActivityEvent } from "../src/watari/activity/normalize.ts";
import type { ActivityRecord } from "../src/watari/activity/types.ts";
import {
  OpenCodeAdapter,
  parseOpenCodeModels,
} from "../src/watari/agents/opencode.ts";
import type { AgentEvent } from "../src/watari/models.ts";
import { TEAM_INSTRUCTIONS } from "../src/watari/team/instructions.ts";
import { resolveProjectContext } from "../src/watari/project/checkout.ts";

const fake = `${import.meta.dir}/fakes/fake-opencode.ts`;

describe("OpenCodeAdapter", () => {
  test("discovers provider-owned models without creating a session", async () => {
    await withRecord(async (recordPath) => {
      const adapter = createAdapter();
      try {
        await adapter.start(resolveProjectContext("."));
        expect(await adapter.availableModels()).toEqual([
          {
            id: "fake-provider/fake-model",
            displayName: "Fake Model",
            description: "deterministic OpenCode fixture",
            efforts: ["low", "high"],
          },
          {
            id: "other/next-model",
            displayName: "Next Model",
            description: "OpenCode model other/next-model",
            efforts: [],
          },
        ]);
      } finally {
        await adapter.stop();
      }
      const records = readRecords(recordPath);
      expect(records.some((entry) => Array.isArray(entry) && entry[0] === "models")).toBe(true);
      expect(wireMethods(records)).not.toContain("session/new");
    });
  });

  test("creates a lazy ACP session with exact MCP identity, model, and effort", async () => {
    await withRecord(async (recordPath) => {
      const adapter = createAdapter({
        agent: "reviewer",
        model: "fake-provider/fake-model",
        effort: "high",
        teamMcpCommand: [
          "/opt/watari",
          "mcp",
          "--agent",
          "reviewer",
          "--provider",
          "opencode",
          "/work/project with spaces",
        ],
      });
      try {
        await adapter.start(resolveProjectContext("."));
        expect(adapter.sessionId).toBeNull();
        await adapter.prepare();
        expect(adapter.sessionId).toBe("session-fake");
      } finally {
        await adapter.stop();
      }

      const wires = wireMessages(readRecords(recordPath));
      const session = wires.find((entry) => entry.method === "session/new");
      expect(session?.params).toMatchObject({
        mcpServers: [{
          name: "watari",
          command: "/opt/watari",
          args: [
            "mcp",
            "--agent",
            "reviewer",
            "--provider",
            "opencode",
            "/work/project with spaces",
          ],
          env: [],
        }],
      });
      expect(wires.filter((entry) => entry.method === "session/set_config_option").map((entry) => entry.params)).toEqual([
        { sessionId: "session-fake", configId: "model", value: "fake-provider/fake-model" },
        { sessionId: "session-fake", configId: "effort", value: "high" },
      ]);
    });
  });

  test("puts the team instructions in OpenCode's system prompt and keeps the user's config", async () => {
    const previousContent = process.env.OPENCODE_CONFIG_CONTENT;
    process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ instructions: ["/home/user/mine.md"], share: "disabled" });
    try {
      await withRecord(async (recordPath) => {
        const adapter = createAdapter({ teamMcpCommand: ["/opt/watari", "mcp", "--agent", "opencode"] });
        try {
          await adapter.start(resolveProjectContext("."));
          await adapter.send({ kind: "message", text: "first message" });
          await waitForEvent(adapter, (event) => event.summary.includes("turn completed"));
        } finally {
          await adapter.stop();
        }
        const records = readRecords(recordPath);
        const content = records.find((entry) => isRecord(entry) && "configContent" in entry) as { configContent: string };
        const config = JSON.parse(content.configContent) as { instructions: string[]; share: string };
        expect(config.share).toBe("disabled");
        expect(config.instructions[0]).toBe("/home/user/mine.md");
        expect(readFileSync(config.instructions[1]!, "utf8")).toBe(TEAM_INSTRUCTIONS);
        const prompt = wireMessages(records).find((entry) => entry.method === "session/prompt");
        expect(JSON.stringify(prompt?.params)).not.toContain("[WATARI MANAGED MESSAGE]");
      });
    } finally {
      restoreEnvironment("OPENCODE_CONFIG_CONTENT", previousContent);
    }
  });

  test("normalizes streaming, tools, diffs, approvals, and turn completion", async () => {
    const previousMode = process.env.WATARI_FAKE_MODE;
    const previousSecret = process.env.WATARI_FAKE_SECRET;
    process.env.WATARI_FAKE_MODE = "approval";
    process.env.WATARI_FAKE_SECRET = "synthetic-opencode-secret";
    const adapter = createAdapter();
    const events: AgentEvent[] = [];
    try {
      await adapter.start(resolveProjectContext("."));
      await adapter.send({ kind: "message", text: "fixture" });
      const iterator = adapter.events()[Symbol.asyncIterator]();
      while (true) {
        const next = await nextWithTimeout(iterator);
        if (next.done) break;
        events.push(next.value);
        if (next.value.kind === "approval") {
          await adapter.send({
            kind: "approval_response",
            requestId: "permission-tool",
            decision: "accept",
          });
        }
        if (next.value.summary.includes("turn completed")) break;
      }
    } finally {
      await adapter.stop();
      restoreEnvironment("WATARI_FAKE_MODE", previousMode);
      restoreEnvironment("WATARI_FAKE_SECRET", previousSecret);
    }
    expect(events.some((event) => event.kind === "assistant")).toBe(true);
    expect(events.some((event) => event.kind === "reasoning")).toBe(true);
    expect(events.some((event) => event.kind === "tool_start")).toBe(true);
    expect(events.some((event) => event.kind === "tool_end")).toBe(true);
    expect(events.some((event) => event.kind === "approval")).toBe(true);
    // Protocol bookkeeping is not transcript material.
    expect(events.some((event) => event.rawType === "session/update/available_commands_update")).toBe(false);
    // The edit becomes a file-change record, which is what edit overlap reads.
    let record: ActivityRecord | null = null;
    for (const event of events.filter((candidate) => candidate.providerEventId === "tool-fake")) {
      record = normalizeActivityEvent(event, record);
    }
    expect(record?.summary).toMatchObject({ kind: "file_change", state: "completed" });
    expect(record?.detail).toMatchObject({ kind: "file_change", files: [{ path: "/work/fixture.ts", diff: "@@ -1,1 +1,1 @@\n-old\n+new" }] });
    expect(JSON.stringify(events)).not.toContain("synthetic-opencode-secret");
    expect(JSON.stringify(events)).toContain("stdin_tty=false");
  });

  test("interrupts and resets, and keeps the provider's session history", async () => {
    const previousMode = process.env.WATARI_FAKE_MODE;
    process.env.WATARI_FAKE_MODE = "hold";
    try {
      await withRecord(async (recordPath) => {
        const adapter = createAdapter();
        try {
          await adapter.start(resolveProjectContext("."));
          await adapter.send({ kind: "message", text: "fixture" });
          await adapter.interrupt();
          await waitForEvent(adapter, (event) => event.summary.includes("turn completed"));
          await adapter.resetSession();
          expect(adapter.sessionId).toBeNull();
        } finally {
          await adapter.stop();
        }
        const records = readRecords(recordPath);
        expect(wireMethods(records)).toContain("session/cancel");
        expect(records).not.toContainEqual(["session", "delete", "session-fake"]);
      });
    } finally {
      restoreEnvironment("WATARI_FAKE_MODE", previousMode);
    }
  });

  test("stopping keeps the session so the next start can resume it", async () => {
    await withRecord(async (recordPath) => {
      const adapter = createAdapter();
      await adapter.start(resolveProjectContext("."));
      await adapter.send({ kind: "message", text: "fixture" });
      await waitForEvent(adapter, (event) => event.summary.includes("turn completed"));
      await adapter.stop();
      expect(adapter.sessionId).toBe("session-fake");
      expect(readRecords(recordPath)).not.toContainEqual(["session", "delete", "session-fake"]);
    });
  });

  test("reports malformed output and an unexpected clean provider exit", async () => {
    for (const mode of ["malformed", "clean-exit"] as const) {
      const previousMode = process.env.WATARI_FAKE_MODE;
      process.env.WATARI_FAKE_MODE = mode;
      const adapter = createAdapter();
      try {
        await adapter.start(resolveProjectContext("."));
        const event = await waitForEvent(
          adapter,
          (candidate) => mode === "malformed"
            ? candidate.rawType === "malformed_jsonl"
            : candidate.kind === "error",
        );
        expect(event).toBeDefined();
      } finally {
        await adapter.stop();
        restoreEnvironment("WATARI_FAKE_MODE", previousMode);
      }
    }
  });
});

test("OpenCode model output parser keeps native variants and ignores default", () => {
  expect(parseOpenCodeModels("provider/model\n{\"name\":\"Model\",\"variants\":{\"default\":{},\"turbo_2\":{}}}\n"))
    .toEqual([{
      id: "provider/model",
      displayName: "Model",
      description: "OpenCode model provider/model",
      efforts: ["turbo_2"],
    }]);
});

function createAdapter(
  options: Partial<ConstructorParameters<typeof OpenCodeAdapter>[0]> = {},
): OpenCodeAdapter {
  return new OpenCodeAdapter({
    executable: process.execPath,
    commandPrefix: [process.execPath, fake],
    ...options,
  });
}

async function withRecord(operation: (recordPath: string) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "watari-opencode-test-"));
  const recordPath = join(directory, "record.jsonl");
  const previous = process.env.WATARI_FAKE_RECORD;
  const previousState = process.env.XDG_STATE_HOME;
  process.env.WATARI_FAKE_RECORD = recordPath;
  process.env.XDG_STATE_HOME = join(directory, "state");
  try {
    await operation(recordPath);
  } finally {
    restoreEnvironment("WATARI_FAKE_RECORD", previous);
    restoreEnvironment("XDG_STATE_HOME", previousState);
    rmSync(directory, { recursive: true, force: true });
  }
}

function readRecords(path: string): unknown[] {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);
}

function wireMessages(records: readonly unknown[]): Array<Record<string, unknown>> {
  return records.flatMap((entry) => {
    if (!isRecord(entry) || !isRecord(entry.wire)) return [];
    return [entry.wire];
  });
}

function wireMethods(records: readonly unknown[]): string[] {
  return wireMessages(records)
    .map((entry) => entry.method)
    .filter((method): method is string => typeof method === "string");
}

async function waitForEvent(
  adapter: OpenCodeAdapter,
  predicate: (event: AgentEvent) => boolean,
): Promise<AgentEvent> {
  const iterator = adapter.events()[Symbol.asyncIterator]();
  while (true) {
    const next = await nextWithTimeout(iterator);
    if (next.done) throw new Error("OpenCode event stream ended");
    if (predicate(next.value)) return next.value;
  }
}

async function nextWithTimeout(
  iterator: AsyncIterator<AgentEvent>,
): Promise<IteratorResult<AgentEvent>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timed out waiting for OpenCode event")), 2_000);
  });
  try {
    return await Promise.race([iterator.next(), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function restoreEnvironment(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
