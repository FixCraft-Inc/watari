import { describe, expect, test } from "bun:test";
import type { ScrollBoxRenderable } from "@opentui/core";
import { testRender } from "@opentui/solid";

import type { ActivityDetail, ActivitySummary, ContentRetention } from "../src/watari/activity/types.ts";
import type { RuntimeEvent, TeamSnapshot } from "../src/watari/state/types.ts";
import { WatariApp } from "../src/watari/tui/app.tsx";
import { chatClientDefaults } from "./fakes/ui-client.ts";

const completeRetention: ContentRetention = {
  truncated: false,
  originalBytes: 0,
  retainedBytes: 0,
  omittedBytes: 0,
  originalLines: 0,
  retainedLines: 0,
  omittedLines: 0,
};

const commandSummary: ActivitySummary = {
  id: "act_111111111111111111111111",
  agent: "codex",
  kind: "command",
  state: "completed",
  title: "bash",
  preview: "test suite",
  providerEventId: "cmd-1",
  revision: 2,
  startedAt: 10,
  updatedAt: 20,
  hasDetail: true,
};

const commandDetail: ActivityDetail = {
  kind: "command",
  command: "bun test --watch=false",
  cwd: "/work/watari",
  outputMode: "split",
  stdout: Array.from({ length: 40 }, (_value, index) => `output line ${index + 1}`).join("\n"),
  stderr: "",
  exitCode: 0,
  durationMs: 1250,
  interrupted: false,
  retention: completeRetention,
};

const editSummary: ActivitySummary = {
  id: "act_222222222222222222222222",
  agent: "claude",
  kind: "file_change",
  state: "completed",
  title: "edit",
  preview: "src/first.ts  src/second.ts",
  providerEventId: "edit-1",
  revision: 2,
  startedAt: 30,
  updatedAt: 40,
  hasDetail: true,
};

const editDetail: ActivityDetail = {
  kind: "file_change",
  files: [
    {
      path: "src/first.ts",
      kind: "update",
      diff: "@@ -1,2 +1,2 @@\n-old first\n+new first\n context",
      additions: 1,
      deletions: 1,
      retention: completeRetention,
    },
    {
      path: "src/second.ts",
      kind: "add",
      diff: "@@ -0,0 +1,2 @@\n+new second\n+another line",
      additions: 2,
      deletions: 0,
      retention: completeRetention,
    },
  ],
  retention: completeRetention,
};

