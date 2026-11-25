import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readCodexLbStatus, readTeamClaudeStatus, staleProviderStatus, type ProviderStatusSnapshot } from "../src/watari/provider-status.ts";
import { ProviderStatusService, type ProviderStatusDocument } from "../src/watari/provider-status-api.ts";
import { CapacityMonitor, capacityChange, type CapacityNoticePost } from "../src/watari/service/capacity-monitor.ts";
import { CoordinatorRuntime } from "../src/watari/service/runtime.ts";
import { FakeAdapter } from "./fakes/fake-adapter.ts";

type ClaudeLevel = "room" | "limited" | "drained" | "unreachable";
type CodexLevel = "room" | "out" | "out-reset" | "short-out-reset" | "unreachable";

function claudeStatus(level: ClaudeLevel): Promise<ProviderStatusSnapshot> {
  const now = Date.now();
  const row = (name: string, used: number) => ({
    name,
    provider: "anthropic",
    status: "active",
    unavailable: null,
    quota: { unified5h: used, unified5hSeenAt: now - 1_000, unified5hReset: now + 3_600_000 },
  });
  const accounts = level === "room" ? [row("a", 0.95), row("b", 0.3)]
    : level === "limited" ? [row("a", 0.95), row("b", 0.92)]
    : [row("a", 1), row("b", 1)];
  return readTeamClaudeStatus("http://127.0.0.1:3456", async () => {
    if (level === "unreachable") throw new Error("connection refused");
    return { accounts };
  });
}

function codexStatus(level: CodexLevel): Promise<ProviderStatusSnapshot> {
  return readCodexLbStatus("http://127.0.0.1:2455", async () => {
    if (level === "unreachable") throw new Error("connection refused");
    const out = level === "out" || level === "out-reset" || level === "short-out-reset";
    return { accounts: [{
      accountId: "a",
      status: out ? "quota_exceeded" : "active",
      eligible: !out,
      usageSampledAt: new Date(Date.now() - 1_000).toISOString(),
      primary: { remainingPercent: out ? 0 : 70 },
      secondary: { remainingPercent: level === "short-out-reset" ? 40 : out ? 0 : 60, windowMinutes: 10080 },
      resetCredits: { available: level === "out-reset" || level === "short-out-reset" ? 1 : 0 },
    }] };
  });
}

/** A status source whose provider levels a test can change between polls. */
function source(levels: { claude: ClaudeLevel; codex: CodexLevel }) {
  const service = new ProviderStatusService([
    { provider: "codex", source: "codexlb", read: () => codexStatus(levels.codex) },
    { provider: "claude", source: "teamclaude", read: () => claudeStatus(levels.claude) },
  ], { retries: 0 });
  return { levels, service };
}

describe("capacity change rules", () => {
  test("announces escalation once and recovery only after a checkpoint", async () => {
    const room = await claudeStatus("room");
    const limited = await claudeStatus("limited");
    const drained = await claudeStatus("drained");
    expect(capacityChange(null, room)).toEqual({ next: null, change: null });
    expect(capacityChange(null, limited)).toEqual({ next: "advisory", change: "advisory" });
    expect(capacityChange("advisory", limited)).toEqual({ next: "advisory", change: null });
    expect(capacityChange("advisory", drained)).toEqual({ next: "checkpoint", change: "checkpoint" });
    expect(capacityChange(null, drained)).toEqual({ next: "checkpoint", change: "checkpoint" });
    expect(capacityChange("checkpoint", room)).toEqual({ next: null, change: "recovered" });
    expect(capacityChange("checkpoint", limited)).toEqual({ next: "advisory", change: "advisory" });
    expect(capacityChange("advisory", room)).toEqual({ next: null, change: null });
  });

  test("stale, unreachable, and unknown readings change nothing", async () => {
    const drained = await claudeStatus("drained");
    const unreachable = await claudeStatus("unreachable");
    for (const previous of [null, "advisory", "checkpoint"] as const) {
      expect(capacityChange(previous, unreachable)).toEqual({ next: previous, change: null });
      expect(capacityChange(previous, staleProviderStatus(drained, "old"))).toEqual({ next: previous, change: null });
    }
  });

  test("banked credits withdraw a stop without falsely claiming capacity recovered", async () => {
    const pendingReset = await codexStatus("out-reset");
    expect(pendingReset.allEligibleUnavailable).toBe(true);
    expect(capacityChange(null, pendingReset)).toEqual({ next: null, change: null });
    expect(capacityChange("checkpoint", pendingReset)).toEqual({ next: "checkpoint", change: null });
    expect(capacityChange("checkpoint", await codexStatus("room"))).toEqual({ next: null, change: "recovered" });
    // Losing quota evidence does not establish usable capacity either.
    const unknownQuota = await readCodexLbStatus("http://127.0.0.1:2455", async () => ({
      accounts: [{ accountId: "a", status: "active", eligible: true, primary: { remainingPercent: 0 } }],
    }));
    expect(capacityChange("checkpoint", unknownQuota)).toEqual({ next: "checkpoint", change: null });
  });
});

