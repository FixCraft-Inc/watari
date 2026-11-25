import { expect, test, describe } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testRender } from "@opentui/solid";

import { WatariApp } from "../src/watari/tui/app.tsx";
import { plainSelection } from "../src/watari/tui/transcript.ts";
import { hasTrueColor, selectTheme } from "../src/watari/tui/theme.ts";
import type { RuntimeEvent, TeamAgent, TeamSnapshot } from "../src/watari/state/types.ts";
import type { AgentDefinitionUpdate, SupportedProviderId } from "../src/watari/team/roster.ts";
import { SUPPORTED_PROVIDERS } from "../src/watari/team/roster.ts";
import { chatClientDefaults } from "./fakes/ui-client.ts";

const idle: TeamSnapshot = {
  schemaVersion: 2,
  agents: [
    {
      id: "codex",
      backend: "codex-app-server",
      displayName: "Codex",
      sessionId: null,
      state: "ready",
      currentGoalId: null,
      updatedAt: 1,
      detail: "native harness ready",
    },
    {
      id: "claude",
      backend: "claude-agent-sdk",
      displayName: "Claude",
      sessionId: null,
      state: "ready",
      currentGoalId: null,
      updatedAt: 1,
      detail: "native harness ready",
    },
  ],
  activeGoal: null,
  messages: [],
  claims: [],
  findings: [],
  events: [],
  activities: [],
};

const working: TeamSnapshot = {
  ...idle,
  agents: [
    { ...idle.agents[0]!, state: "busy", detail: "editing src/watari/service/runtime.ts" },
    { ...idle.agents[1]!, state: "waiting", detail: "awaiting approval for bash" },
  ],
  activeGoal: {
    id: "goal-6f2c19aa",
    instruction: "harden the delivery queue so urgent peer messages survive a disconnect",
    origin: "user",
    initialAddressee: null,
    state: "active",
    createdAt: 1,
    updatedAt: 9,
  },
  messages: [
    {
      id: 1,
      goalId: "goal-6f2c19aa",
      sender: "codex",
      recipients: ["claude"],
      kind: "peer",
      priority: "normal",
      priorityReason: null,
      body: "taking runtime.ts, please cover the store schema so we do not collide",
      createdAt: 2,
    },
  ],
  claims: [
    {
      id: "clm-1",
      goalId: "goal-6f2c19aa",
      claimant: "codex",
      summary: "delivery queue scheduling",
      paths: ["src/watari/service/runtime.ts"],
      state: "active",
      note: null,
      createdAt: 3,
      updatedAt: 3,
    },
  ],
  findings: [
    {
      id: "fnd-1",
      author: "claude",
      target: "codex",
      scope: "src/watari/service/runtime.ts",
      severity: "high",
      summary: "acknowledgement row is dropped on disconnect",
      evidence: null,
      disposition: "open",
      createdAt: 4,
      updatedAt: 4,
    },
  ],
  events: [
    {
      id: 1,
      agent: "codex",
      type: "approval",
      summary: "bash: bun test tests/store.test.ts",
      providerEventId: "req_7731",
      createdAt: 5,
    },
  ],
};

function clientFor(snapshot: TeamSnapshot) {
  return {
    ...chatClientDefaults,
    snapshot,
    subscribe(_listener: (event: RuntimeEvent) => void) {
      return () => undefined;
    },
    async send() {},
    async interrupt() {},
    async approve() {},
    async checkBridges() {
      return [];
    },
    async configureAgent() {},
    async removeAgent() {},
    async availableModels() {
      return [];
    },
    async availableProviderModels() {
      return [];
    },
    async getActivityDetail() {
      return null;
    },
    async completeGoal() {},
    async restartAgent() {},
    async newChat() {},
    async shutdown() {},
  };
}

async function appWith(snapshot: TeamSnapshot, width: number, height: number) {
  return testRender(
    () => (
      <WatariApp
        client={clientFor(snapshot)}
        project={{ launchDirectory: "/work/watari", repositoryRoot: "/work/watari" }}
        stateDirectory="/state/watari"
      />
    ),
    { width, height },
  );
}

