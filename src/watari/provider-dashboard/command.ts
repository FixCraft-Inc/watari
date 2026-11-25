/**
 * `watari dashboard` and `watari providers`: the CLI ends of the provider
 * status model. `providers` only reads. `dashboard` serves the page on
 * 127.0.0.1 and runs Watari's routing: every minute it reads the providers
 * and, for a provider in auto mode, sets CodexLB's routing policy or
 * TeamClaude's priority to match the use order.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { registerProcessCleanup } from "../process/shutdown.ts";
import type { QuotaWindow } from "../provider-status.ts";
import type { ProviderStatusDocument } from "../provider-status-api.ts";
import { dashboardStateDirectory, persistentDashboardToken, providerRouter } from "../provider-control-clients.ts";
import type { RoutingMode } from "../provider-routing-control.ts";
import { providerStatusService } from "../provider-status-readers.ts";
import { DASHBOARD_HOST, createDashboardToken, startProviderDashboard } from "./server.ts";

export const DEFAULT_DASHBOARD_PORT = 4455;
export const DASHBOARD_UNIT = "watari-dashboard.service";
const ROUTING_INTERVAL_MS = 60_000;

export interface DashboardCommandOptions {
  readonly port: number;
  /** Mode for providers that have none saved yet. */
  readonly routing?: RoutingMode;
  readonly environment?: NodeJS.ProcessEnv;
  readonly write?: (text: string) => void;
}

function dashboardLink(port: number, token: string): string {
  return `http://${DASHBOARD_HOST}:${port}/#token=${token}`;
}

/** Serve the dashboard and run routing until the process is interrupted. */
export async function runProviderDashboard(options: DashboardCommandOptions): Promise<number> {
  const write = options.write ?? ((text: string) => void process.stdout.write(text));
  const environment = options.environment ?? process.env;
  const directory = dashboardStateDirectory(environment);
  const token = persistentDashboardToken(directory, createDashboardToken);
  const service = providerStatusService(environment);
  const router = providerRouter({ environment, stateDirectory: directory, ...(options.routing ? { defaultMode: options.routing } : {}) });
  const dashboard = startProviderDashboard({ service, router, port: options.port, token });
  write(
    `Watari provider dashboard on ${dashboard.origin}\n` +
      `Open ${dashboard.launchUrl}\n` +
      "The link stays the same across restarts. Ctrl+C stops the dashboard and its routing.\n",
  );
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const tick = async (): Promise<void> => {
    try {
      await router.evaluate(await service.refresh());
    } catch {
      // A failed read is already shown on the page as unreachable or stale.
    }
    if (!stopped) timer = setTimeout(() => void tick(), ROUTING_INTERVAL_MS);
  };
  void tick();
  await new Promise<void>((resolve) => {
    registerProcessCleanup(async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      service.close();
      await dashboard.stop();
      resolve();
    });
  });
  return 0;
}

/** The stable link of the dashboard on `port`, creating its token if needed. */
export function dashboardLinkFor(port: number, environment: NodeJS.ProcessEnv = process.env): string {
  return dashboardLink(port, persistentDashboardToken(dashboardStateDirectory(environment), createDashboardToken));
}

function systemctl(...args: string[]): { readonly ok: boolean; readonly output: string } {
  const result = spawnSync("systemctl", ["--user", ...args], { encoding: "utf8" });
  return { ok: result.status === 0, output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() };
}

function unitPath(environment: NodeJS.ProcessEnv): string {
  return join(environment["XDG_CONFIG_HOME"] || join(homedir(), ".config"), "systemd", "user", DASHBOARD_UNIT);
}

/**
 * Install the dashboard as a systemd user service running the `watari` found
 * on PATH, then enable and start it. Returns the link to open.
 */
export function installDashboardService(port: number, routing: RoutingMode | undefined, environment: NodeJS.ProcessEnv = process.env): string {
  const executable = Bun.which("watari", environment["PATH"] ? { PATH: environment["PATH"] } : undefined);
  if (!executable) throw new Error("put the watari executable on PATH first (bun run install:cli)");
  const quote = (value: string) => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
  const unit = [
    "[Unit]",
    "Description=Watari provider dashboard and routing",
    "After=codex-lb.service teamclaude.service",
    "",
    "[Service]",
    `ExecStart=${quote(executable)} dashboard --port ${port}${routing ? ` --routing ${routing}` : ""}`,
    "Restart=on-failure",
    "RestartSec=5",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
  const path = unitPath(environment);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, unit, { mode: 0o644 });
  for (const step of [["daemon-reload"], ["enable", DASHBOARD_UNIT], ["restart", DASHBOARD_UNIT]]) {
    const result = systemctl(...step);
    if (!result.ok) throw new Error(`systemctl --user ${step.join(" ")} failed: ${result.output}`);
  }
  return dashboardLinkFor(port, environment);
}

