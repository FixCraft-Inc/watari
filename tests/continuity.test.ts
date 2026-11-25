import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentInput } from "../src/watari/models.ts";
import { CoordinatorRuntime } from "../src/watari/service/runtime.ts";
import { ChatArchive } from "../src/watari/state/chat-archive.ts";
import { TeamStore } from "../src/watari/state/store.ts";
import { FakeAdapter } from "./fakes/fake-adapter.ts";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function workspace(): { directory: string; databasePath: string; chatsDirectory: string } {
  const directory = mkdtempSync(join(tmpdir(), "watari-continuity-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, databasePath: join(directory, "state.db"), chatsDirectory: join(directory, "chats") };
}

async function runtimeOn(paths: ReturnType<typeof workspace>, adapters: { codex: FakeAdapter; claude: FakeAdapter }) {
  const runtime = new CoordinatorRuntime({
    project: { launchDirectory: paths.directory, repositoryRoot: null },
    databasePath: paths.databasePath,
    chatsDirectory: paths.chatsDirectory,
    adapters,
  });
  await runtime.start();
  return runtime;
}

function pair(): { codex: FakeAdapter; claude: FakeAdapter } {
  return { codex: new FakeAdapter("codex"), claude: new FakeAdapter("claude") };
}

describe("a chat that outlives the service", () => {
  test("idle helpers can receive permitted delegation after a maintenance restart", async () => {
    const paths = workspace();
    const taskPolicy = {
      classes: { judgment: { agents: ["codex"] }, mechanical: { agents: ["claude"] } },
      agents: { claude: { requireTaskClass: true } },
    };
    const start = async (adapters: ReturnType<typeof pair>) => {
      const runtime = new CoordinatorRuntime({
        project: { launchDirectory: paths.directory, repositoryRoot: null },
        databasePath: paths.databasePath, adapters, taskPolicy,
      });
      cleanups.push(() => runtime.stop());
      await runtime.start();
      return runtime;
    };
    const first = pair();
    const before = await start(first);
    await before.sendUserMessage("codex", "Coordinate the review.");
    first.codex.sessionId = "lead-saved";
    first.claude.sessionId = "helper-saved";
    first.codex.emit("status", "Codex turn completed: success");
    first.claude.emit("status", "Claude ready");
    await waitUntil(() => before.snapshot().agents.every((agent) => agent.state === "ready"));
    await before.stop();

    const second = pair();
    const after = await start(second);
    await Bun.sleep(150);
    expect(second.codex.resumedSession).toBe("lead-saved");
    expect(second.claude.resumedSession).toBe("helper-saved");
    expect(second.codex.inputs).toHaveLength(0);
    expect(second.claude.inputs).toHaveLength(0);
    await after.sendUserMessage("codex", "Continue from the handoff.");
    await waitUntil(() => second.codex.inputs.length === 1);
    expect(second.claude.inputs).toHaveLength(0);
    expect(await after.callTeamTool("codex", "team_send", {
      to: "claude", task_class: "judgment", message: "Decide the architecture.",
    })).toMatchObject({ ok: false });
    expect(second.claude.inputs).toHaveLength(0);
    expect(await after.callTeamTool("codex", "team_send", {
      task_class: "mechanical", message: "Run the specified check and report the exit code.",
    })).toMatchObject({ ok: true, value: { deliveries: [{ agent: "claude" }] } });
    await waitUntil(() => second.claude.inputs.length === 1);
    expect(text(second.claude.inputs[0])).toContain("Run the specified check");
  });

  test("a restart keeps the team state and resumes each agent's own conversation", async () => {
    const paths = workspace();
    const first = pair();
    const before = await runtimeOn(paths, first);
    await before.sendUserMessage("all", "Review the decoder.");
    first.codex.sessionId = "thread-codex-1";
    first.claude.sessionId = "session-claude-1";
    first.codex.emit("status", "Codex turn started", { rawType: "turn/started" });
    await before.callTeamTool("codex", "team_claim", { scope: "decoder", paths: ["src/decoder.ts"] });
    await before.callTeamTool("codex", "team_todo", { action: "add", items: [{ title: "fuzz the decoder", assignee: "claude" }] });
    await before.callTeamTool("codex", "team_finding", { severity: "high", summary: "length prefix unchecked" });
    // Claude finishes its turn, takes the TODO notice in a new one, and
    // finishes that too, so it is idle when the service stops.
    first.claude.emit("status", "Claude turn completed: success");
    await waitUntil(() => first.claude.inputs.length === 2);
    first.claude.emit("status", "Claude turn completed: success");
    await waitUntil(() => before.snapshot().agents.find((agent) => agent.id === "claude")?.state === "ready");
    await before.stop();

    const second = pair();
    const after = await runtimeOn(paths, second);
    cleanups.push(() => after.stop());
    const snapshot = after.snapshot();
    expect(snapshot.activeGoal?.instruction).toBe("Review the decoder.");
    expect(snapshot.claims).toHaveLength(1);
    expect(snapshot.todos).toHaveLength(1);
    expect(snapshot.findings).toHaveLength(1);
    expect(second.codex.resumedSession).toBe("thread-codex-1");
    expect(second.claude.resumedSession).toBe("session-claude-1");

    // Reopening starts no turn. Codex was cut off mid-turn, so it hears so with
    // the user's next message. Claude was idle and remembers everything.
    await Bun.sleep(150);
    expect(second.codex.inputs).toHaveLength(0);
    expect(second.claude.inputs).toHaveLength(0);
    await after.sendUserMessage("codex", "Carry on.");
    await waitUntil(() => second.codex.inputs.length > 0);
    expect(text(second.codex.inputs[0])).toContain("resumed your conversation");
    expect(text(second.codex.inputs[0])).toContain("Carry on.");
    expect(text(second.codex.inputs[0])).not.toContain("[WATARI SHARED GOAL");
    expect(second.claude.inputs).toHaveLength(0);
    // One chat, one archive file, however many times the service restarts.
    expect(readdirSync(paths.chatsDirectory).filter((name) => name.endsWith(".json"))).toHaveLength(1);
  });

  test("a conversation the provider lost starts fresh with the team state, and says so", async () => {
    const paths = workspace();
    const first = pair();
    const before = await runtimeOn(paths, first);
    await before.sendUserMessage("all", "Review the decoder.");
    first.claude.sessionId = "session-gone";
    first.claude.emit("status", "Claude turn started", { rawType: "turn/started" });
    await Bun.sleep(100);
    await before.stop();

    const second = pair();
    second.claude.resumeError = new Error("Claude has no saved conversation session-gone");
    const after = await runtimeOn(paths, second);
    cleanups.push(() => after.stop());
    await Bun.sleep(150);
    expect(second.claude.inputs).toHaveLength(0);
    await after.sendUserMessage("claude", "Where were we?");
    await waitUntil(() => second.claude.inputs.length > 0);
    const brief = text(second.claude.inputs[0]);
    expect(brief).toContain("[WATARI SHARED GOAL");
    expect(brief).toContain("your previous conversation could not be restored");
    expect(brief).toContain("Where were we?");
    expect(after.snapshot().events.some((event) => event.summary.includes("Could not resume claude"))).toBe(true);
  });

  test("/retry keeps the conversation of the agent it restarts", async () => {
    const paths = workspace();
    const adapters = pair();
    const restarted: FakeAdapter[] = [];
    const runtime = new CoordinatorRuntime({
      project: { launchDirectory: paths.directory, repositoryRoot: null },
      databasePath: paths.databasePath,
      adapters,
      adapterFactory: (definition) => {
        const adapter = new FakeAdapter(definition.alias);
        restarted.push(adapter);
        return adapter;
      },
    });
    cleanups.push(() => runtime.stop());
    await runtime.start();
    await runtime.sendUserMessage("all", "Review the decoder.");
    adapters.claude.sessionId = "session-claude-7";
    adapters.claude.emit("status", "Claude turn started", { rawType: "turn/started" });
    adapters.claude.emit("error", "Claude assistant error: rate_limit");
    await waitUntil(() => runtime.snapshot().agents.find((agent) => agent.id === "claude")?.state === "failed");

    await runtime.restartAgent("claude");

    expect(restarted[0]?.resumedSession).toBe("session-claude-7");
    await waitUntil(() => (restarted[0]?.inputs.length ?? 0) > 0);
    expect(text(restarted[0]?.inputs[0])).toContain("Your conversation is intact");
    const notice = runtime.snapshot().messages.find((message) => message.body.includes("kept its conversation"));
    expect(notice?.recipients).toEqual(["codex"]);
  });

  test("moving an alias to another provider does not carry the old conversation", async () => {
    const paths = workspace();
    const adapters = pair();
    const replacements: FakeAdapter[] = [];
    const runtime = new CoordinatorRuntime({
      project: { launchDirectory: paths.directory, repositoryRoot: null },
      databasePath: paths.databasePath,
      adapters,
      adapterFactory: (definition) => {
        const adapter = new FakeAdapter(definition.alias);
        replacements.push(adapter);
        return adapter;
      },
    });
    cleanups.push(() => runtime.stop());
    await runtime.start();
    await runtime.sendUserMessage("claude", "Look at the parser.");
    adapters.claude.sessionId = "session-claude-9";
    adapters.claude.emit("status", "Claude turn completed: success");
    await Bun.sleep(100);

    await runtime.configureAgent({
      alias: "claude",
      provider: "codex",
      displayName: "Claude",
      mode: "managed",
      unrestricted: true,
    });
    expect(replacements[0]?.resumedSession).toBeNull();
  });
});

describe("restoring an archived chat", () => {
  test("puts back the goal, messages, claims, TODOs, findings, and session ids, with nothing redelivered", () => {
    const source = new TeamStore(":memory:");
    for (const id of ["codex", "claude"]) source.registerAgent({ id, backend: id, displayName: id });
    const goal = source.createGoal({ instruction: "Review", initialAddressee: null, participants: ["codex", "claude"] });
    source.addMessage({ goalId: goal.id, sender: "user", recipients: ["codex"], kind: "goal", body: "Review" });
    source.addMessage({ goalId: goal.id, sender: "codex", recipients: ["claude"], kind: "peer", body: "Take the parser?", expectsReply: true });
    source.createClaim({ goalId: goal.id, claimant: "codex", summary: "decoder", paths: ["src/decoder.ts"], state: "active" });
    source.createTodos({ goalId: goal.id, author: "codex", items: [{ title: "fuzz", assignee: "claude" }] });
    const finding = source.createFinding({ author: "codex", severity: "high", summary: "unchecked length" });
    source.recordFindingVerdict(finding.id, "claude", "confirmed", "reproduced");
    source.setAgentState("codex", "stopped", { sessionId: "thread-1" });
    const archived = source.snapshot({ full: true });

    const target = new TeamStore(":memory:");
    for (const id of ["codex", "claude"]) target.registerAgent({ id, backend: id, displayName: id });
    const summary = target.restoreChat({ ...archived, todos: archived.todos ?? [], activities: source.activityRecords() });

    expect(summary).toMatchObject({ goal: goal.id, messages: 2, claims: 1, todos: 1, findings: 1 });
    expect(target.activeGoal()?.instruction).toBe("Review");
    expect(target.findings()[0]?.verdicts?.[0]).toMatchObject({ reviewer: "claude", verdict: "confirmed" });
    expect(target.agents().find((agent) => agent.id === "codex")?.sessionId).toBe("thread-1");
    // History is history: nothing is handed over again, and no old question is owed.
    expect(target.pendingInbox("claude")).toHaveLength(0);
    expect(target.replyObligations("claude")).toHaveLength(0);
    expect(() => target.restoreChat({ ...archived, todos: [], activities: [] })).toThrow("already has a chat");
    source.close();
    target.close();
  });

  test("an archive keeps one name across restarts of the same chat", () => {
    const paths = workspace();
    const archive = new ChatArchive(paths.chatsDirectory);
    const first = archive.activate(1_000, "1000:1").id;
    archive.finish({ schemaVersion: 2, agents: [], activeGoal: null, messages: [], claims: [], findings: [], events: [], activities: [] });
    expect(new ChatArchive(paths.chatsDirectory).activate(1_000, "1000:1").id).toBe(first);
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