describe("capacity monitor", () => {
  test("five-hour-only exhaustion with banked resets posts one checkpoint and no false recovery", async () => {
    const { levels, service } = source({ claude: "room", codex: "room" });
    const posts: CapacityNoticePost[] = [];
    const monitor = new CapacityMonitor({ source: service, post: (notice) => posts.push(notice) });
    try {
      await monitor.check();
      levels.codex = "short-out-reset";
      await monitor.check();
      await monitor.check();
      expect(posts.map((post) => post.change)).toEqual(["checkpoint"]);
      expect(posts[0]?.body).toContain("stop at a clean point");
      levels.codex = "out-reset";
      await monitor.check();
      expect(posts.map((post) => post.change)).toEqual(["checkpoint"]);
      levels.codex = "room";
      await monitor.check();
      expect(posts.map((post) => post.change)).toEqual(["checkpoint", "recovered"]);
    } finally {
      monitor.stop();
    }
  });

  test("withdraws unread checkpoint mail even on startup, with no replacement notice or reset call", async () => {
    const { levels, service } = source({ claude: "room", codex: "out-reset" });
    const posts: CapacityNoticePost[] = [];
    const withdrawn: string[] = [];
    const monitor = new CapacityMonitor({
      source: service, post: (notice) => posts.push(notice), withdraw: (provider) => withdrawn.push(provider),
    });
    try {
      await monitor.check();
      expect(withdrawn).toContain("codex");
      expect(posts).toEqual([]);
      levels.codex = "out";
      await monitor.check();
      expect(posts.map((post) => post.change)).toEqual(["checkpoint"]);
      levels.codex = "out-reset";
      await monitor.check();
      expect(posts.map((post) => post.change)).toEqual(["checkpoint"]);
      levels.codex = "room";
      await monitor.check();
      expect(posts.map((post) => post.change)).toEqual(["checkpoint", "recovered"]);
    } finally {
      monitor.stop();
    }
  });

  test("posts each change once, per provider, and ignores failed reads", async () => {
    const { levels, service } = source({ claude: "room", codex: "room" });
    const posts: CapacityNoticePost[] = [];
    const monitor = new CapacityMonitor({ source: service, post: (notice) => posts.push(notice) });
    await monitor.check();
    expect(posts).toEqual([]);

    levels.claude = "limited";
    await monitor.check();
    await monitor.check();
    expect(posts.map((post) => [post.provider, post.change])).toEqual([["claude", "advisory"]]);
    expect(posts[0]?.body).toContain("90% or more");

    levels.claude = "unreachable";
    levels.codex = "out";
    await monitor.check();
    expect(posts.map((post) => [post.provider, post.change])).toEqual([["claude", "advisory"], ["codex", "checkpoint"]]);
    expect(posts[1]?.body).toContain("Every ChatGPT/Codex account CodexLB can route to is out of quota");

    levels.codex = "room";
    await monitor.check();
    expect(posts.at(-1)).toMatchObject({ provider: "codex", change: "recovered" });
    expect(posts.at(-1)?.body).toContain("You can resume");

    const failing = new CapacityMonitor({
      source: { refresh: async (): Promise<ProviderStatusDocument> => { throw new Error("boom"); } },
      post: (notice) => posts.push(notice),
    });
    const before = posts.length;
    await failing.check();
    expect(posts.length).toBe(before);
    monitor.stop();
    service.close();
  });
});

