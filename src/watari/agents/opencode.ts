import type { AgentId, AgentModelOption } from "../models.ts";
import { runContainedCommand } from "../process/supervisor.ts";
import { redactSummary } from "../security/redaction.ts";
import { TEAM_INSTRUCTIONS } from "../team/instructions.ts";
import { teamInstructionsFile } from "../team/provider-config.ts";
import {
  AcpAdapter,
  type AcpAdapterOptions,
  type AcpCatalogContext,
  type AcpHarness,
  type AcpLaunch,
} from "./acp.ts";

const MODEL_OUTPUT_LIMIT = 8 * 1024 * 1024;

export type OpenCodeAdapterOptions = AcpAdapterOptions;

/**
 * OpenCode over its ACP stdio server.
 *
 * The team instructions go in through OpenCode's own `instructions` config,
 * which it places in the system prompt, rather than in front of the first
 * message. A first message is summarized away when OpenCode compacts, and the
 * system prompt is not. Watari's entry is added to whatever the user already
 * has in `OPENCODE_CONFIG_CONTENT`, and OpenCode merges `instructions` from
 * every config layer, so the user's own instructions stay.
 */
export const OPENCODE_HARNESS: AcpHarness = {
  name: "OpenCode",
  defaultAgent: "opencode" as AgentId,
  launch(project, posture): AcpLaunch {
    const env: Record<string, string> = { ...openCodeEnvironment() };
    let systemInstructions = false;
    if (posture.team) {
      const config = openCodeTeamConfig();
      if (config) {
        env.OPENCODE_CONFIG_CONTENT = config;
        systemInstructions = true;
      }
    }
    return { args: ["acp", "--cwd", project.launchDirectory], env, systemInstructions };
  },
  async discoverModels(context: AcpCatalogContext): Promise<readonly AgentModelOption[]> {
    const result = await runContainedCommand({
      command: context.command("models", "--verbose"),
      cwd: context.project.launchDirectory,
      env: openCodeEnvironment(),
      timeoutMs: context.timeoutMs,
      maxOutputBytes: MODEL_OUTPUT_LIMIT,
    });
    if (result.exitCode !== 0) {
      const detail = result.stderr.trim() || `exit ${result.exitCode}`;
      throw new Error(`OpenCode model discovery failed: ${redactSummary(detail)}`);
    }
    const models = parseOpenCodeModels(result.stdout);
    if (models.length === 0) {
      throw new Error("OpenCode did not report any configured models");
    }
    return models;
  },
};

/** A contained OpenCode client using its documented ACP stdio server. */
export class OpenCodeAdapter extends AcpAdapter {
  constructor(options: OpenCodeAdapterOptions) {
    super(OPENCODE_HARNESS, options);
  }
}

/**
 * The user's own `OPENCODE_CONFIG_CONTENT` with Watari's instructions file
 * added. Null when the file cannot be written or the user's value is not a
 * JSON object, in which case the instructions lead the first prompt instead.
 */
function openCodeTeamConfig(): string | null {
  let existing: Record<string, unknown> = {};
  const inherited = process.env.OPENCODE_CONFIG_CONTENT?.trim();
  if (inherited) {
    try {
      const parsed = JSON.parse(inherited) as unknown;
      if (!isRecord(parsed)) return null;
      existing = parsed;
    } catch {
      return null;
    }
  }
  let path: string;
  try {
    path = teamInstructionsFile(TEAM_INSTRUCTIONS);
  } catch {
    return null;
  }
  const instructions = Array.isArray(existing.instructions)
    ? existing.instructions.filter((entry): entry is string => typeof entry === "string")
    : [];
  return JSON.stringify({ ...existing, instructions: [...new Set([...instructions, path])] });
}

export function parseOpenCodeModels(output: string): AgentModelOption[] {
  const lines = output.replaceAll("\r\n", "\n").split("\n");
  const records: Array<{ readonly id: string; readonly metadata: string[] }> = [];
  let current: { id: string; metadata: string[] } | null = null;
  for (const line of lines) {
    if (line === line.trim() && /^[A-Za-z0-9._-]+\/\S+$/u.test(line)) {
      if (current) records.push(current);
      current = { id: line, metadata: [] };
      continue;
    }
    current?.metadata.push(line);
  }
  if (current) records.push(current);

  return records.map(({ id, metadata }) => {
    const value = parseModelMetadata(metadata.join("\n").trim());
    const displayName = stringField(value, "name") ?? id;
    const description = stringField(value, "description") ?? `OpenCode model ${id}`;
    const variants = isRecord(value?.variants) ? Object.keys(value.variants) : [];
    return {
      id,
      displayName,
      description,
      efforts: variants.filter((variant) => variant !== "default"),
    };
  });
}

function parseModelMetadata(value: string): Record<string, unknown> | null {
  if (!value.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function openCodeEnvironment(): Readonly<Record<string, string>> {
  return {
    OPENCODE_DISABLE_AUTOUPDATE: "true",
    OPENCODE_DISABLE_TERMINAL_TITLE: "true",
  };
}

function stringField(value: Record<string, unknown> | null, field: string): string | null {
  const candidate = value?.[field];
  return typeof candidate === "string" && candidate.trim() ? candidate : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
