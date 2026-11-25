import { adoptConversation } from "./adopt.ts";
import { exportProjectChat, listProjectChats } from "./chats.ts";
import { runDoctor } from "./doctor.ts";
import { loadFindings } from "./findings.ts";
import { importArchivedChat, restoreArchivedChat } from "./resume.ts";
import { launchWatari, serveWatari } from "./launch.ts";
import type { DoctorReport, ProbeReport, StatusReport } from "./models.ts";
import { resolveProjectContext } from "./project/checkout.ts";
import { runProbe } from "./probe.ts";
import { runPoolCommand } from "./gemini-pool/command.ts";
import {
  DASHBOARD_UNIT,
  DEFAULT_DASHBOARD_PORT,
  dashboardLinkFor,
  installDashboardService,
  readProviderStatus,
  renderProviderStatus,
  runProviderDashboard,
  uninstallDashboardService,
} from "./provider-dashboard/command.ts";
import { ROUTING_MODES, type RoutingMode } from "./provider-routing-control.ts";
import { providerStatusEnabled, providerStatusService, routedCapacityProviders } from "./provider-status-readers.ts";
import { interruptedExitCode } from "./process/shutdown.ts";
import { redactSecrets } from "./security/redaction.ts";
import { renderChats, renderDoctor, renderProbe, renderStatus, renderUsage, resolveStyle } from "./report.ts";
import { runService } from "./service/server.ts";
import { resolveStateLocation } from "./state/location.ts";
import { runStatus } from "./status.ts";
import { AGENT_ALIAS_HELP, isAgentAlias } from "./team/identity.ts";
import { findingsReport } from "./team/review.ts";
import {
  PROVIDER_HELP,
  SUPPORTED_PROVIDERS,
  isProviderId,
  isSupportedProvider,
  type ProviderId,
  type SupportedProviderId,
} from "./team/roster.ts";
import { BRIDGE_TOKEN_ENV, runTeamMcp } from "./team/stdio-mcp.ts";

const VERSION = "0.1.0";

