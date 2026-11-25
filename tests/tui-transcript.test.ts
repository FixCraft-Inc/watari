import { describe, expect, test } from "bun:test";

import { cellWidth } from "../src/watari/tui/format.ts";
import { selectTheme } from "../src/watari/tui/theme.ts";
import {
  buildEntries,
  lastCodeBlock,
  layoutTranscript,
  pendingApprovals,
  plainSelection,
  transcriptView,
  welcomeRows,
} from "../src/watari/tui/transcript.ts";
import type { TeamSnapshot } from "../src/watari/state/types.ts";

const theme = selectTheme("dark", true);

const snapshot: TeamSnapshot = {
  schemaVersion: 2,
  agents: [
    { id: "codex", backend: "codex-app-server", displayName: "Codex", sessionId: null, state: "busy", currentGoalId: "g1", updatedAt: 10, detail: null },
    { id: "claude", backend: "claude-agent-sdk", displayName: "Claude", sessionId: null, state: "waiting", currentGoalId: "g1", updatedAt: 10, detail: null },
  ],
  activeGoal: {
    id: "g1",
    instruction: "harden the delivery queue",
    origin: "user",
    initialAddressee: null,
    state: "active",
    createdAt: 1,
    updatedAt: 10,
  },
  messages: [
    { id: 1, goalId: "g1", sender: "user", recipients: ["codex", "claude"], kind: "goal", priority: "normal", priorityReason: null, body: "harden the delivery queue", createdAt: 1 },
    { id: 2, goalId: "g1", sender: "codex", recipients: ["claude"], kind: "peer", priority: "normal", priorityReason: null, body: "taking runtime.ts, please cover the store schema so we do not collide on the same files", createdAt: 2 },
    { id: 3, goalId: "g1", sender: "claude", recipients: ["codex"], kind: "peer", priority: "urgent", priorityReason: "delivery correctness", body: "that patch drops the acknowledgement row", createdAt: 4 },
  ],
  claims: [],
  findings: [],
  events: [
    { id: 1, agent: "codex", type: "tool", summary: "read src/watari/service/runtime.ts", providerEventId: "ev_1", createdAt: 3 },
    { id: 2, agent: "claude", type: "approval", summary: "bash: bun test", providerEventId: "req_1", createdAt: 5 },
    { id: 3, agent: null, type: "error", summary: "transport reset", providerEventId: null, createdAt: 6 },
  ],
  activities: [],
};

describe("transcript entries", () => {
  test("global keeps every message and event in time order", () => {
    const entries = buildEntries(snapshot, null);
    expect(entries.map((entry) => entry.key)).toEqual(["m1", "m2", "e1", "m3", "e2", "e3"]);
  });

  test("an agent tab keeps only that peer's traffic", () => {
    const keys = buildEntries(snapshot, "codex").map((entry) => entry.key);
    expect(keys).toContain("m2");
    expect(keys).toContain("e1");
    expect(keys).not.toContain("e2");
    expect(keys).not.toContain("e3");
  });

  test("a broadcast is addressed to everyone, a directed one names the peer", () => {
    const entries = buildEntries(snapshot, null);
    const [broadcast, directed] = entries;
    expect(broadcast?.kind === "message" && broadcast.audience).toBe("everyone");
    expect(broadcast?.kind === "message" && broadcast.sender).toBe("you");
    expect(directed?.kind === "message" && directed.audience).toBe("Claude");
  });
});

