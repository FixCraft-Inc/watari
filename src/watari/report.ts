import type { DoctorReport, ProbeReport, StatusReport } from "./models.ts";
import type { ChatListEntry } from "./state/chat-library.ts";

/**
 * Terminal styling for Watari's one-shot commands.
 *
 * These use the 16 ANSI colours rather than Watari's truecolor tokens on
 * purpose: `doctor` and `probe` print into the user's own scrollback, next to
 * their prompt and their other tools, so they should inherit the terminal
 * palette instead of imposing the full-screen theme.
 */
export interface Style {
  readonly bold: (value: string) => string;
  readonly dim: (value: string) => string;
  readonly ok: (value: string) => string;
  readonly warn: (value: string) => string;
  readonly bad: (value: string) => string;
  readonly accent: (value: string) => string;
}

const CSI = `${String.fromCharCode(27)}[`;

function wrap(code: string, reset: string): (value: string) => string {
  return (value) => `${CSI}${code}m${value}${CSI}${reset}m`;
}

const PLAIN: Style = {
  bold: (value) => value,
  dim: (value) => value,
  ok: (value) => value,
  warn: (value) => value,
  bad: (value) => value,
  accent: (value) => value,
};

const COLORED: Style = {
  bold: wrap("1", "22"),
  dim: wrap("2", "22"),
  ok: wrap("32", "39"),
  warn: wrap("33", "39"),
  bad: wrap("31", "39"),
  accent: wrap("36", "39"),
};

/** Colour is off unless stdout is a terminal, and `NO_COLOR` always wins. */
export function resolveStyle(
  stream: { readonly isTTY?: boolean },
  env: Record<string, string | undefined>,
): Style {
  if (env["NO_COLOR"] !== undefined || env["TERM"] === "dumb") return PLAIN;
  return stream.isTTY === true ? COLORED : PLAIN;
}

const GLYPH = { pass: "✓", warn: "!", fail: "✗", detail: "└" } as const;

export function renderDoctor(report: DoctorReport, style: Style): string {
  const width = report.checks.reduce((longest, check) => Math.max(longest, check.id.length), 0);
  const lines: string[] = [
    "",
    `${style.bold("watari doctor")}  ${style.dim(report.project.launchDirectory)}`,
    "",
  ];

  for (const check of report.checks) {
    const paint = check.status === "pass" ? style.ok : check.status === "warn" ? style.warn : style.bad;
    const glyph = check.status === "pass" ? GLYPH.pass : check.status === "warn" ? GLYPH.warn : GLYPH.fail;
    lines.push(`  ${paint(glyph)}  ${check.id.padEnd(width)}  ${check.summary}`);
    if (check.detail) {
      lines.push(`     ${style.dim(`${GLYPH.detail} ${check.detail}`)}`);
    }
  }

  const passed = report.checks.filter((check) => check.status === "pass").length;
  const warned = report.checks.filter((check) => check.status === "warn").length;
  const failed = report.checks.filter((check) => check.status === "fail").length;
  const tally = [
    style.ok(`${passed} ok`),
    warned > 0 ? style.warn(`${warned} warning${warned === 1 ? "" : "s"}`) : null,
    failed > 0 ? style.bad(`${failed} failed`) : null,
  ].filter((part): part is string => part !== null);

  lines.push("", `  ${tally.join(style.dim("  ·  "))}`, "");
  return lines.join("\n");
}

export function renderProbe(report: ProbeReport, style: Style): string {
  const verdict = report.ok ? style.ok("pass") : style.bad("fail");
  const lines: string[] = [
    "",
    `${style.bold(`watari probe ${report.adapter}`)}  ${style.dim(report.mode)}  ${verdict}`,
    "",
  ];

  const width = report.events.reduce((longest, event) => Math.max(longest, event.kind.length), 0);
  for (const event of report.events) {
    const paint = event.kind === "error" ? style.bad : event.kind === "warning" ? style.warn : style.dim;
    lines.push(`  ${paint(event.kind.padEnd(width))}  ${event.summary}`);
  }

  if (report.sessionId) {
    lines.push("", `  ${style.dim("session id")}  ${report.sessionId}`);
  }
  if (report.limitation) {
    lines.push("", `  ${style.warn(GLYPH.warn)}  ${report.limitation}`);
  }
  lines.push("");
  return lines.join("\n");
}

