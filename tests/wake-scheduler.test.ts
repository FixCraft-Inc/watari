import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  WakeScheduler,
  describeWakeCondition,
  formatDuration,
  type WakeOutcome,
} from "../src/watari/service/wake-scheduler.ts";
import type { TeamWake, WakeCondition } from "../src/watari/state/types.ts";

const directories: string[] = [];
const schedulers: WakeScheduler[] = [];

afterEach(() => {
  for (const scheduler of schedulers.splice(0)) scheduler.stop();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function wake(id: number, condition: WakeCondition, deadlineMs = 5_000): TeamWake {
  const now = Date.now();
  return {
    id,
    agent: "codex",
    condition,
    note: "read the result",
    state: "pending",
    createdAt: now,
    deadlineAt: now + deadlineMs,
    settledAt: null,
    outcome: null,
  };
}

function watch(cwd = directory()) {
  const settled: { readonly wake: TeamWake; readonly outcome: WakeOutcome }[] = [];
  const scheduler = new WakeScheduler({
    cwd,
    pollMs: 20,
    onSettled: (entry, outcome) => settled.push({ wake: entry, outcome }),
  });
  schedulers.push(scheduler);
  return { scheduler, settled };
}

describe("WakeScheduler", () => {
  test("a timer fires once, at its deadline", async () => {
    const { scheduler, settled } = watch();
    scheduler.start(wake(1, { kind: "timer", afterSeconds: 1 }, 50));
    expect(scheduler.pending).toBe(1);
    await waitUntil(() => settled.length === 1);
    expect(settled[0]?.outcome.state).toBe("fired");
    expect(scheduler.pending).toBe(0);
  });

  test("a path condition fires when the file appears", async () => {
    const cwd = directory();
    const { scheduler, settled } = watch(cwd);
    scheduler.start(wake(2, { kind: "path", path: "result.json" }));
    await Bun.sleep(60);
    expect(settled).toEqual([]);
    writeFileSync(join(cwd, "result.json"), "{}");
    await waitUntil(() => settled.length === 1);
    expect(settled[0]?.outcome).toMatchObject({ state: "fired", summary: "result.json exists" });
  });

  test("a pid condition fires when the process exits", async () => {
    const child = Bun.spawn(["sleep", "0.2"]);
    const { scheduler, settled } = watch();
    scheduler.start(wake(3, { kind: "pid", pid: child.pid }));
    await child.exited;
    await waitUntil(() => settled.length === 1);
    expect(settled[0]?.outcome.summary).toBe(`process ${child.pid} exited`);
  });

  test("a command condition fires on exit 0 and keeps the tail of its output", async () => {
    const { scheduler, settled } = watch();
    scheduler.start(wake(4, {
      kind: "command",
      argv: ["sh", "-c", "echo suite passed: 42 tests"],
      intervalSeconds: 1,
    }));
    await waitUntil(() => settled.length === 1);
    expect(settled[0]?.outcome).toMatchObject({ state: "fired", output: "suite passed: 42 tests" });
  });

  test("a command that keeps failing times out and reports its last check", async () => {
    const { scheduler, settled } = watch();
    scheduler.start(wake(5, {
      kind: "command",
      argv: ["sh", "-c", "echo still running && exit 3"],
      intervalSeconds: 1,
    }, 300));
    await waitUntil(() => settled.length === 1);
    expect(settled[0]?.outcome).toMatchObject({ state: "expired", output: "still running" });
    expect(settled[0]?.outcome.summary).toContain("last check: exit 3");
  });

  test("a command that cannot start fails at once instead of waiting out its deadline", async () => {
    const { scheduler, settled } = watch();
    scheduler.start(wake(6, { kind: "command", argv: ["/nonexistent/watari-check"], intervalSeconds: 60 }, 60_000));
    await waitUntil(() => settled.length === 1);
    expect(settled[0]?.outcome.state).toBe("failed");
  });

  test("a cancelled wake never reports", async () => {
    const { scheduler, settled } = watch();
    scheduler.start(wake(7, { kind: "timer", afterSeconds: 1 }, 40));
    expect(scheduler.cancel(7)).toBe(true);
    await Bun.sleep(80);
    expect(settled).toEqual([]);
    expect(scheduler.pending).toBe(0);
  });

  test("descriptions read as what the peer is waiting for", () => {
    expect(describeWakeCondition({ kind: "pid", pid: 12 })).toBe("process 12 to exit");
    expect(describeWakeCondition({
      kind: "command",
      argv: ["ssh", "build-host", "test", "-f", "/tmp/result.json"],
      intervalSeconds: 120,
    })).toBe("`ssh build-host test -f /tmp/result.json` to exit 0 (checked every 2m)");
    expect(formatDuration(4 * 60 * 60 * 1_000 + 5 * 60 * 1_000)).toBe("4h 5m");
    expect(formatDuration(42_000)).toBe("42s");
  });
});

function directory(): string {
  const created = mkdtempSync(join(tmpdir(), "watari-wake-"));
  directories.push(created);
  return created;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition was not reached in time");
    await Bun.sleep(5);
  }
}