export async function runCli(args: readonly string[]): Promise<number> {
  try {
    const parsed = parseArguments(args);
    if (parsed.command === "help") {
      process.stdout.write(renderUsage(resolveStyle(process.stdout, process.env)));
      return 0;
    }
    if (parsed.command === "version") {
      process.stdout.write(`watari ${VERSION}\n`);
      return 0;
    }
    if (parsed.command === "gemini-pool") return await runPoolCommand(parsed.args);
    if (parsed.command === "mcp") {
      const project = resolveProjectContext(parsed.path);
      const location = resolveStateLocation(project);
      const token = process.env[BRIDGE_TOKEN_ENV];
      await runTeamMcp({
        agent: parsed.agent,
        provider: parsed.provider,
        socketPath: location.socketPath,
        ...(token ? { token } : {}),
      });
      return interruptedExitCode() ?? 0;
    }
    if (parsed.command === "serve") {
      const project = resolveProjectContext(parsed.path);
      const location = await serveWatari(project);
      const report = await runStatus(project);
      if (!report.ok || report.service.apiVersion === null) {
        throw new Error(report.service.detail ?? "Watari service stopped before startup could be verified");
      }
      if (parsed.json) writeReport(report, true);
      else {
        const style = resolveStyle(process.stdout, process.env);
        process.stdout.write(
          `${style.ok("✓")}  watari service running for ${project.launchDirectory}\n` +
            `   ${style.dim(`api v${report.service.apiVersion}  ·  ${location.socketPath}`)}\n`,
        );
      }
      return interruptedExitCode() ?? 0;
    }
    if (parsed.command === "resume") {
      const project = resolveProjectContext(parsed.path);
      const restored = await restoreArchivedChat(project, parsed.archive);
      const style = resolveStyle(process.stderr, process.env);
      process.stderr.write(
        `${style.ok("✓")}  ${restored.live ? "switched the running service to" : "restored"} ${restored.messages} messages, ` +
          `${restored.claims} claims, ${restored.todos} TODOs, ${restored.findings} findings, and ${restored.events} transcript rows\n` +
          `   ${style.dim(`from ${restored.archive}`)}\n`,
      );
      if (parsed.restoreOnly) return 0;
      await launchWatari(project, { startService: true });
      return interruptedExitCode() ?? 0;
    }
    if (parsed.command === "import") {
      const project = resolveProjectContext(parsed.path);
      const restored = await importArchivedChat(project, parsed.archive);
      const style = resolveStyle(process.stderr, process.env);
      process.stderr.write(
        `${style.ok("✓")}  imported ${restored.messages} messages, ${restored.claims} claims, ` +
          `${restored.todos} TODOs, ${restored.findings} findings, and ${restored.events} transcript rows\n` +
          `   ${style.dim(`from ${restored.archive}`)}\n`,
      );
      if (parsed.restoreOnly) return 0;
      await launchWatari(project, { startService: true });
      return interruptedExitCode() ?? 0;
    }
    if (parsed.command === "adopt") {
      const adopted = await adoptConversation(resolveProjectContext(parsed.path), parsed.agent, parsed.sessionId);
      const style = resolveStyle(process.stderr, process.env);
      process.stderr.write(
        `${style.ok("✓")}  ${adopted.agent} resumes ${adopted.provider} conversation ${adopted.sessionId} in the next session\n` +
          (adopted.replaced && adopted.replaced !== adopted.sessionId
            ? `   ${style.dim(`instead of ${adopted.replaced}`)}\n`
            : ""),
      );
      return 0;
    }
    if (parsed.command === "launch") {
      await launchWatari(resolveProjectContext(parsed.path), { startService: parsed.startService });
      return interruptedExitCode() ?? 0;
    }
    if (parsed.command === "internal-service") {
      const project = resolveProjectContext(parsed.path);
      const expected = resolveStateLocation(project);
      if (
        parsed.databasePath !== expected.databasePath ||
        parsed.chatsDirectory !== expected.chatsDirectory ||
        parsed.configPath !== expected.configPath ||
        parsed.socketPath !== expected.socketPath ||
        parsed.lockPath !== expected.lockPath
      ) {
        throw new Error("internal service paths do not match the resolved Watari project state directory");
      }
      await runService({
        project,
        databasePath: parsed.databasePath,
        chatsDirectory: parsed.chatsDirectory,
        configPath: parsed.configPath,
        socketPath: parsed.socketPath,
        lockPath: parsed.lockPath,
        ...capacityOptions(project.launchDirectory),
      });
      // A stopped service has no socket, no lock, and nothing to answer, so it
      // must not linger because some handle kept the loop alive. Every other
      // command returns and lets the process end on its own.
      process.exit(interruptedExitCode() ?? 0);
    }
    if (parsed.command === "chats") {
      const chats = await listProjectChats(resolveProjectContext(parsed.path));
      if (parsed.json) process.stdout.write(`${JSON.stringify(chats, null, 2)}\n`);
      else process.stdout.write(renderChats(chats, resolveStyle(process.stdout, process.env)));
      return 0;
    }
    if (parsed.command === "export") {
      const style = resolveStyle(process.stderr, process.env);
      if (parsed.handoff) process.stderr.write(`${style.dim("asking each agent for a handoff; this can take a few minutes")}\n`);
      const result = await exportProjectChat(resolveProjectContext(parsed.path), {
        handoff: parsed.handoff,
        ...(parsed.out ? { path: parsed.out } : {}),
      });
      if (parsed.json) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      } else {
        const missing = result.handoffs.filter((entry) => entry.source === "none").map((entry) => entry.agent);
        process.stderr.write(
          `${style.ok("✓")}  ${parsed.handoff ? "handoff" : "chat"} exported to ${result.path}\n` +
            (missing.length > 0 ? `   ${style.warn(`no answer from ${missing.join(", ")}`)}\n` : ""),
        );
      }
      return 0;
    }
    if (parsed.command === "dashboard") {
      if (parsed.action === "install") {
        const link = installDashboardService(parsed.port, parsed.routing ?? undefined);
        process.stdout.write(`Installed ${DASHBOARD_UNIT}. Open ${link}\n`);
        return 0;
      }
      if (parsed.action === "uninstall") {
        uninstallDashboardService();
        process.stdout.write(`Removed ${DASHBOARD_UNIT}.\n`);
        return 0;
      }
      if (parsed.action === "link") {
        process.stdout.write(`${dashboardLinkFor(parsed.port)}\n`);
        return 0;
      }
      return await runProviderDashboard({ port: parsed.port, ...(parsed.routing ? { routing: parsed.routing } : {}) });
    }
    if (parsed.command === "providers") {
      const document = await readProviderStatus();
      process.stdout.write(parsed.json ? `${JSON.stringify(document, null, 2)}\n` : renderProviderStatus(document));
      return 0;
    }
    if (parsed.command === "doctor") {
      const report = await runDoctor(resolveProjectContext(parsed.path));
      writeReport(report, parsed.json);
      return interruptedExitCode() ?? (report.ok ? 0 : 1);
    }
    if (parsed.command === "status") {
      const report = await runStatus(resolveProjectContext(parsed.path));
      writeReport(report, parsed.json);
      return report.ok ? 0 : 1;
    }
    if (parsed.command === "findings") {
      const result = await loadFindings(resolveProjectContext(parsed.path));
      if (parsed.json) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      } else {
        const style = resolveStyle(process.stderr, process.env);
        if (result.archive) process.stderr.write(`${style.dim(`from archived chat ${result.archive}`)}\n\n`);
        process.stdout.write(`${findingsReport(result.findings, result.goal)}\n`);
      }
      return 0;
    }
    const report = await runProbe({
      adapter: parsed.adapter,
      project: resolveProjectContext(parsed.path),
      live: parsed.live,
    });
    writeReport(report, parsed.json);
    return interruptedExitCode() ?? (report.ok ? 0 : 1);
  } catch (error) {
    if (error instanceof UsageError) {
      const style = resolveStyle(process.stderr, process.env);
      process.stderr.write(`${style.bad(error.message)}\n${renderUsage(style)}`);
      return 2;
    }
    const style = resolveStyle(process.stderr, process.env);
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${style.bad("watari")}  ${redactSecrets(message)}\n`);
    return interruptedExitCode() ?? 1;
  }
}

export type ParsedArguments =
  | { readonly command: "help" }
  | { readonly command: "version" }
  | {
      readonly command: "mcp";
      readonly agent: string;
      readonly provider: ProviderId;
      readonly path: string;
    }
  | { readonly command: "launch"; readonly path: string; readonly startService: boolean }
  | {
      readonly command: "resume";
      readonly path: string;
      readonly archive?: string;
      readonly restoreOnly: boolean;
    }
  | {
      readonly command: "import";
      readonly archive: string;
      readonly path: string;
      readonly restoreOnly: boolean;
    }
  | { readonly command: "adopt"; readonly agent: string; readonly sessionId: string; readonly path: string }
  | { readonly command: "serve"; readonly path: string; readonly json: boolean }
  | { readonly command: "chats"; readonly path: string; readonly json: boolean }
  | {
      readonly command: "export";
      readonly path: string;
      readonly out?: string;
      readonly handoff: boolean;
      readonly json: boolean;
    }
  | {
      readonly command: "internal-service";
      readonly path: string;
      readonly databasePath: string;
      readonly chatsDirectory: string;
      readonly configPath: string;
      readonly socketPath: string;
      readonly lockPath: string;
    }
  | {
      readonly command: "dashboard";
      readonly port: number;
      readonly action: "serve" | "install" | "uninstall" | "link";
      readonly routing: RoutingMode | null;
    }
  | { readonly command: "providers"; readonly json: boolean }
  | { readonly command: "gemini-pool"; readonly args: readonly string[] }
  | { readonly command: "doctor"; readonly path: string; readonly json: boolean }
  | { readonly command: "status"; readonly path: string; readonly json: boolean }
  | { readonly command: "findings"; readonly path: string; readonly json: boolean }
  | {
      readonly command: "probe";
      readonly adapter: SupportedProviderId;
      readonly path: string;
      readonly live: boolean;
      readonly json: boolean;
    };

export function parseArguments(args: readonly string[]): ParsedArguments {
  const [command, ...rest] = args;
  if (command === undefined) {
    return { command: "launch", path: ".", startService: true };
  }
  if (command === "--help" || command === "-h" || command === "help") {
    if (rest.length > 0) throw new UsageError("help accepts no arguments");
    return { command: "help" };
  }
  if (command === "--version" || command === "-V" || command === "version") {
    if (rest.length > 0) throw new UsageError("version accepts no arguments");
    return { command: "version" };
  }
  if (command === "ui" || command === "attach") {
    if (rest.length > 1 || rest[0]?.startsWith("--")) {
      throw new UsageError(`${command} accepts at most one project path`);
    }
    return { command: "launch", path: rest[0] ?? ".", startService: command === "ui" };
  }
  if (command === "chats") {
    const flags = new Set(rest.filter((argument) => argument.startsWith("--")));
    rejectUnknownFlags(flags, new Set(["--json"]));
    const positional = rest.filter((argument) => !argument.startsWith("--"));
    if (positional.length > 1) throw new UsageError("chats accepts at most one project path");
    return { command, path: positional[0] ?? ".", json: flags.has("--json") };
  }
  if (command === "export") {
    const outIndex = rest.indexOf("--out");
    const out = outIndex >= 0 ? rest[outIndex + 1] : undefined;
    if (outIndex >= 0 && (!out || out.startsWith("--"))) throw new UsageError("--out needs a file or directory path");
    const remaining = rest.filter((_argument, index) => outIndex < 0 || (index !== outIndex && index !== outIndex + 1));
    const flags = new Set(remaining.filter((argument) => argument.startsWith("--")));
    rejectUnknownFlags(flags, new Set(["--handoff", "--json"]));
    const positional = remaining.filter((argument) => !argument.startsWith("--"));
    if (positional.length > 1) throw new UsageError("export accepts at most one project path");
    return {
      command,
      path: positional[0] ?? ".",
      ...(out ? { out } : {}),
      handoff: flags.has("--handoff"),
      json: flags.has("--json"),
    };
  }
  if (command === "resume") {
    // `--chat` names the chat by id, position, or archive path. `--archive` is
    // its older spelling.
    const archiveIndex = rest.indexOf("--chat") >= 0 ? rest.indexOf("--chat") : rest.indexOf("--archive");
    const archive = archiveIndex >= 0 ? rest[archiveIndex + 1] : undefined;
    if (archiveIndex >= 0 && !archive) throw new UsageError("--chat needs a chat id, a number from `watari chats`, or an archive path");
    const remaining = rest.filter((_argument, index) => index !== archiveIndex && index !== archiveIndex + 1);
    const flags = new Set(remaining.filter((argument) => argument.startsWith("--")));
    rejectUnknownFlags(flags, new Set(["--no-ui"]));
    const positional = remaining.filter((argument) => !argument.startsWith("--"));
    if (positional.length > 1) throw new UsageError("resume accepts at most one project path");
    return {
      command,
      path: positional[0] ?? ".",
      ...(archive ? { archive } : {}),
      restoreOnly: flags.has("--no-ui"),
    };
  }
  if (command === "import") {
    const flags = new Set(rest.filter((argument) => argument.startsWith("--")));
    rejectUnknownFlags(flags, new Set(["--no-ui"]));
    const positional = rest.filter((argument) => !argument.startsWith("--"));
    if (positional.length < 1 || positional.length > 2) {
      throw new UsageError("import needs an archive path and accepts one project path");
    }
    return {
      command,
      archive: positional[0]!,
      path: positional[1] ?? ".",
      restoreOnly: flags.has("--no-ui"),
    };
  }
  if (command === "adopt") {
    const flags = new Set(rest.filter((argument) => argument.startsWith("--")));
    rejectUnknownFlags(flags, new Set());
    const positional = rest.filter((argument) => !argument.startsWith("--"));
    if (positional.length < 2 || positional.length > 3) {
      throw new UsageError("adopt needs an agent alias and a provider session id, and accepts one project path");
    }
    if (!isAgentAlias(positional[0]!)) throw new UsageError(AGENT_ALIAS_HELP);
    return { command, agent: positional[0]!, sessionId: positional[1]!, path: positional[2] ?? "." };
  }
  if (command === "serve") {
    const flags = new Set(rest.filter((argument) => argument.startsWith("--")));
    rejectUnknownFlags(flags, new Set(["--json"]));
    const positional = rest.filter((argument) => !argument.startsWith("--"));
    if (positional.length > 1) throw new UsageError("serve accepts at most one project path");
    return { command, path: positional[0] ?? ".", json: flags.has("--json") };
  }
  if (command === "mcp") {
    return parseMcp(rest);
  }
  if (command === "internal-service") {
    return parseInternalService(rest);
  }
  if (command === "dashboard") {
    return parseDashboard(rest);
  }
  if (command === "gemini-pool") return { command, args: rest };
  if (command === "providers") {
    const flags = new Set(rest.filter((argument) => argument.startsWith("--")));
    rejectUnknownFlags(flags, new Set(["--json"]));
    if (rest.some((argument) => !argument.startsWith("--"))) throw new UsageError("providers accepts no arguments");
    return { command, json: flags.has("--json") };
  }
  if (command === "doctor") {
    const flags = new Set(rest.filter((argument) => argument.startsWith("--")));
    rejectUnknownFlags(flags, new Set(["--json"]));
    const positional = rest.filter((argument) => !argument.startsWith("--"));
    if (positional.length > 1) {
      throw new UsageError("doctor accepts at most one project path");
    }
    return {
      command,
      path: positional[0] ?? ".",
      json: flags.has("--json"),
    };
  }
  if (command === "status" || command === "findings") {
    const flags = new Set(rest.filter((argument) => argument.startsWith("--")));
    rejectUnknownFlags(flags, new Set(["--json"]));
    const positional = rest.filter((argument) => !argument.startsWith("--"));
    if (positional.length > 1) throw new UsageError(`${command} accepts at most one project path`);
    return { command, path: positional[0] ?? ".", json: flags.has("--json") };
  }
  if (command === "probe") {
    const [adapter, ...probeArguments] = rest;
    if (!isProviderId(adapter) || !isSupportedProvider(adapter)) {
      throw new UsageError(`probe requires one of ${SUPPORTED_PROVIDERS.join(", ")}`);
    }
    const flags = new Set(
      probeArguments.filter((argument) => argument.startsWith("--")),
    );
    rejectUnknownFlags(flags, new Set(["--json", "--live"]));
    const positional = probeArguments.filter(
      (argument) => !argument.startsWith("--"),
    );
    if (positional.length > 1) {
      throw new UsageError("probe accepts at most one project path");
    }
    return {
      command,
      adapter,
      path: positional[0] ?? ".",
      live: flags.has("--live"),
      json: flags.has("--json"),
    };
  }
  if (!command.startsWith("--") && rest.length === 0) {
    return { command: "launch", path: command, startService: true };
  }
  throw new UsageError(`unknown command: ${command}`);
}

/**
 * Provider status polling for agent capacity notices, only when a native
 * harness actually routes through CodexLB or TeamClaude. A setup without
 * either polls nothing.
 */
function capacityOptions(projectDirectory: string): { capacityStatus?: ReturnType<typeof providerStatusService>; capacityProviders?: ReadonlySet<string> } {
  if (!providerStatusEnabled(process.env)) return {};
  const routed = routedCapacityProviders(process.env, undefined, undefined, projectDirectory);
  return routed.size > 0 ? { capacityStatus: providerStatusService(process.env), capacityProviders: routed } : {};
}

function parseDashboard(args: readonly string[]): Extract<ParsedArguments, { command: "dashboard" }> {
  let port = DEFAULT_DASHBOARD_PORT;
  let action: "serve" | "install" | "uninstall" | "link" = "serve";
  let routing: RoutingMode | null = null;
  const actions = new Map([["--install", "install"], ["--uninstall", "uninstall"], ["--link", "link"]] as const);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--port") {
      const value = args[index + 1];
      if (value === undefined || !/^\d{1,5}$/u.test(value) || Number(value) > 65_535) {
        throw new UsageError("--port needs a port number from 0 to 65535");
      }
      port = Number(value);
      index += 1;
      continue;
    }
    if (argument === "--routing") {
      const value = args[index + 1];
      if (value === undefined || !(ROUTING_MODES as readonly string[]).includes(value)) {
        throw new UsageError(`--routing needs one of ${ROUTING_MODES.join(", ")}`);
      }
      routing = value as RoutingMode;
      index += 1;
      continue;
    }
    const chosen = actions.get(argument as "--install");
    if (chosen) {
      if (action !== "serve") throw new UsageError("choose one of --install, --uninstall, or --link");
      action = chosen;
      continue;
    }
    throw new UsageError(argument.startsWith("--") ? `unknown option: ${argument}` : "dashboard accepts no arguments");
  }
  return { command: "dashboard", port, action, routing };
}

function parseInternalService(args: readonly string[]): Extract<ParsedArguments, { command: "internal-service" }> {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (
      !flag ||
      !["--project", "--database", "--chats", "--config", "--socket", "--lock"].includes(flag) ||
      !value
    ) {
      throw new UsageError("invalid internal service arguments");
    }
    values.set(flag, value);
  }
  const path = values.get("--project");
  const databasePath = values.get("--database");
  const chatsDirectory = values.get("--chats");
  const configPath = values.get("--config");
  const socketPath = values.get("--socket");
  const lockPath = values.get("--lock");
  if (!path || !databasePath || !chatsDirectory || !configPath || !socketPath || !lockPath || values.size !== 6) {
    throw new UsageError("internal service requires project, database, chats, config, socket, and lock paths");
  }
  return { command: "internal-service", path, databasePath, chatsDirectory, configPath, socketPath, lockPath };
}

function parseMcp(args: readonly string[]): Extract<ParsedArguments, { command: "mcp" }> {
  const consumed = new Set<number>();
  const flagValue = (name: string): string | undefined => {
    const index = args.indexOf(name);
    if (index < 0) return undefined;
    consumed.add(index);
    consumed.add(index + 1);
    return args[index + 1];
  };

  const agent = flagValue("--agent");
  if (!isAgentAlias(agent)) {
    throw new UsageError(`mcp requires --agent followed by ${AGENT_ALIAS_HELP}`);
  }
  // The alias is the team identity and the provider is the harness behind it.
  // An alias that already names a provider may omit the flag, so the built-in
  // `codex` and `claude` entries stay expressible in one word.
  const providerFlag = flagValue("--provider");
  const provider = providerFlag ?? agent;
  if (!isProviderId(provider)) {
    throw new UsageError(
      providerFlag === undefined
        ? `mcp requires --provider followed by ${PROVIDER_HELP} when the alias does not name one`
        : `mcp requires --provider followed by ${PROVIDER_HELP}`,
    );
  }

  const remaining = args.filter((_argument, index) => !consumed.has(index));
  const unknown = remaining.find((argument) => argument.startsWith("--"));
  if (unknown) throw new UsageError(`unknown option: ${unknown}`);
  if (remaining.length > 1) throw new UsageError("mcp accepts at most one project path");
  return { command: "mcp", agent, provider, path: remaining[0] ?? "." };
}

function rejectUnknownFlags(
  actual: ReadonlySet<string>,
  allowed: ReadonlySet<string>,
): void {
  for (const flag of actual) {
    if (!allowed.has(flag)) {
      throw new UsageError(`unknown option: ${flag}`);
    }
  }
}

function writeReport(report: DoctorReport | ProbeReport | StatusReport, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  const style = resolveStyle(process.stdout, process.env);
  process.stdout.write(report.command === "doctor"
    ? renderDoctor(report, style)
    : report.command === "probe"
      ? renderProbe(report, style)
      : renderStatus(report, style));
}

class UsageError extends Error {}