describe("transcript layout", () => {
  const rows = layoutTranscript(buildEntries(snapshot, null), transcriptView(theme, snapshot.agents), 48);

  test("no row is wider than the pane", () => {
    for (const row of rows) {
      const spans = row.spans.reduce((total, span) => total + cellWidth(span.text), 0);
      const trailing = (row.trailing ?? []).reduce((total, span) => total + cellWidth(span.text), 0);
      expect(spans + trailing).toBeLessThanOrEqual(48);
    }
  });

  test("every line of a message carries the same coloured rail", () => {
    const body = rows.filter((row) => /^m2-(?:h|b\d+)$/u.test(row.key));
    expect(body.length).toBeGreaterThan(2);
    for (const row of body) {
      expect(row.spans[0]?.text).toBe(" ┃ ");
      expect(row.spans[0]?.color).toBe(theme.codex);
    }
  });

  test("wrapped body lines hang under the header instead of resetting to column zero", () => {
    const continuation = rows.filter((row) => /^m2-b[1-9]/u.test(row.key));
    expect(continuation.length).toBeGreaterThan(0);
    for (const row of continuation) {
      expect(cellWidth(row.spans[0]?.text ?? "")).toBe(3);
    }
  });

  test("a non normal priority is spelled out, not just coloured", () => {
    const header = rows.find((row) => row.key === "m3-h");
    expect(header?.spans.some((span) => span.text.includes("urgent"))).toBe(true);
  });

  test("routine activity stays on a single dim line", () => {
    const event = rows.filter((row) => row.key === "e1");
    expect(event).toHaveLength(1);
    expect(event[0]?.trailing).toBeUndefined();
  });

  test("errors and approvals get a timestamp", () => {
    expect(rows.find((row) => row.key === "e2")?.trailing).toBeDefined();
    expect(rows.find((row) => row.key === "e3")?.trailing).toBeDefined();
  });

  // A rail, an outcome glyph and a bullet each used to start at their own
  // depth, so the left edge of the pane stepped in and out as the kinds of row
  // alternated. Every marker owns one column and every body starts in the next.
  test("every kind of row puts its marker in the same column", () => {
    const first = rows.filter((row) => row.spans.length > 1).map((row) => row.spans[0]?.text ?? "");
    expect(first.length).toBeGreaterThan(3);
    for (const gutter of first) {
      expect(cellWidth(gutter)).toBe(3);
      expect(gutter.startsWith(" ")).toBe(true);
      expect(gutter.endsWith(" ")).toBe(true);
      expect(gutter.trim()).not.toBe("");
    }
  });
});

describe("provider activity", () => {
  const activity: TeamSnapshot = {
    ...snapshot,
    messages: [],
    events: [
      { id: 10, agent: "codex", type: "assistant", summary: "The queue is bounded and applies backpressure, so nothing is dropped.", providerEventId: "msg_1", createdAt: 1 },
      { id: 11, agent: "codex", type: "reasoning", summary: Array.from({ length: 40 }, (_v, i) => `thought number ${i}`).join(" "), providerEventId: "rs_1", createdAt: 2 },
      { id: 12, agent: "codex", type: "tool_start", summary: "bash  bun test tests/store.test.ts", providerEventId: "toolu_1", createdAt: 3 },
      { id: 13, agent: "claude", type: "tool_end", summary: "edit  src/watari/state/store.ts", providerEventId: "toolu_2", createdAt: 4 },
      { id: 14, agent: "claude", type: "tool_end", summary: "bash  bun test  failed", providerEventId: "toolu_3", createdAt: 5 },
    ],
  };
  const rows = layoutTranscript(buildEntries(activity, null), transcriptView(theme, activity.agents), 70);
  const text = rows.map((row) => row.spans.map((span) => span.text).join("")).join("\n");

  test("assistant text is one railed block of prose, not one row per fragment", () => {
    const body = rows.filter((row) => /^e10-b\d+$/u.test(row.key));
    expect(body.length).toBeGreaterThan(0);
    expect(body.map((row) => row.spans[1]?.text).join(" ")).toContain("applies backpressure");
    for (const row of body) {
      expect(row.spans[0]?.text).toBe(" ┃ ");
      expect(row.spans[0]?.color).toBe(theme.codex);
    }
  });

  test("reasoning gets its own quieter rail and is capped", () => {
    const header = rows.find((row) => row.key === "e11-h");
    expect(header?.spans[0]?.text).toBe(" ┆ ");
    expect(header?.spans.some((span) => span.text.includes("thinking"))).toBe(true);
    expect(rows.filter((row) => /^e11-b\d+$/u.test(row.key))).toHaveLength(8);
    expect(text).toContain("more thinking lines");
  });

  test("a tool call is one row that shows what ran and how it ended", () => {
    const running = rows.find((row) => row.key === "e12");
    const done = rows.find((row) => row.key === "e13");
    const failed = rows.find((row) => row.key === "e14");

    expect(running?.spans[0]?.text).toContain("⋯");
    expect(done?.spans[0]?.text).toContain("✓");
    expect(failed?.spans[0]?.text).toContain("✕");
    expect(running?.spans.map((span) => span.text).join("")).toContain("bash");
    expect(running?.spans.map((span) => span.text).join("")).toContain("bun test tests/store.test.ts");
  });

  test("no provider identifier reaches the transcript", () => {
    for (const marker of ["msg_1", "rs_1", "toolu_1", "toolu_2", "toolu_3"]) {
      expect(text).not.toContain(marker);
    }
  });

  test("an approval still shows the identifier the reader has to type back", () => {
    const approvalRows = layoutTranscript(buildEntries(snapshot, null), transcriptView(theme, snapshot.agents), 70);
    const approval = approvalRows.find((row) => row.key === "e2");
    expect(approval?.spans.map((span) => span.text).join("")).toContain("req_1");
  });
});

