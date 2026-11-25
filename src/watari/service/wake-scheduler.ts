import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import { redactSummary, stripTerminalControl } from "../security/redaction.ts";
import type { TeamWake, WakeCondition } from "../state/types.ts";

/** How often a process or path condition is looked at. Each look is one syscall. */
const DEFAULT_POLL_MS = 5_000;
/** A command check that runs longer than this is killed and counts as not met. */
const MAX_CHECK_MS = 120_000;
/** Output kept from a command check, enough for a verdict line or a short tail. */
const OUTPUT_TAIL_CHARS = 2_000;

export interface WakeOutcome {
  readonly state: "fired" | "expired" | "failed";
  /** One line saying what happened, written for the peer being woken. */
  readonly summary: string;
  /** Bounded, redacted tail of the deciding command check. */
  readonly output?: string;
}

export interface WakeSchedulerOptions {
  /** Relative paths and command checks resolve against the shared checkout. */
  readonly cwd: string;
  readonly onSettled: (wake: TeamWake, outcome: WakeOutcome) => void;
  /** Tests shorten process and path polling. */
  readonly pollMs?: number;
}

interface Watch {
  readonly wake: TeamWake;
  readonly timers: Set<ReturnType<typeof setTimeout>>;
  child: ChildProcess | null;
  checks: number;
  lastCheck: string | null;
  lastOutput: string;
  settled: boolean;
}

/**
 * Watches the conditions peers asked to be woken on.
 *
 * A peer that starts a long job should end its turn rather than spend tokens
 * watching it, and some harnesses cannot wake themselves at all. The scheduler
 * holds the watch on the peer's behalf and reports exactly once: when the
 * condition is met, when it can never be met, or when the deadline passes. It
 * never starts a model turn itself. The runtime turns the outcome into a
 * notice and delivers it like mail.
 */
export class WakeScheduler {
  readonly #cwd: string;
  readonly #onSettled: WakeSchedulerOptions["onSettled"];
  readonly #pollMs: number;
  readonly #watches = new Map<number, Watch>();

