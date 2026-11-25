/**
 * Loopback clients for the provider control routes Watari uses to steer
 * routing, and the file that remembers routing modes and recent changes.
 *
 * Both routes are owned by the provider and accept only local callers that are
 * not web pages: CodexLB's `PUT /api/provider-status/accounts/{id}/routing-policy`
 * and TeamClaude's `POST /teamclaude/priority`. Watari sends no credential.
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { readBoundedText } from "./http-body.ts";
import { StatusHttpError } from "./provider-status.ts";
import {
  ProviderRouter,
  ROUTING_MODES,
  codexLbController,
  teamClaudeController,
  type RoutingController,
  type RoutingLogEntry,
  type RoutingMode,
  type RoutingSettingsStore,
} from "./provider-routing-control.ts";
import { loopbackUrl, providerStatusEndpoints, type ProviderStatusEndpoints } from "./provider-status-readers.ts";

const MAX_RESPONSE_BYTES = 64 * 1024;

export interface LoopbackWriteOptions {
  readonly fetch?: (input: URL, init: RequestInit) => Promise<Response>;
}

/** A JSON request to a loopback control route, refusing redirects and large answers. */
export async function loopbackJsonWrite(
  method: "PUT" | "POST",
  value: string,
  body: unknown,
  signal: AbortSignal,
  options: LoopbackWriteOptions = {},
): Promise<unknown> {
  const url = loopbackUrl(value.replace(/\?.*$/u, ""), "provider control URL");
  const fetchImpl = options.fetch ?? ((input: URL, init: RequestInit) => fetch(input, init));
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method,
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(body),
      redirect: "manual",
      signal,
    });
  } catch (error) {
    if (signal.aborted) throw new Error(`${url.host} did not answer in time`);
    throw new Error(`nothing answered on ${url.host}. Is the provider running there?`);
  }
  const text = await readBoundedText(response, MAX_RESPONSE_BYTES);
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  if (!response.ok) {
    const detail = typeof parsed === "object" && parsed !== null
      ? JSON.stringify((parsed as Record<string, unknown>)["error"] ?? (parsed as Record<string, unknown>)["detail"] ?? "").slice(0, 200)
      : "";
    throw new StatusHttpError(response.status, `${url.host} refused the change (HTTP ${response.status})${detail ? `: ${detail}` : ""}`);
  }
  return parsed;
}

export function codexLbRoutingController(baseUrl: string, options: LoopbackWriteOptions = {}): RoutingController {
  return codexLbController(async (change, signal) => {
    const url = new URL(`/api/provider-status/accounts/${encodeURIComponent(change.accountId)}/routing-policy`, baseUrl);
    try {
      await loopbackJsonWrite("PUT", url.toString(), { routingPolicy: change.to }, signal, options);
    } catch (error) {
      if (error instanceof StatusHttpError && error.status === 404) {
        throw new Error("CodexLB has no routing route for this account. Update and restart CodexLB, or check the account still exists.");
      }
      if (error instanceof StatusHttpError && error.status === 405) {
        throw new Error("CodexLB is running without its routing route. Restart codex-lb.service to enable Watari routing.");
      }
      throw error;
    }
  });
}

export function teamClaudeRoutingController(baseUrl: string, options: LoopbackWriteOptions = {}): RoutingController {
  return teamClaudeController(async (change, signal) => {
    const url = new URL("/teamclaude/priority", baseUrl);
    const answer = await loopbackJsonWrite("POST", url.toString(), { account: change.accountId, priority: Number(change.to) }, signal, options);
    if (typeof answer === "object" && answer !== null && (answer as Record<string, unknown>)["ok"] === false) {
      throw new Error(`TeamClaude refused the change: ${String((answer as Record<string, unknown>)["error"] ?? "no reason given")}`);
    }
  });
}

/** Where the dashboard keeps its link token and routing settings. */
export function dashboardStateDirectory(environment: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return join(environment["XDG_STATE_HOME"] || join(home, ".local", "state"), "watari", "dashboard");
}

function writePrivate(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, text, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}

/** Routing modes and the recent change log, in one private JSON file. */
export function fileRoutingStore(path: string): RoutingSettingsStore {
  return {
    load: () => {
      try {
        const parsed = JSON.parse(readFileSync(path, "utf8")) as { modes?: Record<string, unknown>; log?: unknown[] };
        const modes: Record<string, RoutingMode> = {};
        for (const [provider, mode] of Object.entries(parsed.modes ?? {})) {
          if (typeof mode === "string" && (ROUTING_MODES as readonly string[]).includes(mode)) modes[provider] = mode as RoutingMode;
        }
        const log = Array.isArray(parsed.log) ? parsed.log.filter((entry): entry is RoutingLogEntry =>
          typeof entry === "object" && entry !== null && typeof (entry as RoutingLogEntry).at === "number") : [];
        return { modes, log };
      } catch {
        return { modes: {}, log: [] };
      }
    },
    save: (settings) => writePrivate(path, `${JSON.stringify(settings, null, 2)}\n`),
  };
}

export interface RouterFactoryOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly endpoints?: ProviderStatusEndpoints;
  readonly stateDirectory?: string;
  readonly defaultMode?: RoutingMode;
}

/** A router over the configured providers, remembering its settings on disk. */
export function providerRouter(options: RouterFactoryOptions = {}): ProviderRouter {
  const environment = options.environment ?? process.env;
  const endpoints = options.endpoints ?? providerStatusEndpoints(environment);
  const controllers: RoutingController[] = [];
  if (endpoints.codexlb) controllers.push(codexLbRoutingController(endpoints.codexlb));
  if (endpoints.teamclaude) controllers.push(teamClaudeRoutingController(endpoints.teamclaude));
  const directory = options.stateDirectory ?? dashboardStateDirectory(environment);
  return new ProviderRouter({
    controllers,
    store: fileRoutingStore(join(directory, "routing.json")),
    ...(options.defaultMode ? { defaultMode: options.defaultMode } : {}),
  });
}

/** The dashboard's link token, kept so the link survives restarts. Mode 600. */
export function persistentDashboardToken(directory: string, create: () => string): string {
  const path = join(directory, "token");
  try {
    const existing = readFileSync(path, "utf8").trim();
    if (/^[A-Za-z0-9_-]{32,128}$/u.test(existing)) return existing;
  } catch {
    // No token yet.
  }
  const token = create();
  writePrivate(path, `${token}\n`);
  return token;
}
