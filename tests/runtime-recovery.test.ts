import { afterEach, describe, expect, test } from "bun:test";

import type { AgentInput } from "../src/watari/models.ts";
import { CoordinatorRuntime, type RuntimeOptions } from "../src/watari/service/runtime.ts";
import { FakeAdapter } from "./fakes/fake-adapter.ts";

const runtimes: CoordinatorRuntime[] = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.stop()));
});

describe("goal briefing", () => {
  test("a peer the user did not address meets the goal with its first mail, once", async () => {
    const { runtime, claude } = await pair();
    await runtime.sendUserMessage("codex", "Harden the frame decoder.");
    expect(claude.inputs).toHaveLength(0);

    await runtime.callTeamTool("codex", "team_send", { to: "claude", message: "Take the fuzz tests." });
    await waitUntil(() => claude.inputs.length === 1);
    const first = text(claude.inputs[0]);
    expect(first).toContain("[WATARI SHARED GOAL");
    expect(first).toContain("Harden the frame decoder.");
    expect(first).toContain("You are joining this goal after it started.");
    expect(first).toContain("Peers: codex (codex, default model).");
    expect(first).toContain("Take the fuzz tests.");

    claude.emit("status", "Claude turn completed: success");
    await settle();
    await runtime.callTeamTool("codex", "team_send", { to: "claude", message: "Also the length prefix." });
    await waitUntil(() => claude.inputs.length === 2);
    expect(text(claude.inputs[1])).not.toContain("[WATARI SHARED GOAL");
    expect(text(claude.inputs[1])).toContain("Also the length prefix.");
  });

  test("peers briefed by a broadcast are not briefed again", async () => {
    const { runtime, codex, claude } = await pair();
    await runtime.sendUserMessage("all", "Audit the parser.");
    codex.emit("status", "Codex turn completed", { rawType: "turn/completed" });
    claude.emit("status", "Claude turn completed: success");
    await settle();

    await runtime.sendUserMessage("claude", "Focus on the tokenizer.");
    expect(text(claude.inputs.at(-1))).toBe("Focus on the tokenizer.");
  });
});

describe("working alone", () => {
  test("a lone agent is briefed to keep its notebook in the team tools, not to coordinate", async () => {
    const claude = new FakeAdapter("claude");
    const runtime = new CoordinatorRuntime({
      project: { launchDirectory: "/tmp/project", repositoryRoot: "/tmp/project" },
      databasePath: ":memory:",
      roster: [{ alias: "claude", provider: "claude", displayName: "Claude", mode: "managed", unrestricted: true }],
      adapters: { claude },
    });
    runtimes.push(runtime);
    await runtime.start();
    await runtime.sendUserMessage("claude", "Finish the review.");

    const brief = text(claude.inputs[0]);
    expect(brief).toContain("Finish the review.");
    expect(brief).toContain("You are working alone");
    expect(brief).toContain("team_finding");
    expect(brief).not.toMatch(/intake coordinator|team_send|Peers:|authority/u);

    await runtime.callTeamTool("claude", "team_todo", { action: "add", items: [{ title: "verify fix" }] });
    claude.emit("status", "Claude compacted", { rawType: "system/compact_boundary" });
    await settle();
    const refresh = runtime.snapshot().messages.find((message) => message.body.includes("compacted your context"));
    expect(refresh?.body).toContain("You are claude, working alone.");
    expect(refresh?.body).toContain("verify fix");
    expect(refresh?.body).not.toContain("Peers");
  });
});

