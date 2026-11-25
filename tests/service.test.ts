import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RuntimeClient } from "../src/watari/service/client.ts";
import { WatariService } from "../src/watari/service/server.ts";
import type { RuntimeEvent } from "../src/watari/state/types.ts";
import { FakeAdapter } from "./fakes/fake-adapter.ts";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("Watari Unix-socket service", () => {
  test("native questions survive TUI reconnect and transcript eviction, reject stale answers, and expire with the harness", async () => {
    const directory = mkdtempSync(join(tmpdir(), "watari-service-questions-"));
    const socketPath = join(directory, "runtime.sock");
    const codex = new FakeAdapter("codex");
    const claude = new FakeAdapter("claude");
    const service = new WatariService({
      project: { launchDirectory: directory, repositoryRoot: directory },
      databasePath: join(directory, "state.db"), socketPath, idleExitMs: 30,
      adapters: { codex, claude },
    });
    let client: RuntimeClient | null = null;
    cleanups.push(async () => { client?.close(); await service.stop(); rmSync(directory, { recursive: true, force: true }); });
    await service.start();
    client = await RuntimeClient.connect(socketPath);
    await client.attachUi(true);
    await waitUntil(async () => (await client!.refresh()).agents.every((agent) => agent.state === "ready"));
    const question = {
      id: crypto.randomUUID(), agent: "codex", createdAt: Date.now(),
      fields: [{ id: "scope", header: "Scope", question: "private fixture question", options: [], multiSelect: false, allowOther: true, required: true }],
    };
    codex.emit("question", "Waiting for your answer", { providerEventId: question.id, payload: question });
    await waitUntil(async () => (await client!.refresh()).questions?.length === 1);
    for (let i = 0; i < 450; i++) codex.emit("assistant", `fixture output ${i}`);
    await waitUntil(async () => (await client!.refresh()).events.length === 400);
    client.close();
    await delay(80); // A waiting native question keeps its service alive.
    client = await RuntimeClient.connect(socketPath);
    expect((await client.refresh()).questions).toEqual([question]);
    expect(client.snapshot!.events.some((event) => event.providerEventId === question.id)).toBe(false);
    await expect(client.answerQuestion("claude", question.id, { action: "cancel" })).rejects.toThrow("no longer waiting");
    await expect(client.answerQuestion("codex", question.id, { action: "answer", answers: {} })).rejects.toThrow("answer every question");
    expect(codex.inputs).toHaveLength(0);
    await client.answerQuestion("codex", question.id, { action: "answer", answers: { scope: ["private fixture answer"] } });
    expect(codex.inputs).toEqual([{ kind: "question_response", requestId: question.id, response: { action: "answer", answers: { scope: ["private fixture answer"] } } }]);
    expect((await client.refresh()).questions).toEqual([]);
    expect(client.snapshot!.messages).toHaveLength(0);
    await expect(client.answerQuestion("codex", question.id, { action: "cancel" })).rejects.toThrow("no longer waiting");

    const background = { ...question, id: crypto.randomUUID(), blocking: false };
    codex.emit("question", "Nonblocking question", { providerEventId: background.id, payload: background });
    codex.emit("status", "turn completed");
    await waitUntil(async () => (await client!.refresh()).questions?.length === 1);
    expect(client.snapshot!.agents.find((agent) => agent.id === "codex")?.state).toBe("ready");
    client.close();
    await delay(80);
    client = await RuntimeClient.connect(socketPath);
    expect((await client.refresh()).questions).toEqual([background]);
    await client.answerQuestion("codex", background.id, { action: "cancel" });
    expect((await client.refresh()).agents.find((agent) => agent.id === "codex")?.state).toBe("ready");

    const interrupted = { ...question, id: crypto.randomUUID() };
    codex.emit("question", "Waiting", { providerEventId: interrupted.id, payload: interrupted });
    await waitUntil(async () => (await client!.refresh()).questions?.length === 1);
    await client.interrupt("codex");
    expect((await client.refresh()).questions).toEqual([]);
    claude.emit("question", "Waiting", { providerEventId: question.id, payload: { ...question, agent: "claude" } });
    await waitUntil(async () => (await client!.refresh()).questions?.length === 1);
    claude.emit("error", "fixture process died");
    await waitUntil(async () => (await client!.refresh()).questions?.length === 0);
    claude.emit("question", "Late question from failed harness", { providerEventId: question.id, payload: { ...question, agent: "claude" } });
    await delay(10);
    expect((await client.refresh()).questions).toEqual([]);
    expect(client.snapshot!.agents.find((agent) => agent.id === "claude")?.state).toBe("failed");
    await service.stop();
    expect(readFileSync(join(directory, "state.db")).includes(Buffer.from("private fixture answer"))).toBe(false);
    expect(readFileSync(join(directory, "state.db")).includes(Buffer.from("private fixture question"))).toBe(false);
  });

  test("notifies a client once when the service connection closes", async () => {
    const directory = mkdtempSync(join(tmpdir(), "watari-service-close-"));
    const socketPath = join(directory, "runtime.sock");
    const service = new WatariService({
      project: { launchDirectory: directory, repositoryRoot: directory },
      databasePath: join(directory, "state.db"),
      socketPath,
      adapters: { codex: new FakeAdapter("codex"), claude: new FakeAdapter("claude") },
    });
    await service.start();
    const client = await RuntimeClient.connect(socketPath);
    const events: RuntimeEvent[] = [];
    client.subscribe((event) => events.push(event));
    await client.refresh();
    cleanups.push(async () => {
      client.close();
      await service.stop();
      rmSync(directory, { recursive: true, force: true });
    });

    await service.stop();
    await waitUntil(async () => events.some((event) => event.type === "fatal"));

    expect(events.filter((event) => event.type === "fatal")).toEqual([
      { type: "fatal", message: "Watari service connection closed" },
    ]);
    expect(client.snapshot).toBeNull();
  });

  test("exits after the final client leaves and active agent work completes", async () => {
    const directory = mkdtempSync(join(tmpdir(), "watari-service-idle-"));
    const socketPath = join(directory, "runtime.sock");
    const lockPath = join(directory, "runtime.lock");
    const codex = new FakeAdapter("codex");
    const service = new WatariService({
      project: { launchDirectory: directory, repositoryRoot: directory },
      databasePath: join(directory, "state.db"),
      socketPath,
      lockPath,
      idleExitMs: 30,
      adapters: { codex, claude: new FakeAdapter("claude") },
    });
    await service.start();
    cleanups.push(async () => {
      await service.stop();
      rmSync(directory, { recursive: true, force: true });
    });

    const client = await RuntimeClient.connect(socketPath);
    await client.attachUi(true);
    await waitUntil(async () => (await client.refresh()).agents.every((agent) => agent.state === "ready"));
    await client.send("codex", "Finish this work after I detach.");
    client.close();

    let stopped = false;
    void service.stopped.then(() => {
      stopped = true;
    });
    await delay(80);
    expect(stopped).toBe(false);

    codex.emit("status", "turn completed");
    await waitForStop(service);
    expect(existsSync(socketPath)).toBe(false);
    expect(existsSync(lockPath)).toBe(false);
  });

  test("a reconnect during the idle grace keeps the service alive", async () => {
    const directory = mkdtempSync(join(tmpdir(), "watari-service-reconnect-"));
    const socketPath = join(directory, "runtime.sock");
    const service = new WatariService({
      project: { launchDirectory: directory, repositoryRoot: directory },
      databasePath: join(directory, "state.db"),
      socketPath,
      idleExitMs: 60,
      adapters: { codex: new FakeAdapter("codex"), claude: new FakeAdapter("claude") },
    });
    await service.start();
    cleanups.push(async () => {
      await service.stop();
      rmSync(directory, { recursive: true, force: true });
    });

    const first = await RuntimeClient.connect(socketPath);
    await first.attachUi(true);
    first.close();
    await delay(20);

    const reconnected = await RuntimeClient.connect(socketPath);
    await reconnected.attachUi(false);
    let stopped = false;
    void service.stopped.then(() => {
      stopped = true;
    });
    await delay(80);
    expect(stopped).toBe(false);

    reconnected.close();
    await waitForStop(service);
  });

  test("an abruptly closed external MCP socket cannot leave a ghost agent", async () => {
    const directory = mkdtempSync(join(tmpdir(), "watari-service-bridge-exit-"));
    const socketPath = join(directory, "runtime.sock");
    const configPath = join(directory, "agents.json");
    const service = new WatariService({
      project: { launchDirectory: directory, repositoryRoot: directory },
      databasePath: join(directory, "state.db"),
      configPath,
      socketPath,
      idleExitMs: 30,
      adapters: { codex: new FakeAdapter("codex"), claude: new FakeAdapter("claude") },
    });
    await service.start();
    cleanups.push(async () => {
      await service.stop();
      rmSync(directory, { recursive: true, force: true });
    });

    const bridge = await RuntimeClient.connect(socketPath);
    await bridge.configureAgent({
      alias: "future",
      provider: "opencode",
      displayName: "Future",
      mode: "external",
      unrestricted: true,
    });
    await bridge.registerBridge("future", "opencode");
    expect((await bridge.refresh()).agents.find((agent) => agent.id === "future")?.state).toBe("waiting");

    // Simulate a killed provider: no graceful bridge_disconnected request.
    bridge.close();
    await waitForStop(service);
  });

  test("an idle managed MCP relay is plumbing, not a service keepalive", async () => {
    const directory = mkdtempSync(join(tmpdir(), "watari-service-managed-relay-"));
    const socketPath = join(directory, "runtime.sock");
    const service = new WatariService({
      project: { launchDirectory: directory, repositoryRoot: directory },
      databasePath: join(directory, "state.db"),
      socketPath,
      idleExitMs: 30,
      bridgeToken: "managed-relay-token",
      adapters: { codex: new FakeAdapter("codex"), claude: new FakeAdapter("claude") },
    });
    await service.start();
    const bridge = await RuntimeClient.connect(socketPath);
    cleanups.push(async () => {
      bridge.close();
      await service.stop();
      rmSync(directory, { recursive: true, force: true });
    });

    await bridge.registerBridge("codex", "codex", "managed-relay-token");
    await waitForStop(service);
    expect(existsSync(socketPath)).toBe(false);
  });

  test("a provider launched outside Watari cannot take a managed peer's identity", async () => {
    const directory = mkdtempSync(join(tmpdir(), "watari-service-managed-alias-"));
    const socketPath = join(directory, "runtime.sock");
    const service = new WatariService({
      project: { launchDirectory: directory, repositoryRoot: directory },
      databasePath: join(directory, "state.db"),
      socketPath,
      bridgeToken: "launched-by-watari",
      adapters: { codex: new FakeAdapter("codex"), claude: new FakeAdapter("claude") },
    });
    await service.start();
    const bridge = await RuntimeClient.connect(socketPath);
    cleanups.push(async () => {
      bridge.close();
      await service.stop();
      rmSync(directory, { recursive: true, force: true });
    });

    await expect(bridge.registerBridge("codex", "codex")).rejects.toThrow("managed agent");
    await expect(bridge.registerBridge("codex", "codex", "guessed")).rejects.toThrow("managed agent");
  });

  test("a team bridge is not sent the team's event stream", async () => {
    const directory = mkdtempSync(join(tmpdir(), "watari-service-bridge-quiet-"));
    const socketPath = join(directory, "runtime.sock");
    const service = new WatariService({
      project: { launchDirectory: directory, repositoryRoot: directory },
      databasePath: join(directory, "state.db"),
      socketPath,
      bridgeToken: "quiet-token",
      adapters: { codex: new FakeAdapter("codex"), claude: new FakeAdapter("claude") },
    });
    await service.start();
    const bridge = await RuntimeClient.connect(socketPath);
    const ui = await RuntimeClient.connect(socketPath);
    cleanups.push(async () => {
      bridge.close();
      ui.close();
      await service.stop();
      rmSync(directory, { recursive: true, force: true });
    });
    await bridge.registerBridge("codex", "codex", "quiet-token");
    const bridgeEvents: RuntimeEvent[] = [];
    const uiEvents: RuntimeEvent[] = [];
    bridge.subscribe((event) => bridgeEvents.push(event));
    ui.subscribe((event) => uiEvents.push(event));
    bridgeEvents.length = 0;
    uiEvents.length = 0;

    await ui.newChat();
    await waitUntil(async () => uiEvents.some((event) => event.type === "state_changed"));
    expect(bridgeEvents.filter((event) => event.type === "state_changed")).toEqual([]);
    expect((await bridge.callTeamTool("codex", "team_roster", {})).ok).toBe(true);
  });

  test("reconfigures an external agent live and derives presence from its MCP connection", async () => {
    const directory = mkdtempSync(join(tmpdir(), "watari-service-config-"));
    const socketPath = join(directory, "runtime.sock");
    const configPath = join(directory, "agents.json");
    const taskPolicy = {
      classes: { execute: { agents: ["reviewer", "claude"] } },
      agents: { reviewer: { role: "Runner", guidance: "Report bounded command results." } },
    };
    writeFileSync(configPath, JSON.stringify({ schemaVersion: 1, agents: [{ alias: "codex" }, { alias: "claude" }], taskPolicy }));
    const service = new WatariService({
      project: { launchDirectory: directory, repositoryRoot: directory },
      databasePath: join(directory, "state.db"),
      configPath,
      socketPath,
      adapters: { codex: new FakeAdapter("codex"), claude: new FakeAdapter("claude") },
    });
    await service.start();
    const client = await RuntimeClient.connect(socketPath);
    cleanups.push(async () => {
      client.close();
      await service.stop();
      rmSync(directory, { recursive: true, force: true });
    });

    expect(await client.callTeamTool("codex", "team_roster", {})).toMatchObject({ ok: true, value: { task_policy: taskPolicy } });

    const reviewer = { alias: "reviewer", provider: "opencode", displayName: "Reviewer", mode: "external" } as const;
    await client.configureAgent(reviewer);
    expect((await client.refresh()).agents.find((agent) => agent.id === "reviewer")).toMatchObject({
      state: "stopped",
      provider: "opencode",
      unrestricted: false,
    });
    await client.configureAgent({ ...reviewer, unrestricted: true });
    await client.configureAgent({ ...reviewer, displayName: "Code reviewer" });
    expect((await client.refresh()).agents.find((agent) => agent.id === "reviewer")).toMatchObject({
      displayName: "Code reviewer",
      unrestricted: true,
    });
    await client.configureAgent({ ...reviewer, unrestricted: false });
    await client.configureAgent(reviewer);
    expect((await client.refresh()).agents.find((agent) => agent.id === "reviewer")?.unrestricted).toBe(false);
    await client.registerBridge("reviewer", "opencode");
    expect((await client.refresh()).agents.find((agent) => agent.id === "reviewer")?.state).toBe("waiting");
    expect(JSON.parse(readFileSync(configPath, "utf8")).agents).toContainEqual(expect.objectContaining({ alias: "reviewer" }));
    expect(JSON.parse(readFileSync(configPath, "utf8")).taskPolicy).toEqual(taskPolicy);
    await client.unregisterBridge("reviewer");
    await client.removeAgent("reviewer");
    expect(JSON.parse(readFileSync(configPath, "utf8")).taskPolicy).toEqual(taskPolicy);
  });

  test("serves durable snapshots and user commands without provider stdio", async () => {
    const directory = mkdtempSync(join(tmpdir(), "watari-service-test-"));
    const socketPath = join(directory, "runtime.sock");
    const codex = new FakeAdapter("codex");
    const claude = new FakeAdapter("claude");
    codex.modelOptions = [{
      id: "gpt-service",
      displayName: "GPT Service",
      description: "native service catalog",
      efforts: ["low", "provider-next"],
    }];
    const service = new WatariService({
      project: { launchDirectory: directory, repositoryRoot: directory },
      databasePath: join(directory, "state.db"),
      socketPath,
      lockPath: join(directory, "runtime.lock"),
      adapters: { codex, claude },
    });
    await service.start();
    const client = await RuntimeClient.connect(socketPath);
    const secondClient = await RuntimeClient.connect(socketPath);
    await client.attachUi(true);
    cleanups.push(async () => {
      client.close();
      secondClient.close();
      await service.stop();
      rmSync(directory, { recursive: true, force: true });
    });

    const contender = new WatariService({
      project: { launchDirectory: directory, repositoryRoot: directory },
      databasePath: join(directory, "state.db"),
      socketPath,
      lockPath: join(directory, "runtime.lock"),
      adapters: { codex: new FakeAdapter("codex"), claude: new FakeAdapter("claude") },
    });
    await expect(contender.start()).rejects.toThrow("already running");
    await contender.stop();

    await waitUntil(async () => (await client.refresh()).agents.every((agent) => agent.state === "ready"));
    const info = await secondClient.info();
    expect(info.connectedClients).toBe(2);
    expect(info.bridges).toEqual({
      codex: "identity-bound stdio MCP",
      claude: "identity-bound stdio MCP",
    });
    expect(await client.availableProviderModels("codex")).toEqual(codex.modelOptions);
    await client.send("all", "Build the first usable TUI.");
    const snapshot = await client.refresh();

    expect(snapshot.activeGoal?.instruction).toBe("Build the first usable TUI.");
    expect(codex.inputs).toHaveLength(1);
    expect(claude.inputs).toHaveLength(1);
    expect((await secondClient.refresh()).activeGoal?.instruction).toBe("Build the first usable TUI.");

    const sent = await secondClient.callTeamTool("codex", "team_send", {
      to: "claude",
      message: "Review the active goal.",
    });
    expect(sent.ok).toBe(true);
    const coordinated = await secondClient.refresh();
    expect(coordinated.messages.at(-1)).toMatchObject({
      sender: "codex",
      recipients: ["claude"],
      body: "Review the active goal.",
    });

    const futureAlias = await secondClient.callTeamTool("opencode", "team_roster", {});
    expect(futureAlias).toEqual({
      ok: false,
      error: "Watari agent alias is not registered in this project: opencode",
    });

    client.close();
    await waitUntil(async () => (await secondClient.info()).connectedClients === 1);
    // Reopening while peers are still working rejoins their chat rather than
    // archiving it and resetting every harness mid-turn.
    const rejoined = await RuntimeClient.connect(socketPath);
    expect(await rejoined.attachUi(true)).toEqual({ keptRunningChat: true });
    expect((await rejoined.refresh()).activeGoal?.instruction).toBe("Build the first usable TUI.");
    rejoined.close();
    await waitUntil(async () => (await secondClient.info()).connectedClients === 1);

    // Once every turn has ended, the next open still continues the chat. Only
    // /new starts another.
    await waitUntil(async () => {
      const agents = (await secondClient.refresh()).agents;
      for (const agent of agents) {
        if (agent.state === "busy") {
          (agent.id === "codex" ? codex : claude).emit("status", "turn completed", { rawType: "turn/completed" });
        }
      }
      return agents.every((agent) => agent.state === "ready");
    });
    const reopened = await RuntimeClient.connect(socketPath);
    expect(await reopened.attachUi(true)).toEqual({ keptRunningChat: true });
    expect((await reopened.refresh()).activeGoal?.instruction).toBe("Build the first usable TUI.");
    reopened.close();
  });
});

