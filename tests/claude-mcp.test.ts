import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { TeamStore } from "../src/watari/state/store.ts";
import { createClaudeTeamMcp } from "../src/watari/team/claude-mcp.ts";
import { IdentityBoundTeamTools } from "../src/watari/team/tools.ts";
import { TeamApplicationService } from "../src/watari/team/service.ts";

describe("Claude in-process MCP bridge", () => {
  test("lists the team surface and binds a tool call to Claude", async () => {
    const store = new TeamStore(":memory:");
    store.registerAgent({ id: "codex", backend: "codex", displayName: "Codex" });
    store.registerAgent({ id: "claude", backend: "claude", displayName: "Claude" });
    const host = new IdentityBoundTeamTools({
      agent: "claude",
      service: new TeamApplicationService({ store }),
    });
    const config = createClaudeTeamMcp(host);
    const client = new Client({ name: "watari-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([
        config.instance.connect(serverTransport),
        client.connect(clientTransport),
      ]);
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toContain("team_send");
      const result = await client.callTool({
        name: "team_send",
        arguments: { to: "codex", message: "MCP identity roundtrip" },
      });
      expect(result.isError).not.toBe(true);
      expect(store.inbox("codex")[0]?.sender).toBe("claude");
    } finally {
      await client.close();
      await config.instance.close();
      store.close();
    }
  });
});
