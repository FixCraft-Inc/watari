import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveProjectContext } from "../src/watari/project/checkout.ts";
import { RuntimeClient } from "../src/watari/service/client.ts";
import { WatariService } from "../src/watari/service/server.ts";
import { resolveStateLocation } from "../src/watari/state/location.ts";
import { TeamBridgeConnection, createTeamMcpServer } from "../src/watari/team/stdio-mcp.ts";
import { FakeAdapter } from "./fakes/fake-adapter.ts";

describe("identity-bound stdio MCP server", () => {
  test("exposes the team surface and forwards calls without a sender argument", async () => {
    const calls: Array<{ name: string; input: unknown }> = [];
    const server = createTeamMcpServer("codex", async (name, input) => {
      calls.push({ name, input });
      return { ok: true, value: { sender: "codex" } };
    });
    const client = new Client({ name: "watari-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
        "team_activity",
        "team_activity_detail",
        "team_availability",
        "team_claim",
        "team_claim_update",
        "team_finding",
        "team_finding_update",
        "team_goal",
        "team_handoff",
        "team_inbox",
        "team_job",
        "team_progress",
        "team_release",
        "team_roster",
        "team_send",
        "team_status",
        "team_todo",
        "team_wake",
      ]);
      const result = await client.callTool({
        name: "team_send",
        arguments: { to: "claude", message: "Review this change." },
      });
      expect(result.isError).not.toBe(true);
      expect(calls).toEqual([{
        name: "team_send",
        input: { to: "claude", message: "Review this change." },
      }]);
      expect(JSON.stringify(calls)).not.toContain('"sender"');
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("runs as a real stdio child and reaches the private project service", async () => {
    const directory = mkdtempSync(join(tmpdir(), "watari-mcp-process-test-"));
    const projectDirectory = join(directory, "project");
    const stateDirectory = join(directory, "state");
    mkdirSync(projectDirectory);
    const project = resolveProjectContext(projectDirectory);
    const priorStateHome = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = stateDirectory;
    const location = resolveStateLocation(project);
    restoreStateHome(priorStateHome);

    const service = new WatariService({
      project,
      databasePath: location.databasePath,
      socketPath: location.socketPath,
      lockPath: location.lockPath,
      bridgeToken: "stdio-process-token",
      adapters: {
        codex: new FakeAdapter("codex"),
        claude: new FakeAdapter("claude"),
      },
    });
    await service.start();
    const runtime = await RuntimeClient.connect(location.socketPath);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        join(import.meta.dir, "../src/watari/index.ts"),
        "mcp",
        "--agent",
        "codex",
        projectDirectory,
      ],
      cwd: projectDirectory,
      env: { XDG_STATE_HOME: stateDirectory, WATARI_BRIDGE_TOKEN: "stdio-process-token" },
      stderr: "pipe",
    });
    const client = new Client({ name: "watari-process-test", version: "0.1.0" });
    try {
      await client.connect(transport);
      const result = await client.callTool({
        name: "team_send",
        arguments: { to: "claude", message: "stdio process roundtrip" },
      });
      expect(result.isError).not.toBe(true);
      const snapshot = await runtime.refresh();
      expect(snapshot.messages.at(-1)).toMatchObject({
        sender: "codex",
        recipients: ["claude"],
        body: "stdio process roundtrip",
      });
    } finally {
      await client.close();
      runtime.close();
      await service.stop();
      restoreStateHome(priorStateHome);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("a bridge reconnects to a service that restarted instead of staying dead", async () => {
    const directory = mkdtempSync(join(tmpdir(), "watari-mcp-reconnect-"));
    const socketPath = join(directory, "runtime.sock");
    const start = async (): Promise<WatariService> => {
      const service = new WatariService({
        project: { launchDirectory: directory, repositoryRoot: directory },
        databasePath: join(directory, "state.db"),
        socketPath,
        bridgeToken: "reconnect-token",
        adapters: { codex: new FakeAdapter("codex"), claude: new FakeAdapter("claude") },
      });
      await service.start();
      return service;
    };
    let service = await start();
    const connection = new TeamBridgeConnection({
      agent: "codex",
      provider: "codex",
      socketPath,
      token: "reconnect-token",
    });
    try {
      await connection.connect();
      expect((await connection.call("team_roster", {})).ok).toBe(true);

      await service.stop();
      await Bun.sleep(100);
      expect(await connection.call("team_roster", {})).toMatchObject({
        ok: false,
        error: expect.stringContaining("not reachable"),
      });

      service = await start();
      expect((await connection.call("team_roster", {})).ok).toBe(true);
    } finally {
      await connection.close();
      await service.stop();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

function restoreStateHome(value: string | undefined): void {
  if (value === undefined) {
    delete process.env.XDG_STATE_HOME;
  } else {
    process.env.XDG_STATE_HOME = value;
  }
}
