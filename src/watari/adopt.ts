import type { AgentId, ProjectContext } from "./models.ts";
import { RuntimeClient, ServiceProtocolError } from "./service/client.ts";
import { backendName } from "./service/provider-adapters.ts";
import { resolveStateLocation } from "./state/location.ts";
import { TeamStore } from "./state/store.ts";
import { loadProjectConfig } from "./team/config.ts";

export interface AdoptedConversation {
  readonly agent: string;
  readonly provider: string;
  readonly sessionId: string;
  /** The conversation the agent would have resumed before, if it had one. */
  readonly replaced: string | null;
}

/** Codex thread ids, Claude session ids, and ACP session ids all fit this. */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;

/**
 * Gives a configured agent a native conversation that was started outside
 * Watari, so the next service resumes it instead of opening a new one.
 *
 * Like `import`, this is offline: a running service owns the database. The
 * conversation itself is not looked up here, since only the provider knows
 * where it keeps them. A provider that cannot find it says so when the
 * service resumes, and that agent then starts a fresh conversation.
 */
export async function adoptConversation(
  project: ProjectContext,
  alias: string,
  sessionId: string,
): Promise<AdoptedConversation> {
  if (!SESSION_ID.test(sessionId)) throw new Error(`not a provider session id: ${sessionId}`);
  const location = resolveStateLocation(project);
  const definition = loadProjectConfig(location.configPath).agents
    .find((agent) => agent.alias.toLowerCase() === alias.toLowerCase());
  if (!definition) throw new Error(`Watari agent is not configured: ${alias}`);
  if (definition.mode === "external") {
    throw new Error(`${definition.alias} is an external agent, so its conversation belongs to its own provider session`);
  }
  await refuseRunningService(location.socketPath);
  const id = definition.alias as AgentId;
  const store = new TeamStore(location.databasePath);
  try {
    const replaced = store.agents().find((agent) => agent.id === id)?.sessionId ?? null;
    store.registerAgent({
      id,
      backend: backendName(definition),
      displayName: definition.displayName,
      provider: definition.provider,
      model: definition.model ?? null,
      effort: definition.effort ?? null,
      mode: definition.mode,
      unrestricted: definition.unrestricted,
    });
    store.setAgentState(id, "stopped", { sessionId, detail: `adopted ${definition.provider} conversation` });
    return { agent: definition.alias, provider: definition.provider, sessionId, replaced };
  } finally {
    store.close();
  }
}

async function refuseRunningService(socketPath: string): Promise<void> {
  let client: RuntimeClient | null = null;
  try {
    client = await RuntimeClient.connect(socketPath);
  } catch (error) {
    // A stale socket or a stopped service is fine. An incompatible live one
    // still owns the database and must not race an offline writer.
    if (error instanceof ServiceProtocolError) throw error;
  }
  if (client) {
    client.close();
    throw new Error("stop the running Watari service before adopting a conversation");
  }
}