describe("context compaction", () => {
  test("runtime carries project policy into startup, joining, and compaction briefs", async () => {
    const { runtime, codex, claude } = await pair({ taskPolicy: {
      classes: { author: { agents: ["claude", "codex"] } },
      agents: {
        codex: { role: "Coordinator", guidance: "Delegate bounded execution." },
        claude: { role: "Author", guidance: "Implement only the agreed scope." },
      },
    } });
    await runtime.sendUserMessage("codex", "Review the decoder.");
    expect(text(codex.inputs[0])).toContain("author: claude > codex");
    expect(text(codex.inputs[0])).toContain("Delegate bounded execution.");
    expect(await runtime.callTeamTool("codex", "team_send", { task_class: "author", message: "Implement the scoped fix." })).toMatchObject({ ok: true });
    await waitUntil(() => claude.inputs.length === 1);
    expect(text(claude.inputs[0])).toContain("Your project role: Author");
    expect(text(claude.inputs[0])).toContain("author: claude > codex");
    claude.emit("status", "Claude compacted", { rawType: "system/compact_boundary" });
    await settle();
    const refresh = runtime.snapshot().messages.find((message) => message.body.includes("compacted your context"));
    expect(refresh?.body).toContain("Implement only the agreed scope.");
    expect(refresh?.body).toContain("author: claude > codex");
  });

  test("a compacted peer is handed its own team state once, without a new turn", async () => {
    const { runtime, codex, claude } = await pair();
    await runtime.sendUserMessage("all", "Harden the frame decoder.");
    await runtime.callTeamTool("codex", "team_claim", { scope: "decoder", paths: ["src/decoder.ts"] });
    await runtime.callTeamTool("claude", "team_send", {
      to: "codex",
      message: "Does the decoder accept empty frames?",
      expects_reply: true,
    });
    const handed = codex.inputs.length;
    codex.emit("tool_end", "read file", { providerEventId: "call-1" });
    await waitUntil(() => codex.inputs.length > handed);

    codex.emit("status", "Codex event: thread/compacted", { rawType: "thread/compacted" });
    // Codex reports the compaction item as a status row, not a tool boundary.
    codex.emit("status", "context compaction", {
      rawType: "item/completed",
      payload: { type: "contextCompaction", id: "item-9" },
    });
    await settle();

    const refreshes = runtime.snapshot().messages.filter((message) => message.body.includes("compacted your context"));
    expect(refreshes).toHaveLength(1);
    expect(refreshes[0]).toMatchObject({ sender: "watari", recipients: ["codex"], delivery: "passive" });
    const body = refreshes[0]?.body ?? "";
    expect(body).toContain("Goal ");
    expect(body).toContain("Harden the frame decoder.");
    expect(body).not.toContain("clipped here");
    expect(body).toContain("Peers: claude (claude, default model).");
    expect(body).toMatch(/Your open claims: [0-9a-f]{8} decoder \[src\/decoder\.ts\]/u);
    expect(body).toContain("from claude: Does the decoder accept empty frames?");
    // It rides along at the next boundary instead of waiting for a new turn.
    const before = codex.inputs.length;
    codex.emit("tool_end", "read file", { providerEventId: "call-2" });
    await waitUntil(() => codex.inputs.length > before);
    expect(text(codex.inputs.at(-1))).toContain("compacted your context");
    expect(claude.inputs.some((input) => text(input).includes("compacted your context"))).toBe(false);
  });
});

describe("failed peers", () => {
  test("a message to a failed peer restarts its harness and briefs the new session", async () => {
    const replacements: FakeAdapter[] = [];
    const { runtime, claude } = await pair({
      adapterFactory: (definition) => {
        const adapter = new FakeAdapter(definition.alias);
        replacements.push(adapter);
        return adapter;
      },
    });
    await runtime.sendUserMessage("all", "Ship the migration.");
    claude.emit("error", "Claude assistant error: rate_limit");
    await waitUntil(() => state(runtime, "claude") === "failed");

    await runtime.sendUserMessage("claude", "Try again now.");

    expect(replacements).toHaveLength(1);
    const recovery = runtime.snapshot().messages.find((message) => message.body.includes("was restarted"));
    expect(recovery).toMatchObject({ sender: "watari", recipients: ["codex"], delivery: "passive" });
    expect(state(runtime, "claude")).toBe("busy");
    const input = text(replacements[0]?.inputs[0]);
    expect(input).toContain("Ship the migration.");
    expect(input).toContain("You are joining this goal after it started.");
    expect(input).toContain("The user's message to you:\n\nTry again now.");
  });

  test("/retry restarts a managed peer and refuses an external one", async () => {
    const replacements: FakeAdapter[] = [];
    const { runtime, codex } = await pair({
      adapterFactory: (definition) => {
        const adapter = new FakeAdapter(definition.alias);
        replacements.push(adapter);
        return adapter;
      },
    });
    codex.emit("error", "Codex process exited");
    await waitUntil(() => state(runtime, "codex") === "failed");

    await runtime.restartAgent("codex");
    expect(state(runtime, "codex")).toBe("ready");
    expect(replacements.map((adapter) => adapter.id)).toEqual(["codex"]);

    await runtime.configureAgent({
      alias: "outside",
      provider: "claude",
      displayName: "Outside",
      mode: "external",
      unrestricted: true,
    });
    await expect(runtime.restartAgent("outside")).rejects.toThrow("external");
    await expect(runtime.sendUserMessage("outside", "hello")).rejects.toThrow("is not connected");
  });
});

