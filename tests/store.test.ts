import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TeamStore } from "../src/watari/state/store.ts";
import { normalizeActivityEvent } from "../src/watari/activity/normalize.ts";

function createStore(): TeamStore {
  const store = new TeamStore(":memory:");
  store.registerAgent({ id: "codex", backend: "codex-app-server", displayName: "Codex" });
  store.registerAgent({ id: "claude", backend: "claude-agent-sdk", displayName: "Claude" });
  return store;
}

describe("TeamStore", () => {
  test("creates one exact shared goal for every peer", () => {
    const store = createStore();
    const instruction = "Implement the transport without changing its wire contract.";
    const goal = store.createGoal({
      instruction,
      initialAddressee: "codex",
      participants: ["codex", "claude"],
    });

    expect(goal.instruction).toBe(instruction);
    expect(store.agents().map((agent) => agent.currentGoalId)).toEqual([goal.id, goal.id]);
    expect(() =>
      store.createGoal({ instruction: "second", initialAddressee: null, participants: ["codex"] }),
    ).toThrow("already active");
    store.close();
  });

  test("persists directed messages and identity-bound acknowledgements", () => {
    const store = createStore();
    const message = store.addMessage({
      goalId: null,
      sender: "codex",
      recipients: ["claude"],
      kind: "peer",
      body: "Please verify shutdown ordering.",
    });

    expect(store.inbox("claude")).toEqual([message]);
    expect(store.pendingInbox("claude")).toEqual([message]);
    expect(store.inbox("codex")).toEqual([]);
    store.acknowledge("claude", message.id);
    expect(store.pendingInbox("claude")).toEqual([]);
    store.close();
  });

  test("restores goals, messages, and acknowledgements after reopening SQLite", () => {
    const directory = mkdtempSync(join(tmpdir(), "watari-store-test-"));
    const databasePath = join(directory, "state.db");
    try {
      const first = new TeamStore(databasePath);
      first.registerAgent({ id: "codex", backend: "codex", displayName: "Codex" });
      first.registerAgent({ id: "claude", backend: "claude", displayName: "Claude" });
      const goal = first.createGoal({
        instruction: "Survive restart",
        initialAddressee: null,
        participants: ["codex", "claude"],
      });
      const message = first.addMessage({
        goalId: goal.id,
        sender: "codex",
        recipients: ["claude"],
        kind: "peer",
        body: "Persist this delivery.",
      });
      first.acknowledge("claude", message.id);
      first.close();

      const reopened = new TeamStore(databasePath);
      expect(reopened.activeGoal()?.instruction).toBe("Survive restart");
      expect(reopened.inbox("claude")[0]?.body).toBe("Persist this delivery.");
      expect(reopened.pendingInbox("claude")).toEqual([]);
      reopened.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("repairs duplicate Claude blocks and empty speech from an older database", () => {
    const directory = mkdtempSync(join(tmpdir(), "watari-store-repair-test-"));
    const databasePath = join(directory, "state.db");
    try {
      const first = new TeamStore(databasePath);
      first.persistAgentEvent({
        agent: "claude",
        kind: "assistant",
        summary: "One statement.",
        providerEventId: "msg_1#0",
        timestamp: 1,
      });
      first.persistAgentEvent({
        agent: "claude",
        kind: "assistant",
        summary: "One statement.",
        providerEventId: "msg_1#1",
        timestamp: 2,
      });
      first.persistAgentEvent({
        agent: "claude",
        kind: "reasoning",
        summary: "",
        providerEventId: "msg_1#2",
        timestamp: 3,
      });
      first.close();

      const metadata = new Database(databasePath);
      // Version 2 databases can contain duplicates written after their one-time
      // startup repair; version 3 must revisit those rows.
      metadata.exec("PRAGMA user_version = 2");
      metadata.close();

      const repaired = new TeamStore(databasePath);
      expect(repaired.snapshot().events.map((event) => event.summary)).toEqual(["One statement."]);
      repaired.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("marks deterministic overlapping path claims contested without a winner", () => {
    const store = createStore();
    const goal = store.createGoal({
      instruction: "Refactor transport",
      initialAddressee: null,
      participants: ["codex", "claude"],
    });
    const first = store.createClaim({
      goalId: goal.id,
      claimant: "codex",
      summary: "framing",
      paths: ["src/transport/**"],
    });
    const second = store.createClaim({
      goalId: goal.id,
      claimant: "claude",
      summary: "shutdown",
      paths: ["src/transport/shutdown.ts"],
    });
    const claims = store.claims(goal.id);

    expect(claims.find((claim) => claim.id === first.id)?.state).toBe("contested");
    expect(claims.find((claim) => claim.id === second.id)?.state).toBe("contested");
    store.close();
  });

  test("rejects unsafe identities, traversal paths, and oversized messages", () => {
    const store = createStore();
    expect(() =>
      store.addMessage({
        goalId: null,
        sender: "bad identity",
        recipients: ["claude"],
        kind: "peer",
        body: "spoof",
      }),
    ).toThrow("valid Watari agent identity");
    const goal = store.createGoal({
      instruction: "safe",
      initialAddressee: null,
      participants: ["codex", "claude"],
    });
    expect(() =>
      store.createClaim({
        goalId: goal.id,
        claimant: "codex",
        summary: "escape",
        paths: ["../outside"],
      }),
    ).toThrow("repository-relative");
    expect(() =>
      store.addMessage({
        goalId: goal.id,
        sender: "codex",
        recipients: ["claude"],
        kind: "peer",
        body: "x".repeat(32_001),
      }),
    ).toThrow("exceeds");
    store.close();
  });

  test("enforces delivery priority reasons independently of finding severity", () => {
    const store = createStore();
    expect(() => store.addMessage({
      goalId: null,
      sender: "codex",
      recipients: ["claude"],
      kind: "peer",
      priority: "urgent",
      body: "look now",
    })).toThrow("require priority_reason");
    expect(() => store.addMessage({
      goalId: null,
      sender: "codex",
      recipients: ["claude"],
      kind: "peer",
      priorityReason: "not allowed on a normal message",
      body: "ordinary mail",
    })).toThrow("normal messages cannot carry");

    const urgent = store.addMessage({
      goalId: null,
      sender: "codex",
      recipients: ["claude"],
      kind: "peer",
      priority: "urgent",
      priorityReason: "the recipient must see this before its normal queue",
      body: "look now",
    });
    const finding = store.createFinding({
      author: "codex",
      target: "claude",
      severity: "info",
      summary: "non-blocking observation",
    });
    expect(urgent).toMatchObject({ priority: "urgent", priorityReason: expect.any(String) });
    expect(finding.severity).toBe("info");
    store.close();
  });

  test("keeps the acknowledged inbox cursor behind priority-delivery gaps", () => {
    const store = createStore();
    const normal = store.addMessage({
      goalId: null,
      sender: "codex",
      recipients: ["claude"],
      kind: "peer",
      body: "normal first",
    });
    const urgent = store.addMessage({
      goalId: null,
      sender: "codex",
      recipients: ["claude"],
      kind: "peer",
      priority: "urgent",
      priorityReason: "deliver before normal",
      body: "urgent second",
    });

    store.acknowledgeMessages("claude", [urgent.id]);
    expect(store.inboxCursors().find((cursor) => cursor.agent === "claude")).toMatchObject({
      latestMessageId: urgent.id,
      acknowledgedThrough: 0,
      pendingCount: 1,
    });
    store.acknowledgeMessages("claude", [normal.id]);
    expect(store.inboxCursors().find((cursor) => cursor.agent === "claude")).toMatchObject({
      acknowledgedThrough: urgent.id,
      pendingCount: 0,
    });
    store.close();
  });

  test("persists activity revisions and ignores stale overwrites", () => {
    const store = createStore();
    const started = normalizeActivityEvent({
      agent: "codex",
      kind: "tool_start",
      rawType: "item/started",
      providerEventId: "cmd-revision",
      summary: "bash  bun test",
      timestamp: 10,
      payload: { type: "commandExecution", command: "bun test", status: "running" },
    }, null)!;
    const completed = normalizeActivityEvent({
      agent: "codex",
      kind: "tool_end",
      rawType: "item/completed",
      providerEventId: "cmd-revision",
      summary: "bash  bun test",
      timestamp: 20,
      payload: { type: "commandExecution", command: "bun test", status: "completed", exitCode: 0 },
    }, started)!;

    store.saveActivity(completed);
    store.saveActivity(started);
    expect(store.snapshot().activities).toEqual([completed.summary]);
    expect(store.activityDetail(completed.summary.id)).toEqual(completed.detail);
    store.close();
  });

  test("backfills recognizable v1 provider payloads without changing legacy events", () => {
    const directory = mkdtempSync(join(tmpdir(), "watari-activity-backfill-"));
    const databasePath = join(directory, "state.db");
    try {
      const seeded = createFileStore(databasePath);
      seeded.persistAgentEvent({
        agent: "codex",
        kind: "tool_end",
        rawType: "item/completed",
        providerEventId: "legacy-command",
        summary: "bash  bun test",
        timestamp: 10,
        payload: {
          type: "commandExecution",
          command: "bun test",
          cwd: "/work",
          aggregatedOutput: "pass",
          status: "completed",
          exitCode: 0,
        },
      });
      seeded.persistAgentEvent({
        agent: "claude",
        kind: "edit",
        rawType: "tool_result",
        providerEventId: "legacy-edit",
        summary: "edit  src/a.ts",
        timestamp: 20,
        payload: {
          filePath: "src/a.ts",
          gitDiff: { patch: "@@ -1 +1 @@\n-old\n+new" },
          status: "completed",
        },
      });
      seeded.registerAgent({
        id: "opencode",
        backend: "opencode-acp",
        provider: "opencode",
        displayName: "OpenCode",
      });
      seeded.persistAgentEvent({
        agent: "opencode",
        kind: "edit",
        rawType: "session/update/tool_diff",
        providerEventId: "legacy-opencode-edit",
        summary: "edit  src/oc.ts",
        timestamp: 30,
        payload: { path: "src/oc.ts", oldText: "old", newText: "new" },
      });
      const before = seeded.snapshot().events;
      seeded.close();

      const metadata = new Database(databasePath);
      metadata.exec("DELETE FROM activities");
      metadata.exec("PRAGMA user_version = 3");
      metadata.close();

      const migrated = new TeamStore(databasePath);
      expect(migrated.snapshot().events).toEqual(before);
      expect(migrated.snapshot().activities).toHaveLength(2);
      expect(migrated.snapshot().activities.map((activity) => activity.kind).sort())
        .toEqual(["command", "file_change"]);
      expect(migrated.activityRecords().map((record) => record.detail.kind).sort())
        .toEqual(["command", "file_change"]);
      migrated.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("a question is owed once it is handed over and settled by any answer to the asker", () => {
    const store = createStore();
    const question = store.addMessage({
      goalId: null,
      sender: "codex",
      recipients: ["claude"],
      kind: "peer",
      body: "Which branch are you on?",
      expectsReply: true,
    });
    expect(question.expectsReply).toBe(true);
    expect(store.replyObligations("claude")).toEqual([]);
    expect(store.unsettledQuestionsTo("claude").map((entry) => entry.messageId)).toEqual([question.id]);

    store.acknowledgeMessages("claude", [question.id]);
    expect(store.replyObligations("claude").map((entry) => entry.messageId)).toEqual([question.id]);
    expect(store.awaitedReplies("codex")).toMatchObject([{ messageId: question.id, recipient: "claude" }]);

    // No reply_to: writing back to the asker still answers what was already seen.
    store.addMessage({ goalId: null, sender: "claude", recipients: ["codex"], kind: "peer", body: "main" });
    expect(store.replyObligations("claude")).toEqual([]);
    expect(store.awaitedReplies("codex")).toEqual([]);
    store.close();
  });

  test("a reminder and an escalation are each recorded once per question", () => {
    const store = createStore();
    const question = store.addMessage({
      goalId: null,
      sender: "codex",
      recipients: ["claude"],
      kind: "peer",
      body: "Is the remote workspace free?",
      expectsReply: true,
    });
    store.acknowledgeMessages("claude", [question.id]);
    store.markNudged("claude", [question.id]);
    expect(store.replyObligations("claude")[0]?.nudgedAt).toEqual(expect.any(Number));
    store.markEscalated("claude", [question.id]);
    expect(store.replyObligations("claude")).toEqual([]);
    expect(store.awaitedReplies("codex")).toEqual([]);
    expect(() => store.addMessage({
      goalId: null,
      sender: "codex",
      recipients: ["claude"],
      kind: "peer",
      body: "threading onto my own message",
      replyTo: question.id,
    })).toThrow("not a message addressed to codex");
    store.close();
  });

  test("a reset clears TODO items, wakes, and do-not-disturb along with the chat", () => {
    const store = createStore();
    store.createTodos({ goalId: null, author: "codex", items: [{ title: "first", assignee: "claude" }] });
    store.createWake({
      agent: "codex",
      condition: { kind: "timer", afterSeconds: 5 },
      note: "check the suite",
      deadlineAt: Date.now() + 5_000,
    });
    store.setAvailability("claude", "dnd", { reason: "migration", until: Date.now() + 60_000 });
    expect(store.snapshot()).toMatchObject({ todos: [{ id: 1 }], wakes: [{ id: 1, state: "pending" }] });

    store.resetConversation();
    expect(store.todos()).toEqual([]);
    expect(store.wakes()).toEqual([]);
    expect(store.agents().find((agent) => agent.id === "claude")?.availability).toBeUndefined();
    expect("todos" in store.snapshot()).toBe(false);
    // Numbering starts again, so the next chat's first item is #1.
    expect(store.createTodos({ goalId: null, author: "codex", items: [{ title: "next" }] })[0]?.id).toBe(1);
    store.close();
  });

  test("a wake settles once, and a TODO update needs something to change", () => {
    const store = createStore();
    const wake = store.createWake({
      agent: "codex",
      condition: { kind: "path", path: "result.json" },
      note: "read the result",
      deadlineAt: Date.now() + 60_000,
    });
    expect(store.settleWake(wake.id, "fired", "result.json exists")?.state).toBe("fired");
    expect(store.settleWake(wake.id, "expired", "too late")).toBeNull();
    expect(store.pendingWakes()).toEqual([]);

    const [item] = store.createTodos({ goalId: null, author: "user", items: [{ title: "triage" }] });
    expect(() => store.updateTodo(item!.id, {})).toThrow("needs a state");
    expect(store.updateTodo(item!.id, { assignee: "codex", state: "doing" })).toMatchObject({
      assignee: "codex",
      state: "doing",
    });
    expect(store.updateTodo(item!.id, { assignee: null }).assignee).toBeNull();
    store.close();
  });

  test("completing a goal releases the claims made for it", () => {
    const store = createStore();
    const goal = store.createGoal({ instruction: "Ship", initialAddressee: null, participants: ["codex", "claude"] });
    const claim = store.createClaim({ goalId: goal.id, claimant: "codex", summary: "transport", state: "active" });
    store.completeGoal(goal.id);
    expect(store.claims(goal.id)[0]).toMatchObject({
      id: claim.id,
      state: "released",
      note: "released when the goal was completed",
    });
    store.close();
  });

  test("the live snapshot stays bounded while a full snapshot keeps every message and its recipients", () => {
    const store = createStore();
    for (let index = 0; index < 410; index += 1) {
      store.addMessage({ goalId: null, sender: "codex", recipients: ["claude"], kind: "peer", body: `note ${index}` });
    }
    expect(store.snapshot().messages).toHaveLength(400);
    const full = store.snapshot({ full: true }).messages;
    expect(full).toHaveLength(410);
    expect(full.every((message) => message.recipients.length === 1 && message.recipients[0] === "claude")).toBe(true);
    store.close();
  });

  test("a reset hands a long chat's pages back to the filesystem", () => {
    const directory = mkdtempSync(join(tmpdir(), "watari-store-vacuum-"));
    const databasePath = join(directory, "state.db");
    try {
      const store = createFileStore(databasePath);
      const body = "x".repeat(30_000);
      for (let index = 0; index < 500; index += 1) {
        store.addMessage({ goalId: null, sender: "codex", recipients: ["claude"], kind: "peer", body });
      }
      store.checkpoint();
      const filled = statSync(databasePath).size;
      store.resetConversation();
      store.checkpoint();
      expect(statSync(databasePath).size).toBeLessThan(filled / 4);
      store.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

function createFileStore(databasePath: string): TeamStore {
  const store = new TeamStore(databasePath);
  store.registerAgent({ id: "codex", backend: "codex", displayName: "Codex" });
  store.registerAgent({ id: "claude", backend: "claude", displayName: "Claude" });
  return store;
}
