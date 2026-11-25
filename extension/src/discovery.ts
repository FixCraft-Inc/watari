import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { StatusReport } from "./protocol.js";
import { parseStatusReport } from "./validation.js";

const run = promisify(execFile);

/** A `watari` that could not be run at all, as opposed to one that ran and
 * reported a stopped service. The two need different messages: one is an
 * installation problem, the other is an ordinary "nothing started yet". */
export class ExecutableMissingError extends Error {
  constructor(executable: string, cause: string) {
    super(
      `Could not run "${executable}". Install Watari and put it on PATH, or set ` +
        `watari.executablePath to its absolute location. (${cause})`,
    );
    this.name = "ExecutableMissingError";
  }
}

export interface Discovery {
  readonly running: boolean;
  readonly socketPath: string;
  readonly apiVersion: number | null;
  readonly stateDirectory: string;
  readonly pid: number | null;
}

/**
 * Asks the installed executable where its service is.
 *
 * The socket path is deliberately not reconstructed here. Watari derives it
 * from a hash of the repository root under `XDG_STATE_HOME`, and a copy of that
 * rule in this extension would be a second source of truth that silently breaks
 * the day the layout changes. `status --json` is the published answer.
 */
export async function discover(
  executable: string,
  projectPath: string,
  signal?: AbortSignal,
): Promise<Discovery> {
  const report = await status(executable, projectPath, signal);
  if (report.service.state === "incompatible") {
    throw new Error(
      report.service.detail ??
        `A Watari service is running for this folder, but it does not speak local API ` +
          `v${report.service.expectedApiVersion}. Stop or upgrade that service before reconnecting.`,
    );
  }
  return {
    running: report.service.state === "running",
    socketPath: report.service.socketPath,
    apiVersion: report.service.apiVersion,
    stateDirectory: report.stateDirectory,
    pid: report.service.pid,
  };
}

export async function status(
  executable: string,
  projectPath: string,
  signal?: AbortSignal,
): Promise<StatusReport> {
  let stdout: string;
  try {
    // `status` exits non-zero when the service is stopped, which is information
    // rather than failure, so the report is read from stdout either way.
    ({ stdout } = await run(executable, ["status", projectPath, "--json"], {
      maxBuffer: 8 * 1024 * 1024,
      timeout: 15_000,
      signal,
    }));
  } catch (error) {
    const failure = error as { stdout?: string; code?: string; name?: string; message?: string };
    if (signal?.aborted || failure.name === "AbortError" || failure.code === "ABORT_ERR") {
      throw new Error("Cancelled while asking Watari for service status.");
    }
    if (failure.code === "ENOENT" || failure.code === "EACCES") {
      throw new ExecutableMissingError(executable, failure.code);
    }
    if (typeof failure.stdout === "string" && failure.stdout.trim() !== "") {
      stdout = failure.stdout;
    } else {
      throw new ExecutableMissingError(executable, failure.message ?? "unknown error");
    }
  }

  let report: StatusReport;
  try {
    report = parseStatusReport(JSON.parse(stdout) as unknown);
  } catch (error) {
    throw new Error(
      "This Watari build returned an invalid status report. Upgrade Watari, or run " +
        `\`watari status . --json\` to inspect it. (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  return report;
}

/**
 * Starts a service for this project and waits for it to answer.
 *
 * `watari serve` is the headless half of `watari ui`: it starts the detached
 * per-project service and exits, leaving nothing attached to this process. The
 * service is meant to outlive whoever started it, which is the whole reason the
 * extension does not host it.
 */
export async function startService(
  executable: string,
  projectPath: string,
  signal: AbortSignal,
): Promise<Discovery> {
  try {
    await run(executable, ["serve", projectPath, "--json"], {
      maxBuffer: 8 * 1024 * 1024,
      timeout: 60_000,
      signal,
    });
  } catch (error) {
    const failure = error as { code?: string; name?: string; stderr?: string; message?: string };
    if (signal.aborted || failure.name === "AbortError" || failure.code === "ABORT_ERR") {
      throw new Error("Cancelled while starting the Watari service.");
    }
    if (failure.code === "ENOENT" || failure.code === "EACCES") {
      throw new ExecutableMissingError(executable, failure.code);
    }
    throw new Error(
      `Watari could not start a service for this folder: ${
        (failure.stderr ?? failure.message ?? "unknown error").trim()
      }`,
    );
  }
  if (signal.aborted) throw new Error("Cancelled while starting the Watari service.");

  const found = await discover(executable, projectPath, signal);
  if (!found.running) throw new Error("Watari reported no running service after starting one.");
  return found;
}