  constructor(options: WakeSchedulerOptions) {
    this.#cwd = options.cwd;
    this.#onSettled = options.onSettled;
    this.#pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  }

  /** Watches still waiting. Each one is a reason to keep the service alive. */
  get pending(): number {
    return this.#watches.size;
  }

  start(wake: TeamWake): void {
    if (this.#watches.has(wake.id)) return;
    const watch: Watch = {
      wake,
      timers: new Set(),
      child: null,
      checks: 0,
      lastCheck: null,
      lastOutput: "",
      settled: false,
    };
    this.#watches.set(wake.id, watch);
    const remaining = Math.max(0, wake.deadlineAt - Date.now());
    const condition = wake.condition;
    if (condition.kind === "timer") {
      this.#after(watch, remaining, () =>
        this.#settle(watch, {
          state: "fired",
          summary: `${formatDuration(condition.afterSeconds * 1_000)} timer elapsed`,
        }));
      return;
    }
    this.#after(watch, remaining, () => this.#settle(watch, this.#expiry(watch)));
    if (condition.kind === "command") {
      // Checked at once, so a job that already finished does not cost a wait.
      this.#runCheck(watch, condition);
    } else {
      this.#after(watch, this.#pollMs, () => this.#poll(watch, condition));
    }
  }

  /** Stops one watch without reporting it. */
  cancel(id: number): boolean {
    const watch = this.#watches.get(id);
    if (!watch) return false;
    this.#dispose(watch);
    return true;
  }

  cancelAgent(agent: string): number[] {
    const ids = [...this.#watches.values()]
      .filter((watch) => watch.wake.agent === agent)
      .map((watch) => watch.wake.id);
    for (const id of ids) this.cancel(id);
    return ids;
  }

  stop(): void {
    for (const watch of [...this.#watches.values()]) this.#dispose(watch);
  }

  #poll(watch: Watch, condition: Extract<WakeCondition, { kind: "pid" | "path" }>): void {
    if (watch.settled) return;
    watch.checks += 1;
    const met = condition.kind === "pid"
      ? !processIsAlive(condition.pid)
      : existsSync(resolveWakePath(this.#cwd, condition.path));
    if (met) {
      this.#settle(watch, {
        state: "fired",
        summary: condition.kind === "pid"
          ? `process ${condition.pid} exited`
          : `${condition.path} exists`,
      });
      return;
    }
    this.#after(watch, this.#pollMs, () => this.#poll(watch, condition));
  }

  #runCheck(watch: Watch, condition: Extract<WakeCondition, { kind: "command" }>): void {
    if (watch.settled) return;
    watch.checks += 1;
    const [file, ...args] = condition.argv;
    let output = "";
    let child: ChildProcess;
    try {
      // No shell. The argv is exactly what the peer wrote, in its own process
      // group, so a check that hangs is killed with everything it started.
      child = spawn(file ?? "", args, {
        cwd: this.#cwd,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      });
    } catch (error) {
      this.#settle(watch, { state: "failed", summary: `command could not start: ${errorMessage(error)}` });
      return;
    }
    watch.child = child;
    const append = (chunk: Buffer | string): void => {
      output = (output + String(chunk)).slice(-OUTPUT_TAIL_CHARS * 2);
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    const limit = Math.min(MAX_CHECK_MS, Math.max(5_000, condition.intervalSeconds * 1_000));
    const killer = setTimeout(() => signalGroup(child, "SIGKILL"), limit);
    killer.unref?.();

    let finished = false;
    const finish = (code: number | null, signal: NodeJS.Signals | null, error?: Error): void => {
      if (finished) return;
      finished = true;
      clearTimeout(killer);
      if (watch.child === child) watch.child = null;
      if (watch.settled) return;
      if (error) {
        this.#settle(watch, { state: "failed", summary: `command could not start: ${error.message}` });
        return;
      }
      const tail = cleanOutput(output);
      if (code === 0) {
        this.#settle(watch, {
          state: "fired",
          summary: `${describeCommand(condition.argv)} exited 0 on check ${watch.checks}`,
          ...(tail ? { output: tail } : {}),
        });
        return;
      }
      watch.lastCheck = signal ? `killed by ${signal}` : `exit ${code}`;
      watch.lastOutput = tail;
      this.#after(watch, condition.intervalSeconds * 1_000, () => this.#runCheck(watch, condition));
    };
    child.once("error", (error) => finish(null, null, error));
    child.once("close", (code, signal) => finish(code, signal));
  }

  #expiry(watch: Watch): WakeOutcome {
    const waited = formatDuration(watch.wake.deadlineAt - watch.wake.createdAt);
    const last = watch.lastCheck ? ` (last check: ${watch.lastCheck})` : "";
    return {
      state: "expired",
      summary: `timed out after ${waited} waiting for ${describeWakeCondition(watch.wake.condition)}${last}`,
      ...(watch.lastOutput ? { output: watch.lastOutput } : {}),
    };
  }

  #settle(watch: Watch, outcome: WakeOutcome): void {
    if (watch.settled) return;
    this.#dispose(watch);
    this.#onSettled(watch.wake, outcome);
  }

  #dispose(watch: Watch): void {
    watch.settled = true;
    for (const timer of watch.timers) clearTimeout(timer);
    watch.timers.clear();
    if (watch.child) signalGroup(watch.child, "SIGKILL");
    watch.child = null;
    this.#watches.delete(watch.wake.id);
  }

  #after(watch: Watch, delayMs: number, run: () => void): void {
    if (watch.settled) return;
    const timer = setTimeout(() => {
      watch.timers.delete(timer);
      run();
    }, delayMs);
    timer.unref?.();
    watch.timers.add(timer);
  }
}

/** What a wake is waiting for, phrased to follow "waiting for". */
export function describeWakeCondition(condition: WakeCondition): string {
  switch (condition.kind) {
    case "timer":
      return `a ${formatDuration(condition.afterSeconds * 1_000)} timer`;
    case "pid":
      return `process ${condition.pid} to exit`;
    case "path":
      return `${condition.path} to exist`;
    case "command":
      return `${describeCommand(condition.argv)} to exit 0 (checked every ${formatDuration(condition.intervalSeconds * 1_000)})`;
  }
}

export function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

/** Signal 0 only probes. A process owned by someone else still exists. */
export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "EPERM";
  }
}

export function resolveWakePath(cwd: string, path: string): string {
  return isAbsolute(path) ? path : resolve(cwd, path);
}

function describeCommand(argv: readonly string[]): string {
  const text = argv
    .map((part) => (/^[\w./:=@%+,-]+$/u.test(part) ? part : JSON.stringify(part)))
    .join(" ");
  return `\`${redactSummary(text.length > 200 ? `${text.slice(0, 199)}…` : text)}\``;
}

function cleanOutput(output: string): string {
  const text = redactSummary(stripTerminalControl(output)).trim();
  return text.length > OUTPUT_TAIL_CHARS ? `…${text.slice(-OUTPUT_TAIL_CHARS)}` : text;
}

function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (!pid || child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Already gone.
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
