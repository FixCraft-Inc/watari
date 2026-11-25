import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";

import type { AgentId } from "../models.ts";
import { redactSummary } from "../security/redaction.ts";
import type { TeamMcpCommand, TeamMcpEnvironment } from "./provider-config.ts";
import { TEAM_TOOL_CATALOG } from "./tool-catalog.ts";

/**
 * Proves the team bridge works before a peer is asked to rely on it.
 *
 * A native harness reports an MCP server as connected as soon as its process
 * starts and answers `initialize`. That is not the property Watari needs. The
 * bridge is a relay: the model calls a tool, the stdio child forwards it to the
 * per-project service socket, and the service answers as that bound identity.
 * Any hop can be broken while the provider still calls the server healthy — a
 * stale socket path, a service that exited, an alias missing from this
 * project's roster, an executable that resolves to a different build.
 *
 * So the check is the whole round trip, ending in a real read-only tool call.
 * It costs no tokens and contacts no model: it is Watari talking to Watari
 * through exactly the command string the provider was handed.
 */

/** The tools a peer must be able to see for coordination to be possible. */
export const REQUIRED_TEAM_TOOLS: readonly string[] = TEAM_TOOL_CATALOG.map((entry) => entry.name);

const DEFAULT_TIMEOUT_MS = 10_000;

export type BridgeState = "unknown" | "checking" | "ready" | "failed";

export interface BridgeStatus {
  readonly agent: AgentId;
  readonly state: BridgeState;
  /** One sentence a user can act on. */
  readonly detail: string;
  /** Tool names the bridge advertised, for the failure message. */
  readonly tools: readonly string[];
  /** Required tools that were missing. */
  readonly missing: readonly string[];
  /** Round-trip time of the whole handshake, in milliseconds. */
  readonly elapsedMs: number;
  readonly checkedAt: number;
  /** Set once the provider itself reports how it loaded the server. */
  readonly providerReported?: string;
}

export interface BridgeProbeOptions {
  readonly agent: AgentId;
  readonly command: TeamMcpCommand;
  readonly cwd?: string;
  /** The same extra environment the provider launches the bridge with. */
  readonly env?: TeamMcpEnvironment;
  readonly timeoutMs?: number;
}

/**
 * Runs the full bridge round trip once.
 *
 * Never throws: a preflight that can fail the send it is guarding is worse than
 * no preflight, so every failure is reported as a status the caller can show.
 */
export async function probeTeamBridge(options: BridgeProbeOptions): Promise<BridgeStatus> {
  const started = Date.now();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const [executable, ...args] = options.command;
  const client = new Client(
    { name: "watari-preflight", version: "0.1.0" },
    { capabilities: {} },
  );
  const transport = new StdioClientTransport({
    command: executable,
    args,
    // The bridge writes diagnostics to stderr. Letting it inherit would print
    // over the fullscreen UI, so it is discarded here.
    stderr: "ignore",
    ...(options.cwd ? { cwd: options.cwd } : {}),
    // The SDK's default environment keeps only a few login variables. The
    // state location has to survive it, or the probe would look for the service
    // socket somewhere other than where the provider's bridge looks.
    env: {
      ...getDefaultEnvironment(),
      ...(process.env.XDG_STATE_HOME ? { XDG_STATE_HOME: process.env.XDG_STATE_HOME } : {}),
      ...options.env,
    },
  });

  const fail = (detail: string, tools: readonly string[] = [], missing: readonly string[] = []): BridgeStatus => ({
    agent: options.agent,
    state: "failed",
    detail: redactSummary(detail),
    tools,
    missing,
    elapsedMs: Date.now() - started,
    checkedAt: Date.now(),
  });

  try {
    await withTimeout(client.connect(transport), timeoutMs, "the bridge did not complete the MCP handshake");

    const listed = await withTimeout(client.listTools(), timeoutMs, "the bridge did not answer tools/list");
    const tools = listed.tools.map((tool) => tool.name).sort();
    const missing = REQUIRED_TEAM_TOOLS.filter((name) => !tools.includes(name));
    if (missing.length > 0) {
      return fail(`the bridge is missing ${missing.join(", ")}`, tools, missing);
    }

    // The one call that proves the socket, the service, and the identity
    // binding are all live. It is read-only and mutates nothing.
    const called = await withTimeout(
      client.callTool({ name: "team_roster", arguments: {} }),
      timeoutMs,
      "the bridge did not answer team_roster",
    );
    const answer = readToolAnswer(called);
    if (!answer.ok) {
      return fail(`the service refused team_roster: ${answer.error}`, tools);
    }

    return {
      agent: options.agent,
      state: "ready",
      detail: `${tools.length} team tools, roster answered in ${Date.now() - started}ms`,
      tools,
      missing: [],
      elapsedMs: Date.now() - started,
      checkedAt: Date.now(),
    };
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
  }
}

/** The team tools answer with a JSON envelope; this reads its verdict. */
export function readToolAnswer(result: unknown): { readonly ok: boolean; readonly error: string } {
  if (!isRecord(result)) return { ok: false, error: "the bridge returned no result" };
  if (result.isError === true) {
    return { ok: false, error: firstText(result.content) ?? "the tool reported an error" };
  }
  const text = firstText(result.content);
  if (text === null) return { ok: false, error: "the bridge returned no text content" };
  try {
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed) && parsed.ok === false) {
      return { ok: false, error: typeof parsed.error === "string" ? parsed.error : "unknown error" };
    }
    return { ok: true, error: "" };
  } catch {
    return { ok: false, error: "the bridge returned content that is not the team envelope" };
  }
}

function firstText(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
      return block.text;
    }
  }
  return null;
}

async function withTimeout<T>(work: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${message} within ${timeoutMs}ms`)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** A never-checked bridge, so the UI has something to render before a probe. */
export function unknownBridge(agent: AgentId, detail = "not checked yet"): BridgeStatus {
  return {
    agent,
    state: "unknown",
    detail,
    tools: [],
    missing: [],
    elapsedMs: 0,
    checkedAt: 0,
  };
}

/**
 * Folds what a provider says about the server into what Watari measured.
 *
 * The two disagree in a way that matters: the provider knows whether *it*
 * loaded the server into the model's tool list, and Watari knows whether the
 * relay behind it actually works. A provider failure is authoritative, because
 * a bridge the model cannot see is useless however healthy it is.
 */
export function withProviderReport(
  status: BridgeStatus,
  report: { readonly state: "connected" | "failed" | "pending"; readonly detail: string },
): BridgeStatus {
  if (report.state === "failed") {
    return {
      ...status,
      state: "failed",
      detail: redactSummary(report.detail),
      providerReported: report.state,
    };
  }
  return { ...status, providerReported: report.state };
}

/** One line per peer for the status line and the `/check` command. */
export function summarizeBridges(statuses: readonly BridgeStatus[]): string {
  if (statuses.length === 0) return "no team bridges are configured";
  return statuses
    .map((status) => `${status.agent} ${status.state === "ready" ? "ok" : status.state}`)
    .join("  ·  ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