describe("interactive activity cards", () => {
  test("stays collapsed, then keyboard focus expands and scrolls an inner command pane", async () => {
    const details = new Map([[commandSummary.id, commandDetail]]);
    const setup = await renderApp(snapshot([commandSummary]), details, 100, 32);
    await setup.renderOnce();
    let frame = setup.captureCharFrame();
    expect(frame).toContain("test suite");
    expect(frame).not.toContain("bun test --watch=false");

    setup.mockInput.pressTab();
    await setup.renderOnce();
    setup.mockInput.pressEnter();
    frame = await setup.waitForFrame((rendered) => rendered.includes("bun test --watch=false"));
    expect(frame).toContain("cwd /work/watari");
    expect(frame).toContain("exit 0");

    const pane = requiredScrollBox(setup, `activity-${commandSummary.id}-pane`);
    const transcript = requiredScrollBox(setup, "transcript-scroll");
    expect(pane.height).toBeGreaterThanOrEqual(10);
    expect(pane.height).toBeLessThanOrEqual(16);
    const outerBefore = transcript.scrollTop;
    setup.mockInput.pressArrow("down");
    await setup.renderOnce();
    expect(pane.scrollTop).toBeGreaterThan(0);
    expect(transcript.scrollTop).toBe(outerBefore);

    const innerBeforeWheel = pane.scrollTop;
    await setup.mockMouse.scroll(pane.screenX + 2, pane.screenY + 2, "down");
    await setup.renderOnce();
    expect(pane.scrollTop).toBeGreaterThan(innerBeforeWheel);
    expect(transcript.scrollTop).toBe(outerBefore);

    setup.mockInput.pressEscape();
    await delay(40);
    await setup.renderOnce();
    await setup.mockInput.typeText("composer owns keys again");
    expect(await setup.waitForFrame((rendered) => rendered.includes("composer owns keys again"))).toContain("composer owns keys again");
    setup.renderer.destroy();
  });

  test("click toggles a card and left/right switches edited files", async () => {
    const details = new Map([[editSummary.id, editDetail]]);
    const setup = await renderApp(snapshot([editSummary]), details, 100, 32);
    await setup.renderOnce();
    setup.mockInput.pressKey("t", { ctrl: true });
    await setup.renderOnce();
    const cardRow = setup.captureCharFrame().split("\n").findIndex((row) => row.includes("src/first.ts"));
    expect(cardRow).toBeGreaterThanOrEqual(0);
    await setup.mockMouse.click(2, cardRow);
    let frame = await setup.waitForFrame((rendered) => rendered.includes("src/first.ts") && rendered.includes("old first"));
    expect(frame).toContain("+1 -1");

    setup.mockInput.pressArrow("right");
    frame = await setup.waitForFrame((rendered) => rendered.includes("src/second.ts") && rendered.includes("new second"));
    expect(frame).toContain("+2 -0");
    setup.mockInput.pressArrow("left");
    expect(await setup.waitForFrame((rendered) => rendered.includes("old first"))).toContain("src/first.ts");
    setup.renderer.destroy();
  });

  test("slash autocomplete has precedence and Shift+Tab traverses from the last card", async () => {
    const details = new Map<string, ActivityDetail>([
      [commandSummary.id, commandDetail],
      [editSummary.id, editDetail],
    ]);
    const setup = await renderApp(snapshot([commandSummary, editSummary]), details, 100, 34);
    await setup.renderOnce();
    setup.mockInput.pressKey("t", { ctrl: true });
    await setup.renderOnce();

    await setup.mockInput.typeText("/eff");
    setup.mockInput.pressTab();
    const completed = await setup.waitForFrame((rendered) => rendered.includes("▸ all │ /effort"));
    expect(completed).not.toContain("bun test --watch=false");
    setup.mockInput.pressKey("u", { ctrl: true });
    await setup.waitForFrame((rendered) => !rendered.includes("/effort") && !rendered.includes("commands"));

    setup.mockInput.pressTab({ shift: true });
    await setup.renderOnce();
    setup.mockInput.pressEnter();
    const expanded = await setup.waitForFrame((rendered) => rendered.includes("src/first.ts") && rendered.includes("old first"));
    expect(expanded).not.toContain("bun test --watch=false");
    setup.renderer.destroy();
  });

  test("the global scrollbar auto-hides and appears only for overflow", async () => {
    const small = await renderApp(snapshot([commandSummary]), new Map([[commandSummary.id, commandDetail]]), 80, 24);
    await small.renderOnce();
    expect(requiredScrollBox(small, "transcript-scroll").verticalScrollBar.visible).toBe(false);
    small.renderer.destroy();

    const crowded = {
      ...snapshot([]),
      events: Array.from({ length: 60 }, (_value, index) => ({
        id: index + 1,
        agent: "codex" as const,
        type: "assistant",
        summary: `transcript row ${index + 1}`,
        providerEventId: `message-${index + 1}`,
        createdAt: index + 1,
      })),
    };
    const large = await renderApp(crowded, new Map(), 80, 24);
    await large.renderOnce();
    expect(requiredScrollBox(large, "transcript-scroll").verticalScrollBar.visible).toBe(true);
    large.renderer.destroy();
  });

  test("reloads a detail revision that arrives while the first fetch is pending", async () => {
    let listener: ((event: RuntimeEvent) => void) | undefined;
    let calls = 0;
    let resolveFirst: (detail: ActivityDetail) => void = () => undefined;
    const first = new Promise<ActivityDetail>((resolve) => {
      resolveFirst = resolve;
    });
    const refreshed: ActivityDetail = {
      ...commandDetail,
      stdout: "fresh revision output",
    };
    let current = snapshot([commandSummary]);
    const client = {
      ...chatClientDefaults,
      get snapshot() {
        return current;
      },
      subscribe(next: (event: RuntimeEvent) => void) {
        listener = next;
        return () => undefined;
      },
      async getActivityDetail() {
        calls += 1;
        return calls === 1 ? await first : refreshed;
      },
      async send() {},
      async interrupt() {},
      async approve() {},
      async checkBridges() { return []; },
      async configureAgent() {},
      async removeAgent() {},
      async availableModels() { return []; },
      async availableProviderModels() { return []; },
      async completeGoal() {},
      async restartAgent() {},
      async newChat() {},
      async shutdown() {},
    };
    const setup = await testRender(
      () => (
        <WatariApp
          client={client}
          project={{ launchDirectory: "/work/watari", repositoryRoot: "/work/watari" }}
          stateDirectory="/state/watari"
        />
      ),
      { width: 100, height: 32 },
    );
    await setup.renderOnce();
    setup.mockInput.pressTab();
    setup.mockInput.pressEnter();
    await waitUntil(() => calls === 1);

    const revised = { ...commandSummary, revision: commandSummary.revision + 1, updatedAt: 30 };
    current = snapshot([revised]);
    listener?.({ type: "activity_detail_changed", activityId: revised.id, revision: revised.revision });
    resolveFirst(commandDetail);

    expect(await setup.waitForFrame((frame) => frame.includes("fresh revision output")))
      .toContain("fresh revision output");
    expect(calls).toBe(2);
    setup.renderer.destroy();
  });

  test("keeps a multiline command inside the bounded card viewport", async () => {
    const multiline: ActivityDetail = {
      ...commandDetail,
      command: Array.from({ length: 200 }, (_value, index) => `printf line-${index + 1}`).join("\n"),
    };
    const setup = await renderApp(
      snapshot([commandSummary]),
      new Map([[commandSummary.id, multiline]]),
      100,
      32,
    );
    await setup.renderOnce();
    setup.mockInput.pressTab();
    setup.mockInput.pressEnter();
    await setup.waitForFrame((frame) => frame.includes("printf line-1"));

    const card = setup.renderer.root.findDescendantById(`activity-${commandSummary.id}`);
    if (!card) throw new Error("missing activity card");
    expect(card.height).toBeLessThanOrEqual(20);
    setup.renderer.destroy();
  });
});

