import { existsSync, readFileSync } from "node:fs";

import type { AgentId, ProjectContext, StatusReport } from "./models.ts";
import { RuntimeClient, ServiceProtocolError } from "./service/client.ts";
import { redactSecrets } from "./security/redaction.ts";
import { SERVICE_API_VERSION } from "./service/protocol.ts";
import { resolveStateLocation } from "./state/location.ts";

export async function runStatus(project: ProjectContext): Promise<StatusReport> {
  const location = resolveStateLocation(project);
  let client: RuntimeClient | null = null;
  try {
    client = await RuntimeClient.connect(location.socketPath);
    // Snapshot predates the optional info endpoint, so it is the compatibility
    // probe. This lets a newly installed CLI describe an older still-running
    // Watari service instead of incorrectly reporting it as stopped.
    const snapshot = await client.refresh();
    const info = await client.info().catch(() => ({
      schemaVersion: 1 as const,
      pid: readOwner(location.lockPath) ?? 0,
      connectedClients: 1,
      bridges: {
        codex: "app-server dynamic tools" as const,
        claude: "Agent SDK in-process MCP" as const,
      },
    }));
    return {
      schemaVersion: 1,
      command: "status",
      project,
      stateDirectory: location.directory,
      service: {
        state: "running",
        pid: info.pid > 0 ? info.pid : null,
        connectedClients: info.connectedClients,
        socketPath: location.socketPath,
        apiVersion: SERVICE_API_VERSION,
        expectedApiVersion: SERVICE_API_VERSION,
        detail: null,
      },
      agents: snapshot.agents.map((agent) => ({
        id: agent.id,
        state: agent.state,
        backend: agent.backend,
        ...(agent.provider ? { provider: agent.provider } : {}),
        ...(agent.model !== undefined ? { model: agent.model } : {}),
        ...(agent.effort !== undefined ? { effort: agent.effort } : {}),
        ...(agent.mode ? { mode: agent.mode } : {}),
        ...(agent.unrestricted !== undefined ? { unrestricted: agent.unrestricted } : {}),
        teamBridge: teamBridge(agent.id, info.bridges),
        sessionId: agent.sessionId,
        detail: agent.detail,
      })),
      ok: true,
    };
  } catch (error) {
    const incompatible = error instanceof ServiceProtocolError;
    return {
      schemaVersion: 1,
      command: "status",
      project,
      stateDirectory: location.directory,
      service: {
        state: incompatible ? "incompatible" : "stopped",
        pid: readOwner(location.lockPath),
        connectedClients: 0,
        socketPath: location.socketPath,
        apiVersion: null,
        expectedApiVersion: SERVICE_API_VERSION,
        detail: incompatible ? redactSecrets(error.message) : null,
      },
      agents: [],
      ok: false,
    };
  } finally {
    client?.close();
  }
}

function teamBridge(
  agent: AgentId,
  bridges: Readonly<Record<string, string>>,
): string {
  return bridges[agent] ?? "identity-bound stdio MCP";
}

function readOwner(lockPath: string): number | null {
  if (!existsSync(lockPath)) return null;
  try {
    const value = Number.parseInt(readFileSync(lockPath, "utf8").trim(), 10);
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}
