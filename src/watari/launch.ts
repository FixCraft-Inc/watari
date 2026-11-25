import { closeSync, openSync } from "node:fs";

import type { ProjectContext } from "./models.ts";
import { RuntimeClient, ServiceProtocolError } from "./service/client.ts";
import { selfCommand } from "./service/self.ts";
import { resolveStateLocation, type StateLocation } from "./state/location.ts";

const SERVICE_START_TIMEOUT_MS = 20_000;

/**
 * Starts this project's service if it is not already answering.
 *
 * The detached child is deliberately not adopted by whoever called this: the
 * service owns the provider children and is meant to outlive every client, so
 * the caller's job ends once the socket answers.
 */
export async function ensureService(
  project: ProjectContext,
  location: StateLocation,
): Promise<RuntimeClient> {
  const existing = await tryConnect(location.socketPath);
  if (existing) return existing;

  const logDescriptor = openSync(location.logPath, "a", 0o600);
  let child;
  try {
    child = Bun.spawn(
      selfCommand([
        "internal-service",
        "--project",
        project.launchDirectory,
        "--database",
        location.databasePath,
        "--chats",
        location.chatsDirectory,
        "--config",
        location.configPath,
        "--socket",
        location.socketPath,
        "--lock",
        location.lockPath,
      ]),
      {
        cwd: project.launchDirectory,
        stdin: "ignore",
        stdout: logDescriptor,
        stderr: logDescriptor,
        detached: true,
        env: process.env,
      },
    );
  } finally {
    closeSync(logDescriptor);
  }
  child.unref();
  return await waitForService(location.socketPath);
}

/**
 * Starts the service and returns, without opening any UI.
 *
 * A frontend that is not a terminal — an editor extension, say — needs the
 * service running before it can attach, and `watari ui` is not usable for that
 * because it takes over the terminal. This is the headless half of that
 * command. It registers no UI attachment, so the service's idle-exit grace
 * applies normally until a real client connects.
 */
export async function serveWatari(project: ProjectContext): Promise<StateLocation> {
  const location = resolveStateLocation(project);
  const client = await ensureService(project, location);
  try {
    await client.refresh();
  } finally {
    client.close();
  }
  return location;
}

export async function launchWatari(
  project: ProjectContext,
  options: { readonly startService?: boolean } = {},
): Promise<void> {
  const location = resolveStateLocation(project);
  let client = await tryConnect(location.socketPath);
  if (!client) {
    if (options.startService === false) {
      throw new Error(
        `no Watari service is running for ${project.launchDirectory}; run watari ${project.launchDirectory} first`,
      );
    }
    client = await ensureService(project, location);
  }

  try {
    const attached = await client.attachUi(options.startService !== false);
    await client.refresh();
    // OpenTUI treats any generic DEBUG value (including values meant for an
    // unrelated program) as verbose reconciler tracing, which corrupts a
    // fullscreen terminal. Watari uses an explicit opt-in instead.
    if (process.env.WATARI_DEBUG_UI !== "1") {
      delete process.env.DEBUG;
    }
    const { runTui } = await import("./tui/app.tsx");
    await runTui({
      client,
      project,
      stateDirectory: location.directory,
      ...(attached.keptRunningChat
        ? { initialNotice: "continuing the current chat; /new starts a fresh one" }
        : {}),
    });
  } finally {
    client.close();
  }
}

async function waitForService(socketPath: string): Promise<RuntimeClient> {
  const deadline = Date.now() + SERVICE_START_TIMEOUT_MS;
  let lastError: Error | null = null;
  while (Date.now() < deadline) {
    try {
      return await RuntimeClient.connect(socketPath);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error(`Watari service did not start: ${lastError?.message ?? "timed out"}`);
}

async function tryConnect(socketPath: string): Promise<RuntimeClient | null> {
  try {
    return await RuntimeClient.connect(socketPath);
  } catch (error) {
    if (error instanceof ServiceProtocolError) throw error;
    return null;
  }
}