describe("bounded automatic recovery", () => {
  async function recoverablePair(delayMs = 15, resumeError?: Error) {
    const replacements: FakeAdapter[] = [];
    const peers = await pair({
      transientRetryMs: delayMs,
      adapterFactory: (definition) => {
        const replacement = new FakeAdapter(definition.alias);
        replacement.resumeError = resumeError ?? null;
        replacements.push(replacement);
        return replacement;
      },
    });
    peers.codex.sessionId = "saved-codex-conversation";
    await peers.runtime.sendUserMessage("codex", "Review the local parser tests.");
    return { ...peers, replacements };
  }

  function fail(adapter: FakeAdapter, info: unknown = { responseStreamDisconnected: { httpStatusCode: null } }) {
    adapter.emit("error", "Provider failed", { rawType: "error", payload: { willRetry: false, codexErrorInfo: info } });
    adapter.emit("status", "Codex turn completed: failed", { rawType: "turn/completed", payload: { codexErrorInfo: info } });
  }

  test("resumes the exact conversation after a temporary failure without restarting other peers", async () => {
    const { runtime, codex, claude, replacements } = await recoverablePair();
    fail(codex);
    await waitUntil(() => replacements[0]?.inputs.length === 1);
    expect(replacements).toHaveLength(1);
    expect(replacements[0]?.resumedSession).toBe("saved-codex-conversation");
    expect(text(replacements[0]?.inputs[0])).toContain("Your conversation is intact");
    expect(state(runtime, "codex")).toBe("busy");
    expect(claude.resumedSession).toBeNull();
    expect(claude.inputs).toHaveLength(0);
  });

  test.each(["serverOverloaded", "internalServerError", "flexUnavailable", { httpConnectionFailed: { httpStatusCode: 503 } }])("recovers structured temporary server failure: %j", async (info) => {
    const { codex, replacements } = await recoverablePair();
    fail(codex, info);
    await waitUntil(() => replacements[0]?.inputs.length === 1);
    expect(replacements[0]?.resumedSession).toBe("saved-codex-conversation");
  });

  test("leaves native retries alone and never starts a turn before user activation", async () => {
    const replacements: FakeAdapter[] = [];
    const { runtime, codex } = await pair({ transientRetryMs: 15, adapterFactory: (definition) => {
      const replacement = new FakeAdapter(definition.alias);
      replacements.push(replacement);
      return replacement;
    } });
    codex.sessionId = "saved-codex-conversation";
    fail(codex);
    await settle();
    expect(replacements).toHaveLength(0);
    await runtime.sendUserMessage("codex", "Review the local parser tests.");
    replacements[0]!.emit("warning", "Codex is retrying after a connection failure", { rawType: "error", payload: { willRetry: true, codexErrorInfo: "serverOverloaded" } });
    await settle();
    expect(replacements).toHaveLength(1);
    expect(state(runtime, "codex")).toBe("busy");
  });

  test("stops after two retries, and only a completed successful turn resets the budget", async () => {
    const { runtime, codex, replacements } = await recoverablePair();
    fail(codex);
    await waitUntil(() => replacements[0]?.inputs.length === 1);
    replacements[0]!.emit("status", "Codex turn started", { rawType: "turn/started" });
    fail(replacements[0]!);
    await waitUntil(() => replacements[1]?.inputs.length === 1);
    fail(replacements[1]!);
    await settle();
    expect(replacements).toHaveLength(2);
    expect(state(runtime, "codex")).toBe("failed");
    expect(runtime.snapshot().events.some((e) => e.summary.includes("exhausted two retries"))).toBe(true);

    await runtime.restartAgent("codex");
    await waitUntil(() => replacements[2]?.inputs.length === 1);
    fail(replacements[2]!);
    await waitUntil(() => replacements[3]?.inputs.length === 1);
    replacements[3]!.emit("status", "Codex turn completed: completed", { rawType: "turn/completed" });
    await waitUntil(() => state(runtime, "codex") === "ready");
    await runtime.sendUserMessage("codex", "Continue the local test review.");
    fail(replacements[3]!);
    await waitUntil(() => replacements[4]?.inputs.length === 1);
  });

  test.each([
    "cyberPolicy", "misalignmentPolicyViolation", "inferenceHookDenied", "unauthorized",
    "contextWindowExceeded", "usageLimitExceeded", "rateLimitExceeded", "sessionBudgetExceeded", "other",
    { httpConnectionFailed: { httpStatusCode: 401 } },
    { responseStreamConnectionFailed: { httpStatusCode: 429 } },
    { responseStreamDisconnected: {} },
  ])("does not automatically retry a nontransient failure: %j", async (info) => {
    const { runtime, codex, replacements } = await recoverablePair();
    fail(codex, info);
    await settle();
    expect(replacements).toHaveLength(0);
    expect(state(runtime, "codex")).toBe("failed");
  });

  test("a later policy failure cancels an already scheduled temporary retry", async () => {
    const { runtime, codex, replacements } = await recoverablePair(100);
    fail(codex);
    fail(codex, "cyberPolicy");
    await settle();
    expect(replacements).toHaveLength(0);
    expect(state(runtime, "codex")).toBe("failed");
  });

  test.each(["interrupt", "clear", "remove", "stop", "goal_complete", "reconfigure"] as const)("%s cancels pending recovery", async (action) => {
    const { runtime, codex, replacements } = await recoverablePair(100);
    fail(codex);
    await waitUntil(() => state(runtime, "codex") === "failed");
    if (action === "interrupt") await runtime.interrupt("codex");
    if (action === "clear") await runtime.clearAgentContext("codex");
    if (action === "remove") await runtime.removeAgent("codex");
    if (action === "stop") await runtime.stop();
    if (action === "goal_complete") runtime.completeActiveGoal();
    if (action === "reconfigure") await runtime.configureAgent({ alias: "codex", provider: "codex", displayName: "Codex", mode: "managed", unrestricted: true });
    await settle();
    expect(replacements).toHaveLength(action === "reconfigure" ? 1 : 0);
    expect(replacements.every((adapter) => adapter.inputs.length === 0)).toBe(true);
  });

  test("does not start a fresh conversation when automatic resume fails", async () => {
    const { runtime, codex, replacements } = await recoverablePair(15, new Error("missing native session"));
    fail(codex);
    await waitUntil(() => replacements.length === 1 && state(runtime, "codex") === "failed");
    await settle();
    expect(replacements[0]?.inputs).toHaveLength(0);
    expect(runtime.snapshot().agents.find((agent) => agent.id === "codex")?.detail).toContain("could not be resumed");
  });
});

