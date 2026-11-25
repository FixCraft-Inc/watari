import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sessionModels } from "../src/watari/agents/acp.ts";
import { QWEN_HARNESS, QWEN_MID_TURN_INBOX, QwenAdapter, qwenApprovalMode } from "../src/watari/agents/qwen.ts";
import type { AgentEvent, BoundaryInbox } from "../src/watari/models.ts";
import { resolveProjectContext } from "../src/watari/project/checkout.ts";
import { TEAM_INSTRUCTIONS } from "../src/watari/team/instructions.ts";

const fake = `${import.meta.dir}/fakes/fake-opencode.ts`;
let directory = "";
let recordPath = "";
const saved = new Map<string, string | undefined>();

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "watari-qwen-test-"));
  recordPath = join(directory, "record.jsonl");
  for (const name of [
    "WATARI_FAKE_FLAVOR",
    "WATARI_FAKE_RECORD",
    "WATARI_FAKE_MODE",
    "WATARI_FAKE_QWEN_LEGACY",
    "WATARI_FAKE_RESTORED_MODE",
  ]) {
    saved.set(name, process.env[name]);
  }
  process.env.WATARI_FAKE_FLAVOR = "qwen";
  process.env.WATARI_FAKE_RECORD = recordPath;
  delete process.env.WATARI_FAKE_MODE;
  delete process.env.WATARI_FAKE_QWEN_LEGACY;
  delete process.env.WATARI_FAKE_RESTORED_MODE;
});

afterEach(() => {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(directory, { recursive: true, force: true });
});

describe("Qwen Code launch posture", () => {
  const project = resolveProjectContext(".");

  test("a team session is unrestricted with the instructions in its system prompt", () => {
    const launch = QWEN_HARNESS.launch(project, { readOnlyProbe: false, unrestricted: true, team: true });
    expect(launch.args.slice(0, 3)).toEqual(["--acp", "--approval-mode", "yolo"]);
    expect(launch.args.slice(-2)).toEqual(["--append-system-prompt", TEAM_INSTRUCTIONS]);
    expect(launch.systemInstructions).toBe(true);
    expect(launch.sessionMode).toBe("yolo");
    expect(QWEN_HARNESS.midTurnInbox).toBe(QWEN_MID_TURN_INBOX);
  });

  test("never falls back to the model classifier, and probes record nothing", () => {
    expect(qwenApprovalMode({ readOnlyProbe: false, unrestricted: false, team: true })).toBe("default");
    const probe = QWEN_HARNESS.launch(project, { readOnlyProbe: true, unrestricted: true, team: false });
    expect(probe.args).toEqual(["--acp", "--approval-mode", "plan", "--chat-recording=false"]);
    expect(probe.systemInstructions).toBe(false);
  });
});

