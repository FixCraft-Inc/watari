import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentInput } from "../src/watari/models.ts";
import {
  configureProcessLedger,
  processStartTime,
  reapLeftoverProcesses,
  trackProcess,
} from "../src/watari/process/ledger.ts";
import { CoordinatorRuntime, type RuntimeOptions } from "../src/watari/service/runtime.ts";
import { FakeAdapter } from "./fakes/fake-adapter.ts";

/**
 * Chat management against fake harnesses. Nothing here starts a real provider
 * or a model turn: every agent is a FakeAdapter that records what it is sent.
 */
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function workspace() {
  const directory = mkdtempSync(join(tmpdir(), "watari-chats-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, databasePath: join(directory, "state.db"), chatsDirectory: join(directory, "chats") };
}

function pair() {
  return { codex: new FakeAdapter("codex"), claude: new FakeAdapter("claude") };
}

async function runtimeOn(
  paths: ReturnType<typeof workspace>,
  adapters: ReturnType<typeof pair>,
  extra: Partial<RuntimeOptions> = {},
): Promise<CoordinatorRuntime> {
  const runtime = new CoordinatorRuntime({
    project: { launchDirectory: paths.directory, repositoryRoot: null },
    databasePath: paths.databasePath,
    chatsDirectory: paths.chatsDirectory,
    adapters,
    ...extra,
  });
  await runtime.start();
  return runtime;
}

describe("an abrupt stop", () => {
  test("a service that never stopped cleanly loses nothing, and the cut-off agent waits for the user", async () => {
    const paths = workspace();
    const first = pair();
    const crashed = await runtimeOn(paths, first);
    await crashed.sendUserMessage("codex", "Port the parser.");
    first.codex.sessionId = "thread-1";
    first.codex.emit("session", "Codex thread started", { rawType: "thread/started" });
    first.codex.emit("status", "Codex turn started", { rawType: "turn/started" });
    first.codex.emit("assistant", "Half way through the parser.", { rawType: "item/agentMessage/delta", providerEventId: "m1" });
    await waitUntil(() => {
      const codex = crashed.snapshot().agents.find((agent) => agent.id === "codex");
      return codex?.state === "busy" && codex.sessionId === "thread-1";
    });
    // No stop(): as far as the database is concerned, the process is gone.

    const second = pair();
    const after = await runtimeOn(paths, second);
    cleanups.push(async () => {
      await after.stop();
      await crashed.stop();
    });
    const snapshot = after.snapshot();
    expect(snapshot.activeGoal?.instruction).toBe("Port the parser.");
    expect(snapshot.events.some((event) => event.summary.includes("Half way through the parser."))).toBe(true);
    expect(second.codex.resumedSession).toBe("thread-1");
    // Reopening starts nothing. The note that its turn was cut off goes in
    // with the user's next message instead of waking it.
    await Bun.sleep(150);
    expect(second.codex.inputs).toHaveLength(0);
    await after.sendUserMessage("codex", "Carry on with the parser.");
    await waitUntil(() => second.codex.inputs.length > 0);
    expect(second.codex.inputs).toHaveLength(1);
    expect(text(second.codex.inputs[0])).toContain("resumed your conversation");
    expect(text(second.codex.inputs[0])).toContain("Carry on with the parser.");
  });
});

describe("/clear <agent>", () => {
  test("forgets only that agent's conversation, keeps the chat, and tells the others", async () => {
    const paths = workspace();
    const agents = pair();
    const runtime = await runtimeOn(paths, agents);
    cleanups.push(() => runtime.stop());
    await runtime.sendUserMessage("all", "Review the queue.");
    agents.claude.sessionId = "session-claude";
    agents.claude.emit("session", "Claude session started", { rawType: "system/init" });
    await waitUntil(() => runtime.snapshot().agents.find((agent) => agent.id === "claude")?.sessionId === "session-claude");

    await runtime.clearAgentContext("claude");

    expect(agents.claude.resets).toBe(1);
    expect(agents.codex.resets).toBe(0);
    const snapshot = runtime.snapshot();
    expect(snapshot.agents.find((agent) => agent.id === "claude")?.sessionId).toBeNull();
    expect(snapshot.activeGoal?.instruction).toBe("Review the queue.");
    const notices = snapshot.messages.filter((message) => message.sender === "watari");
    expect(notices.some((message) => message.recipients.includes("codex") && message.body.includes("cleared Claude"))).toBe(true);
    expect(notices.some((message) =>
      message.recipients.includes("claude") && message.body.includes("The user cleared your conversation")
    )).toBe(true);
  });
});

describe("export and handoff", () => {
  test("a handoff asks each agent, takes team_handoff or its reply, and writes one Markdown file", async () => {
    const paths = workspace();
    const agents = pair();
    const runtime = await runtimeOn(paths, agents, { handoffTimeoutMs: 5_000 });
    cleanups.push(() => runtime.stop());
    await runtime.sendUserMessage("all", "Harden the decoder.");
    agents.codex.sessionId = "thread-codex";
    agents.claude.sessionId = "session-claude";
    for (const agent of [agents.codex, agents.claude]) agent.emit("session", "session", { rawType: "session/new" });
    agents.codex.emit("status", "Codex turn completed", { rawType: "turn/completed" });
    agents.claude.emit("status", "Claude turn completed", { rawType: "result" });
    await waitUntil(() => runtime.snapshot().agents.every((agent) => agent.state === "ready"));

    const exporting = runtime.exportChat({ handoff: true, path: "handoff.md" });
    await waitUntil(() => agents.codex.inputs.some((input) => text(input).includes("team_handoff")));
    await waitUntil(() => agents.claude.inputs.some((input) => text(input).includes("team_handoff")));
    // Codex answers through the tool. Claude answers in its reply and ends its turn.
    expect(await runtime.callTeamTool("codex", "team_handoff", { markdown: "Decoder bounds done, fuzzing next." }))
      .toMatchObject({ ok: true });
    agents.claude.emit("status", "Claude turn started", { rawType: "turn/started" });
    agents.claude.emit("assistant", "I reviewed the length checks; two remain.", { rawType: "assistant_text", providerEventId: "c1" });
    agents.claude.emit("status", "Claude turn completed", { rawType: "result" });

    const result = await exporting;
    expect(result.path).toBe(join(paths.directory, "handoff.md"));
    expect(result.handoffs).toEqual([
      { agent: "codex", source: "tool" },
      { agent: "claude", source: "reply" },
    ]);
    const markdown = readFileSync(result.path, "utf8");
    expect(markdown).toContain("# Harden the decoder.");
    expect(markdown).toContain("## AGENT codex");
    expect(markdown).toContain("Decoder bounds done, fuzzing next.");
    expect(markdown).toContain("## AGENT claude");
    expect(markdown).toContain("two remain");
    expect(markdown).toContain("## Conversation");
    expect(markdown.indexOf("## AGENT codex")).toBeLessThan(markdown.indexOf("## Conversation"));
  });

  test("an agent that never answers is named, and a plain export asks nobody", async () => {
    const paths = workspace();
    const agents = pair();
    const runtime = await runtimeOn(paths, agents, { handoffTimeoutMs: 50 });
    cleanups.push(() => runtime.stop());
    await runtime.sendUserMessage("codex", "Map the repo.");
    agents.codex.sessionId = "thread-codex";
    agents.codex.emit("session", "session", { rawType: "session/new" });
    await waitUntil(() => runtime.snapshot().agents.find((agent) => agent.id === "codex")?.sessionId === "thread-codex");

    const silent = await runtime.exportChat({ handoff: true });
    expect(silent.handoffs).toEqual([{ agent: "codex", source: "none" }]);
    expect(silent.path.startsWith(join(paths.directory, "exports"))).toBe(true);
    expect(readFileSync(silent.path, "utf8")).toContain("did not answer");

    const inputs = agents.codex.inputs.length;
    const plain = await runtime.exportChat({ path: paths.directory });
    expect(plain.handoffs).toEqual([]);
    expect(agents.codex.inputs.length).toBe(inputs);
    expect(readFileSync(plain.path, "utf8")).toContain("Map the repo.");

    // A handoff an agent saved on its own goes into a plain export, unasked.
    await runtime.callTeamTool("codex", "team_handoff", { markdown: "Earlier checkpoint, src/ still unreviewed." });
    await runtime.callTeamTool("codex", "team_handoff", { markdown: "Mapped src/, tests/ next." });
    const wrapped = await runtime.exportChat({ path: join(paths.directory, "wrapped.md") });
    expect(wrapped.handoffs).toContainEqual({ agent: "codex", source: "tool" });
    expect(agents.codex.inputs.length).toBe(inputs);
    expect(readFileSync(wrapped.path, "utf8")).toContain("Mapped src/, tests/ next.");
    expect(readFileSync(wrapped.path, "utf8")).not.toContain("Earlier checkpoint, src/ still unreviewed.");
  });
});

describe("saved and resumed chats", () => {
  test("/save writes the archive, and /resume brings a chat and each agent's conversation back", async () => {
    const paths = workspace();
    const agents = pair();
    const runtime = await runtimeOn(paths, agents);
    cleanups.push(() => runtime.stop());
    await runtime.sendUserMessage("all", "First chat about the store.");
    agents.codex.sessionId = "thread-first";
    agents.codex.emit("session", "session", { rawType: "thread/started" });
    await waitUntil(() => runtime.snapshot().agents.find((agent) => agent.id === "codex")?.sessionId === "thread-first");
    const saved = runtime.saveChat();
    expect(existsSync(saved.path)).toBe(true);
    const firstId = runtime.listChats()[0]?.id;
    expect(runtime.listChats()[0]).toMatchObject({ title: "First chat about the store.", current: true });

    await runtime.newChat();
    await runtime.sendUserMessage("claude", "Second chat about the UI.");
    runtime.saveChat();
    await expect(runtime.resumeChat("no-such-chat")).rejects.toThrow();

    const resumed = await runtime.resumeChat(firstId!);
    expect(resumed.chatId).toBe(firstId!);
    expect(runtime.snapshot().activeGoal?.instruction).toBe("First chat about the store.");
    expect(agents.codex.resumedSession).toBe("thread-first");
    // Both chats are archived, and the resumed one keeps writing its own file.
    const listed = runtime.listChats();
    expect(listed).toHaveLength(2);
    expect(listed.find((chat) => chat.id === firstId)?.current).toBe(true);
    expect(readdirSync(paths.chatsDirectory).filter((name) => name.endsWith(".json"))).toHaveLength(2);
  });
});

describe("the process ledger", () => {
  test("a harness left running by a killed service is ended, and an unrelated PID is never touched", async () => {
    const paths = workspace();
    const ledger = join(paths.directory, "harnesses.json");
    configureProcessLedger(ledger);
    const orphan = Bun.spawn(["sleep", "30"], { detached: true, stdout: "ignore", stderr: "ignore" });
    trackProcess(orphan.pid);
    const recorded = JSON.parse(readFileSync(ledger, "utf8")) as { pid: number; startTime: string }[];
    expect(recorded.map((entry) => entry.pid)).toEqual([orphan.pid]);
    configureProcessLedger(null);
    // What a killed service leaves behind: the orphan, and a reused PID whose
    // start time no longer matches.
    writeFileSync(ledger, JSON.stringify([
      ...recorded,
      { pid: process.pid, startTime: "1" },
    ]));
    expect(await reapLeftoverProcesses(ledger, 500)).toBe(1);
    await orphan.exited;
    expect(orphan.signalCode).not.toBeNull();
    expect(processStartTime(process.pid)).not.toBeNull();
    expect(JSON.parse(readFileSync(ledger, "utf8"))).toEqual([]);
  });
});

function text(input: AgentInput | undefined): string {
  return input?.kind === "message" ? input.text : "";
}

async function waitUntil(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition was not reached in time");
    await Bun.sleep(5);
  }
}