describe("mail that piled up during a long turn", () => {
  test("is handed over once, and a peer's stale outage notices collapse to the latest", async () => {
    const replacements: FakeAdapter[] = [];
    const { runtime, codex } = await pair({
      adapterFactory: (definition) => {
        const adapter = new FakeAdapter(definition.alias);
        replacements.push(adapter);
        return adapter;
      },
    });
    await runtime.sendUserMessage("all", "Ship the migration.");
    const inbox = runtime.boundaryInbox("claude");

    codex.emit("error", "Codex usage limit");
    await waitUntil(() => state(runtime, "codex") === "failed");
    await runtime.restartAgent("codex");
    await runtime.callTeamTool("codex", "team_send", { to: "claude", message: "Schema check done." });
    replacements[0]?.emit("error", "Codex usage limit again");
    await waitUntil(() => state(runtime, "codex") === "failed");

    const handed = await inbox.atToolBoundary();
    expect(handed).toContain("[WATARI MAIL: 2 messages]");
    expect(handed).toContain("Schema check done.");
    expect(handed).toContain("is offline: Codex usage limit again");
    expect(handed?.match(/is offline|was restarted/gu)).toHaveLength(1);
    // The urgent notice leads the batch.
    expect(handed?.indexOf("is offline")).toBeLessThan(handed?.indexOf("Schema check done.") ?? 0);
    expect(await inbox.atToolBoundary()).toBeNull();
  });
});