describe("peer outage notice", () => {
  test("a Watari outage handoff is visibly urgent in the target peer tab", () => {
    const outage: TeamSnapshot = {
      ...snapshot,
      events: [],
      messages: [{
        id: 99,
        goalId: "goal-1",
        sender: "watari",
        recipients: ["codex"],
        kind: "system",
        priority: "urgent",
        priorityReason: "peer unavailable",
        body: "Claude (claude) is offline: rate_limit. Continue independently; do not wait for this peer.",
        createdAt: 10,
      }],
    };
    const rows = layoutTranscript(buildEntries(outage, "codex"), transcriptView(theme, outage.agents), 72);
    const header = rows.find((row) => row.key === "m99-h");
    const body = rows.find((row) => row.key === "m99-b0");
    expect(header?.spans.map((span) => span.text).join("")).toContain("watari → Codex  urgent");
    expect(header?.spans[0]?.color).toBe(theme.urgent);
    expect(body?.spans[1]?.color).toBe(theme.warn);
    expect(
      rows
        .filter((row) => row.key.startsWith("m99-b"))
        .map((row) => row.spans[1]?.text ?? "")
        .join(" "),
    ).toContain("do not wait");
  });
});

describe("standing state", () => {
  test("an unanswered approval is offered, an answered one is not", () => {
    expect(pendingApprovals(snapshot).map((event) => event.providerEventId)).toEqual(["req_1"]);
    const answered: TeamSnapshot = {
      ...snapshot,
      events: [
        ...snapshot.events,
        { id: 4, agent: "claude", type: "approval_answered", summary: "accepted", providerEventId: "req_1", createdAt: 7 },
      ],
    };
    expect(pendingApprovals(answered)).toHaveLength(0);
  });

  test("the first run explains what a message will do", () => {
    const rows = welcomeRows(transcriptView(theme, snapshot.agents), 60);
    const text = rows.map((row) => row.spans.map((span) => span.text).join("")).join("\n");
    expect(text).toContain("watari");
    expect(text).toContain("shared goal");
    for (const row of rows) {
      expect(row.spans.reduce((total, span) => total + cellWidth(span.text), 0)).toBeLessThanOrEqual(60);
    }
  });
});

