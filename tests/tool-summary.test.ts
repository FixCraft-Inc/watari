import { describe, expect, test } from "bun:test";

import {
  claudePermissionOptions,
  codexThreadPosture,
  codexTeamMcpConfig,
} from "../src/watari/team/provider-config.ts";
import { describeClaudeTool, describeCodexItem, formatToolLabel } from "../src/watari/agents/tool-summary.ts";

describe("managed provider configuration", () => {
  test("managed sessions are unrestricted while probes stay read-only", () => {
    expect(claudePermissionOptions({ unrestricted: true })).toMatchObject({
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      promptsForApproval: false,
    });
    expect(codexThreadPosture({ unrestricted: true })).toEqual({
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    });

    const probe = claudePermissionOptions({ readOnlyProbe: true, unrestricted: true });
    expect(probe).toMatchObject({ permissionMode: "dontAsk", tools: [] });
    expect(probe.allowDangerouslySkipPermissions).toBeUndefined();
    expect(codexThreadPosture({ readOnlyProbe: true, unrestricted: true })).toEqual({
      sandbox: "read-only",
      approvalPolicy: "never",
    });
  });

  test("the team bridge is launched as a stdio server in the project directory", () => {
    const config = codexTeamMcpConfig(["/usr/bin/watari", "mcp", "--agent", "codex"], "/work");
    const servers = config["mcp_servers"];
    expect(servers).toMatchObject({
      watari: { command: "/usr/bin/watari", cwd: "/work", enabled: true },
    });
  });
});

describe("tool labels", () => {
  test("Claude tool calls read as a verb and its target", () => {
    expect(formatToolLabel(describeClaudeTool("Bash", { command: "bun test" }))).toBe("bash  bun test");
    expect(formatToolLabel(describeClaudeTool("Edit", { file_path: "src/a.ts" }))).toBe("edit  src/a.ts");
    expect(formatToolLabel(describeClaudeTool("Grep", { pattern: "queue" }))).toBe("search  queue");
    expect(formatToolLabel(describeClaudeTool("WebFetch", { url: "https://example.com" }))).toBe(
      "fetch  https://example.com",
    );
  });

  test("a team tool loses its mcp prefix", () => {
    expect(formatToolLabel(describeClaudeTool("mcp__watari__team_status", {}))).toBe("team  team status");
    expect(formatToolLabel(describeClaudeTool("mcp__other__do_thing", {}))).toBe("team  other do thing");
  });

  test("an unknown tool still gets a lowercase verb", () => {
    expect(formatToolLabel(describeClaudeTool("SomeNewTool", {}))).toBe("somenewtool");
  });

  test("long arguments are cut so one call stays one line", () => {
    const label = describeClaudeTool("Bash", { command: "x".repeat(500) });
    expect(label.detail.length).toBeLessThanOrEqual(160);
    expect(label.detail.endsWith("…")).toBe(true);
  });

  test("multi-line commands collapse onto one line", () => {
    expect(describeClaudeTool("Bash", { command: "one\n  two" }).detail).toBe("one two");
  });

  test("Codex thread items read the same way", () => {
    expect(formatToolLabel(describeCodexItem({ type: "commandExecution", command: "bun test" })!)).toBe(
      "bash  bun test",
    );
    expect(
      formatToolLabel(
        describeCodexItem({ type: "fileChange", changes: [{ path: "src/a.ts" }, { path: "src/b.ts" }] })!,
      ),
    ).toBe("edit  src/a.ts src/b.ts");
    expect(formatToolLabel(describeCodexItem({ type: "mcpToolCall", server: "watari", tool: "team_send" })!)).toBe(
      "team  team send",
    );
    expect(formatToolLabel(describeCodexItem({ type: "webSearch", query: "bounded queue" })!)).toBe(
      "web  bounded queue",
    );
  });

  test("a long file change list is summarised rather than wrapped", () => {
    const label = describeCodexItem({
      type: "fileChange",
      changes: [{ path: "a.ts" }, { path: "b.ts" }, { path: "c.ts" }, { path: "d.ts" }],
    });
    expect(label?.detail).toBe("a.ts b.ts +2 more");
  });

  test("an item Watari has no label for is left to the caller", () => {
    expect(describeCodexItem({ type: "userMessage" })).toBeNull();
  });

  test("the detail never contains the double space that separates it from the verb", () => {
    const labels = [
      describeClaudeTool("Bash", { command: "a    b\tc" }),
      describeCodexItem({ type: "commandExecution", command: "a    b" })!,
      describeCodexItem({ type: "fileChange", changes: [{ path: "a.ts" }, { path: "b.ts" }] })!,
    ];
    for (const label of labels) {
      expect(label.detail).not.toMatch(/\s{2,}/u);
      expect(formatToolLabel(label).split(/\s{2,}/u)).toHaveLength(2);
    }
  });
});
