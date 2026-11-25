import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createClaudeTeamMcp } from "../src/watari/team/claude-mcp.ts";
import { createTeamMcpServer } from "../src/watari/team/stdio-mcp.ts";
import { TEAM_TOOL_CATALOG } from "../src/watari/team/tool-catalog.ts";
import {
  IdentityBoundTeamTools,
  TEAM_TOOL_DEFINITIONS,
} from "../src/watari/team/tools.ts";

describe("team tool transport parity", () => {
  test("Claude, stdio MCP, and Codex dynamic definitions expose the canonical catalog", async () => {
    const expected = TEAM_TOOL_CATALOG.map(({ name }) => name).sort();
    expect(TEAM_TOOL_DEFINITIONS.map(({ name }) => name).sort()).toEqual(expected);

    const host = {
      call: async () => ({ ok: true, value: null }),
    } as unknown as IdentityBoundTeamTools;
    const claude = createClaudeTeamMcp(host);
    const stdio = createTeamMcpServer("codex", async () => ({ ok: true, value: null }));
    const claudeClient = new Client({ name: "watari-parity-claude", version: "0.1.0" });
    const stdioClient = new Client({ name: "watari-parity-stdio", version: "0.1.0" });
    const [claudeClientTransport, claudeServerTransport] = InMemoryTransport.createLinkedPair();
    const [stdioClientTransport, stdioServerTransport] = InMemoryTransport.createLinkedPair();

    try {
      await Promise.all([
        claude.instance.connect(claudeServerTransport),
        claudeClient.connect(claudeClientTransport),
        stdio.connect(stdioServerTransport),
        stdioClient.connect(stdioClientTransport),
      ]);
      const [claudeTools, stdioTools] = await Promise.all([
        claudeClient.listTools(),
        stdioClient.listTools(),
      ]);
      expect(claudeTools.tools.map(({ name }) => name).sort()).toEqual(expected);
      expect(stdioTools.tools.map(({ name }) => name).sort()).toEqual(expected);
    } finally {
      await Promise.allSettled([
        claudeClient.close(),
        stdioClient.close(),
        claude.instance.close(),
        stdio.close(),
      ]);
    }
  });
});
