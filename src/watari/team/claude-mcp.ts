import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";

import { TEAM_TOOL_CATALOG } from "./tool-catalog.ts";
import { IdentityBoundTeamTools } from "./tools.ts";

export function createClaudeTeamMcp(host: IdentityBoundTeamTools) {
  return createSdkMcpServer({
    name: "watari",
    version: "0.1.0",
    instructions:
      "Durable Watari peer coordination. Sender identity is bound by the host and cannot be supplied by tool input.",
    alwaysLoad: true,
    tools: TEAM_TOOL_CATALOG.map((definition) => tool(
      definition.name,
      definition.description,
      definition.inputShape,
      (args) => call(host, definition.name, args),
    )),
  });
}

async function call(host: IdentityBoundTeamTools, name: string, input: unknown) {
  const result = await host.call(name, input);
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result) }],
    ...(result.ok ? {} : { isError: true }),
  };
}
