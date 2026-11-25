import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { McpStdioServerConfig } from "@anthropic-ai/claude-agent-sdk";
import type { McpServerStdio } from "@agentclientprotocol/sdk";

import type { JsonValue } from "../../generated/codex/serde_json/JsonValue.ts";

export type TeamMcpCommand = readonly [string, ...string[]];

/**
 * Extra environment for a managed team bridge.
 *
 * It carries the service's managed-bridge token, which is how the service tells
 * the bridge it launched for a managed alias apart from a separately started
 * provider that was configured with the same alias.
 */
export type TeamMcpEnvironment = Readonly<Record<string, string>>;

export function claudeTeamMcpConfig(
  command: TeamMcpCommand,
  env?: TeamMcpEnvironment,
): McpStdioServerConfig {
  const [executable, ...args] = command;
  return {
    type: "stdio",
    command: executable,
    args,
    ...(hasEntries(env) ? { env: { ...env } } : {}),
    alwaysLoad: true,
  };
}

/** The stdio server entry every ACP harness (OpenCode, Qwen Code) accepts. */
export function acpTeamMcpConfig(
  command: TeamMcpCommand,
  env?: TeamMcpEnvironment,
): McpServerStdio {
  const [executable, ...args] = command;
  return {
    name: "watari",
    command: executable,
    args,
    env: Object.entries(env ?? {}).map(([name, value]) => ({ name, value })),
  };
}

/** Typed as app-server config JSON so a bad shape fails the build. */
export function codexTeamMcpConfig(
  command: TeamMcpCommand,
  cwd: string,
  env?: TeamMcpEnvironment,
): { [key in string]?: JsonValue } {
  const [executable, ...args] = command;
  return {
    // Watari owns the normalized transcript instead of adding these managed
    // turns to the user's ordinary Codex history under CODEX_HOME.
    history: { persistence: "none" },
    mcp_servers: {
      watari: {
        command: executable,
        args,
        cwd,
        ...(hasEntries(env) ? { env: { ...env } } : {}),
        enabled: true,
        required: true,
        startup_timeout_sec: 10,
        tool_timeout_sec: 60,
      },
    },
  };
}

function hasEntries(env: TeamMcpEnvironment | undefined): env is TeamMcpEnvironment {
  return env !== undefined && Object.keys(env).length > 0;
}

export interface HarnessPosture {
  readonly readOnlyProbe?: boolean;
  readonly unrestricted?: boolean;
}

/** Managed team sessions have no operator watching a provider modal. The
 * unrestricted posture is explicit and limited to the service-owned harness,
 * and doctor/probe always take the read-only branch first. */
export function claudePermissionOptions(posture: HarnessPosture): {
  readonly permissionMode: "dontAsk" | "bypassPermissions" | "default";
  readonly allowDangerouslySkipPermissions?: true;
  readonly tools?: readonly string[];
  readonly promptsForApproval: boolean;
} {
  if (posture.readOnlyProbe) {
    return { permissionMode: "dontAsk", tools: [], promptsForApproval: true };
  }
  if (posture.unrestricted) {
    return {
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      promptsForApproval: false,
    };
  }
  return { permissionMode: "default", promptsForApproval: true };
}

export function codexThreadPosture(posture: HarnessPosture): {
  readonly sandbox: "read-only" | "workspace-write" | "danger-full-access";
  readonly approvalPolicy: "on-request" | "never";
} {
  if (posture.readOnlyProbe) {
    return { sandbox: "read-only", approvalPolicy: "never" };
  }
  if (posture.unrestricted) {
    return { sandbox: "danger-full-access", approvalPolicy: "never" };
  }
  // Resume otherwise retains the previous thread's unrestricted posture,
  // even after the user changes this agent to permissions=prompt.
  return { sandbox: "workspace-write", approvalPolicy: "on-request" };
}

/**
 * The team instructions as a private file, for a harness that takes system
 * instructions by path (OpenCode's `instructions`). The name carries a digest
 * of the text, so a Watari upgrade writes a new file instead of changing one a
 * running harness already read.
 */
export function teamInstructionsFile(instructions: string): string {
  const stateRoot = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
  const directory = join(stateRoot, "watari");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const digest = createHash("sha256").update(instructions).digest("hex").slice(0, 16);
  const path = join(directory, `team-instructions-${digest}.md`);
  if (existsSync(path) && readFileSync(path, "utf8") === instructions) return path;
  const staging = `${path}.${process.pid}.tmp`;
  writeFileSync(staging, instructions, { mode: 0o600 });
  renameSync(staging, path);
  return path;
}