async function frameOf(snapshot: TeamSnapshot, width: number, height: number): Promise<string> {
  const setup = await testRender(
    () => (
      <WatariApp
        client={clientFor(snapshot)}
        project={{ launchDirectory: "/work/watari", repositoryRoot: "/work/watari" }}
        stateDirectory="/state/watari"
      />
    ),
    { width, height },
  );
  await setup.renderOnce();
  await setup.renderOnce();
  const frame = setup.captureCharFrame();
  setup.renderer.destroy();
  return frame;
}

describe("side panel team coordination", () => {
  test("shows a focused peer's reason, a sleeping peer's wake, and the shared TODO list", async () => {
    const now = Date.now();
    const snapshot: TeamSnapshot = {
      ...idle,
      agents: [
        {
          ...idle.agents[0]!,
          availability: "dnd",
          availabilityReason: "applying the migration",
          availabilityUntil: now + 10 * 60_000,
        },
        { ...idle.agents[1]!, detail: "Claude turn completed: success" },
      ],
      wakes: [{
        id: 1,
        agent: "claude",
        condition: { kind: "path", path: "suite/result.json" },
        note: "read the suite result",
        state: "pending",
        createdAt: now,
        deadlineAt: now + 60 * 60_000,
        settledAt: null,
        outcome: null,
      }],
      todos: [{
        id: 1,
        goalId: null,
        title: "Port the steer fallback",
        detail: null,
        author: "codex",
        assignee: "claude",
        paths: [],
        state: "doing",
        note: null,
        createdAt: now,
        updatedAt: now,
      }],
    };
    const frame = await frameOf(snapshot, 130, 40);
    expect(frame).toContain("dnd: applying the");
    expect(frame).toContain("sleeping until");
    expect(frame).toContain("#1 Port the steer");
  });
});

