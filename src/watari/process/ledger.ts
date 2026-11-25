import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

/**
 * The native harness process groups a service has running, kept on disk.
 *
 * A service that is killed outright (SIGKILL, an OOM kill, a crashed host
 * terminal) runs none of its cleanup. Its harnesses live in detached process
 * groups, so an idle one exits when its stdin closes but one in the middle of a
 * turn, and the tool commands under it, can keep going with nobody reading
 * them. The next service would then resume the same conversation beside it,
 * and two harnesses would edit one checkout from one context. The ledger lets
 * the next service end those leftovers before it resumes anything.
 *
 * Every entry carries the process start time from `/proc`, so a PID the kernel
 * has since handed to an unrelated process is never signalled.
 */
interface LedgerEntry {
  readonly pid: number;
  readonly startTime: string;
}

let ledgerPath: string | null = null;
const tracked = new Map<number, LedgerEntry>();

/** Binds the ledger to one project's state directory. Tests leave it unset. */
export function configureProcessLedger(path: string | null): void {
  ledgerPath = path;
  tracked.clear();
  persist();
}

/** Records a harness process group leader the moment it is spawned. */
export function trackProcess(pid: number | undefined): void {
  if (!ledgerPath || !pid || pid <= 1) return;
  const startTime = processStartTime(pid);
  if (startTime === null) return;
  tracked.set(pid, { pid, startTime });
  persist();
}

export function untrackProcess(pid: number | undefined): void {
  if (!pid || !tracked.delete(pid)) return;
  persist();
}

/**
 * Ends the process groups a previous service left behind, then empties the
 * ledger. Returns how many were still running.
 */
export async function reapLeftoverProcesses(path: string, graceMs = 2_000): Promise<number> {
  let entries: LedgerEntry[] = [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (Array.isArray(parsed)) entries = parsed.filter(isEntry);
  } catch {
    return 0;
  }
  const alive = entries.filter((entry) => processStartTime(entry.pid) === entry.startTime);
  for (const entry of alive) signalGroup(entry.pid, "SIGTERM");
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && alive.some((entry) => processStartTime(entry.pid) === entry.startTime)) {
    await Bun.sleep(50);
  }
  for (const entry of alive) {
    if (processStartTime(entry.pid) === entry.startTime) signalGroup(entry.pid, "SIGKILL");
  }
  try {
    atomicWrite(path, "[]\n");
  } catch {
    // The directory went away. There is nothing left to protect.
  }
  return alive.length;
}

function persist(): void {
  if (!ledgerPath) return;
  try {
    atomicWrite(ledgerPath, `${JSON.stringify([...tracked.values()])}\n`);
  } catch {
    // A ledger that cannot be written only loses the crash cleanup. It must
    // never stop a harness from starting.
  }
}

/** Field 22 of `/proc/<pid>/stat`, in clock ticks since boot. Null when gone. */
export function processStartTime(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // The command name is parenthesised and may contain spaces, so fields are
    // counted from the last closing parenthesis.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const zombie = fields[0] === "Z";
    return zombie ? null : fields[19] ?? null;
  } catch {
    return null;
  }
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone.
    }
  }
}

function isEntry(value: unknown): value is LedgerEntry {
  return typeof value === "object" && value !== null &&
    typeof (value as LedgerEntry).pid === "number" && typeof (value as LedgerEntry).startTime === "string";
}

function atomicWrite(path: string, content: string): void {
  const staging = `${path}.${process.pid}.tmp`;
  writeFileSync(staging, content, { mode: 0o600 });
  renameSync(staging, path);
  if (existsSync(path)) chmodSync(path, 0o600);
}
