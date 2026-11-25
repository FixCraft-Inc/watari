import { describe, expect, test } from "bun:test";

import {
  claudeTeamMcpConfig,
  codexTeamMcpConfig,
  acpTeamMcpConfig,
} from "../src/watari/team/provider-config.ts";

describe("managed provider MCP configuration", () => {
  test("passes an exact identity-bound command to Claude without a shell", () => {
    expect(claudeTeamMcpConfig([
      "/opt/watari",
      "mcp",
      "--agent",
      "claude",
      "/work/project with spaces",
    ])).toEqual({
      type: "stdio",
      command: "/opt/watari",
      args: ["mcp", "--agent", "claude", "/work/project with spaces"],
      alwaysLoad: true,
    });
  });

  test("passes an exact identity-bound command to a Codex thread", () => {
    expect(codexTeamMcpConfig([
      "/opt/watari",
      "mcp",
      "--agent",
      "codex",
      "/work/project with spaces",
    ], "/work/project with spaces")).toEqual({
      history: { persistence: "none" },
      mcp_servers: {
        watari: {
          command: "/opt/watari",
          args: ["mcp", "--agent", "codex", "/work/project with spaces"],
          cwd: "/work/project with spaces",
          enabled: true,
          required: true,
          startup_timeout_sec: 10,
          tool_timeout_sec: 60,
        },
      },
    });
  });

  test("passes an exact identity-bound command to an OpenCode ACP session", () => {
    expect(acpTeamMcpConfig([
      "/opt/watari",
      "mcp",
      "--agent",
      "reviewer",
      "--provider",
      "opencode",
      "/work/project with spaces",
    ])).toEqual({
      name: "watari",
      command: "/opt/watari",
      args: [
        "mcp",
        "--agent",
        "reviewer",
        "--provider",
        "opencode",
        "/work/project with spaces",
      ],
      env: [],
    });
  });

  test("carries the managed-bridge token in each provider's own environment shape", () => {
    const env = { WATARI_BRIDGE_TOKEN: "token" };
    expect(claudeTeamMcpConfig(["/opt/watari", "mcp"], env)).toMatchObject({ env });
    expect(codexTeamMcpConfig(["/opt/watari", "mcp"], "/work", env).mcp_servers).toMatchObject({
      watari: { env },
    });
    expect(acpTeamMcpConfig(["/opt/watari", "mcp"], env).env).toEqual([
      { name: "WATARI_BRIDGE_TOKEN", value: "token" },
    ]);
  });
});
