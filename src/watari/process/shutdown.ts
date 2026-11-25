type Cleanup = () => Promise<void>;

const cleanups = new Set<Cleanup>();
let installed = false;
let receivedSignal: NodeJS.Signals | null = null;

export function registerProcessCleanup(cleanup: Cleanup): () => void {
  installHandlers();
  cleanups.add(cleanup);
  return () => cleanups.delete(cleanup);
}

/**
 * Runs every registered cleanup now.
 *
 * The signal handlers do this on the way out; a service that stops because it
 * went idle has no signal, and a provider whose own shutdown was abandoned
 * still has a process group that must not outlive Watari.
 */
export async function runProcessCleanups(): Promise<void> {
  await Promise.allSettled([...cleanups].map((cleanup) => cleanup()));
}

export function interruptedExitCode(): number | null {
  if (receivedSignal === "SIGINT") {
    return 130;
  }
  if (receivedSignal === "SIGTERM") {
    return 143;
  }
  return null;
}

function installHandlers(): void {
  if (installed) {
    return;
  }
  installed = true;
  process.once("SIGINT", () => void handleSignal("SIGINT"));
  process.once("SIGTERM", () => void handleSignal("SIGTERM"));
}

async function handleSignal(signal: NodeJS.Signals): Promise<void> {
  receivedSignal = signal;
  await Promise.allSettled([...cleanups].map((cleanup) => cleanup()));
  const exitCode = interruptedExitCode() ?? 1;
  process.exitCode = exitCode;
  process.exit(exitCode);
}