export function renderStatus(report: StatusReport, style: Style): string {
  const running = report.service.state === "running";
  const incompatible = report.service.state === "incompatible";
  const version = report.service.apiVersion === null
    ? `expects api v${report.service.expectedApiVersion}`
    : `api v${report.service.apiVersion}`;
  const lines = [
    "",
    `${style.bold("watari status")}  ${style.dim(report.project.launchDirectory)}`,
    "",
    `  ${running ? style.ok("✓") : incompatible ? style.bad("✗") : style.warn("!")}  service  ${
      running
        ? `running as pid ${report.service.pid ?? "unknown"}  ·  ${report.service.connectedClients} local client connection${report.service.connectedClients === 1 ? "" : "s"}`
        : incompatible
          ? `incompatible service as pid ${report.service.pid ?? "unknown"}`
          : "stopped"
    }`,
    // A local frontend needs both of these to decide whether it can attach, so
    // they are printed here as well as in `--json`.
    `     ${style.dim(`${version}  ·  ${report.service.socketPath}`)}`,
  ];
  if (report.service.detail) lines.push(`     ${style.bad(report.service.detail)}`);
  for (const agent of report.agents) {
    const paint = agent.state === "failed" ? style.bad : agent.state === "stopped" ? style.warn : style.ok;
    lines.push(
      `  ${paint(agent.state === "failed" ? "✗" : "✓")}  ${agent.id.padEnd(12)}  ${agent.state}  ` +
        style.dim(
          `· ${agent.provider ?? agent.backend}/${agent.model ?? "default"} · ${agent.effort ?? "default"} · ` +
            `${agent.unrestricted === true ? "bypass" : "ask"} · ${agent.teamBridge}`,
        ),
    );
  }
  lines.push("", `  ${style.dim("state")}  ${report.stateDirectory}`, "");
  return lines.join("\n");
}

/** Archived chats as a numbered list, so `watari resume --chat <n>` reads off it. */
export function renderChats(chats: readonly ChatListEntry[], style: Style, now = Date.now()): string {
  if (chats.length === 0) return `\n  ${style.dim("no archived chats yet")}\n\n`;
  const lines = [""];
  for (const [index, chat] of chats.entries()) {
    const number = String(index + 1).padStart(String(chats.length).length);
    const marker = chat.current ? style.ok(" open") : "";
    lines.push(`  ${style.dim(number)}  ${style.bold(chat.title)}${marker}`);
    lines.push(`  ${" ".repeat(number.length)}  ${style.dim(`${chat.messages} message${chat.messages === 1 ? "" : "s"} · ${age(chat.updatedAt, now)} · ${chat.id}`)}`);
  }
  lines.push("", `  ${style.dim("watari resume --chat <n> continues one")}`, "");
  return lines.join("\n");
}

function age(timestamp: number, now: number): string {
  const minutes = Math.max(0, Math.round((now - timestamp) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function renderUsage(style: Style): string {
  const commands: readonly (readonly [string, string])[] = [
    ["watari [path]", "open the team ui for a checkout"],
    ["watari ui [path]", "explicit form of the default command"],
    ["watari attach [path]", "attach a ui without starting a service"],
    ["watari serve [path]", "start the service for another frontend, no ui"],
    ["watari status [path]", "show service, peers, and team bridges"],
    ["watari findings [path]", "print the team's findings as markdown"],
    ["watari chats [path]", "list archived chats, newest first"],
    ["watari resume [path] [--chat <id|n>]", "continue an archived chat, then open it"],
    ["watari import <archive> [path]", "restore a copied chat archive into the next session"],
    ["watari adopt <agent> <session-id> [path]", "continue a provider conversation in the next session"],
    ["watari export [path] [--out <file>] [--handoff]", "write the chat as markdown to continue anywhere"],
    ["watari mcp --agent <alias> [--provider <id>] [path]", "run the identity-bound stdio MCP bridge"],
    ["watari providers [--json]", "read CodexLB and TeamClaude account status once"],
    ["watari gemini-pool --help", "configure a private free-project Gemini pool for OpenCode"],
    ["watari dashboard [--port <n>] [--routing off|suggest|auto]", "serve the provider dashboard and routing on 127.0.0.1"],
    ["watari dashboard --install | --uninstall | --link", "run it as a user service, remove it, or print its link"],
    ["watari doctor [path]", "check prerequisites and state storage"],
    ["watari probe <codex|claude|opencode|qwen> [path]", "handshake one native harness"],
  ];
  const width = commands.reduce((longest, [usage]) => Math.max(longest, usage.length), 0);
  const lines = [
    "",
    `${style.bold("watari")}  ${style.dim("native coding harnesses, one checkout, one screen")}`,
    "",
  ];
  for (const [usage, description] of commands) {
    lines.push(`  ${usage.padEnd(width)}  ${style.dim(description)}`);
  }
  lines.push(
    "",
    `  ${style.dim("--json")}   machine readable output for status, findings, chats, export, providers, doctor, and probe`,
    `  ${style.dim("--live")}   probe with one real turn, this spends provider quota`,
    "",
  );
  return lines.join("\n");
}
