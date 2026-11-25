import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TeamStore } from "../src/watari/state/store.ts";
import { IdentityBoundTeamTools } from "../src/watari/team/tools.ts";
import { TeamApplicationService } from "../src/watari/team/service.ts";
import { normalizeActivityEvent } from "../src/watari/activity/normalize.ts";

function setup() {
  const store = new TeamStore(":memory:");
  store.registerAgent({ id: "codex", backend: "codex", displayName: "Codex" });
  store.registerAgent({ id: "claude", backend: "claude", displayName: "Claude" });
  const goal = store.createGoal({
    instruction: "Coordinate safely",
    initialAddressee: null,
    participants: ["codex", "claude"],
  });
  const service = new TeamApplicationService({ store });
  return {
    store,
    goal,
    service,
    codex: new IdentityBoundTeamTools({ agent: "codex", service }),
    claude: new IdentityBoundTeamTools({ agent: "claude", service }),
  };
}

describe("IdentityBoundTeamTools", () => {
  test("enforces project alias allowlists without model inference", async () => {
    const store = new TeamStore(":memory:");
    store.registerAgent({ id: "codex", backend: "codex", displayName: "Astra", provider: "codex", model: "gpt-6-astra" });
    store.registerAgent({ id: "qwen", backend: "qwen", displayName: "Qwen", provider: "qwen", model: "test-qwen" });
    store.registerAgent({ id: "sol", backend: "codex", displayName: "Sol", provider: "codex", model: "gpt-6.1-sol" });
    store.setAgentState("sol", "ready");
    store.setAgentState("qwen", "ready");
    const service = new TeamApplicationService({ store, taskPolicy: {
      classes: { critical: { agents: ["codex", "sol"] }, normal: { agents: ["sol"] }, mechanical: { agents: ["qwen"] } },
      agents: { qwen: { requireTaskClass: true, resource: "gpu:test" } },
    } });
    const codex = new IdentityBoundTeamTools({ agent: "codex", service });

    expect(await codex.call("team_send", {
      to: "qwen", message: "run the build and report the result",
    })).toMatchObject({ ok: false, error: expect.stringContaining("requires task_class") });
    expect(await codex.call("team_send", {
      to: "qwen", task_class: "critical", message: "inspect the trust boundary",
    })).toMatchObject({ ok: false, error: expect.stringContaining("cannot delegate critical work") });
    expect(await codex.call("team_send", {
      to: "qwen", task_class: "mechanical", message: "format the fixture",
    })).toMatchObject({ ok: true });
    expect(await codex.call("team_send", {
      to: "sol", task_class: "normal", message: "implement the parser",
    })).toMatchObject({ ok: true });
    store.close();
  });

  test("automatic delegation skips unavailable peers and blocks instead of downgrading", async () => {
    const { store } = setup();
    try {
      store.registerAgent({ id: "helper", backend: "qwen", displayName: "Helper" });
      store.setAgentState("helper", "ready");
      store.setAgentState("claude", "failed");
      const taskPolicy = {
        classes: { design: { agents: ["missing-lead", "claude", "helper"] }, execute: { agents: ["helper"] } },
        agents: { helper: { resource: "gpu:test", requireTaskClass: true } },
      };
      const service = new TeamApplicationService({ store, taskPolicy });
      const codex = new IdentityBoundTeamTools({ agent: "codex", service });
      const helper = new IdentityBoundTeamTools({ agent: "helper", service });
      expect(await codex.call("team_send", { task_class: "design", message: "Review this scope" })).toMatchObject({
        ok: true, value: { deliveries: [{ agent: "helper" }] },
      });
      store.setAgentState("helper", "failed");
      expect(await codex.call("team_send", { task_class: "design", message: "Review this scope" })).toMatchObject({
        ok: false, error: expect.stringContaining("no permitted agent is available"),
      });
      store.setAgentState("helper", "ready");
      expect(await codex.call("team_send", { to: "helper", task_class: "unknown", message: "Run" })).toMatchObject({ ok: false });
      expect(await codex.call("team_send", { to: ["helper", "claude"], task_class: "execute", message: "Run" })).toMatchObject({ ok: false });
      // A helper cannot bypass its shared resource by reserving another name.
      expect(await helper.call("team_job", { action: "reserve", source: "test", title: "Build", resources: ["build:one"] })).toMatchObject({ ok: true });
      expect(store.jobs({ activeOnly: true })[0]?.resources).toContain("gpu:test");
      expect(await helper.call("team_job", { action: "reserve", source: "test", title: "Second build", resources: ["build:two"] })).toMatchObject({ ok: false });
      expect(await codex.call("team_send", { task_class: "execute", message: "Run again" })).toMatchObject({ ok: false });
      expect((await codex.call("team_roster", {}))).toMatchObject({ ok: true, value: { task_policy: taskPolicy } });
    } finally {
      store.close();
    }
  });

  test("projects without policy do not infer restrictions from model names", async () => {
    const { store, codex } = setup();
    try {
      store.registerAgent({ id: "helper", backend: "qwen", displayName: "Helper", provider: "qwen", model: "test-qwen" });
      expect(await codex.call("team_send", { to: "helper", message: "A coordination note" })).toMatchObject({ ok: true });
      expect(await codex.call("team_send", { to: "claude", task_class: "normal", message: "A task" })).toMatchObject({ ok: false });
    } finally {
      store.close();
    }
  });

  test("binds sender identity outside model-controlled arguments", async () => {
    const { store, codex } = setup();
    const result = await codex.call("team_send", {
      to: "claude",
      sender: "claude",
      message: "Check this invariant",
    });

    expect(result.ok).toBe(true);
    expect(store.inbox("claude")[0]?.sender).toBe("codex");
    store.close();
  });

  test("cannot address itself or an unknown identity", async () => {
    const { store, codex } = setup();
    expect((await codex.call("team_send", { to: "codex", message: "spoof" })).ok).toBe(false);
    expect((await codex.call("team_send", { to: "nobody", message: "lost" })).ok).toBe(false);
    store.close();
  });

  test("records claims under the bound peer", async () => {
    const { store, goal, codex } = setup();
    const result = await codex.call("team_claim", {
      goal_id: goal.id,
      scope: "state layer",
      paths: ["src/watari/state/**"],
    });

    expect(result.ok).toBe(true);
    expect(store.claims(goal.id)[0]?.claimant).toBe("codex");
    store.close();
  });

  test("atomically reserves shared resources and keeps ownership through completion", async () => {
    const { store, codex, claude } = setup();
    const first = await codex.call("team_job", {
      action: "reserve",
      source: "mcp:test-remote",
      title: "remote test",
      resources: ["remote:ci/linux-build"],
    });
    expect(first).toMatchObject({ ok: true, value: { state: "pending", owner: "codex" } });
    const jobId = (first.value as { id: string }).id;

    const collision = await claude.call("team_job", {
      action: "reserve",
      source: "mcp:test-remote",
      title: "same remote test",
      resources: ["remote:ci/linux-build"],
    });
    expect(collision).toMatchObject({ ok: false, error: expect.stringContaining(jobId) });
    expect(await codex.call("team_job", { action: "update", job_id: jobId, state: "running", handle: "pid:42" }))
      .toMatchObject({ ok: true, value: { state: "running", handle: "pid:42" } });
    expect((await codex.call("team_status", {})).value).toMatchObject({
      jobs: [{ id: jobId, owner: "codex", state: "running", resources: ["remote:ci/linux-build"] }],
    });
    expect(await codex.call("team_job", {
      action: "update", job_id: jobId, state: "succeeded", result: "exit 0",
    })).toMatchObject({ ok: true, value: { state: "succeeded", result: "exit 0" } });
    expect(await claude.call("team_job", {
      action: "reserve", source: "mcp:test-remote", title: "retry", resources: ["remote:ci/linux-build"],
    })).toMatchObject({ ok: true, value: { owner: "claude", state: "pending" } });
    store.close();
  });

  for (const state of ["pending", "running", "unknown"] as const) {
    for (const [held, requested] of [["remote:x", "remote:x/y"], ["remote:x/y", "remote:x"]]) {
      test(`refuses ${requested} while ${held} is ${state}, but permits unrelated resources`, async () => {
        const { store, codex, claude } = setup();
        try {
          const first = await codex.call("team_job", {
            action: "reserve", source: "mcp:test", title: "held", resources: [held],
          });
          expect(first.ok).toBe(true);
          const jobId = (first.value as { id: string }).id;
          if (state !== "pending") {
            expect((await codex.call("team_job", { action: "update", job_id: jobId, state })).ok).toBe(true);
          }
          expect(await claude.call("team_job", {
            action: "reserve", source: "mcp:test", title: "overlap", resources: [requested],
          })).toMatchObject({ ok: false, error: expect.stringContaining(jobId) });
          expect(await claude.call("team_job", {
            action: "reserve", source: "mcp:test", title: "unrelated", resources: ["remote:xy", "remote:z/lane"],
          })).toMatchObject({ ok: true, value: { state: "pending", owner: "claude" } });
          expect(store.jobs()).toHaveLength(2);
        } finally {
          store.close();
        }
      });
    }
  }

  test("marks unfinished reservations unknown after an observer restart", () => {
    const directory = mkdtempSync(join(tmpdir(), "watari-job-recovery-"));
    const databasePath = join(directory, "state.db");
    const first = new TeamStore(databasePath);
    first.registerAgent({ id: "codex", backend: "codex", displayName: "Codex" });
    const job = first.reserveJob({
      owner: "codex",
      source: "harness:test",
      title: "detached test",
      resources: ["remote:test/lane"],
    });
    first.updateJob(job.id, "codex", { state: "running", handle: "result.json" });
    first.close();

    const recovered = new TeamStore(databasePath);
    recovered.markJobsUnknown();
    expect(recovered.job(job.id)).toMatchObject({ state: "unknown", handle: "result.json" });
    expect(() => recovered.reserveJob({
      owner: "codex",
      source: "harness:test",
      title: "racing test",
      resources: ["remote:test/lane"],
    })).toThrow(job.id);
    recovered.close();
    rmSync(directory, { recursive: true, force: true });
  });

  test("requires reasons only for urgent and stop delivery", async () => {
    const { store, codex } = setup();
    expect(await codex.call("team_send", { to: "claude", priority: "urgent", message: "now" }))
      .toMatchObject({ ok: false, error: expect.stringContaining("require priority_reason") });
    expect(await codex.call("team_send", {
      to: "claude",
      priority: "normal",
      priority_reason: "misclassified",
      message: "later",
    })).toMatchObject({ ok: false, error: expect.stringContaining("must omit priority_reason") });

    expect(await codex.call("team_send", {
      to: "claude",
      priority: "urgent",
      priority_reason: "must precede the normal queue",
      message: "now",
    })).toMatchObject({ ok: true });
    expect(store.inbox("claude")[0]).toMatchObject({
      priority: "urgent",
      priorityReason: "must precede the normal queue",
    });
    store.close();
  });

  test("interrupts before persisting stop mail and reports external limitations", async () => {
    const store = new TeamStore(":memory:");
    store.registerAgent({ id: "codex", backend: "codex", displayName: "Codex" });
    store.registerAgent({ id: "claude", backend: "claude", displayName: "Claude" });
    store.registerAgent({
      id: "external",
      backend: "claude",
      displayName: "External",
      mode: "external",
    });
    const calls: string[] = [];
    const service = new TeamApplicationService({
      store,
      interruptPeer: async (agent) => {
        expect(store.inbox(agent)).toEqual([]);
        calls.push(agent);
        return agent === "external"
          ? { agent, interrupted: false, limitation: "external MCP-only peers cannot be interrupted" }
          : { agent, interrupted: true };
      },
    });
    const codex = new IdentityBoundTeamTools({ agent: "codex", service });
    const result = await codex.call("team_send", {
      to: ["claude", "external"],
      priority: "stop",
      priority_reason: "continuing would modify the wrong files",
      message: "stop current work and reassess",
    });

    expect(calls.sort()).toEqual(["claude", "external"]);
    expect(result).toMatchObject({
      ok: true,
      value: {
        id: expect.any(Number),
        deliveries: [{ agent: "claude" }, { agent: "external" }],
        interruptions: [
          { agent: "claude", interrupted: true },
          { agent: "external", interrupted: false, limitation: expect.stringContaining("cannot be interrupted") },
        ],
      },
    });
    expect(store.inbox("claude")).toHaveLength(1);
    expect(store.inbox("external")).toHaveLength(1);
    store.close();
  });

  test("validates stop input before attempting an interruption", async () => {
    const store = new TeamStore(":memory:");
    store.registerAgent({ id: "codex", backend: "codex", displayName: "Codex" });
    store.registerAgent({ id: "claude", backend: "claude", displayName: "Claude" });
    let interruptions = 0;
    const service = new TeamApplicationService({
      store,
      interruptPeer: async (agent) => {
        interruptions += 1;
        return { agent, interrupted: true };
      },
    });
    const codex = new IdentityBoundTeamTools({ agent: "codex", service });

    expect(await codex.call("team_send", {
      to: "claude",
      kind: "invalid",
      priority: "stop",
      priority_reason: "the payload should fail closed",
      message: "do not interrupt",
    })).toMatchObject({ ok: false });
    expect(interruptions).toBe(0);
    expect(store.inbox("claude")).toEqual([]);
    store.close();
  });

  test("exposes status, bounded activities, progress, and authorized lifecycles", async () => {
    const { store, goal, codex, claude } = setup();
    const activity = normalizeActivityEvent({
      agent: "codex",
      kind: "tool_end",
      providerEventId: "team-activity",
      rawType: "item/completed",
      summary: "bash  inspect",
      timestamp: 5,
      payload: {
        type: "commandExecution",
        command: "inspect",
        stdout: "x".repeat(48 * 1024),
        status: "completed",
        exitCode: 0,
      },
    }, null)!;
    store.saveActivity(activity);

    expect(await codex.call("team_progress", {
      goal_id: goal.id,
      stance: "participating",
      evidence: "activity started",
    })).toMatchObject({ ok: true, value: { agent: "codex", stance: "participating" } });
    const status = await codex.call("team_status", {});
    expect(status).toMatchObject({
      ok: true,
      value: {
        you: "codex",
        peers: [{ id: "claude", state: "starting" }, { id: "codex", state: "starting" }],
        goal: { id: goal.id, participants: expect.any(Array) },
      },
    });
    // Empty sections are left out, so a quiet team costs a short answer.
    expect(Object.keys(status.value as object)).not.toContain("claims");
    expect(await codex.call("team_activity", { agent: "codex", limit: 1 }))
      .toMatchObject({ ok: true, value: [{ id: activity.summary.id, detail: true }] });
    const detail = await codex.call("team_activity_detail", {
      activity_id: activity.summary.id,
      max_bytes: 16 * 1024,
    });
    expect(detail).toMatchObject({ ok: true, value: { maximumBytes: 16 * 1024 } });
    expect(Buffer.byteLength(JSON.stringify(detail.value), "utf8")).toBeLessThan(24 * 1024);

    const createdClaim = await codex.call("team_claim", {
      goal_id: goal.id,
      scope: "activity API",
      paths: ["src/watari/activity/**"],
    });
    const claimId = (createdClaim.value as { id: string }).id;
    expect(await codex.call("team_claim_update", { claim_id: claimId, state: "active" }))
      .toMatchObject({ ok: true, value: { claimant: "codex", state: "active" } });
    expect(await claude.call("team_claim_update", { claim_id: claimId, state: "released" }))
      .toMatchObject({ ok: false, error: expect.stringContaining("only codex") });

    const finding = await codex.call("team_finding", {
      target: "claude",
      severity: "low",
      summary: "verify output cap",
    });
    const findingId = (finding.value as { id: string }).id;
    expect(await claude.call("team_finding_update", { finding_id: findingId, disposition: "accepted" }))
      .toMatchObject({ ok: true, value: { disposition: "accepted" } });
    expect(await codex.call("team_finding", {
      target: "missing",
      severity: "high",
      summary: "bad target",
    })).toMatchObject({ ok: false, error: "finding target is not in the Watari roster: missing" });
    store.close();
  });

  test("a reply threads to its question and settles it on both sides", async () => {
    const { store, codex, claude } = setup();
    const asked = await codex.call("team_send", {
      to: "claude",
      message: "Are you using the remote workspace?",
      expects_reply: true,
    });
    const questionId = (asked.value as { id: number }).id;
    // Reading the question is what makes the peer owe an answer.
    expect(await claude.call("team_inbox", {})).toMatchObject({
      ok: true,
      value: [{ id: questionId, from: "codex", expects_reply: true }],
    });
    expect(store.replyObligations("claude").map((entry) => entry.messageId)).toEqual([questionId]);
    expect(store.awaitedReplies("codex").map((entry) => entry.messageId)).toEqual([questionId]);

    expect(await claude.call("team_send", { to: "codex", message: "No, it is free.", reply_to: questionId }))
      .toMatchObject({ ok: true });
    expect(store.replyObligations("claude")).toEqual([]);
    expect(store.awaitedReplies("codex")).toEqual([]);
    expect(store.inbox("codex").at(-1)).toMatchObject({ sender: "claude", replyTo: questionId });
    store.close();
  });

  test("reply_to must name a message the caller received", async () => {
    const { store, codex, claude } = setup();
    const sent = await codex.call("team_send", { to: "claude", message: "hello" });
    const id = (sent.value as { id: number }).id;
    expect(await codex.call("team_send", { to: "claude", message: "self thread", reply_to: id }))
      .toMatchObject({ ok: false, error: expect.stringContaining("not a message addressed to codex") });
    expect(store.inbox("claude")).toHaveLength(1);
    expect(await claude.call("team_send", { to: "codex", message: "answer", reply_to: id }))
      .toMatchObject({ ok: true });
    store.close();
  });

  test("the inbox returns unread mail once instead of the whole history on every call", async () => {
    const { store, codex, claude } = setup();
    await codex.call("team_send", { to: "claude", message: "first" });
    expect((await claude.call("team_inbox", {})).value).toHaveLength(1);
    expect((await claude.call("team_inbox", {})).value).toEqual([]);
    await codex.call("team_send", { to: "claude", message: "second" });
    expect((await claude.call("team_inbox", {})).value).toMatchObject([{ text: "second" }]);
    expect((await claude.call("team_inbox", { after_id: 0 })).value).toHaveLength(2);
    store.close();
  });

  test("a claim is active at once and names the claims it overlaps", async () => {
    const { store, codex, claude } = setup();
    expect(await codex.call("team_claim", { scope: "state layer", paths: ["src/watari/state/**"] }))
      .toMatchObject({ ok: true, value: { state: "active", claimant: "codex" } });
    expect(await claude.call("team_claim", { scope: "store tests", paths: ["src/watari/state/store.ts"] }))
      .toMatchObject({
        ok: true,
        value: {
          state: "contested",
          conflicts: [{ claimant: "codex", paths: ["src/watari/state/**"] }],
        },
      });
    store.close();
  });

  test("the shared TODO list assigns work and tells only the peer that was given it", async () => {
    const { store, codex, claude } = setup();
    const added = await codex.call("team_todo", {
      action: "add",
      items: [
        { title: "Port the steer fallback", assignee: "claude", paths: ["src/watari/agents/codex.ts"] },
        { title: "Write the wake tests", assignee: "me" },
      ],
    });
    expect(added).toMatchObject({
      ok: true,
      value: { added: [{ id: 1, assignee: "claude", state: "todo" }, { id: 2, assignee: "codex" }] },
    });
    expect(store.inbox("claude").at(-1)).toMatchObject({
      sender: "watari",
      body: expect.stringContaining("codex assigned TODO #1 to you"),
    });
    expect(store.inbox("codex")).toEqual([]);

    expect(await claude.call("team_todo", { action: "update", id: 1, state: "doing" }))
      .toMatchObject({ ok: true, value: { state: "doing" } });
    expect((await claude.call("team_todo", { action: "list", filter: "mine" })).value).toMatchObject([{ id: 1 }]);
    await claude.call("team_todo", { action: "update", id: 1, state: "done", note: "landed with tests" });
    expect((await codex.call("team_todo", { action: "list" })).value).toMatchObject([{ id: 2 }]);
    expect(await codex.call("team_todo", { action: "add", items: [{ title: "lost", assignee: "nobody" }] }))
      .toMatchObject({ ok: false, error: expect.stringContaining("not in the Watari roster") });
    store.close();
  });

  test("do-not-disturb needs a reason peers can read and reports when it ends", async () => {
    const { store, codex } = setup();
    expect(await codex.call("team_availability", { mode: "dnd" }))
      .toMatchObject({ ok: false, error: expect.stringContaining("reason") });
    expect(await codex.call("team_availability", { mode: "dnd", reason: "running the migration", minutes: 15 }))
      .toMatchObject({ ok: true, value: { mode: "dnd", reason: "running the migration", ends_in: "15m" } });
    expect(store.agents().find((agent) => agent.id === "codex")).toMatchObject({ availability: "dnd" });
    expect(await codex.call("team_availability", { mode: "open" }))
      .toMatchObject({ ok: true, value: { mode: "open" } });
    expect(store.agents().find((agent) => agent.id === "codex")?.availability).toBeUndefined();
    store.close();
  });

  test("a wake takes exactly one condition and needs a live host to watch it", async () => {
    const { store, codex } = setup();
    expect(await codex.call("team_wake", { note: "check", pid: 1, path: "out.json" }))
      .toMatchObject({ ok: false, error: expect.stringContaining("exactly one") });
    expect(await codex.call("team_wake", { note: "check", after_seconds: 30 }))
      .toMatchObject({ ok: false, error: expect.stringContaining("cannot schedule wakeups") });
    store.close();
  });
});
