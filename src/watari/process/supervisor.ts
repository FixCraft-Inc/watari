import { JsonLineDecoder, type JsonLineResult } from "./jsonl.ts";
import { registerProcessCleanup } from "./shutdown.ts";
import { trackProcess, untrackProcess } from "./ledger.ts";
import { redactSecrets } from "../security/redaction.ts";

const DEFAULT_GRACE_MS = 2_000;
const SIGNAL_GRACE_MS = 250;
const STDERR_CHUNK_LIMIT = 64 * 1024;
const COMMAND_OUTPUT_LIMIT = 8 * 1024 * 1024;

export interface ManagedProcessOptions {
  readonly command: readonly [string, ...string[]];
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly maxJsonLineBytes?: number;
  readonly onJsonLine: (result: JsonLineResult) => void;
  readonly onDiagnostic?: (message: string) => void;
  readonly onTransportError?: (error: Error) => void;
}

export class ManagedProcess {
  readonly #child: Bun.Subprocess<"pipe", "pipe", "pipe">;
  readonly #onJsonLine: ManagedProcessOptions["onJsonLine"];
  readonly #onDiagnostic: NonNullable<ManagedProcessOptions["onDiagnostic"]>;
  readonly #onTransportError: NonNullable<
    ManagedProcessOptions["onTransportError"]
  >;
  readonly #decoder: JsonLineDecoder;
  readonly #stdoutTask: Promise<void>;
  readonly #stderrTask: Promise<void>;
  readonly #unregisterCleanup: () => void;
  #closed = false;
  #stopPromise: Promise<number> | null = null;

  private constructor(options: ManagedProcessOptions) {
    this.#onJsonLine = options.onJsonLine;
    this.#onDiagnostic = options.onDiagnostic ?? (() => undefined);
    this.#onTransportError = options.onTransportError ?? (() => undefined);
    this.#decoder = new JsonLineDecoder(options.maxJsonLineBytes);
    const environment = cleanEnvironment(options.env);
    this.#child = Bun.spawn([...options.command], {
      cwd: options.cwd,
      env: environment,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      detached: process.platform !== "win32",
    });
    trackProcess(this.#child.pid);
    void this.#child.exited.then(() => untrackProcess(this.#child.pid));
    this.#stdoutTask = this.#readStdout();
    this.#stderrTask = this.#readStderr();
    this.#unregisterCleanup = registerProcessCleanup(async () => {
      await this.stop(SIGNAL_GRACE_MS);
    });
  }

  static start(options: ManagedProcessOptions): ManagedProcess {
    return new ManagedProcess(options);
  }

  get pid(): number {
    return this.#child.pid;
  }

  get exitCode(): number | null {
    return this.#child.exitCode;
  }

  get exited(): Promise<number> {
    return this.#child.exited;
  }

  writeJson(value: unknown): void {
    this.writeLine(JSON.stringify(value));
  }

  writeLine(value: string): void {
    if (this.#closed || this.#child.exitCode !== null) {
      throw new Error("cannot write to a closed provider process");
    }
    this.#child.stdin.write(`${value}\n`);
    this.#child.stdin.flush();
  }

  async stop(graceMs = DEFAULT_GRACE_MS): Promise<number> {
    this.#stopPromise ??= this.#stopInternal(graceMs);
    return await this.#stopPromise;
  }

  async #stopInternal(graceMs: number): Promise<number> {
    try {
      if (!this.#closed) {
        this.#closed = true;
        this.#child.stdin.end();
      }
      let exitCode = await waitForExit(this.#child, graceMs);
      if (exitCode === null) {
        signalProcessGroup(this.#child, "SIGTERM");
        exitCode = await waitForExit(this.#child, graceMs);
      }
      if (exitCode === null) {
        signalProcessGroup(this.#child, "SIGKILL");
        exitCode = await this.#child.exited;
      }
      await Promise.allSettled([this.#stdoutTask, this.#stderrTask]);
      return exitCode;
    } finally {
      this.#unregisterCleanup();
    }
  }

  interrupt(): void {
    signalProcessGroup(this.#child, "SIGINT");
  }

  async #readStdout(): Promise<void> {
    try {
      const reader = this.#child.stdout.getReader();
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }
        for (const result of this.#decoder.push(value)) {
          this.#onJsonLine(result);
        }
      }
      for (const result of this.#decoder.finish()) {
        this.#onJsonLine(result);
      }
    } catch (error) {
      this.#onTransportError(asError(error));
    }
  }

  async #readStderr(): Promise<void> {
    const decoder = new TextDecoder("utf-8", { fatal: false });
    try {
      const reader = this.#child.stderr.getReader();
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }
        const diagnostic = decoder.decode(value, { stream: true });
        if (diagnostic) {
          this.#onDiagnostic(
            redactSecrets(diagnostic.slice(0, STDERR_CHUNK_LIMIT)).trimEnd(),
          );
        }
      }
      const remainder = decoder.decode();
      if (remainder) {
        this.#onDiagnostic(redactSecrets(remainder).trimEnd());
      }
    } catch (error) {
      this.#onTransportError(asError(error));
    }
  }
}

