import type { AgentAdapter, BoundaryInbox } from "../models.ts";
import { ClaudeAdapter } from "../agents/claude.ts";
import { CodexAdapter } from "../agents/codex.ts";
import { OpenCodeAdapter } from "../agents/opencode.ts";
import { QwenAdapter } from "../agents/qwen.ts";
import type { AgentDefinition, SupportedProviderId } from "../team/roster.ts";

export type ProviderAdapterOptions = ConstructorParameters<typeof OpenCodeAdapter>[0];

/** The one place a supported provider id becomes a native harness adapter. */
export function createProviderAdapter(
  provider: SupportedProviderId,
  options: ProviderAdapterOptions,
  boundaryInbox?: BoundaryInbox,
): AgentAdapter {
  if (provider === "codex") return new CodexAdapter(options);
  if (provider === "claude") {
    return new ClaudeAdapter(boundaryInbox ? { ...options, boundaryInbox } : options);
  }
  if (provider === "qwen") {
    return new QwenAdapter(boundaryInbox ? { ...options, boundaryInbox } : options);
  }
  return new OpenCodeAdapter(options);
}

/**
 * Whether a provider's harness pulls team mail inside a turn through callbacks.
 *
 * Claude does through its Agent SDK hooks, and Qwen Code by asking its ACP
 * client for queued input after each tool run. The others take mail by input:
 * Codex through `turn/steer`, and OpenCode when a prompt completes.
 */
export function takesMailInTurn(provider: SupportedProviderId): boolean {
  return provider === "claude" || provider === "qwen";
}

/** The transport name recorded for an agent, which `status` and the UI show. */
export function backendName(definition: AgentDefinition): string {
  if (definition.mode === "external") return `${definition.provider}-external-mcp`;
  if (definition.provider === "codex") return "codex-app-server";
  if (definition.provider === "claude") return "claude-agent-sdk";
  if (definition.provider === "qwen") return "qwen-acp";
  return "opencode-acp";
}

/** `WATARI_<PROVIDER>_BIN` pins a harness executable instead of searching PATH. */
export function providerExecutableOverride(provider: SupportedProviderId): string | undefined {
  if (provider === "codex") return process.env.WATARI_CODEX_BIN;
  if (provider === "claude") return process.env.WATARI_CLAUDE_BIN;
  if (provider === "qwen") return process.env.WATARI_QWEN_BIN;
  return process.env.WATARI_OPENCODE_BIN;
}
