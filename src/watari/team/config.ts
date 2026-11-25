import { chmodSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ProjectTaskPolicySchema, type ProjectTaskPolicy } from "../task-policy.ts";

import { defaultRoster, parseRoster, type AgentDefinition } from "./roster.ts";

export interface WatariProjectConfig {
  readonly schemaVersion: 1;
  readonly agents: readonly AgentDefinition[];
  readonly taskPolicy?: ProjectTaskPolicy;
}

export function loadProjectConfig(path: string): WatariProjectConfig {
  if (!existsSync(path)) return { schemaVersion: 1, agents: defaultRoster() };
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`could not read Watari agent configuration ${path}: ${errorMessage(error)}`);
  }
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error(`Watari agent configuration has an unsupported schema: ${path}`);
  }
  return {
    schemaVersion: 1,
    agents: parseRoster(value.agents),
    ...(value.taskPolicy === undefined ? {} : { taskPolicy: ProjectTaskPolicySchema.parse(value.taskPolicy) }),
  };
}

/** Writes one complete configuration through a same-directory rename, so a
 * crash cannot leave the service with half a JSON document. */
export function saveProjectConfig(path: string, input: Omit<WatariProjectConfig, "schemaVersion">): WatariProjectConfig {
  const config: WatariProjectConfig = {
    schemaVersion: 1,
    agents: parseRoster(input.agents),
    ...(input.taskPolicy === undefined ? {} : { taskPolicy: ProjectTaskPolicySchema.parse(input.taskPolicy) }),
  };
  const temporary = join(dirname(path), `.agents-${process.pid}-${crypto.randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } catch (error) {
    try {
      if (existsSync(temporary)) unlinkSync(temporary);
    } catch {
      // The next write uses a unique name, so an orphan cannot corrupt config.
    }
    throw new Error(`could not save Watari agent configuration ${path}: ${errorMessage(error)}`);
  }
  return config;
}

export function upsertAgent(
  agents: readonly AgentDefinition[],
  definition: AgentDefinition,
): AgentDefinition[] {
  const index = agents.findIndex((agent) => agent.alias.toLowerCase() === definition.alias.toLowerCase());
  if (index < 0) return [...agents, definition];
  return agents.map((agent, agentIndex) => agentIndex === index ? definition : agent);
}

export function removeAgent(agents: readonly AgentDefinition[], alias: string): AgentDefinition[] {
  const next = agents.filter((agent) => agent.alias.toLowerCase() !== alias.toLowerCase());
  if (next.length === agents.length) throw new Error(`Watari agent is not configured: ${alias}`);
  if (next.length === 0) throw new Error("Watari needs at least one configured agent");
  return next;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
