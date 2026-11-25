import { describe, expect, test } from "bun:test";

import { parseArguments } from "../src/watari/cli.ts";

describe("CLI modes", () => {
  test("the default and ui modes may start the per-project service", () => {
    expect(parseArguments([])).toEqual({ command: "launch", path: ".", startService: true });
    expect(parseArguments(["ui", "/work/project"])).toEqual({
      command: "launch",
      path: "/work/project",
      startService: true,
    });
  });

  test("attach never starts a second service", () => {
    expect(parseArguments(["attach", "/work/project"])).toEqual({
      command: "launch",
      path: "/work/project",
      startService: false,
    });
  });

  // A frontend that is not a terminal cannot use `ui`, which takes the terminal
  // over, and must not reach for `internal-service`, whose paths are private.
  test("serve starts the service headlessly for another frontend", () => {
    expect(parseArguments(["serve"])).toEqual({ command: "serve", path: ".", json: false });
    expect(parseArguments(["serve", "/work/project", "--json"])).toEqual({
      command: "serve",
      path: "/work/project",
      json: true,
    });
    expect(() => parseArguments(["serve", "a", "b"])).toThrow();
    expect(() => parseArguments(["serve", "--wat"])).toThrow();
  });

  test("status, help, and version are explicit non-ui modes", () => {
    expect(parseArguments(["status", ".", "--json"])).toEqual({
      command: "status",
      path: ".",
      json: true,
    });
    expect(parseArguments(["--help"])).toEqual({ command: "help" });
    expect(parseArguments(["--version"])).toEqual({ command: "version" });
    expect(parseArguments(["probe", "opencode", "/work/project", "--json"])).toEqual({
      command: "probe",
      adapter: "opencode",
      path: "/work/project",
      live: false,
      json: true,
    });
  });

  test("MCP mode binds a safe alias and defaults to the current directory", () => {
    expect(parseArguments(["mcp", "--agent", "codex", "/work/project"])).toEqual({
      command: "mcp",
      agent: "codex",
      provider: "codex",
      path: "/work/project",
    });
    expect(parseArguments(["mcp", "--agent", "opencode"])).toEqual({
      command: "mcp",
      agent: "opencode",
      provider: "opencode",
      path: ".",
    });
  });

  test("an alias is separate from the harness it runs on", () => {
    expect(parseArguments(["mcp", "--agent", "sonnet-2", "--provider", "claude", "/work"])).toEqual({
      command: "mcp",
      agent: "sonnet-2",
      provider: "claude",
      path: "/work",
    });
    // An alias that names no provider cannot be resolved on its own.
    expect(() => parseArguments(["mcp", "--agent", "sonnet-2"])).toThrow("--provider");
    expect(() => parseArguments(["mcp", "--agent", "a", "--provider", "gemini"])).toThrow("--provider");
    expect(() => parseArguments(["mcp", "--agent", "user"])).toThrow("agent alias");
    expect(() => parseArguments(["mcp", "--agent", "bad alias"])).toThrow("agent alias");
    expect(() => parseArguments(["--mcp", "--iam", "codex"])).toThrow("unknown command");
  });
});