describe("runtime capacity notices", () => {
  const runtimes: CoordinatorRuntime[] = [];
  const directories: string[] = [];
  afterEach(async () => {
    while (runtimes.length > 0) await runtimes.pop()!.stop();
    while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true });
  });

  test("a maintenance restart retires an old unread stop when banked credits are available", async () => {
    const directory = mkdtempSync(join(tmpdir(), "watari-capacity-"));
    directories.push(directory);
    const start = async (level: CodexLevel) => {
      const { service } = source({ claude: "room", codex: level });
      const adapter = new FakeAdapter("codex");
      const runtime = new CoordinatorRuntime({
        project: { launchDirectory: directory, repositoryRoot: null },
        databasePath: join(directory, "state.db"),
        roster: [{ alias: "codex", provider: "codex", displayName: "Codex", mode: "managed", unrestricted: true }],
        adapters: { codex: adapter }, capacityStatus: service,
      });
      runtimes.push(runtime);
      await runtime.start();
      return { runtime, adapter };
    };
    const before = await start("out");
    const deadline = Date.now() + 5_000;
    while (!before.runtime.snapshot().messages.some((message) => message.body.includes("out of quota"))) {
      if (Date.now() > deadline) throw new Error("no initial checkpoint");
      await Bun.sleep(10);
    }
    expect(before.adapter.inputs).toHaveLength(0);
    await before.runtime.stop();

    const after = await start("out-reset");
    // Initial status refresh and passive delivery are asynchronous.
    await Bun.sleep(150);
    const inbox = await after.runtime.callTeamTool("codex", "team_inbox", {});
    expect(inbox).toMatchObject({ ok: true, value: [] });
    expect(after.adapter.inputs).toHaveLength(0);
    const history = after.runtime.snapshot().messages;
    expect(history.filter((message) => message.body.includes("out of quota"))).toHaveLength(1);
    expect(history.some((message) => message.body.includes("capacity again"))).toBe(false);
  });

  test("reach only the agents on that provider and never start a turn", async () => {
    const { service } = source({ claude: "room", codex: "out" });
    const codex = new FakeAdapter("codex");
    const claude = new FakeAdapter("claude");
    const runtime = new CoordinatorRuntime({
      project: { launchDirectory: "/tmp/project", repositoryRoot: "/tmp/project" },
      databasePath: ":memory:",
      adapters: { codex, claude },
      capacityStatus: service,
      capacityPollMs: 60_000,
    });
    runtimes.push(runtime);
    await runtime.start();
    const deadline = Date.now() + 5_000;
    const notices = () => runtime.snapshot().messages.filter((message) => message.sender === "watari" && message.body.includes("out of quota"));
    while (notices().length === 0) {
      if (Date.now() > deadline) throw new Error("no capacity notice was posted");
      await Bun.sleep(10);
    }
    await Bun.sleep(150);
    const [notice] = notices();
    expect(notice).toMatchObject({ recipients: ["codex"], delivery: "passive", priority: "urgent", kind: "system" });
    // Passive mail never starts a turn on an idle agent by itself.
    expect(codex.inputs).toHaveLength(0);
    expect(claude.inputs).toHaveLength(0);
  });

  test("stay silent for a provider the harnesses do not route through", async () => {
    const { service } = source({ claude: "drained", codex: "out" });
    const runtime = new CoordinatorRuntime({
      project: { launchDirectory: "/tmp/project", repositoryRoot: "/tmp/project" },
      databasePath: ":memory:",
      adapters: { codex: new FakeAdapter("codex"), claude: new FakeAdapter("claude") },
      capacityStatus: service,
      capacityPollMs: 60_000,
      capacityProviders: new Set(["codex"]),
    });
    runtimes.push(runtime);
    await runtime.start();
    const deadline = Date.now() + 5_000;
    const notices = () => runtime.snapshot().messages.filter((message) => message.sender === "watari" && message.body.includes("out of quota"));
    while (notices().length === 0) {
      if (Date.now() > deadline) throw new Error("no capacity notice was posted");
      await Bun.sleep(10);
    }
    await Bun.sleep(150);
    expect(notices().map((message) => message.recipients)).toEqual([["codex"]]);
  });
});
