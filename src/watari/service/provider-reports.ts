import type { AgentEvent } from "../models.ts";

export type ProviderBridgeReport = {
  readonly state: "connected" | "failed" | "pending";
  readonly detail: string;
};

/**
 * What a harness says about the team MCP server it was configured with.
 *
 * The providers report it in different shapes and at different moments. Codex
 * sends a startup-status notification per server and Claude lists the servers
 * on its session init message, so each is normalised here rather than in the
 * UI. This answers a question the probe cannot: whether the server reached the
 * model's tool list at all.
 */
export function providerBridgeReport(event: AgentEvent): ProviderBridgeReport | null {
  if (event.rawType === "mcpServer/startupStatus/updated") return codexBridgeReport(event.payload);
  if (event.rawType === "system/init") return claudeBridgeReport(event.payload);
  return null;
}

/** `mcpServer/startupStatus/updated` names one server and its startup state. */
function codexBridgeReport(payload: unknown): ProviderBridgeReport | null {
  if (!isRecord(payload) || payload.name !== "watari") return null;
  const status = typeof payload.status === "string" ? payload.status : "";
  if (status === "ready") return { state: "connected", detail: "Codex loaded the team server" };
  if (status === "failed" || status === "cancelled") {
    const error = typeof payload.error === "string" && payload.error ? payload.error : status;
    return { state: "failed", detail: `Codex could not start the team server: ${error}` };
  }
  return { state: "pending", detail: `Codex reports the team server ${status || "starting"}` };
}

/** Claude's session init lists every MCP server it resolved and their states. */
function claudeBridgeReport(payload: unknown): ProviderBridgeReport | null {
  if (!isRecord(payload) || !Array.isArray(payload.mcpServers)) return null;
  const entry = payload.mcpServers.find(
    (server) => isRecord(server) && server.name === "watari",
  );
  if (!isRecord(entry)) {
    return { state: "failed", detail: "Claude did not load a team server named watari" };
  }
  const status = typeof entry.status === "string" ? entry.status : "";
  if (status === "connected") return { state: "connected", detail: "Claude loaded the team server" };
  if (status === "pending") return { state: "pending", detail: "Claude is still connecting the team server" };
  const error = typeof entry.error === "string" && entry.error ? entry.error : status || "unknown";
  return { state: "failed", detail: `Claude reports the team server ${error}` };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