async function waitUntil(condition: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!(await condition())) {
    if (Date.now() >= deadline) {
      throw new Error("condition timed out");
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForStop(service: WatariService): Promise<void> {
  await Promise.race([
    service.stopped,
    delay(2_000).then(() => {
      throw new Error("service did not stop while idle");
    }),
  ]);
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

describe("chat management over the socket", () => {
  test("save, list, export, clear, and resume travel through the service API", async () => {
    const directory = mkdtempSync(join(tmpdir(), "watari-service-chats-"));
    const socketPath = join(directory, "runtime.sock");
    const codex = new FakeAdapter("codex");
    const service = new WatariService({
      project: { launchDirectory: directory, repositoryRoot: directory },
      databasePath: join(directory, "state.db"),
      chatsDirectory: join(directory, "chats"),
      socketPath,
      idleExitMs: false,
      adapters: { codex, claude: new FakeAdapter("claude") },
    });
    await service.start();
    const client = await RuntimeClient.connect(socketPath);
    cleanups.push(async () => {
      client.close();
      await service.stop();
      rmSync(directory, { recursive: true, force: true });
    });
    await waitUntil(async () => (await client.refresh()).agents.every((agent) => agent.state === "ready"));
    await client.send("codex", "Socket chat one.");

    const saved = await client.saveChat();
    expect(existsSync(saved.path)).toBe(true);
    const [first] = await client.listChats();
    expect(first).toMatchObject({ title: "Socket chat one.", current: true });

    const exported = await client.exportChat({ handoff: false, path: "out.md" });
    expect(readFileSync(exported.path, "utf8")).toContain("Socket chat one.");

    await client.clearAgent("codex");
    expect(codex.resets).toBe(1);

    await client.newChat();
    await client.send("claude", "Socket chat two.");
    const resumed = await client.resumeChat(first!.id);
    expect(resumed.title).toBe("Socket chat one.");
    expect((await client.refresh()).activeGoal?.instruction).toBe("Socket chat one.");
  });
});