describe("QwenAdapter over ACP", () => {
  test("reads its catalog from the session, with efforts found by category", async () => {
    const adapter = createAdapter();
    try {
      await adapter.start(resolveProjectContext("."));
      expect(await adapter.availableModels()).toEqual([
        {
          id: "fake-provider/fake-model",
          displayName: "Fake Provider/Fake Model",
          description: "Fake Provider/Fake Model",
          efforts: ["low", "high"],
          isDefault: true,
        },
        {
          id: "other/next-model",
          displayName: "Other/Next Model",
          description: "Other/Next Model",
          efforts: ["low", "high"],
        },
      ]);
    } finally {
      await adapter.stop();
    }
  });

  test("sets effort through reasoning_effort and never sends the prompt the instructions", async () => {
    const adapter = createAdapter({
      effort: "high",
      teamMcpCommand: ["/opt/watari", "mcp", "--agent", "qwen"],
    });
    const logged: unknown[] = [];
    const consoleError = console.error;
    console.error = (...args: unknown[]) => logged.push(args);
    try {
      await adapter.start(resolveProjectContext("."));
      await adapter.send({ kind: "message", text: "hello" });
      await collectUntil(adapter, (event) => event.summary.includes("turn completed"));
    } finally {
      console.error = consoleError;
      await adapter.stop();
    }
    const wires = wireMessages();
    expect(wires.filter((entry) => entry.method === "session/set_config_option").map((entry) => entry.params))
      .toEqual([{ sessionId: "session-fake", configId: "reasoning_effort", value: "high" }]);
    expect(JSON.stringify(wires.find((entry) => entry.method === "session/prompt")?.params))
      .not.toContain("[WATARI MANAGED MESSAGE]");
    // The extension notification is accepted, where it used to be logged as an error.
    expect(JSON.stringify(logged)).not.toContain("qwen/notify");
  });

  test("gives each run of id-less chunks its own row id", async () => {
    const adapter = createAdapter();
    const events: AgentEvent[] = [];
    try {
      await adapter.start(resolveProjectContext("."));
      await adapter.send({ kind: "message", text: "first" });
      events.push(...await collectUntil(adapter, (event) => event.summary.includes("turn completed")));
      await adapter.send({ kind: "message", text: "second" });
      events.push(...await collectUntil(adapter, (event) => event.summary.includes("turn completed")));
    } finally {
      await adapter.stop();
    }
    const thoughts = events.filter((event) => event.kind === "reasoning").map((event) => event.providerEventId);
    const replies = events.filter((event) => event.kind === "assistant").map((event) => event.providerEventId);
    expect(thoughts).toHaveLength(4);
    // Two chunks of one thought share a row, and the next turn opens a new one.
    expect(thoughts[0]).toBe(thoughts[1]);
    expect(thoughts[2]).toBe(thoughts[3]);
    expect(thoughts[0]).not.toBe(thoughts[2]);
    expect(new Set(replies).size).toBe(2);
    expect(replies).not.toContain(thoughts[0]);
  });

  test("resumes through session/resume and puts the restored session back in its posture's mode", async () => {
    // Qwen Code restores the approval mode the session last ran in. This agent
    // was unrestricted then and must prompt now.
    process.env.WATARI_FAKE_RESTORED_MODE = "yolo";
    const adapter = createAdapter({ unrestricted: false });
    try {
      await adapter.start(resolveProjectContext("."));
      await adapter.resume("session-fake");
      expect(adapter.sessionId).toBe("session-fake");
      await adapter.resetSession();
      expect(adapter.sessionId).toBeNull();
    } finally {
      await adapter.stop();
    }
    const wires = wireMessages();
    const methods = wires.map((entry) => entry.method);
    expect(methods).toContain("session/resume");
    expect(methods).not.toContain("session/load");
    expect(methods).not.toContain("session/close");
    expect(wires.filter((entry) => entry.method === "session/set_config_option").map((entry) => entry.params))
      .toEqual([{ sessionId: "session-fake", configId: "mode", value: "default" }]);
  });

  test("an older Qwen resumes through session/load without replaying history", async () => {
    process.env.WATARI_FAKE_QWEN_LEGACY = "1";
    const adapter = createAdapter();
    const events: AgentEvent[] = [];
    try {
      await adapter.start(resolveProjectContext("."));
      await adapter.resume("session-fake");
      expect(adapter.sessionId).toBe("session-fake");
    } finally {
      await adapter.stop();
      for await (const event of adapter.events()) events.push(event);
    }
    const methods = wireMessages().map((entry) => entry.method);
    expect(methods).toContain("session/load");
    expect(methods).not.toContain("session/resume");
    expect(JSON.stringify(events)).not.toContain("REPLAYED_HISTORY");
  });

  test("hands team mail over when Qwen asks for queued input after a tool run", async () => {
    process.env.WATARI_FAKE_MODE = "drain";
    const boundaries: string[] = [];
    const inbox: BoundaryInbox = {
      atToolBoundary: async () => {
        boundaries.push("tool");
        return "[WATARI PEER MAIL] from codex: the parser is yours";
      },
      beforeTurnEnd: async () => null,
    };
    const adapter = createAdapter({ boundaryInbox: inbox });
    let events: AgentEvent[] = [];
    try {
      await adapter.start(resolveProjectContext("."));
      await adapter.send({ kind: "message", text: "work" });
      events = await collectUntil(adapter, (event) => event.summary.includes("turn completed"));
    } finally {
      await adapter.stop();
    }
    expect(boundaries).toEqual(["tool"]);
    const drained = events.find((event) => event.kind === "assistant" && event.summary.startsWith("DRAINED"));
    expect(JSON.parse(drained!.summary.slice("DRAINED ".length))).toEqual({
      messages: ["[WATARI PEER MAIL] from codex: the parser is yours"],
      hasQueuedPrompt: false,
    });
  });

  test("tells Qwen a prompt is waiting, so its todo guard does not keep the turn past it", async () => {
    process.env.WATARI_FAKE_MODE = "drain";
    let adapter: QwenAdapter | null = null;
    const inbox: BoundaryInbox = {
      atToolBoundary: async () => {
        await adapter!.send({ kind: "message", text: "the user's next message" });
        return null;
      },
      beforeTurnEnd: async () => null,
    };
    adapter = createAdapter({ boundaryInbox: inbox });
    let events: AgentEvent[] = [];
    try {
      await adapter.start(resolveProjectContext("."));
      await adapter.send({ kind: "message", text: "work" });
      events = await collectUntil(adapter, (event) => event.summary.startsWith("DRAINED"));
    } finally {
      await adapter.stop();
    }
    const drained = events.find((event) => event.summary.startsWith("DRAINED"));
    expect(JSON.parse(drained!.summary.slice("DRAINED ".length))).toEqual({ messages: [], hasQueuedPrompt: true });
  });

  test("a message sent while Qwen works is taken at once instead of waiting for the turn to end", async () => {
    process.env.WATARI_FAKE_MODE = "steer";
    const adapter = createAdapter();
    let events: AgentEvent[] = [];
    try {
      await adapter.start(resolveProjectContext("."));
      await adapter.send({ kind: "message", text: "start the audit" });
      await collectUntil(adapter, (event) => event.summary.includes("turn started"));
      await adapter.send({ kind: "message", text: "also check the parser" });
      events = await collectUntil(adapter, (event) => event.summary.includes("turn completed"));
    } finally {
      await adapter.stop();
    }
    const wires = wireMessages();
    expect(wires.filter((entry) => entry.method === "craft/midTurnSendNow")).toHaveLength(1);
    // The second message reached the running turn, so it never became a prompt.
    expect(wires.filter((entry) => entry.method === "session/prompt")).toHaveLength(1);
    const drained = events.find((event) => event.summary.startsWith("DRAINED"));
    expect(JSON.parse(drained!.summary.slice("DRAINED ".length))).toEqual({
      messages: ["also check the parser"],
      hasQueuedPrompt: false,
    });
    expect(events.some((event) => event.summary === "Qwen Code took 1 queued message inside its turn")).toBe(true);
  });

  test("a stop holds queued input until the next message, then sends it all as one prompt", async () => {
    process.env.WATARI_FAKE_MODE = "hold";
    const adapter = createAdapter();
    try {
      await adapter.start(resolveProjectContext("."));
      await adapter.send({ kind: "message", text: "first" });
      await collectUntil(adapter, (event) => event.summary.includes("turn started"));
      // This fake Qwen does not cut in, so the message stays queued.
      await adapter.send({ kind: "message", text: "second" });
      await adapter.interrupt();
      await collectUntil(adapter, (event) => event.summary.includes("turn completed (cancelled)"));
      await Bun.sleep(100);
      expect(wireMessages().filter((entry) => entry.method === "session/prompt")).toHaveLength(1);
      await adapter.send({ kind: "message", text: "third" });
      await collectUntil(adapter, (event) => event.summary.includes("turn started"));
    } finally {
      await adapter.stop();
    }
    const prompts = wireMessages().filter((entry) => entry.method === "session/prompt");
    expect(prompts).toHaveLength(2);
    expect(JSON.stringify(prompts[1]!.params)).toContain("second\\n\\nthird");
  });

  test("without a team inbox it still answers, with the input queued for it", async () => {
    process.env.WATARI_FAKE_MODE = "drain";
    const adapter = createAdapter();
    let events: AgentEvent[] = [];
    try {
      await adapter.start(resolveProjectContext("."));
      await adapter.send({ kind: "message", text: "work" });
      events = await collectUntil(adapter, (event) => event.summary.includes("turn completed"));
    } finally {
      await adapter.stop();
    }
    const drained = events.find((event) => event.kind === "assistant" && event.summary.startsWith("DRAINED"));
    expect(JSON.parse(drained!.summary.slice("DRAINED ".length))).toEqual({ messages: [], hasQueuedPrompt: false });
  });
});