export function uninstallDashboardService(environment: NodeJS.ProcessEnv = process.env): void {
  systemctl("disable", "--now", DASHBOARD_UNIT);
  const path = unitPath(environment);
  if (existsSync(path)) rmSync(path);
  systemctl("daemon-reload");
}

/** Read every configured provider once. */
export async function readProviderStatus(environment: NodeJS.ProcessEnv = process.env): Promise<ProviderStatusDocument> {
  const service = providerStatusService(environment);
  try {
    return await service.refresh();
  } finally {
    service.close();
  }
}

function span(ms: number): string {
  const minutes = Math.round(Math.abs(ms) / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ""}` : `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function windowText(fallback: string, window: QuotaWindow | null, now: number, sibling: QuotaWindow | null): string {
  if (!window) return sibling ? `${fallback}: no limit reported` : `${fallback} not reported`;
  const minutes = window.windowMinutes;
  const label = minutes === 10_080 ? "weekly" : minutes && minutes % 60 === 0 ? `${minutes / 60}h` : fallback;
  if (window.remainingPercent === null) return `${label} not reported`;
  const reset = window.resetAt === null ? "reset not reported"
    : window.resetAt <= now ? "reset passed" : `resets in ${span(window.resetAt - now)}`;
  const quality = window.freshness !== "fresh" ? ", stale" : window.confidence === "derived" ? ", sample time not reported" : "";
  return `${label} ${Math.round(window.remainingPercent)}% left (${reset}${quality})`;
}

const SOURCE_NAMES: Readonly<Record<string, string>> = { codexlb: "CodexLB", teamclaude: "TeamClaude", watari: "Watari" };

/** A compact terminal summary of the same document the dashboard renders. */
export function renderProviderStatus(document: ProviderStatusDocument, now = Date.now()): string {
  const lines: string[] = [];
  for (const group of document.providers) {
    const capacity = group.capacity.replace("_", " ");
    lines.push(`${group.label} via ${SOURCE_NAMES[group.source] ?? group.source}: ${group.reachable ? "reachable" : "not reachable"}, ` +
      `${group.freshness}, capacity ${capacity}`);
    if (group.error) lines.push(`  error: ${group.error}`);
    if (group.notice) lines.push(`  ${group.noticeKind ?? "notice"}: ${group.notice}`);
    const next = group.useOrder[0];
    if (next) {
      const name = group.snapshot.accounts.find((account) => account.accountAlias === next.accountAlias)?.displayName ?? next.accountAlias;
      lines.push(`  use next: ${name ?? "unnamed account"} (${next.reason.charAt(0).toLowerCase()}${next.reason.slice(1)})`);
    }
    const current = group.snapshot.currentRoute?.accountAlias ?? null;
    if (group.snapshot.accounts.length === 0) lines.push("  no account data");
    for (const account of group.snapshot.accounts) {
      const name = account.displayName ?? account.accountAlias ?? "unnamed account";
      const eligibility = account.eligible === true ? "eligible"
        : account.eligible === false
          ? `not eligible${account.eligibilityReason ? ` (${account.eligibilityReason})` : ""}${account.remedy ? `, fix: ${account.remedy}` : ""}`
          : "eligibility unknown";
      const marker = account.accountAlias !== null && account.accountAlias === current ? "*" : " ";
      const paidThrough = account.billing?.paidThroughAt ?? null;
      const checked = account.billing?.paidThroughCheckedAt ?? null;
      const stale = paidThrough !== null && paidThrough <= now && (checked === null || checked <= paidThrough);
      lines.push(`${marker} ${name}: ${eligibility}; ${windowText("primary", account.primary, now, account.secondary)}; ` +
        `${windowText("secondary", account.secondary, now, account.primary)}; plan ${account.plan ?? "not reported"}` +
        (paidThrough === null ? "" : `; renews or ends ${new Date(paidThrough).toISOString().slice(0, 10)}` +
          (stale ? ` (passed, data from ${checked === null ? "unknown" : new Date(checked).toISOString().slice(0, 10)})` : "")));
    }
    for (const pin of group.snapshot.sessionPins) {
      lines.push(`  pinned session ${pin.sessionId} on ${pin.accountAlias ?? "unknown account"}`);
    }
    lines.push("");
  }
  if (document.providers.length === 0) lines.push("No provider readers are configured.", "");
  lines.push("* marks the provider's current route. Read-only. Account changes stay in CodexLB and TeamClaude.");
  return `${lines.join("\n")}\n`;
}
