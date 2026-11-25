import { describe, expect, test } from "bun:test";

import { panelBudget, panelRows } from "../src/watari/tui/panel.ts";
import { tabWindow } from "../src/watari/tui/components.tsx";
import type { TeamClaim, TeamFinding, TeamSnapshot, TeamTodo } from "../src/watari/state/types.ts";

function todo(index: number, state: TeamTodo["state"] = "todo"): TeamTodo {
  return {
    id: index,
    goalId: "g1",
    title: `todo ${index}`,
    detail: null,
    author: "codex",
    assignee: index % 2 === 0 ? "claude" : null,
    paths: [],
    state,
    note: null,
    createdAt: index,
    updatedAt: index,
  };
}

function claim(index: number, state: TeamClaim["state"] = "active"): TeamClaim {
  return {
    id: `clm-${index}`,
    goalId: "g1",
    claimant: index % 2 === 0 ? "codex" : "claude",
    summary: `claim ${index}`,
    paths: [`src/file-${index}.ts`],
    state,
    note: null,
    createdAt: index,
    updatedAt: index,
  };
}

function finding(index: number, disposition: TeamFinding["disposition"] = "open"): TeamFinding {
  return {
    id: `fnd-${index}`,
    author: "claude",
    target: "codex",
    scope: null,
    severity: "high",
    summary: `finding ${index}`,
    evidence: null,
    disposition,
    createdAt: index,
    updatedAt: index,
  };
}

function snapshotWith(claims: readonly TeamClaim[], findings: readonly TeamFinding[]): TeamSnapshot {
  return {
    schemaVersion: 2,
    agents: [
      { id: "codex", backend: "codex-app-server", displayName: "Codex", sessionId: null, state: "ready", currentGoalId: null, updatedAt: 0, detail: null },
      { id: "claude", backend: "claude-agent-sdk", displayName: "Claude", sessionId: null, state: "ready", currentGoalId: null, updatedAt: 0, detail: null },
    ],
    activeGoal: null,
    messages: [],
    claims,
    findings,
    events: [],
    activities: [],
  };
}

function withBridges(snapshot: TeamSnapshot): TeamSnapshot {
  return {
    ...snapshot,
    bridges: snapshot.agents.map((agent) => ({
      agent: agent.id,
      state: "ready" as const,
      detail: "roster answered",
      tools: [],
      missing: [],
      elapsedMs: 12,
      checkedAt: 0,
    })),
  };
}

describe("side panel budget", () => {
  test("never asks for more rows than the pane has", () => {
    for (const claimCount of [0, 1, 3, 9]) {
      for (const findingCount of [0, 1, 3, 9]) {
        const base = snapshotWith(
          Array.from({ length: claimCount }, (_value, index) => claim(index)),
          Array.from({ length: findingCount }, (_value, index) => finding(index)),
        );
        // A measured bridge adds a row per peer, so the invariant has to hold
        // both before and after the first check runs.
        for (const snapshot of [base, withBridges(base)]) {
          for (let height = 3; height <= 60; height += 1) {
            const budget = panelBudget(snapshot, height);
            expect(panelRows(snapshot, budget)).toBeLessThanOrEqual(Math.max(height, 8));
          }
        }
      }
    }
  });

  test("reports exactly what it trimmed", () => {
    const snapshot = snapshotWith([claim(1), claim(2), claim(3)], [finding(1), finding(2)]);
    const budget = panelBudget(snapshot, 14);
    expect(budget.claims.length + budget.hiddenClaims).toBe(3);
    expect(budget.findings.length + budget.hiddenFindings).toBe(2);
  });

  test("keeps a finding visible before it fills the panel with claims", () => {
    const snapshot = snapshotWith([claim(1), claim(2), claim(3)], [finding(1), finding(2)]);
    const budget = panelBudget(snapshot, 14);
    expect(budget.findings.length).toBeGreaterThan(0);
    expect(budget.claims.length).toBeGreaterThan(0);
  });

  test("shows everything when there is room", () => {
    const snapshot = snapshotWith([claim(1), claim(2), claim(3)], [finding(1), finding(2)]);
    const budget = panelBudget(snapshot, 40);
    expect(budget.hiddenClaims).toBe(0);
    expect(budget.hiddenFindings).toBe(0);
  });

  test("ignores released claims and settled findings", () => {
    const snapshot = snapshotWith(
      [claim(1, "released"), claim(2)],
      [finding(1, "resolved"), finding(2, "dismissed"), finding(3)],
    );
    const budget = panelBudget(snapshot, 40);
    expect(budget.claims.map((entry) => entry.id)).toEqual(["clm-2"]);
    expect(budget.findings.map((entry) => entry.id)).toEqual(["fnd-3"]);
  });

  test("a pane with no room shows only the peer roster", () => {
    const snapshot = snapshotWith([claim(1)], [finding(1)]);
    const budget = panelBudget(snapshot, 5);
    expect(budget.claims).toEqual([]);
    expect(budget.findings).toEqual([]);
    expect(budget.hiddenClaims).toBe(1);
    expect(budget.hiddenFindings).toBe(1);
  });

  test("open TODO items take the room left and never push the panel past its pane", () => {
    const snapshot: TeamSnapshot = {
      ...snapshotWith([claim(1)], [finding(1)]),
      todos: [todo(1), todo(2, "done"), todo(3, "blocked"), todo(4, "doing")],
    };
    const roomy = panelBudget(snapshot, 40);
    expect(roomy.todos.map((entry) => entry.id)).toEqual([1, 3, 4]);
    expect(roomy.hiddenTodos).toBe(0);
    for (let height = 3; height <= 40; height += 1) {
      const budget = panelBudget(snapshot, height);
      expect(panelRows(snapshot, budget)).toBeLessThanOrEqual(Math.max(height, 8));
      expect(budget.todos.length + budget.hiddenTodos).toBe(3);
    }
  });
});

describe("chat tabs", () => {
  const cells = ["  global  ", ...Array.from({ length: 7 }, (_value, index) => `  reviewer-${index} \u25cb  `)];

  test("everything is shown while everything fits", () => {
    expect(tabWindow(cells, 0, 500)).toEqual({ start: 0, end: cells.length });
  });

  test("the focused chat is always inside the window", () => {
    for (let active = 0; active < cells.length; active += 1) {
      const window = tabWindow(cells, active, 44);
      expect(window.start).toBeLessThanOrEqual(active);
      expect(window.end).toBeGreaterThan(active);
    }
  });

  test("the window never draws wider than the room it was given", () => {
    for (let active = 0; active < cells.length; active += 1) {
      const window = tabWindow(cells, active, 44);
      const width = cells
        .slice(window.start, window.end)
        .reduce((total, cell) => total + cell.length, 0);
      const markers = (window.start > 0 ? 2 : 0) + (window.end < cells.length ? 2 : 0);
      expect(width + markers).toBeLessThanOrEqual(44);
    }
  });

  test("an empty strip and a room too small for one tab are still answerable", () => {
    expect(tabWindow([], 0, 20)).toEqual({ start: 0, end: 0 });
    expect(tabWindow(cells, 3, 4)).toEqual({ start: 3, end: 4 });
  });
});
