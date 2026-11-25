import type { AgentId } from "../models.ts";
import type { TeamApplicationService } from "./service.ts";
import { TEAM_TOOL_CATALOG } from "./tool-catalog.ts";

export interface TeamToolResult {
  readonly ok: boolean;
  readonly value?: unknown;
  readonly error?: string;
}

export interface TeamToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

export const TEAM_TOOL_DEFINITIONS: readonly TeamToolDefinition[] = TEAM_TOOL_CATALOG.map(
  ({ name, description, inputSchema }) => ({ name, description, inputSchema }),
);

/** Binds model calls to one roster identity; behavior lives in the application service. */
export class IdentityBoundTeamTools {
  readonly #agent: AgentId;
  readonly #service: TeamApplicationService;

  constructor(options: {
    readonly agent: AgentId;
    readonly service: TeamApplicationService;
  }) {
    this.#agent = options.agent;
    this.#service = options.service;
  }

  async call(name: string, rawInput: unknown): Promise<TeamToolResult> {
    try {
      const input = objectInput(rawInput);
      return { ok: true, value: await this.#service.execute(this.#agent, name, input) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}

function objectInput(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("tool input must be an object");
  }
  return value as Record<string, unknown>;
}