describe("identity", () => {
  const mixed: TeamSnapshot = {
    ...snapshot,
    agents: [
      { id: "codex", backend: "codex-app-server", displayName: "Codex", provider: "codex", sessionId: null, state: "ready", currentGoalId: "g1", updatedAt: 1, detail: null },
      // An alias that is not its provider's name, which is the whole point of
      // aliases: the colour still has to say "this is Claude".
      { id: "reviewer", backend: "claude-agent-sdk", displayName: "Reviewer", provider: "claude", sessionId: null, state: "ready", currentGoalId: "g1", updatedAt: 1, detail: null },
      { id: "oc", backend: "opencode-acp", displayName: "OpenCode", provider: "opencode", sessionId: null, state: "ready", currentGoalId: "g1", updatedAt: 1, detail: null },
    ],
    messages: [
      { id: 1, goalId: "g1", sender: "reviewer", recipients: ["codex"], kind: "peer", priority: "normal", priorityReason: null, body: "claiming the store schema", createdAt: 1 },
      { id: 2, goalId: "g1", sender: "oc", recipients: ["codex"], kind: "peer", priority: "normal", priorityReason: null, body: "reading the queue tests", createdAt: 2 },
      { id: 3, goalId: "g1", sender: "user", recipients: ["codex"], kind: "user", priority: "normal", priorityReason: null, body: "carry on", createdAt: 3 },
    ],
    events: [],
  };
  const view = transcriptView(theme, mixed.agents);
  const rows = layoutTranscript(buildEntries(mixed, null), view, 60);
  const railOf = (key: string): string | undefined =>
    rows.find((row) => row.key === key)?.spans[0]?.color;

  test("colour follows the provider, never the alias", () => {
    expect(railOf("m1-h")).toBe(theme.claude);
    expect(railOf("m2-h")).toBe(theme.opencode);
    expect(view.accent("reviewer")).toBe(view.accent("claude"));
    expect(view.accent("codex")).toBe(theme.codex);
  });

  test("the person at the keyboard has an identity of their own", () => {
    expect(railOf("m3-h")).toBe(theme.user);
    for (const agent of mixed.agents) {
      expect(view.accent(agent.id)).not.toBe(theme.user);
    }
  });

  test("peers are named the way the roster names them", () => {
    const header = rows.find((row) => row.key === "m1-h");
    expect(header?.spans[1]?.text).toBe("Reviewer");
    expect(view.name("user")).toBe("you");
    expect(view.name(null)).toBe("watari");
  });

  test("an unknown harness still gets a stable accent instead of no colour", () => {
    const accent = view.accent("someone-else");
    expect(accent).not.toBe("");
    expect(view.accent("someone-else")).toBe(accent);
  });
});

describe("copy", () => {
  test("a dragged selection loses the rail and keeps the words", () => {
    const dragged = [
      " ┃ Reviewer → Codex",
      " ┃ the acknowledgement row is dropped when a peer",
      " ┃ disconnects mid-turn",
      " ┃ ┆ nothing interrupts a running command",
      "",
      "",
      "",
    ].join("\n");

    expect(plainSelection(dragged)).toBe(
      [
        "Reviewer → Codex",
        "the acknowledgement row is dropped when a peer",
        "disconnects mid-turn",
        "> nothing interrupts a running command",
      ].join("\n"),
    );
  });

  test("the newest fenced block is copyable in full", () => {
    const long = Array.from({ length: 40 }, (_value, index) => `line ${index}`);
    const entries = buildEntries(
      {
        ...snapshot,
        messages: [],
        events: [
          { id: 1, agent: "codex", type: "assistant", summary: ["```ts", ...long, "```"].join("\n"), providerEventId: null, createdAt: 1 },
          { id: 2, agent: "codex", type: "reasoning", summary: ["```ts", "not this one", "```"].join("\n"), providerEventId: null, createdAt: 2 },
        ],
      },
      null,
    );

    expect(lastCodeBlock(entries)).toBe(long.join("\n"));
    expect(lastCodeBlock(buildEntries({ ...snapshot, messages: [], events: [] }, null))).toBeNull();
  });
});