function snapshot(activities: ActivitySummary[]): TeamSnapshot {
  return {
    schemaVersion: 2,
    agents: [
      {
        id: "codex",
        backend: "codex-app-server",
        displayName: "Codex",
        provider: "codex",
        sessionId: null,
        state: "ready",
        currentGoalId: null,
        updatedAt: 1,
        detail: "ready",
      },
      {
        id: "claude",
        backend: "claude-agent-sdk",
        displayName: "Claude",
        provider: "claude",
        sessionId: null,
        state: "ready",
        currentGoalId: null,
        updatedAt: 1,
        detail: "ready",
      },
    ],
    activeGoal: null,
    messages: [],
    claims: [],
    findings: [],
    events: [],
    activities,
  };
}

async function renderApp(
  current: TeamSnapshot,
  details: ReadonlyMap<string, ActivityDetail>,
  width: number,
  height: number,
) {
  return await testRender(
    () => (
      <WatariApp
        client={{
          ...chatClientDefaults,
          snapshot: current,
          subscribe(_listener: (event: RuntimeEvent) => void) {
            return () => undefined;
          },
          async send() {},
          async interrupt() {},
          async approve() {},
          async checkBridges() { return []; },
          async configureAgent() {},
          async removeAgent() {},
          async availableModels() { return []; },
          async availableProviderModels() { return []; },
          async getActivityDetail(activityId: string) { return details.get(activityId) ?? null; },
          async completeGoal() {},
          async restartAgent() {},
          async newChat() {},
          async shutdown() {},
        }}
        project={{ launchDirectory: "/work/watari", repositoryRoot: "/work/watari" }}
        stateDirectory="/state/watari"
      />
    ),
    { width, height },
  );
}

function requiredScrollBox(
  setup: Awaited<ReturnType<typeof renderApp>>,
  id: string,
): ScrollBoxRenderable {
  const renderable = setup.renderer.root.findDescendantById(id);
  if (!renderable) throw new Error(`missing renderable ${id}`);
  return renderable as ScrollBoxRenderable;
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function waitUntil(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("condition timed out");
    await delay(10);
  }
}
