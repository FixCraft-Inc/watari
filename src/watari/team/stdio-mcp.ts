import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import type { AgentId } from "../models.ts";
import { RuntimeClient } from "../service/client.ts";
import type { ProviderId } from "./roster.ts";
import { TEAM_TOOL_CATALOG } from "./tool-catalog.ts";
import type { TeamToolResult } from "./tools.ts";

export type TeamMcpAgent = AgentId;
export type TeamMcpCaller = (name: string, input: unknown) => Promise<TeamToolResult>;

/**
 * Environment variable carrying the managed-bridge token.
 *
 * The service puts it only into the MCP configuration of the harnesses it
 * launches, so a bridge that presents it was started for that managed alias.
 */
export const BRIDGE_TOKEN_ENV = "WATARI_BRIDGE_TOKEN";

export function createTeamMcpServer(
  agent: TeamMcpAgent,
  call: TeamMcpCaller,
  provider?: ProviderId,
): McpServer {
  const server = new McpServer(
    { name: `watari-${agent}`, version: "0.1.0" },
    {
      instructions:
        `Watari team coordination for the fixed ${agent} identity` +
        (provider ? ` running on ${provider}` : "") +
        ". The sender is bound to this MCP process and must never be inferred from tool input.",
    },
  );

  for (const definition of TEAM_TOOL_CATALOG) {
    server.registerTool(
      definition.name,
      { description: definition.description, inputSchema: definition.inputShape },
      (input) => invoke(call, definition.name, input),
    );
  }
  return server;
}

export interface TeamMcpOptions {
  readonly agent: TeamMcpAgent;
  /** The harness this identity runs on. Recorded so the service can tell a
   * connected peer from one that was only ever configured. */
  readonly provider?: ProviderId;
  readonly socketPath: string;
  /** Proves the bridge was launched by the service that manages this alias. */
  readonly token?: string;
  /** Tests substitute the socket client. */
  readonly connect?: (socketPath: string) => Promise<RuntimeClient>;
}

/**
 * The bridge's connection to the project service, re-established on demand.
 *
 * A provider keeps its MCP child for its whole session, while the service
 * behind it can exit when the team goes idle and start again later. Holding a
 * single socket for the child's lifetime left a bridge that stayed running and
 * answered every call with a closed connection until the provider restarted.
 * A call now reconnects, and registers the identity again, before giving up.
 */
export class TeamBridgeConnection {
  readonly #options: TeamMcpOptions;
  #client: RuntimeClient | null = null;
  #connecting: Promise<RuntimeClient> | null = null;
  #closed = false;

  constructor(options: TeamMcpOptions) {
    this.#options = options;
  }

  /** Connects and registers the identity, or throws why it could not. */
  async connect(): Promise<RuntimeClient> {
    if (this.#client) return this.#client;
    this.#connecting ??= this.#open().finally(() => {
      this.#connecting = null;
    });
    return await this.#connecting;
  }

  async call(name: string, input: unknown): Promise<TeamToolResult> {
    let client: RuntimeClient;
    try {
      client = await this.connect();
    } catch (error) {
      return {
        ok: false,
        error: `the Watari service for this project is not reachable (${errorMessage(error)}). ` +
          "Start it with `watari .` or `watari serve`, then call again.",
      };
    }
    try {
      return await client.callTeamTool(this.#options.agent, name, input);
    } catch (error) {
      this.#drop(client);
      // The request may already have been applied, so it is not retried here.
      return {
        ok: false,
        error: `the connection to the Watari service was lost during ${name} (${errorMessage(error)}). ` +
          "Its effect is unknown. Check team_status before repeating it.",
      };
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    const client = this.#client;
    this.#client = null;
    if (!client) return;
    await client.unregisterBridge(this.#options.agent).catch(() => undefined);
    client.close();
  }

  async #open(): Promise<RuntimeClient> {
    if (this.#closed) throw new Error("the team bridge is closing");
    const client = await (this.#options.connect ?? RuntimeClient.connect)(this.#options.socketPath);
    try {
      await client.registerBridge(
        this.#options.agent,
        this.#options.provider ?? "unknown",
        this.#options.token,
      );
    } catch (error) {
      client.close();
      throw error;
    }
    client.subscribe((event) => {
      if (event.type === "fatal") this.#drop(client);
    });
    this.#client = client;
    return client;
  }

  #drop(client: RuntimeClient): void {
    if (this.#client === client) this.#client = null;
    client.close();
  }
}

export async function runTeamMcp(options: TeamMcpOptions): Promise<void> {
  const connection = new TeamBridgeConnection(options);
  // The first connection must work. A provider started where no Watari service
  // runs then shows the bridge as unavailable instead of listing tools that
  // cannot answer.
  try {
    await connection.connect();
  } catch (error) {
    throw new Error(
      `no Watari team service is reachable for this project at ${options.socketPath} (${errorMessage(error)}). ` +
        "Start one with `watari .` or `watari serve` in the project directory.",
      { cause: error },
    );
  }
  const server = createTeamMcpServer(
    options.agent,
    (name, input) => connection.call(name, input),
    options.provider,
  );
  const transport = new StdioServerTransport(process.stdin, process.stdout, {
    maxBufferSize: 8 * 1024 * 1024,
  });
  let finish: () => void = () => undefined;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const stop = () => finish();
  process.stdin.once("end", stop);
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await server.connect(transport);
    await finished;
  } finally {
    process.stdin.off("end", stop);
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await server.close().catch(() => undefined);
    await connection.close();
  }
}

async function invoke(
  call: TeamMcpCaller,
  name: string,
  input: unknown,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: true;
}> {
  const result = await call(name, input);
  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
    ...(result.ok ? {} : { isError: true as const }),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