describe("bridge checks for replaced agents", () => {
  test("a probe that finishes after its agent was removed reports nothing", async () => {
    const previous = process.env["WATARI_CODEX_BIN"];
    process.env["WATARI_CODEX_BIN"] = "/nonexistent/codex";
    let release: (() => void) | null = null;
    const probed: string[] = [];
    try {
      const runtime = new CoordinatorRuntime({
        project: { launchDirectory: "/tmp/project", repositoryRoot: "/tmp/project" },
        databasePath: ":memory:",
        roster: [
          { alias: "codex", provider: "codex", displayName: "Codex", mode: "managed", unrestricted: true },
          { alias: "spare", provider: "codex", displayName: "Spare", mode: "managed", unrestricted: true },
        ],
        async probeBridge({ agent }) {
          probed.push(agent);
          if (agent === "codex") await new Promise<void>((resolve) => { release = resolve; });
          return {
            agent,
            state: agent === "codex" ? "failed" : "ready",
            detail: agent === "codex" ? "Connection closed" : "stub probe",
            tools: [],
            missing: [],
            elapsedMs: 1,
            checkedAt: Date.now(),
          };
        },
      });
      runtimes.push(runtime);
      await runtime.start();
      await waitUntil(() => release !== null);

      await runtime.removeAgent("codex");
      release!();
      await settle();

      expect(runtime.bridges().map((bridge) => bridge.agent)).toEqual(["spare"]);
      expect(runtime.snapshot().events.some((event) => event.summary.includes("Team bridge check failed"))).toBe(false);
    } finally {
      if (previous === undefined) delete process.env["WATARI_CODEX_BIN"];
      else process.env["WATARI_CODEX_BIN"] = previous;
    }
  });
});

describe("reconfiguring while a harness starts", () => {
  test("a start that fails because its harness was replaced marks nothing failed", async () => {
    const slow = new SlowStart("codex");
    const replacement = new FakeAdapter("codex");
    const runtime = new CoordinatorRuntime({
      project: { launchDirectory: "/tmp/project", repositoryRoot: "/tmp/project" },
      databasePath: ":memory:",
      adapters: { codex: slow, claude: new FakeAdapter("claude") },
      adapterFactory: () => replacement,
    });
    runtimes.push(runtime);
    const starting = runtime.start();
    await waitUntil(() => slow.startCalled);

    await runtime.configureAgent({
      alias: "codex",
      provider: "codex",
      displayName: "Codex",
      model: "cheaper",
      mode: "managed",
      unrestricted: true,
    });
    await starting;
    await settle();

    expect(state(runtime, "codex")).toBe("ready");
    const events = runtime.snapshot().events.map((event) => event.summary);
    expect(events.some((summary) => summary.includes("Could not start"))).toBe(false);
    expect(runtime.snapshot().messages.some((message) => message.body.includes("is offline"))).toBe(false);

    // The replacement's own stream ending is still an outage.
    replacement.disconnect();
    await waitUntil(() => state(runtime, "codex") === "failed");
  });
});

/** A harness whose start only ends when it is stopped, like one stopped mid-handshake. */
class SlowStart extends FakeAdapter {
  startCalled = false;
  #reject: ((error: Error) => void) | null = null;

  override async start(): Promise<void> {
    this.startCalled = true;
    await new Promise<void>((_resolve, reject) => {
      this.#reject = reject;
    });
  }

  override async stop(): Promise<void> {
    this.#reject?.(new Error("Codex adapter stopped"));
    await super.stop();
  }
}

async function pair(overrides: Partial<RuntimeOptions> = {}) {
  const codex = new FakeAdapter("codex");
  const claude = new FakeAdapter("claude");
  const runtime = new CoordinatorRuntime({
    project: { launchDirectory: "/tmp/project", repositoryRoot: "/tmp/project" },
    databasePath: ":memory:",
    adapters: { codex, claude },
    ...overrides,
  });
  runtimes.push(runtime);
  await runtime.start();
  return { runtime, codex, claude };
}

function state(runtime: CoordinatorRuntime, id: string): string | undefined {
  return runtime.snapshot().agents.find((agent) => agent.id === id)?.state;
}

function text(input: AgentInput | undefined): string {
  return input?.kind === "message" ? input.text : "";
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition was not reached in time");
    await Bun.sleep(5);
  }
}

async function settle(): Promise<void> {
  for (let pass = 0; pass < 4; pass += 1) {
    await new Promise((resolve) => setTimeout(resolve, 35));
  }
}