test("session catalogs drop the harness's own default effort", () => {
  expect(sessionModels([
    { id: "model", name: "Model", category: "model", type: "select", currentValue: "a", options: [{ value: "a", name: "A" }] },
    {
      id: "reasoning_effort",
      name: "Effort",
      category: "thought_level",
      type: "select",
      currentValue: "default",
      options: [{ value: "default", name: "Default" }, { value: "max", name: "Max" }],
    },
  ])).toEqual([{ id: "a", displayName: "A", description: "A", efforts: ["max"], isDefault: true }]);
});

function createAdapter(options: Partial<ConstructorParameters<typeof QwenAdapter>[0]> = {}): QwenAdapter {
  return new QwenAdapter({
    executable: process.execPath,
    commandPrefix: [process.execPath, fake],
    unrestricted: true,
    ...options,
  });
}

function wireMessages(): Array<Record<string, unknown>> {
  return readFileSync(recordPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .flatMap((entry) => typeof entry.wire === "object" && entry.wire !== null ? [entry.wire as Record<string, unknown>] : []);
}

async function collectUntil(adapter: QwenAdapter, done: (event: AgentEvent) => boolean): Promise<AgentEvent[]> {
  const iterator = adapter.events()[Symbol.asyncIterator]();
  const events: AgentEvent[] = [];
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const next = await Promise.race([
      iterator.next(),
      Bun.sleep(deadline - Date.now()).then(() => ({ done: true, value: undefined }) as IteratorResult<AgentEvent>),
    ]);
    if (next.done) break;
    events.push(next.value);
    if (done(next.value)) return events;
  }
  throw new Error(`events ended before the expected one: ${JSON.stringify(events.map((event) => event.summary))}`);
}
