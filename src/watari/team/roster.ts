import { AGENT_ALIAS_HELP, isAgentAlias } from "./identity.ts";

/**
 * Who is on the team, and what each of them runs on.
 *
 * Alias and provider are deliberately different things. The alias is the
 * identity the team state is keyed by — who claimed a path, who sent a message,
 * whose inbox this is. The provider is the harness that identity happens to be
 * driven by. Collapsing the two, as an earlier build did by keying everything
 * on `codex` and `claude`, makes three ordinary requests impossible: two agents
 * on one harness (`sonnet-2` and `sonnet-3` both on Claude), an agent whose
 * harness is swapped without losing its history, and a provider Watari learns
 * about later.
 *
 * The roster is also what "connected" means. A peer exists on the team because
 * its bridge is registered, not because Watari assumed it should be there — so
 * an agent nobody configured cannot block the ones who are working.
 */

export const PROVIDERS = ["codex", "claude", "opencode", "qwen"] as const;
export type ProviderId = (typeof PROVIDERS)[number];

/** Providers Watari can currently launch and supervise itself. */
export const SUPPORTED_PROVIDERS = ["codex", "claude", "opencode", "qwen"] as const;
export type SupportedProviderId = (typeof SUPPORTED_PROVIDERS)[number];
const DEFAULT_PROVIDERS = ["codex", "claude"] as const satisfies readonly SupportedProviderId[];

export const PROVIDER_HELP = `a provider: ${PROVIDERS.join(", ")}`;

/** A provider-reported effort identifier. Availability is model-specific and
 * comes from native discovery; Watari deliberately owns no effort catalog. */
export type ReasoningEffort = string;

export const AGENT_MODES = ["managed", "external"] as const;
export type AgentMode = (typeof AGENT_MODES)[number];

export interface AgentDefinition {
  /** Team identity. Stable across model and provider changes. */
  readonly alias: string;
  readonly provider: ProviderId;
  /** What the UI calls this peer. Defaults to a capitalised alias. */
  readonly displayName: string;
  /** Provider model id. Absent means the harness's own default. */
  readonly model?: string;
  readonly effort?: ReasoningEffort;
  /** Managed peers are launched by Watari. External peers join through the
   * identity-bound MCP command and pull their durable inbox themselves. */
  readonly mode: AgentMode;
  /** Skip provider approval prompts when the user opts in. */
  readonly unrestricted: boolean;
}

/** Omitted permissions keep the agent's saved setting on profile updates. */
export type AgentDefinitionUpdate = Omit<AgentDefinition, "unrestricted"> & {
  readonly unrestricted?: boolean | undefined;
};

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === "string" && (PROVIDERS as readonly string[]).includes(value);
}

export function isSupportedProvider(value: ProviderId): value is SupportedProviderId {
  return (SUPPORTED_PROVIDERS as readonly string[]).includes(value);
}

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === "string" && /^[a-z][a-z0-9_-]{0,31}$/u.test(value);
}

/** Title case for an alias that has no explicit display name. */
export function defaultDisplayName(alias: string): string {
  return alias.charAt(0).toUpperCase() + alias.slice(1);
}

/**
 * The roster Watari starts with when a project has no configuration.
 *
 * Keep the previous fixed pair even as new managed harnesses arrive, so an
 * upgrade never adds an unexpected paid peer to an existing project.
 */
export function defaultRoster(): AgentDefinition[] {
  return DEFAULT_PROVIDERS.map((provider) => ({
    alias: provider,
    provider,
    displayName: defaultDisplayName(provider),
    mode: "managed",
    unrestricted: false,
  }));
}

export class RosterError extends Error {}

/**
 * Validates one agent entry from a configuration file.
 *
 * Fails closed and names the offending field: a typo in a model id or provider
 * should be a startup error the user can read, not a peer that silently runs on
 * the wrong harness.
 */
export function parseAgentDefinition(value: unknown): AgentDefinition {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RosterError("each agent must be an object");
  }
  const entry = value as Record<string, unknown>;
  const alias = entry["alias"];
  if (!isAgentAlias(alias)) {
    throw new RosterError(`agent alias must be ${AGENT_ALIAS_HELP}`);
  }
  // An alias that names a provider is allowed to omit the provider, which is
  // what keeps the default `codex` / `claude` roster expressible in one word.
  const provider = entry["provider"] ?? alias;
  if (!isProviderId(provider)) {
    throw new RosterError(`agent ${alias} needs ${PROVIDER_HELP}`);
  }
  const model = entry["model"];
  if (model !== undefined && (typeof model !== "string" || model.trim() === "")) {
    throw new RosterError(`agent ${alias} has a model that is not a string`);
  }
  const effort = entry["effort"];
  if (effort !== undefined && !isReasoningEffort(effort)) {
    throw new RosterError(`agent ${alias} has an invalid provider effort identifier`);
  }
  const displayName = entry["displayName"];
  if (displayName !== undefined && typeof displayName !== "string") {
    throw new RosterError(`agent ${alias} has a displayName that is not a string`);
  }
  const unrestricted = entry["unrestricted"];
  if (unrestricted !== undefined && typeof unrestricted !== "boolean") {
    throw new RosterError(`agent ${alias} has an unrestricted flag that is not a boolean`);
  }
  const mode = entry["mode"];
  if (mode !== undefined && !AGENT_MODES.includes(mode as AgentMode)) {
    throw new RosterError(`agent ${alias} needs a mode of ${AGENT_MODES.join(", ")}`);
  }

  return {
    alias,
    provider,
    displayName: displayName ?? defaultDisplayName(alias),
    ...(typeof model === "string" ? { model } : {}),
    ...(isReasoningEffort(effort) ? { effort } : {}),
    mode: (mode as AgentMode | undefined) ?? "managed",
    unrestricted: unrestricted ?? false,
  };
}

/** Validates a whole roster, rejecting duplicate identities. */
export function parseRoster(value: unknown): AgentDefinition[] {
  if (!Array.isArray(value)) {
    throw new RosterError("agents must be an array");
  }
  const roster = value.map(parseAgentDefinition);
  const seen = new Set<string>();
  for (const agent of roster) {
    const key = agent.alias.toLowerCase();
    if (seen.has(key)) {
      throw new RosterError(`agent alias ${agent.alias} appears more than once`);
    }
    seen.add(key);
  }
  if (roster.length === 0) {
    throw new RosterError("a roster needs at least one agent");
  }
  return roster;
}