describe("watari ui", () => {
  test("questions on another tab open with ctrl+q, require input, and return the answer without sending a chat message", async () => {
    const stateDirectory = mkdtempSync(join(tmpdir(), "watari-tui-questions-"));
    const question = {
      id: crypto.randomUUID(), agent: "claude", createdAt: 1,
      fields: [{ id: "scope", header: "Scope", question: "What should be reviewed?", options: [{ label: "Core", description: "Core only" }, { label: "All", description: "Everything" }], multiSelect: false, allowOther: true, required: true }],
    };
    const answered: unknown[] = [];
    const sent: unknown[] = [];
    const setup = await testRender(() => <WatariApp client={{ ...chatClientDefaults, ...clientFor({ ...idle, questions: [question] }),
      async answerQuestion(...args) { answered.push(args); }, async send(...args) { sent.push(args); },
    }} project={{ launchDirectory: "/work/watari", repositoryRoot: "/work/watari" }} stateDirectory={stateDirectory} />, { width: 100, height: 26 });
    try {
      await setup.waitForFrame((frame) => frame.includes("question(s) waiting from claude"));
      await setup.mockInput.typeText("keep this draft");
      setup.mockInput.pressKey("q", { ctrl: true });
      await setup.waitForFrame((frame) => frame.includes("What should be reviewed?"));
      setup.mockInput.pressEnter();
      await setup.waitForFrame((frame) => frame.includes("Enter an answer first"));
      expect(answered).toHaveLength(0);
      await setup.mockInput.typeText("2");
      setup.mockInput.pressEnter();
      await setup.waitFor(() => answered.length === 1);
      expect(answered).toEqual([["claude", question.id, { action: "answer", answers: { scope: ["All"] } }]]);
      setup.mockInput.pressEscape();
      await setup.waitForFrame((frame) => frame.includes("keep this draft"));
      expect(sent).toHaveLength(0);
      expect(existsSync(join(stateDirectory, "composer-history.json"))).toBe(false);
    } finally { setup.renderer.destroy(); rmSync(stateDirectory, { recursive: true, force: true }); }
  });

  test("the question panel preserves partial answers across escape, supports multiple fields and cancelling another request", async () => {
    const first = {
      id: crypto.randomUUID(), agent: "codex", createdAt: 1,
      fields: [
        { id: "scope", header: "Scope", question: "Select review scopes", options: [{ label: "Core", description: "" }, { label: "Tests", description: "" }], multiSelect: true, allowOther: true, required: true },
        { id: "note", header: "Note", question: "Any instructions?", options: [], multiSelect: false, allowOther: true, required: true },
      ],
    };
    const second = { ...first, id: crypto.randomUUID(), agent: "claude", fields: [first.fields[0]!] };
    const answered: unknown[] = [];
    const setup = await testRender(() => <WatariApp client={{ ...chatClientDefaults, ...clientFor({ ...idle, questions: [first, second] }),
      async answerQuestion(...args) { answered.push(args); },
    }} project={{ launchDirectory: "/work/watari", repositoryRoot: "/work/watari" }} stateDirectory="/state/watari" />, { width: 62, height: 18 });
    try {
      await setup.waitForFrame((frame) => frame.includes("question(s) waiting"));
      await setup.mockInput.typeText("/questions");
      await setup.waitForFrame((frame) => frame.includes("/questions"));
      setup.mockInput.pressEnter();
      await setup.waitForFrame((frame) => frame.includes("Select review scopes"));
      await setup.mockInput.typeText("1,2");
      setup.mockInput.pressEnter();
      await setup.waitForFrame((frame) => frame.includes("Any instructions?"));
      await setup.mockInput.typeText("Review only");
      setup.mockInput.pressEscape();
      await setup.waitForFrame((frame) => !frame.includes("Any instructions?"));
      setup.mockInput.pressKey("q", { ctrl: true });
      await setup.waitForFrame((frame) => frame.includes("Review only"));
      setup.mockInput.pressEnter();
      await setup.waitFor(() => answered.length === 1);
      expect(answered[0]).toEqual(["codex", first.id, { action: "answer", answers: { scope: ["Core", "Tests"], note: ["Review only"] } }]);
      setup.mockInput.pressKey("n", { ctrl: true });
      await setup.waitForFrame((frame) => frame.includes("questions · claude"));
      setup.mockInput.pressKey("x", { ctrl: true });
      await setup.waitFor(() => answered.length === 2);
      expect(answered[1]).toEqual(["claude", second.id, { action: "cancel" }]);
    } finally { setup.renderer.destroy(); }
  });

  test("a fatal service event closes the stale UI", async () => {
    const listeners: Array<(event: RuntimeEvent) => void> = [];
    const failures: string[] = [];
    const setup = await testRender(
      () => (
        <WatariApp
          client={{
            ...chatClientDefaults,
            ...clientFor(idle),
            subscribe(callback: (event: RuntimeEvent) => void) {
              listeners.push(callback);
              return () => undefined;
            },
          }}
          project={{ launchDirectory: "/work/watari", repositoryRoot: "/work/watari" }}
          stateDirectory="/state/watari"
          onFatal={(message) => failures.push(message)}
        />
      ),
      { width: 100, height: 24 },
    );
    await setup.renderOnce();

    listeners[0]?.({ type: "fatal", message: "Watari service connection closed" });
    await setup.waitFor(() => failures.length === 1);

    expect(failures).toEqual(["Watari service connection closed"]);
  });

  test("first run names the peers and explains what a message will do", async () => {
    const frame = await frameOf(idle, 100, 24);

    expect(frame).toContain("watari");
    expect(frame).toContain("global");
    expect(frame).toContain("codex");
    expect(frame).toContain("claude");
    expect(frame).toContain("ready");
    expect(frame).toContain("none yet, your next message opens one");
    expect(frame).toContain("start a shared goal with codex");
    expect(frame).toContain("▸ codex");
  });

  test("a long multi-line paste is sent whole, and a failed send gives it back", async () => {
    const sent: { target: string; text: string }[] = [];
    let failNext = true;
    const setup = await testRender(
      () => (
        <WatariApp
          client={{
            ...chatClientDefaults,
            ...clientFor(idle),
            async send(target: string, text: string) {
              if (failNext) {
                failNext = false;
                throw new Error("message not sent; team MCP preflight failed");
              }
              sent.push({ target, text });
            },
          }}
          project={{ launchDirectory: "/work/watari", repositoryRoot: "/work/watari" }}
          stateDirectory="/state/watari"
        />
      ),
      { width: 100, height: 26 },
    );
    const prompt = Array.from({ length: 90 }, (_value, index) =>
      `Line ${index + 1}: review the native tree with evidence and keep the docs in line.`
    ).join("\n");
    expect(prompt.length).toBeGreaterThan(6_000);

    await setup.mockInput.typeText("/all ");
    await setup.mockInput.pasteBracketedText(prompt);
    await setup.waitForFrame((frame) => frame.includes("[pasted #1: 90 lines]"));
    setup.mockInput.pressEnter();
    await setup.waitForFrame((frame) => frame.includes("preflight failed"));
    // The text came back, marker and all, so nothing was lost.
    await setup.waitForFrame((frame) => frame.includes("/all [pasted #1: 90 lines]"));

    setup.mockInput.pressEnter();
    await setup.waitFor(() => sent.length === 1);
    expect(sent[0]).toEqual({ target: "all", text: prompt });
  });

  test("models guides provider, native model, native effort, and alias without a command", async () => {
    const configured: AgentDefinitionUpdate[] = [];
    const providers: SupportedProviderId[] = [];
    const setup = await testRender(
      () => (
        <WatariApp
          client={{
            ...chatClientDefaults,
            ...clientFor(idle),
            async availableProviderModels(provider: SupportedProviderId) {
              providers.push(provider);
              return [{
                id: "api-model",
                displayName: "API Model",
                description: "returned by native discovery",
                efforts: ["api-effort"],
              }];
            },
            async configureAgent(definition: AgentDefinitionUpdate) {
              configured.push(definition);
            },
          }}
          project={{ launchDirectory: "/work/watari", repositoryRoot: "/work/watari" }}
          stateDirectory="/state/watari"
        />
      ),
      { width: 100, height: 26 },
    );

    await setup.mockInput.typeText("/models");
    setup.mockInput.pressEnter();
    await setup.waitForFrame((frame) => frame.includes("add agent · provider"));
    setup.mockInput.pressEnter();
    await setup.waitForFrame((frame) => frame.includes("new agent · codex model"));
    setup.mockInput.pressArrow("down");
    setup.mockInput.pressEnter();
    await setup.waitForFrame((frame) => frame.includes("API Model · effort"));
    setup.mockInput.pressArrow("down");
    setup.mockInput.pressEnter();
    await setup.waitForFrame((frame) => frame.includes("new agent · name"));
    setup.mockInput.pressEnter();
    await setup.waitFor(() => configured.length === 1);

    expect(providers).toEqual(["codex"]);
    expect(configured[0]).toMatchObject({
      alias: "codex-2",
      provider: "codex",
      model: "api-model",
      effort: "api-effort",
      mode: "managed",
    });
    expect(configured[0]).not.toHaveProperty("unrestricted");
    setup.renderer.destroy();
  });

  test("slash opens a described command palette and tab completes the selection", async () => {
    const setup = await testRender(
      () => (
        <WatariApp
          client={clientFor(idle)}
          project={{ launchDirectory: "/work/watari", repositoryRoot: "/work/watari" }}
          stateDirectory="/state/watari"
        />
      ),
      { width: 100, height: 28 },
    );

    await setup.mockInput.typeText("/eff");
    await setup.waitForFrame((frame) => frame.includes("commands") && frame.includes("choose native effort"));
    setup.mockInput.pressTab();
    await setup.waitForFrame((frame) => frame.includes("▸ codex │ /effort"));
    setup.renderer.destroy();
  });

  test("multi-word completion keeps helping through a live model-backed peer choice", async () => {
    const removed: string[] = [];
    const profiled: TeamSnapshot = {
      ...idle,
      agents: [
        { ...idle.agents[0]!, provider: "codex", model: "gpt-5.6-codex" },
        { ...idle.agents[1]!, provider: "claude", model: "claude-sonnet-4-6" },
      ],
    };
    const setup = await testRender(
      () => (
        <WatariApp
          client={{
            ...chatClientDefaults,
            ...clientFor(profiled),
            async removeAgent(agent: string) {
              removed.push(agent);
            },
          }}
          project={{ launchDirectory: "/work/watari", repositoryRoot: "/work/watari" }}
          stateDirectory="/state/watari"
        />
      ),
      { width: 100, height: 28 },
    );

    await setup.mockInput.typeText("/model rem");
    await setup.waitForFrame((frame) => frame.includes("/model remove <peer>"));
    setup.mockInput.pressTab();
    const choices = await setup.waitForFrame(
      (frame) => frame.includes("/model remove codex") && frame.includes("claude-sonnet-4-6"),
    );
    expect(choices).toContain("gpt-5.6-codex");
    setup.mockInput.pressArrow("down");
    setup.mockInput.pressTab();
    await setup.waitForFrame((frame) => frame.includes("▸ codex │ /model remove claude"));
    setup.mockInput.pressEnter();
    await setup.waitFor(() => removed.length === 1);

    expect(removed).toEqual(["claude"]);
    setup.renderer.destroy();
  });

  test("a working team shows the goal, the transcript rail, and standing state", async () => {
    const frame = await frameOf(working, 110, 30);

    expect(frame).toContain("goal  harden the delivery queue");
    expect(frame).toContain("┃ Codex → Claude");
    expect(frame).toContain("working");
    expect(frame).toContain("waiting");
    expect(frame).toContain("claims");
    expect(frame).toContain("findings");
    expect(frame).toContain("delivery queue");
  });

  test("a pending approval shows the exact commands that answer it", async () => {
    const frame = await frameOf(working, 110, 30);

    expect(frame).toContain("approval");
    expect(frame).toContain("/approve codex req_7731");
    expect(frame).toContain("/decline codex req_7731");
  });

  test("the composer is an outlined input with room, and a single ruled row without", async () => {
    const roomy = (await frameOf(working, 100, 30)).split("\n");
    const input = roomy.findIndex((row) => row.includes("▸ codex │"));
    expect(roomy[input - 1]?.trimStart().startsWith("╭")).toBe(true);
    expect(roomy[input]?.trimStart().startsWith("│ ▸ codex")).toBe(true);
    expect(roomy[input + 1]?.trimStart().startsWith("╰")).toBe(true);

    // Below the compact height the frame would cost two conversation rows, and
    // a border left behind on a one-row box draws corners through the input.
    const tight = (await frameOf(working, 100, 20)).split("\n");
    const flat = tight.findIndex((row) => row.includes("▸ codex │"));
    expect(tight[flat]?.startsWith(" ▸ codex │")).toBe(true);
    expect(tight[flat - 1]?.trim()).toMatch(/^─+$/u);
  });

  test("the composer survives a long transcript on a short terminal", async () => {
    const noisy: TeamSnapshot = {
      ...working,
      messages: Array.from({ length: 40 }, (_value, index) => ({
        id: index + 1,
        goalId: "goal-6f2c19aa",
        sender: index % 2 === 0 ? "codex" : "claude",
        recipients: [index % 2 === 0 ? "claude" : "codex"],
        kind: "peer" as const,
        priority: "normal" as const,
        priorityReason: null,
        body: `line ${index} with enough text to wrap across more than a single row of the pane`,
        createdAt: index + 1,
      })),
    };
    const frame = await frameOf(noisy, 80, 20);
    const rows = frame.split("\n").filter((row) => row.trim() !== "");

    // Composer, then the status line that reports what just happened.
    expect(rows.at(-2) ?? "").toContain("▸ codex");
    expect(rows.at(-1) ?? "").toContain("ctrl+g help");
    expect(frame).toContain("watari");
  });

  test("a crowded side panel trims entries instead of drawing over itself", async () => {
    const crowded: TeamSnapshot = {
      ...working,
      claims: Array.from({ length: 6 }, (_value, index) => ({
        ...working.claims[0]!,
        id: `clm-${index}`,
        summary: `claim ${index}`,
      })),
      findings: Array.from({ length: 6 }, (_value, index) => ({
        ...working.findings[0]!,
        id: `fnd-${index}`,
        summary: `finding ${index}`,
      })),
    };
    const frame = await frameOf(crowded, 104, 22);

    expect(frame).toContain("peers");
    expect(frame).toContain("editing src/watari/service");
    expect(frame).toContain("awaiting approval for bash");
    expect(frame.split("peers")).toHaveLength(2);
  });

  test("the side panel is dropped rather than squeezed on a narrow terminal", async () => {
    const wide = await frameOf(working, 110, 30);
    const narrow = await frameOf(working, 78, 30);

    expect(wide).toContain("peers");
    expect(narrow).not.toContain("peers");
    for (const row of narrow.split("\n")) {
      expect(row.length).toBeLessThanOrEqual(78);
    }
  });
  test("the provider picker offers every harness Watari can launch", async () => {
    const setup = await appWith(idle, 100, 26);

    await setup.mockInput.typeText("/models");
    setup.mockInput.pressEnter();
    const frame = await setup.waitForFrame((rendered: string) => rendered.includes("add agent · provider"));

    for (const provider of SUPPORTED_PROVIDERS) {
      expect(frame.toLowerCase()).toContain(provider);
    }
    setup.renderer.destroy();
  });

  test("a dragged selection copies the words, not the rail Watari drew", async () => {
    const talking: TeamSnapshot = {
      ...working,
      events: [],
      messages: [{
        id: 1,
        goalId: "goal-6f2c19aa",
        sender: "claude",
        recipients: ["codex"],
        kind: "peer",
        priority: "normal",
        priorityReason: null,
        body: "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi",
        createdAt: 2,
      }],
    };
    const setup = await appWith(talking, 60, 20);
    await setup.renderOnce();

    // Rows 5 and 6 are the two wrapped body lines under the message header.
    await setup.mockMouse.drag(1, 5, 58, 6);
    await setup.renderOnce();
    const raw = setup.renderer.getSelection()?.getSelectedText() ?? "";

    expect(raw).toContain("┃");
    expect(plainSelection(raw)).toBe("alpha beta gamma delta epsilon zeta eta theta iota\nkappa lambda mu nu xi");
    setup.renderer.destroy();
  });

  test("a wide roster keeps the focused chat on screen instead of running off it", async () => {
    const many: TeamSnapshot = {
      ...working,
      agents: Array.from({ length: 7 }, (_value, index) => ({
        ...(working.agents[0] as TeamAgent),
        id: `reviewer-${index}`,
        displayName: `Reviewer ${index}`,
        provider: "claude",
        backend: "claude-agent-sdk",
        state: "ready" as const,
      })),
    };
    const setup = await appWith(many, 70, 24);
    await setup.renderOnce();
    // Walk from the first agent tab to the last; it has to be visible once it
    // is focused, however many chats are in front of it.
    for (let step = 0; step < 6; step += 1) setup.mockInput.pressArrow("right");
    const frame = await setup.waitForFrame((rendered: string) => rendered.includes("reviewer-6"));

    expect(frame).toContain("‹");
    for (const row of frame.split("\n")) {
      expect(row.length).toBeLessThanOrEqual(70);
    }
    setup.renderer.destroy();
  });

  test("clicking a tab switches the conversation target", async () => {
    const talking: TeamSnapshot = {
      ...working,
      messages: [
        { id: 1, goalId: "goal-6f2c19aa", sender: "codex", recipients: ["codex"], kind: "peer", priority: "normal", priorityReason: null, body: "codex-only reply", createdAt: 2 },
        { id: 2, goalId: "goal-6f2c19aa", sender: "claude", recipients: ["claude"], kind: "peer", priority: "normal", priorityReason: null, body: "claude-only reply", createdAt: 3 },
      ],
      events: [],
    };
    const setup = await appWith(talking, 100, 24);
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("codex-only reply");
    const tabRow = setup.captureCharFrame().split("\n")[1] ?? "";
    const claudeX = tabRow.indexOf("claude");
    expect(claudeX).toBeGreaterThanOrEqual(0);
    await setup.mockMouse.click(claudeX, 1);
    const frame = await setup.waitForFrame((rendered) => rendered.includes("claude-only reply"));
    expect(frame).not.toContain("codex-only reply");
    expect(setup.renderer.hasSelection).toBe(false);
    setup.renderer.destroy();
  });

  test("the header counts the peers it has no room to name", async () => {
    const many: TeamSnapshot = {
      ...working,
      agents: Array.from({ length: 6 }, (_value, index) => ({
        ...(working.agents[index % 2] as TeamAgent),
        id: `peer-${index}`,
        displayName: `Peer ${index}`,
      })),
    };
    const wide = await frameOf(many, 160, 24);
    const narrow = await frameOf(many, 80, 24);

    expect(wide).toContain("peer-0 working");
    expect(narrow).toContain("6 peers");
    expect(narrow).toContain("3 working");
  });

  test("identity colour comes from the provider, so an alias is not a new colour", async () => {
    // The test terminal advertises no truecolor, so the palette under test is
    // whichever one the app itself would pick here.
    const theme = selectTheme("dark", hasTrueColor(process.env));
    const aliased: TeamSnapshot = {
      ...working,
      messages: [{
        id: 1,
        goalId: "goal-6f2c19aa",
        sender: "reviewer",
        recipients: ["codex"],
        kind: "peer",
        priority: "normal",
        priorityReason: null,
        body: "claiming the store schema",
        createdAt: 2,
      }],
      events: [],
      agents: [
        working.agents[0] as TeamAgent,
        { ...(working.agents[1] as TeamAgent), id: "reviewer", displayName: "Reviewer", provider: "claude", state: "ready" },
      ],
    };
    const setup = await appWith(aliased, 100, 30);
    await setup.renderOnce();
    const frame = setup.captureSpans();
    const hex = (span: { fg: { r: number; g: number; b: number } }): string =>
      `#${[span.fg.r, span.fg.g, span.fg.b].map((channel) => Math.round(channel * 255).toString(16).padStart(2, "0")).join("")}`;
    const name = frame.lines
      .flatMap((line) => line.spans)
      .find((span) => span.text.trim() === "Reviewer");

    expect(name).toBeDefined();
    expect(hex(name!)).toBe(theme.claude);
    setup.renderer.destroy();
  });

  test("a project with no agents yet says so instead of drawing an empty team", async () => {
    const frame = await frameOf({ ...idle, agents: [] }, 100, 24);

    expect(frame).toContain("no agents yet");
    expect(frame).toContain("ctrl+p");
    expect(frame).toContain("no agent is configured yet");
  });

  test("a harness that serves other people's models is separated by provider, then searched", async () => {
    const catalog = [
      { id: "anthropic/claude-sonnet-4-5", displayName: "Claude Sonnet 4.5", description: "served by anthropic", efforts: ["low", "high"] },
      { id: "anthropic/claude-opus-4-1", displayName: "Claude Opus 4.1", description: "served by anthropic", efforts: [] },
      { id: "openai/gpt-5", displayName: "GPT-5", description: "served by openai", efforts: [] },
      { id: "qwen/qwen3-coder", displayName: "Qwen3 Coder", description: "served by qwen", efforts: [] },
    ];
    const configured: AgentDefinitionUpdate[] = [];
    const setup = await testRender(
      () => (
        <WatariApp
          client={{
            ...chatClientDefaults,
            ...clientFor(idle),
            async availableProviderModels(provider: SupportedProviderId) {
              return provider === "opencode" ? catalog : [];
            },
            async configureAgent(definition: AgentDefinitionUpdate) {
              configured.push(definition);
            },
          }}
          project={{ launchDirectory: "/work/watari", repositoryRoot: "/work/watari" }}
          stateDirectory="/state/watari"
        />
      ),
      { width: 100, height: 30 },
    );

    await setup.mockInput.typeText("/models");
    setup.mockInput.pressEnter();
    await setup.waitForFrame((frame) => frame.includes("add agent · provider"));
    // Codex, Claude, OpenCode: the third harness in the list.
    setup.mockInput.pressArrow("down");
    setup.mockInput.pressArrow("down");
    setup.mockInput.pressEnter();

    const vendors = await setup.waitForFrame((frame) => frame.includes("model provider"));
    expect(vendors).toContain("All providers");
    expect(vendors).toContain("anthropic");
    expect(vendors).toContain("qwen");
    expect(vendors).toContain("2 models");

    // "All providers" is the search over everything.
    setup.mockInput.pressEnter();
    await setup.waitForFrame((frame) => frame.includes("search"));
    await setup.mockInput.typeText("qwen3");
    const searched = await setup.waitForFrame((frame) => frame.includes("1 of 4 models"));
    expect(searched).toContain("Qwen3 Coder");
    expect(searched).not.toContain("Claude Opus");

    setup.mockInput.pressEnter();
    await setup.waitForFrame((frame) => frame.includes("effort"));
    setup.mockInput.pressEnter();
    await setup.waitForFrame((frame) => frame.includes("new agent · name"));
    setup.mockInput.pressEnter();
    await setup.waitFor(() => configured.length === 1);

    expect(configured[0]).toMatchObject({
      alias: "opencode",
      provider: "opencode",
      model: "qwen/qwen3-coder",
      mode: "managed",
    });
    setup.renderer.destroy();
  });

  test("an OpenCode agent keeps OpenCode's identity, tinted by the model's vendor", async () => {
    const theme = selectTheme("dark", hasTrueColor(process.env));
    const viaOpenCode: TeamSnapshot = {
      ...working,
      events: [],
      messages: [
        { id: 1, goalId: "goal-6f2c19aa", sender: "oc-claude", recipients: ["codex"], kind: "peer", priority: "normal", priorityReason: null, body: "reading the queue", createdAt: 2 },
        { id: 2, goalId: "goal-6f2c19aa", sender: "oc-plain", recipients: ["codex"], kind: "peer", priority: "normal", priorityReason: null, body: "reading the store", createdAt: 3 },
      ],
      agents: [
        working.agents[0] as TeamAgent,
        { ...(working.agents[1] as TeamAgent), id: "oc-claude", displayName: "OcClaude", provider: "opencode", backend: "opencode-acp", model: "anthropic/claude-sonnet-4-5", state: "ready" },
        { ...(working.agents[1] as TeamAgent), id: "oc-plain", displayName: "OcPlain", provider: "opencode", backend: "opencode-acp", model: "google/gemini-2.5-pro", state: "ready" },
      ],
    };
    const setup = await appWith(viaOpenCode, 100, 32);
    await setup.renderOnce();
    const hex = (span: { fg: { r: number; g: number; b: number } }): string =>
      `#${[span.fg.r, span.fg.g, span.fg.b].map((channel) => Math.round(channel * 255).toString(16).padStart(2, "0")).join("")}`;
    const spans = setup.captureSpans().lines.flatMap((line) => line.spans);
    const named = (name: string) => spans.find((span) => span.text.trim() === name);

    expect(hex(named("OcClaude")!)).toBe(theme.viaClaude);
    expect(hex(named("OcClaude")!)).not.toBe(theme.claude);
    expect(hex(named("OcPlain")!)).toBe(theme.opencode);
    setup.renderer.destroy();
  });
});
