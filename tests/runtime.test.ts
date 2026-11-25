import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { InputDeferredError } from "../src/watari/models.ts";
import { CoordinatorRuntime, type RuntimeOptions } from "../src/watari/service/runtime.ts";
import { FakeAdapter } from "./fakes/fake-adapter.ts";

const runtimes: CoordinatorRuntime[] = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.stop()));
});

describe("CoordinatorRuntime", () => {
  test("routes provider-neutral aliases and exposes their model profiles", async () => {
    const builder = new FakeAdapter("builder");
    const reviewer = new FakeAdapter("reviewer");
    builder.modelOptions = [{
      id: "gpt-native",
      displayName: "GPT Native",
      description: "reported by Codex",
      efforts: ["provider-next"],
    }];
    const runtime = new CoordinatorRuntime({
      project: { launchDirectory: "/tmp/project", repositoryRoot: "/tmp/project" },
      databasePath: ":memory:",
      roster: [
        {
          alias: "builder",
          provider: "codex",
          displayName: "Builder",
          model: "gpt-test",
          effort: "high",
          mode: "managed",
          unrestricted: true,
        },
        {
          alias: "reviewer",
          provider: "claude",
          displayName: "Reviewer",
          model: "sonnet-test",
          effort: "low",
          mode: "managed",
          unrestricted: false,
        },
      ],
      adapters: { builder, reviewer },
    });
    runtimes.push(runtime);
    await runtime.start();
    await runtime.sendUserMessage("reviewer", "Review this API.");

    expect(builder.inputs).toHaveLength(0);
    expect(reviewer.inputs).toHaveLength(1);
    expect(runtime.snapshot().agents.find((agent) => agent.id === "reviewer")).toMatchObject({
      provider: "claude",
      model: "sonnet-test",
      effort: "low",
      unrestricted: false,
    });
    expect(await runtime.availableProviderModels("codex")).toEqual(builder.modelOptions);
  });

  test("an external alias exists only while its MCP connection is live", async () => {
    const runtime = new CoordinatorRuntime({
      project: { launchDirectory: "/tmp/project", repositoryRoot: "/tmp/project" },
      databasePath: ":memory:",
      roster: [{
        alias: "future",
        provider: "opencode",
        displayName: "Future",
        mode: "external",
        unrestricted: true,
      }],
    });
    runtimes.push(runtime);
    await runtime.start();
    expect(runtime.snapshot().agents[0]).toMatchObject({ state: "stopped", mode: "external" });

    runtime.registerBridge("future", "opencode");
    await runtime.sendUserMessage("future", "Inspect the queue.");
    expect(runtime.snapshot().agents[0]).toMatchObject({ state: "waiting" });
    expect(runtime.snapshot().messages.at(-1)).toMatchObject({ recipients: ["future"] });
    const inbox = await runtime.callTeamTool("future", "team_inbox", {});
    expect(inbox.ok).toBe(true);
    expect(JSON.stringify(inbox.value)).toContain("You are working alone");

    runtime.unregisterBridge("future");
    expect(runtime.snapshot().agents[0]).toMatchObject({ state: "stopped" });
    await expect(runtime.sendUserMessage("future", "Are you there?")).rejects.toThrow("not connected");
  });
  test("a broadcast opens the goal and reaches every ready peer", async () => {
    const codex = new FakeAdapter("codex");
    const claude = new FakeAdapter("claude");
    const runtime = new CoordinatorRuntime({
      project: { launchDirectory: "/tmp/project", repositoryRoot: "/tmp/project" },
      databasePath: ":memory:",
      adapters: { codex, claude },
    });
    runtimes.push(runtime);
    await runtime.start();

    const instruction = "Implement the shared framing contract exactly.";
    await runtime.sendUserMessage("all", instruction);

    expect(runtime.snapshot().activeGoal?.instruction).toBe(instruction);
    expect(codex.inputs[0]?.kind).toBe("message");
    expect(claude.inputs[0]?.kind).toBe("message");
    expect(messageText(codex.inputs[0])).toContain(`<watari_goal>\n${instruction}\n</watari_goal>`);
    expect(messageText(claude.inputs[0])).toContain(`<watari_goal>\n${instruction}\n</watari_goal>`);
    expect(messageText(codex.inputs[0])).toContain("intake coordinator (position 1 of 2)");
    expect(messageText(codex.inputs[0])).toContain("Peers: claude (claude, default model).");
    expect(messageText(claude.inputs[0])).toContain("collaborator (position 2 of 2)");
    expect(messageText(claude.inputs[0])).toContain("Begin with light read-only exploration");
  });

  test("a first message aimed at one peer opens the goal without telling the other", async () => {
    const codex = new FakeAdapter("codex");
    const claude = new FakeAdapter("claude");
    const runtime = new CoordinatorRuntime({
      project: { launchDirectory: "/tmp/project", repositoryRoot: "/tmp/project" },
      databasePath: ":memory:",
      adapters: { codex, claude },
    });
    runtimes.push(runtime);
    await runtime.start();

    const instruction = "Implement the shared framing contract exactly.";
    await runtime.sendUserMessage("codex", instruction);

    // The goal is shared state both peers can read through `team_goal`, but
    // typing in one peer's tab addresses that peer only.
    expect(runtime.snapshot().activeGoal?.instruction).toBe(instruction);
    expect(runtime.snapshot().activeGoal?.initialAddressee).toBe("codex");
    expect(messageText(codex.inputs[0])).toContain(`<watari_goal>\n${instruction}\n</watari_goal>`);
    expect(messageText(codex.inputs[0])).toContain("intake coordinator (position 1 of 2)");
    expect(messageText(codex.inputs[0])).toContain("team_send");
    expect(claude.inputs).toHaveLength(0);
    expect(runtime.snapshot().messages[0]?.recipients).toEqual(["codex"]);
  });

  test("routes follow-ups to the selected native harness", async () => {
    const codex = new FakeAdapter("codex");
    const claude = new FakeAdapter("claude");
    const runtime = new CoordinatorRuntime({
      project: { launchDirectory: "/tmp/project", repositoryRoot: "/tmp/project" },
      databasePath: ":memory:",
      adapters: { codex, claude },
    });
    runtimes.push(runtime);
    await runtime.start();
    await runtime.sendUserMessage("all", "Shared goal");
    await runtime.sendUserMessage("claude", "Please focus on shutdown behavior.");

    expect(codex.inputs).toHaveLength(1);
    expect(claude.inputs).toHaveLength(2);
    expect(messageText(claude.inputs[1])).toBe("Please focus on shutdown behavior.");
  });

  test("session metadata cannot make a working or failed peer ready", async () => {
    const codex = new FakeAdapter("codex");
    const claude = new FakeAdapter("claude");
    const runtime = new CoordinatorRuntime({
      project: { launchDirectory: "/tmp/project", repositoryRoot: "/tmp/project" },
      databasePath: ":memory:",
      adapters: { codex, claude },
    });
    runtimes.push(runtime);
    await runtime.start();
    await runtime.sendUserMessage("claude", "Inspect the lifecycle.");

    expect(runtime.snapshot().agents.find((agent) => agent.id === "claude")?.state).toBe("busy");
    claude.emit("session", "Claude session initialized");
    claude.emit("assistant", "Working now.");
    await settle();
    expect(runtime.snapshot().agents.find((agent) => agent.id === "claude")?.state).toBe("busy");

    claude.emit("status", "Claude turn completed: success");
    await settle();
    expect(runtime.snapshot().agents.find((agent) => agent.id === "claude")?.state).toBe("ready");

    claude.emit("error", "transport reset");
    claude.emit("session", "late session initialization");
    await settle();
    expect(runtime.snapshot().agents.find((agent) => agent.id === "claude")?.state).toBe("failed");
  });

  test("a session event is not a peer-message delivery boundary", async () => {
    const codex = new FakeAdapter("codex");
    const claude = new FakeAdapter("claude");
    const runtime = new CoordinatorRuntime({
      project: { launchDirectory: "/tmp/project", repositoryRoot: "/tmp/project" },
      databasePath: ":memory:",
      adapters: { codex, claude },
    });
    runtimes.push(runtime);
    await runtime.start();
    await runtime.sendUserMessage("all", "Shared goal");
    const before = claude.inputs.length;
    await runtime.callTeamTool("codex", "team_send", {
      to: "claude",
      message: "deliver this only at a real boundary",
    });

    claude.emit("session", "Claude session initialized");
    await settle();
    expect(claude.inputs).toHaveLength(before);

    claude.emit("status", "Claude turn completed: success");
    await settle();
    expect(claude.inputs).toHaveLength(before + 1);
    expect(messageText(claude.inputs.at(-1))).toContain("only at a real boundary");
  });

  test("answering an approval moves the peer from waiting back to working", async () => {
    const claude = new FakeAdapter("claude");
    const runtime = new CoordinatorRuntime({
      project: { launchDirectory: "/tmp/project", repositoryRoot: "/tmp/project" },
      databasePath: ":memory:",
      adapters: { codex: new FakeAdapter("codex"), claude },
    });
    runtimes.push(runtime);
    await runtime.start();
    await runtime.sendUserMessage("claude", "Request approval.");
    claude.emit("approval", "bash: bun test");
    await settle();
    expect(runtime.snapshot().agents.find((agent) => agent.id === "claude")?.state).toBe("waiting");

    await runtime.respondToApproval("claude", "req-1", "accept");
    expect(runtime.snapshot().agents.find((agent) => agent.id === "claude")?.state).toBe("busy");
  });

  test("a peer that is mid turn still receives its mail at the next boundary", async () => {
    const codex = new FakeAdapter("codex");
    const claude = new FakeAdapter("claude");
    const runtime = new CoordinatorRuntime({
      project: { launchDirectory: "/tmp/project", repositoryRoot: "/tmp/project" },
      databasePath: ":memory:",
      adapters: { codex, claude },
    });
    runtimes.push(runtime);
    await runtime.start();
    await runtime.sendUserMessage("all", "Shared goal");
    const before = claude.inputs.length;

    // Claude opens a long turn and never returns to idle.
    claude.emit("status", "Claude turn started");
    await settle();
    expect(runtime.snapshot().agents.find((agent) => agent.id === "claude")?.state).toBe("busy");

    await runtime.callTeamTool("codex", "team_send", {
      to: "claude",
      message: "acknowledgement row is dropped on disconnect",
    });
    await settle();

    // Nothing has finished yet, so nothing has been handed over.
    expect(claude.inputs).toHaveLength(before);

    // A finished tool step is a boundary the harness can take input at.
    claude.emit("tool_end", "bash  bun test");
    await settle();

    expect(claude.inputs.length).toBeGreaterThan(before);
    expect(messageText(claude.inputs.at(-1))).toContain("acknowledgement row is dropped");
  });

  test("a provider without safe steer receives queued mail only after its turn", async () => {
    const codex = new FakeAdapter("codex");
    const openCode = new FakeAdapter("opencode");
    openCode.safeSteer = false;
    const runtime = new CoordinatorRuntime({
      project: { launchDirectory: "/tmp/project", repositoryRoot: "/tmp/project" },
      databasePath: ":memory:",
      roster: [
        { alias: "codex", provider: "codex", displayName: "Codex", mode: "managed", unrestricted: true },
        { alias: "opencode", provider: "opencode", displayName: "OpenCode", mode: "managed", unrestricted: true },
      ],
      adapters: { codex, opencode: openCode },
    });
    runtimes.push(runtime);
    await runtime.start();
    await runtime.sendUserMessage("opencode", "Inspect delivery boundaries.");
    openCode.emit("status", "OpenCode turn started");
    await settle();
    const before = openCode.inputs.length;

    await runtime.callTeamTool("codex", "team_send", {
      to: "opencode",
      message: "wait for the ACP turn boundary",
    });
    openCode.emit("tool_end", "edit  fixture");
    await settle();
    expect(openCode.inputs).toHaveLength(before);

    openCode.emit("status", "OpenCode turn completed");
    await settle();
    expect(openCode.inputs).toHaveLength(before + 1);
    expect(messageText(openCode.inputs.at(-1))).toContain("wait for the ACP turn boundary");
  });

  test("messages that pile up during one turn arrive as a single handover", async () => {
    const codex = new FakeAdapter("codex");
    const claude = new FakeAdapter("claude");
    const runtime = new CoordinatorRuntime({
      project: { launchDirectory: "/tmp/project", repositoryRoot: "/tmp/project" },
      databasePath: ":memory:",
      adapters: { codex, claude },
    });
    runtimes.push(runtime);
    await runtime.start();
    await runtime.sendUserMessage("all", "Shared goal");
    claude.emit("status", "Claude turn started");
    await settle();
    const before = claude.inputs.length;

    for (const message of ["first finding", "second finding", "third finding"]) {
      await runtime.callTeamTool("codex", "team_send", { to: "claude", message });
    }
    await settle();
    claude.emit("tool_end", "bash  bun test");
    await settle();

    expect(claude.inputs).toHaveLength(before + 1);
    const delivered = messageText(claude.inputs.at(-1));
    expect(delivered).toContain("first finding");
    expect(delivered).toContain("second finding");
    expect(delivered).toContain("third finding");
  });

  test("stop interrupts a managed turn, then stop, urgent, and normal mail go as one batch", async () => {
    const codex = new FakeAdapter("codex");
    const claude = new FakeAdapter("claude");
    const runtime = new CoordinatorRuntime({
      project: { launchDirectory: "/tmp/project", repositoryRoot: "/tmp/project" },
      databasePath: ":memory:",
      adapters: { codex, claude },
    });
    runtimes.push(runtime);
    await runtime.start();
    await runtime.sendUserMessage("all", "Shared goal");
    claude.emit("status", "Claude turn started");
    await settle();
    const before = claude.inputs.length;

    await runtime.callTeamTool("codex", "team_send", {
      to: "claude",
      message: "normal mail",
    });
    await runtime.callTeamTool("codex", "team_send", {
      to: "claude",
      priority: "urgent",
      priority_reason: "must precede the normal queue",
      message: "urgent mail",
    });
    const stopped = await runtime.callTeamTool("codex", "team_send", {
      to: "claude",
      priority: "stop",
      priority_reason: "continuing would edit the wrong target",
      message: "stop mail",
    });
    expect(claude.interrupts).toBe(1);
    expect(stopped).toMatchObject({
      ok: true,
      value: { interruptions: [{ agent: "claude", interrupted: true }] },
    });
    expect(claude.inputs).toHaveLength(before);

    // One boundary hands over everything, in priority order, as one input.
    claude.emit("tool_end", "bash  boundary one");
    await settle();
    expect(claude.inputs).toHaveLength(before + 1);
    const batch = messageText(claude.inputs.at(-1));
    expect(batch.indexOf("stop mail")).toBeGreaterThan(-1);
    expect(batch.indexOf("stop mail")).toBeLessThan(batch.indexOf("urgent mail"));
    expect(batch.indexOf("urgent mail")).toBeLessThan(batch.indexOf("normal mail"));

    claude.emit("tool_end", "bash  boundary two");
    await settle();
    expect(claude.inputs).toHaveLength(before + 1);
  });

  test("a peer that is down is not handed mail", async () => {
    const codex = new FakeAdapter("codex");
    const claude = new FakeAdapter("claude");
    const runtime = new CoordinatorRuntime({
      project: { launchDirectory: "/tmp/project", repositoryRoot: "/tmp/project" },
      databasePath: ":memory:",
      adapters: { codex, claude },
    });
    runtimes.push(runtime);
    await runtime.start();
    await runtime.sendUserMessage("all", "Shared goal");
    claude.emit("error", "transport reset");
    await settle();
    const before = claude.inputs.length;

    await runtime.callTeamTool("codex", "team_send", { to: "claude", message: "still there?" });
    await settle();
    claude.emit("tool_end", "bash  something");
    await settle();

    expect(runtime.snapshot().agents.find((agent) => agent.id === "claude")?.state).toBe("failed");
    expect(claude.inputs).toHaveLength(before);
  });

  test("an agent error stays failed and notifies its working peer once", async () => {
    const codex = new FakeAdapter("codex");
    const claude = new FakeAdapter("claude");
    const runtime = new CoordinatorRuntime({
      project: { launchDirectory: "/tmp/project", repositoryRoot: "/tmp/project" },
      databasePath: ":memory:",
      adapters: { codex, claude },
    });
    runtimes.push(runtime);
    await runtime.start();
    await runtime.sendUserMessage("all", "Shared goal");
    const before = codex.inputs.length;

    claude.emit("error", "Claude assistant error: rate_limit");
    claude.emit("status", "Claude turn completed: success");
    claude.emit("error", "Claude terminal result repeated the failure");
    await settle();

    const failed = runtime.snapshot().agents.find((agent) => agent.id === "claude");
    expect(failed).toMatchObject({
      state: "failed",
      detail: "Claude assistant error: rate_limit",
    });
    const notifications = runtime.snapshot().messages.filter(
      (message) => message.sender === "watari" && message.body.startsWith("Claude (claude) is offline:"),
    );
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({ recipients: ["codex"], kind: "system", priority: "urgent" });
    expect(codex.inputs).toHaveLength(before);

    codex.emit("tool_end", "bash  bun test");
    await settle();
    expect(codex.inputs).toHaveLength(before + 1);
    expect(messageText(codex.inputs.at(-1))).toContain("Claude (claude) is offline: Claude assistant error: rate_limit");
    expect(messageText(codex.inputs.at(-1))).toContain("do not wait for this peer");
  });

  test("an event stream that closes unexpectedly marks the peer offline", async () => {
    const codex = new FakeAdapter("codex");
    const claude = new FakeAdapter("claude");
    const runtime = new CoordinatorRuntime({
      project: { launchDirectory: "/tmp/project", repositoryRoot: "/tmp/project" },
      databasePath: ":memory:",
      adapters: { codex, claude },
    });
    runtimes.push(runtime);
    await runtime.start();

    claude.disconnect();
    await settle();

    expect(runtime.snapshot().agents.find((agent) => agent.id === "claude")).toMatchObject({
      state: "failed",
      detail: "native harness event stream ended unexpectedly",
    });
    expect(runtime.snapshot().messages.at(-1)).toMatchObject({
      sender: "watari",
      recipients: ["codex"],
      priority: "urgent",
    });
  });

  test("starts no provider session or archive until a user message and never resumes old sessions", async () => {
    const directory = mkdtempSync(join(tmpdir(), "watari-fresh-chat-"));
    const chatsDirectory = join(directory, "chats");
    const codex = new FakeAdapter("codex");
    const claude = new FakeAdapter("claude");
    const runtime = new CoordinatorRuntime({
      project: { launchDirectory: directory, repositoryRoot: directory },
      databasePath: join(directory, "state.db"),
      chatsDirectory,
      adapters: { codex, claude },
    });
    runtimes.push(runtime);
    await runtime.start();

    expect(codex.prepared).toBe(0);
    expect(claude.prepared).toBe(0);
    expect(codex.resumedSession).toBeNull();
    expect(claude.resumedSession).toBeNull();
    expect(existsSync(chatsDirectory)).toBe(false);

    await runtime.sendUserMessage("codex", "Inspect this project.");
    expect(codex.prepared).toBe(1);
    expect(claude.prepared).toBe(0);
    expect(readdirSync(chatsDirectory).filter((name) => name.endsWith(".jsonl"))).toHaveLength(1);

    await runtime.newChat();
    expect(runtime.snapshot().messages).toEqual([]);
    expect(runtime.snapshot().activeGoal).toBeNull();
    expect(codex.resets).toBe(1);
    expect(claude.resets).toBe(1);
    await runtime.stop();
    runtimes.splice(runtimes.indexOf(runtime), 1);
    rmSync(directory, { recursive: true, force: true });
  });
  test("bridges are probed when the service starts, not left unknown until a send", async () => {
    const probed: string[] = [];
    // No harness binary, so nothing is spawned: a peer whose harness is missing
    // still has a coordination bridge, and which of the two is broken is
    // exactly what the panel has to be able to say.
    const previous = process.env["WATARI_CODEX_BIN"];
    const previousState = process.env.XDG_STATE_HOME;
    process.env["WATARI_CODEX_BIN"] = "/nonexistent/codex";
    process.env.XDG_STATE_HOME = "/tmp/watari-custom-state";
    try {
      const runtime = new CoordinatorRuntime({
        project: { launchDirectory: "/tmp/project", repositoryRoot: "/tmp/project" },
        databasePath: ":memory:",
        roster: [
          { alias: "codex", provider: "codex", displayName: "Codex", mode: "managed", unrestricted: true },
        ],
        async probeBridge({ agent, env }) {
          // This exact environment is also injected into native MCP launchers,
          // which may discard XDG_STATE_HOME from their inherited environment.
          expect(env?.XDG_STATE_HOME).toBe("/tmp/watari-custom-state");
          probed.push(agent);
          return {
            agent,
            state: "ready",
            detail: "stub probe",
            tools: [],
            missing: [],
            elapsedMs: 1,
            checkedAt: Date.now(),
          };
        },
      });
      runtimes.push(runtime);
      await runtime.start();
      await waitUntil(() => probed.length === 1);

      expect(probed).toEqual(["codex"]);
      expect(runtime.bridges().map((bridge) => bridge.state)).toEqual(["ready"]);
      // The harness is separately, visibly broken.
      expect(runtime.snapshot().agents[0]?.state).toBe("failed");
      expect(runtime.snapshot().agents[0]?.detail).toContain("executable not found");
    } finally {
      if (previous === undefined) delete process.env["WATARI_CODEX_BIN"];
      else process.env["WATARI_CODEX_BIN"] = previous;
      if (previousState === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = previousState;
    }
  });

  test("a harness that never finishes starting is failed, not waited on forever", async () => {
    const wedged = new FakeAdapter("wedged");
    wedged.hangOnStart = true;
    const runtime = new CoordinatorRuntime({
      project: { launchDirectory: "/tmp/project", repositoryRoot: "/tmp/project" },
      databasePath: ":memory:",
      roster: [
        { alias: "wedged", provider: "codex", displayName: "Wedged", mode: "managed", unrestricted: true },
      ],
      adapters: { wedged },
      startTimeoutMs: 60,
    });
    runtimes.push(runtime);
    const started = runtime.start();

    // Coming up is Watari's own work: with nobody attached and nothing queued,
    // it must not count as a reason to keep the service and its children alive.
    await waitUntil(() => runtime.snapshot().agents[0]?.state === "starting");
    expect(runtime.hasActiveWork()).toBe(false);

    await started;
    expect(runtime.snapshot().agents[0]?.state).toBe("failed");
    expect(runtime.snapshot().agents[0]?.detail).toContain("did not finish starting");
    expect(runtime.hasActiveWork()).toBe(false);
  });

  test("a harness that will not close cannot hold the shutdown open", async () => {
    const stubborn = new FakeAdapter("stubborn");
    const willing = new FakeAdapter("willing");
    stubborn.hangOnStop = true;
    const runtime = new CoordinatorRuntime({
      project: { launchDirectory: "/tmp/project", repositoryRoot: "/tmp/project" },
      databasePath: ":memory:",
      roster: [
        { alias: "stubborn", provider: "codex", displayName: "Stubborn", mode: "managed", unrestricted: true },
        { alias: "willing", provider: "claude", displayName: "Willing", mode: "managed", unrestricted: true },
      ],
      adapters: { stubborn, willing },
      stopTimeoutMs: 60,
    });
    await runtime.start();

    await withDeadline(runtime.stop(), 2_000);
  });

  test("a peer with no bridge of its own is reported as unknown, never as healthy", async () => {
    const runtime = new CoordinatorRuntime({
      project: { launchDirectory: "/tmp/project", repositoryRoot: "/tmp/project" },
      databasePath: ":memory:",
      roster: [
        { alias: "solo", provider: "codex", displayName: "Solo", mode: "external", unrestricted: true },
      ],
    });
    runtimes.push(runtime);
    await runtime.start();

    expect(runtime.bridges().map((bridge) => bridge.state)).toEqual(["unknown"]);
  });

  test("an unanswered question gets one reminder, and then the asker is told", async () => {
    const { runtime, codex, claude } = await pair();
    await runtime.sendUserMessage("all", "Shared goal");
    codex.emit("status", "Codex turn completed");
    claude.emit("status", "Claude turn started");
    await settle();

    const asked = await runtime.callTeamTool("codex", "team_send", {
      to: "claude",
      message: "Are you using the remote workspace?",
      expects_reply: true,
    });
    const questionId = (asked.value as { id: number }).id;
    claude.emit("tool_end", "bash  inspect");
    await settle();
    expect(messageText(claude.inputs.at(-1))).toContain(`expects_reply="true"`);
    expect(messageText(claude.inputs.at(-1))).toContain("Peers cannot see your chat output");
    const beforeReminder = claude.inputs.length;

    claude.emit("status", "Claude turn completed: success");
    await settle();
    expect(claude.inputs).toHaveLength(beforeReminder + 1);
    expect(messageText(claude.inputs.at(-1))).toContain("[WATARI REMINDER]");
    expect(messageText(claude.inputs.at(-1))).toContain(`#${questionId} from codex`);

    const codexBefore = codex.inputs.length;
    claude.emit("status", "Claude turn completed: success");
    await settle();
    expect(codex.inputs).toHaveLength(codexBefore + 1);
    expect(messageText(codex.inputs.at(-1))).toContain(`without answering message #${questionId}`);

    claude.emit("status", "Claude turn completed: success");
    await settle();
    expect(codex.inputs).toHaveLength(codexBefore + 1);
  });

  test("a peer that answers before its turn ends is not reminded", async () => {
    const { runtime, codex, claude } = await pair();
    await runtime.sendUserMessage("all", "Shared goal");
    codex.emit("status", "Codex turn completed");
    claude.emit("status", "Claude turn started");
    await settle();
    const asked = await runtime.callTeamTool("codex", "team_send", {
      to: "claude",
      message: "Which branch?",
      expects_reply: true,
    });
    const questionId = (asked.value as { id: number }).id;
    claude.emit("tool_end", "bash  inspect");
    await settle();
    await runtime.callTeamTool("claude", "team_send", { to: "codex", message: "main", reply_to: questionId });
    await settle();
    expect(messageText(codex.inputs.at(-1))).toContain(`reply_to="${questionId}"`);

    const before = claude.inputs.length;
    claude.emit("status", "Claude turn completed: success");
    await settle();
    expect(claude.inputs).toHaveLength(before);
  });

  test("a harness with in-turn hooks pulls its mail at tool batches and is reminded before its turn ends", async () => {
    const { runtime, codex, claude } = await pair();
    claude.safeSteer = false;
    await runtime.sendUserMessage("all", "Shared goal");
    codex.emit("status", "Codex turn completed");
    claude.emit("status", "Claude turn started");
    await settle();
    const asked = await runtime.callTeamTool("codex", "team_send", {
      to: "claude",
      message: "Which branch are you on?",
      expects_reply: true,
    });
    const questionId = (asked.value as { id: number }).id;
    const inbox = runtime.boundaryInbox("claude");

    expect(await inbox.atToolBoundary()).toContain("Which branch are you on?");
    expect(await inbox.atToolBoundary()).toBeNull();
    expect(await inbox.beforeTurnEnd()).toContain(`#${questionId} from codex`);
    expect(await inbox.beforeTurnEnd()).toBeNull();

    const codexBefore = codex.inputs.length;
    claude.emit("status", "Claude turn completed: success");
    await settle();
    expect(codex.inputs).toHaveLength(codexBefore + 1);
    expect(messageText(codex.inputs.at(-1))).toContain(`without answering message #${questionId}`);
  });

  test("do-not-disturb holds normal mail inside and between turns until the peer is open again", async () => {
    const { runtime, claude } = await pair();
    await runtime.sendUserMessage("all", "Shared goal");
    claude.emit("status", "Claude turn started");
    await settle();
    await runtime.callTeamTool("claude", "team_availability", {
      mode: "dnd",
      reason: "applying the migration",
      minutes: 10,
    });
    const sent = await runtime.callTeamTool("codex", "team_send", { to: "claude", message: "normal note" });
    expect(sent).toMatchObject({
      ok: true,
      value: {
        deliveries: [{
          agent: "claude",
          delivery: "held_dnd",
          note: expect.stringContaining("applying the migration"),
        }],
      },
    });
    const before = claude.inputs.length;
    claude.emit("tool_end", "bash  migrate");
    await settle();
    expect(claude.inputs).toHaveLength(before);
    claude.emit("status", "Claude turn completed: success");
    await settle();
    expect(claude.inputs).toHaveLength(before);

    await runtime.callTeamTool("claude", "team_availability", { mode: "open" });
    await settle();
    expect(claude.inputs).toHaveLength(before + 1);
    expect(messageText(claude.inputs.at(-1))).toContain("normal note");
  });

  test("urgent mail waits for the end of a focused peer's turn rather than steering it", async () => {
    const { runtime, claude } = await pair();
    await runtime.sendUserMessage("all", "Shared goal");
    claude.emit("status", "Claude turn started");
    await settle();
    await runtime.callTeamTool("claude", "team_availability", { mode: "dnd", reason: "release step" });
    const sent = await runtime.callTeamTool("codex", "team_send", {
      to: "claude",
      message: "the release tag is wrong",
      priority: "urgent",
      priority_reason: "the tag must be fixed before publishing",
    });
    expect(sent).toMatchObject({ ok: true, value: { deliveries: [{ delivery: "after_turn" }] } });
    const before = claude.inputs.length;
    claude.emit("tool_end", "bash  tag");
    await settle();
    expect(claude.inputs).toHaveLength(before);
    claude.emit("status", "Claude turn completed: success");
    await settle();
    expect(messageText(claude.inputs.at(-1))).toContain("the release tag is wrong");
  });

  test("closing the goal informs peers without starting a turn for the idle ones", async () => {
    const { runtime, codex, claude } = await pair();
    await runtime.sendUserMessage("all", "Shared goal");
    codex.emit("status", "Codex turn completed");
    claude.emit("status", "Claude turn completed: success");
    await settle();
    const codexBefore = codex.inputs.length;
    const claudeBefore = claude.inputs.length;

    runtime.completeActiveGoal();
    await settle();
    expect(codex.inputs).toHaveLength(codexBefore);
    expect(claude.inputs).toHaveLength(claudeBefore);

    await runtime.callTeamTool("claude", "team_send", { to: "codex", message: "follow-up" });
    await settle();
    expect(codex.inputs).toHaveLength(codexBefore + 1);
    expect(messageText(codex.inputs.at(-1))).toContain("The user marked the shared goal complete.");
    expect(messageText(codex.inputs.at(-1))).toContain("follow-up");
  });

  test("a harness that refuses a handover keeps its mail queued and is not reported offline", async () => {
    const { runtime, claude } = await pair();
    await runtime.sendUserMessage("all", "Shared goal");
    claude.emit("status", "Claude turn started");
    await settle();
    await runtime.callTeamTool("codex", "team_send", { to: "claude", message: "retry me" });
    claude.sendError = new InputDeferredError("the turn is compacting");
    const before = claude.inputs.length;

    claude.emit("tool_end", "bash  step");
    await settle();
    expect(claude.inputs).toHaveLength(before);
    expect(runtime.snapshot().agents.find((agent) => agent.id === "claude")?.state).toBe("busy");
    expect(runtime.snapshot().messages.some((message) => message.body.includes("is offline"))).toBe(false);

    claude.emit("tool_end", "bash  next step");
    await settle();
    expect(messageText(claude.inputs.at(-1))).toContain("retry me");
  });

  test("Codex is steered only after every tool call in its batch has finished", async () => {
    const { runtime, codex } = await pair();
    await runtime.sendUserMessage("all", "Shared goal");
    codex.emit("status", "Codex turn started");
    codex.emit("tool_start", "bash  build", { providerEventId: "call-1" });
    codex.emit("tool_start", "bash  lint", { providerEventId: "call-2" });
    await settle();
    await runtime.callTeamTool("claude", "team_send", { to: "codex", message: "the lint rule changed" });
    const before = codex.inputs.length;

    codex.emit("tool_end", "bash  lint", { providerEventId: "call-2" });
    await settle();
    expect(codex.inputs).toHaveLength(before);

    codex.emit("tool_end", "bash  build", { providerEventId: "call-1" });
    await settle();
    expect(codex.inputs).toHaveLength(before + 1);
  });

  test("a stop lets the running tool call finish before it interrupts", async () => {
    const { runtime, claude } = await pair({ stopDeferMs: 5_000 });
    await runtime.sendUserMessage("all", "Shared goal");
    claude.emit("status", "Claude turn started");
    claude.emit("tool_start", "bash  git rebase", { providerEventId: "rebase" });
    await settle();

    const stopped = await runtime.callTeamTool("codex", "team_send", {
      to: "claude",
      priority: "stop",
      priority_reason: "this branch is the wrong target",
      message: "stop and re-check the branch",
    });
    expect(stopped).toMatchObject({
      ok: true,
      value: { interruptions: [{ agent: "claude", interrupted: false, deferred: true }] },
    });
    expect(claude.interrupts).toBe(0);
    const before = claude.inputs.length;

    claude.emit("tool_end", "bash  git rebase", { providerEventId: "rebase" });
    await settle();
    expect(claude.interrupts).toBe(1);
    expect(claude.inputs).toHaveLength(before);

    claude.emit("status", "Claude turn completed: interrupted");
    await settle();
    expect(messageText(claude.inputs.at(-1))).toContain("stop and re-check the branch");
    expect(claude.inputs).toHaveLength(before + 1);
  });

  test("a held stop still lands when the tool call never finishes", async () => {
    const { runtime, claude } = await pair({ stopDeferMs: 50 });
    await runtime.sendUserMessage("all", "Shared goal");
    claude.emit("status", "Claude turn started");
    claude.emit("tool_start", "bash  sleep forever", { providerEventId: "stuck" });
    await settle();
    await runtime.callTeamTool("codex", "team_send", {
      to: "claude",
      priority: "stop",
      priority_reason: "the command is hung",
      message: "stop",
    });
    await waitUntil(() => claude.interrupts === 1);
  });

  test("a wake starts a turn for the peer that asked for it and keeps the service busy until then", async () => {
    const directory = mkdtempSync(join(tmpdir(), "watari-runtime-wake-"));
    try {
      const { runtime, codex } = await pair({
        project: { launchDirectory: directory, repositoryRoot: directory },
        wakePollMs: 20,
      });
      await runtime.sendUserMessage("codex", "Run the long suite.");
      const scheduled = await runtime.callTeamTool("codex", "team_wake", {
        path: "suite/result.json",
        note: "Read the suite result and report to claude.",
        timeout_seconds: 60,
      });
      expect(scheduled).toMatchObject({
        ok: true,
        value: { wake: { id: 1, state: "pending" }, next: expect.stringContaining("End your turn") },
      });
      codex.emit("status", "Codex turn completed");
      await settle();
      const before = codex.inputs.length;
      expect(runtime.hasActiveWork()).toBe(true);

      mkdirSync(join(directory, "suite"));
      writeFileSync(join(directory, "suite", "result.json"), "{}");
      await waitUntil(() => codex.inputs.length === before + 1);
      expect(messageText(codex.inputs.at(-1))).toContain("Wake #1 fired: suite/result.json exists.");
      expect(messageText(codex.inputs.at(-1))).toContain("Your note: Read the suite result and report to claude.");
      expect(runtime.snapshot().wakes?.[0]).toMatchObject({ state: "fired" });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("a wake that could never fire, or would run with Watari's permissions, is refused up front", async () => {
    const builder = new FakeAdapter("builder");
    const reviewer = new FakeAdapter("reviewer");
    const runtime = new CoordinatorRuntime({
      project: { launchDirectory: "/tmp", repositoryRoot: "/tmp" },
      databasePath: ":memory:",
      roster: [
        { alias: "builder", provider: "codex", displayName: "Builder", mode: "managed", unrestricted: true },
        { alias: "reviewer", provider: "claude", displayName: "Reviewer", mode: "managed", unrestricted: false },
      ],
      adapters: { builder, reviewer },
    });
    runtimes.push(runtime);
    await runtime.start();

    expect(await runtime.callTeamTool("reviewer", "team_wake", { command: ["true"], note: "check" }))
      .toMatchObject({ ok: false, error: expect.stringContaining("unrestricted") });
    expect(await runtime.callTeamTool("builder", "team_wake", { pid: 999_999_999, note: "check" }))
      .toMatchObject({ ok: false, error: expect.stringContaining("is not running") });
    expect(await runtime.callTeamTool("builder", "team_wake", { path: ".", note: "check" }))
      .toMatchObject({ ok: false, error: expect.stringContaining("already exists") });
    expect(runtime.hasActiveWork()).toBe(false);
  });

  test("only the bridge Watari launched may speak as a managed peer", async () => {
    const { runtime } = await pair({ bridgeToken: "launch-token" });
    expect(() => runtime.registerBridge("codex", "codex")).toThrow("managed agent");
    expect(() => runtime.registerBridge("codex", "codex", "guessed")).toThrow("managed agent");
    expect(() => runtime.registerBridge("codex", "codex", "launch-token")).not.toThrow();
  });

  test("a finished chat archive keeps every event, not only the live window", async () => {
    const directory = mkdtempSync(join(tmpdir(), "watari-archive-"));
    const chatsDirectory = join(directory, "chats");
    try {
      const { runtime, codex } = await pair({
        project: { launchDirectory: directory, repositoryRoot: directory },
        chatsDirectory,
      });
      await runtime.sendUserMessage("codex", "A long chat.");
      for (let index = 0; index < 450; index += 1) {
        codex.emit("assistant", `line ${index}`, { providerEventId: `message-${index}` });
      }
      await waitUntil(() => runtime.snapshot().events.at(-1)?.summary === "line 449");
      await runtime.newChat();

      const archive = readdirSync(chatsDirectory).find((name) => name.endsWith(".jsonl"));
      const records = readFileSync(join(chatsDirectory, archive ?? ""), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { recordType: string });
      expect(records.filter((record) => record.recordType === "event").length).toBeGreaterThanOrEqual(450);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

/** A started Codex and Claude pair backed by fakes. */
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

/** Fails loudly instead of hanging the suite when a promise never settles. */
async function withDeadline<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`did not settle within ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Waits for something the runtime reaches on its own, without a fixed sleep. */
async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition was not reached in time");
    await Bun.sleep(5);
  }
}

/** Lets the runtime's throttled publish and its delivery promises settle. */
async function settle(): Promise<void> {
  for (let pass = 0; pass < 4; pass += 1) {
    await new Promise((resolve) => setTimeout(resolve, 35));
  }
}

function messageText(input: import("../src/watari/models.ts").AgentInput | undefined): string {
  return input?.kind === "message" ? input.text : "";
}