export interface ContainedCommandOptions {
  readonly command: readonly [string, ...string[]];
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

export interface ContainedCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs a short provider-owned command with the same containment and cleanup
 * rules as a long-lived harness. Output is bounded before it is decoded. */
export async function runContainedCommand(
  options: ContainedCommandOptions,
): Promise<ContainedCommandResult> {
  const child = Bun.spawn([...options.command], {
    cwd: options.cwd,
    env: cleanEnvironment(options.env),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    detached: process.platform !== "win32",
  });
  trackProcess(child.pid);
  void child.exited.then(() => untrackProcess(child.pid));
  let stopPromise: Promise<number> | null = null;
  const stop = async (): Promise<number> => {
    stopPromise ??= (async () => {
      let exitCode = await waitForExit(child, SIGNAL_GRACE_MS);
      if (exitCode === null) {
        signalProcessGroup(child, "SIGTERM");
        exitCode = await waitForExit(child, SIGNAL_GRACE_MS);
      }
      if (exitCode === null) {
        signalProcessGroup(child, "SIGKILL");
        exitCode = await child.exited;
      }
      return exitCode;
    })();
    return await stopPromise;
  };
  const unregisterCleanup = registerProcessCleanup(async () => {
    await stop();
  });
  const limit = options.maxOutputBytes ?? COMMAND_OUTPUT_LIMIT;
  const stdoutTask = readBounded(child.stdout, limit, "stdout");
  const stderrTask = readBounded(child.stderr, limit, "stderr");
  // Attach handlers immediately: a noisy child can exceed the bound before it
  // exits, and the rejection must not spend that interval unobserved.
  void stdoutTask.catch(() => undefined);
  void stderrTask.catch(() => undefined);
  try {
    const exitCode = await waitForExit(child, options.timeoutMs ?? 15_000);
    if (exitCode === null) {
      await stop();
      throw new Error(`provider command timed out after ${options.timeoutMs ?? 15_000}ms`);
    }
    const [stdout, stderr] = await Promise.all([stdoutTask, stderrTask]);
    return { exitCode, stdout, stderr: redactSecrets(stderr) };
  } catch (error) {
    await stop();
    await Promise.allSettled([stdoutTask, stderrTask]);
    throw error;
  } finally {
    unregisterCleanup();
  }
}

function cleanEnvironment(
  overrides: Readonly<Record<string, string | undefined>> | undefined,
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries({ ...process.env, ...overrides })) {
    if (value !== undefined) {
      environment[key] = value;
    }
  }
  return environment;
}

async function readBounded(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  label: string,
): Promise<string> {
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const reader = stream.getReader();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      throw new Error(`provider ${label} exceeded ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const output = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(output);
}

async function waitForExit(
  child: Bun.Subprocess,
  timeoutMs: number,
): Promise<number | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  const result = await Promise.race([child.exited, timeout]);
  if (timer) {
    clearTimeout(timer);
  }
  return result;
}

function signalProcessGroup(
  child: Bun.Subprocess,
  signal: NodeJS.Signals,
): void {
  if (child.exitCode !== null || child.pid <= 1) {
    return;
  }
  try {
    if (process.platform !== "win32") {
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ESRCH") {
      throw error;
    }
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
