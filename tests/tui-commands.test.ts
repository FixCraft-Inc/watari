import { describe, expect, test } from "bun:test";

import {
  COMMANDS,
  KEYS,
  commandSuggestions,
  completeCommand,
  parseCommand,
  targetForTab,
  usageFor,
} from "../src/watari/tui/commands.ts";
import { helpRows } from "../src/watari/tui/components.tsx";
import { cellWidth } from "../src/watari/tui/format.ts";

describe("composer commands", () => {
  test("plain text goes to the tab's audience", () => {
    expect(parseCommand("ship it", 0)).toEqual({ type: "send", target: "all", text: "ship it" });
    expect(parseCommand("ship it", 1)).toEqual({ type: "send", target: "codex", text: "ship it" });
    expect(parseCommand("ship it", 2)).toEqual({ type: "send", target: "claude", text: "ship it" });
  });

  test("a slash inside a sentence is still a message", () => {
    expect(parseCommand("look at src/a.ts / src/b.ts", 0)).toEqual({
      type: "send",
      target: "all",
      text: "look at src/a.ts / src/b.ts",
    });
  });

  test("routes broadcast and directed sends", () => {
    expect(parseCommand("/all rebase first", 1)).toEqual({ type: "send", target: "all", text: "rebase first" });
    expect(parseCommand("/to claude check the schema", 0)).toEqual({
      type: "send",
      target: "claude",
      text: "check the schema",
    });
    expect(parseCommand("/goal harden the queue", 0)).toEqual({
      type: "send",
      target: "all",
      text: "harden the queue",
    });
  });

  test("parses lifecycle and approval commands", () => {
    expect(parseCommand("/done", 0)).toEqual({ type: "complete" });
    expect(parseCommand("/new", 0)).toEqual({ type: "new_chat" });
    expect(parseCommand("/detach", 0)).toEqual({ type: "detach" });
    expect(parseCommand("/quit", 0)).toEqual({ type: "quit" });
    expect(parseCommand("/status", 0)).toEqual({ type: "status" });
    expect(parseCommand("/help", 0)).toEqual({ type: "help" });
    expect(parseCommand("/interrupt codex", 0)).toEqual({ type: "interrupt", agent: "codex" });
    expect(parseCommand("/approve claude req_1", 0)).toEqual({
      type: "approval",
      agent: "claude",
      requestId: "req_1",
      decision: "accept",
    });
    expect(parseCommand("/decline codex req_2", 0)).toEqual({
      type: "approval",
      agent: "codex",
      requestId: "req_2",
      decision: "decline",
    });
    expect(parseCommand("/cancel codex req_3", 0)).toEqual({
      type: "approval",
      agent: "codex",
      requestId: "req_3",
      decision: "cancel",
    });
  });

  test("a malformed command is reported instead of being sent to a peer", () => {
    for (const input of ["/all", "/to", "/to all hello", "/interrupt all", "/approve codex", "/nope"]) {
      expect(parseCommand(input, 0)).toEqual({ type: "unknown", input });
    }
  });

  test("every documented command parses to something other than unknown", () => {
    // The approval the strip is showing. The documented `[peer id]` forms are
    // optional precisely because this exists.
    const pending = { agent: "codex", requestId: "req_1" } as const;
    for (const entry of COMMANDS) {
      // `<x>` is a required placeholder; `[x]` is an optional argument, so the
      // documented form has to parse with it left out.
      const filled = entry.usage
        .replace(/\s*\[[^\]]*\]/gu, "")
        .replace("<peer|all>", "codex")
        .replace("<chat>", "1")
        .replace("<peer>", "codex")
        .replace("<provider>", "codex")
        .replace("<id>", "req_1")
        .replace("<text>", "hello");
      expect(parseCommand(filled, 0, ["codex", "claude"], pending).type).not.toBe("unknown");
    }
  });

  test("a bare approval answers the request on the strip, and nothing without one", () => {
    const pending = { agent: "claude", requestId: "req_7731" } as const;
    expect(parseCommand("/approve", 0, ["codex", "claude"], pending)).toEqual({
      type: "approval",
      agent: "claude",
      requestId: "req_7731",
      decision: "accept",
    });
    expect(parseCommand("/decline", 0, ["codex", "claude"], pending)).toMatchObject({ decision: "decline" });
    expect(parseCommand("/approve", 0)).toEqual({ type: "unknown", input: "/approve" });
    // An explicit peer and id still win, so a second request stays answerable.
    expect(parseCommand("/approve codex req_2", 0, ["codex", "claude"], pending)).toMatchObject({
      agent: "codex",
      requestId: "req_2",
    });
  });

  test("the help panel documents keys as well as commands", () => {
    expect(KEYS.length).toBeGreaterThan(0);
    expect(KEYS.some((entry) => entry.usage.includes("ctrl+c"))).toBe(true);
  });

  test("tab index maps to a send target", () => {
    expect([targetForTab(0), targetForTab(1), targetForTab(2)]).toEqual(["all", "codex", "claude"]);
    expect(targetForTab(2, ["review", "builder", "tester"])).toBe("builder");
  });

  test("agent configuration keeps alias separate from provider", () => {
    expect(parseCommand("/agent add reviewer claude model=sonnet effort=high permissions=prompt", 0)).toEqual({
      type: "agent_configure",
      definition: {
        alias: "reviewer",
        provider: "claude",
        displayName: "Reviewer",
        model: "sonnet",
        effort: "high",
        mode: "managed",
        unrestricted: false,
      },
    });
    expect(parseCommand("/agent remove reviewer", 0)).toEqual({ type: "agent_remove", agent: "reviewer" });
    expect(parseCommand("/agent set reviewer claude", 0)).toEqual({
      type: "agent_configure",
      definition: { alias: "reviewer", provider: "claude", displayName: "Reviewer", mode: "managed" },
    });
    expect(parseCommand("/agent set reviewer claude permissions=bypass", 0)).toMatchObject({
      type: "agent_configure",
      definition: { unrestricted: true },
    });
    expect(parseCommand("/models", 2, ["builder", "reviewer"])).toEqual({ type: "models" });
    expect(parseCommand("/models reviewer", 0)).toEqual({ type: "models", agent: "reviewer" });
    expect(parseCommand("/model", 2, ["builder", "reviewer"])).toEqual({ type: "models", agent: "reviewer" });
    expect(parseCommand("/model remove reviewer", 0)).toEqual({ type: "agent_remove", agent: "reviewer" });
    expect(parseCommand("/effort", 1, ["builder", "reviewer"])).toEqual({ type: "effort", agent: "builder" });
  });

  test("suggests command names and descriptions while typing slash", () => {
    expect(commandSuggestions("/mo").map((entry) => entry.usage)).toEqual([
      "/models [peer]",
      "/model [peer]",
      "/model remove <peer>",
    ]);
    expect(commandSuggestions("/models ").map((entry) => entry.usage)).toEqual([
      "/models codex",
      "/models claude",
    ]);
    expect(commandSuggestions("hello")).toEqual([]);
    expect(completeCommand(commandSuggestions("/eff")[0]!)).toBe("/effort ");
    expect(completeCommand(commandSuggestions("/go")[0]!)).toBe("/goal ");
  });

  test("completes multi-word commands and live peer arguments one segment at a time", () => {
    const peers = [
      { id: "builder", description: "Builder · gpt-5.6 · codex" },
      { id: "reviewer", description: "Reviewer · sonnet · claude" },
    ] as const;

    expect(commandSuggestions("/agent ").map((entry) => entry.usage)).toEqual([
      "/agent add <peer> <provider>",
      "/agent set <peer> <provider>",
      "/agent remove <peer>",
    ]);
    expect(completeCommand(commandSuggestions("/agent s", peers)[0]!)).toBe("/agent set ");
    expect(completeCommand(commandSuggestions("/agent r", peers)[0]!)).toBe("/agent remove ");
    expect(commandSuggestions("/agent remove ", peers).map((entry) => entry.usage)).toEqual([
      "/agent remove builder",
      "/agent remove reviewer",
    ]);
    expect(commandSuggestions("/agent remove r", peers)[0]).toMatchObject({
      usage: "/agent remove reviewer",
      description: "Reviewer · sonnet · claude",
      completion: "/agent remove reviewer",
    });

    const removeAlias = commandSuggestions("/model rem", peers)[0]!;
    expect(removeAlias.usage).toBe("/model remove <peer>");
    expect(completeCommand(removeAlias)).toBe("/model remove ");
    expect(commandSuggestions("/model remove ", peers).map((entry) => entry.usage)).toEqual([
      "/model remove builder",
      "/model remove reviewer",
    ]);

    expect(completeCommand(commandSuggestions("/to b", peers)[0]!)).toBe("/to builder ");
    expect(completeCommand(commandSuggestions("/copy g", peers)[0]!)).toBe("/copy goal");
  });
});

describe("command discovery", () => {
  test("an older spelling finds the command it became", () => {
    expect(commandSuggestions("/mcp").map((entry) => entry.usage)).toEqual(["/check"]);
    expect(commandSuggestions("/interrupt").map((entry) => entry.usage)).toEqual(["/stop [peer|all]"]);
    expect(commandSuggestions("/history").map((entry) => entry.usage)).toEqual(["/chats"]);
    // Every alias the parser accepts is discoverable, or it may as well not exist.
    for (const alias of ["/roster", "/keys", "/mcp", "/interrupt", "/history"]) {
      expect(commandSuggestions(alias)).not.toHaveLength(0);
      expect(parseCommand(alias, 0).type).not.toBe("unknown");
    }
  });

  test("contextual suggestions stop only once free-form text begins", () => {
    expect(commandSuggestions("/to ").map((entry) => entry.usage)).toEqual([
      "/to codex",
      "/to claude",
    ]);
    expect(commandSuggestions("/to codex hello")).toEqual([]);
    expect(commandSuggestions("hello")).toEqual([]);
  });

  test("a known command typed wrong is answered with its shape", () => {
    expect(usageFor("/to codex")).toBe("/to <peer> <text>");
    expect(usageFor("/mcp")).toBe("/check");
    expect(usageFor("/model remove")).toBe("/agent remove <peer>");
    expect(usageFor("/nope")).toBeNull();
    expect(usageFor("hello")).toBeNull();
  });
});

test("help rows keep every word of a description within their column", () => {
  for (const width of [30, 44, 61]) {
    const rows = helpRows(COMMANDS, width);
    for (const row of rows) {
      const used = row.description === "" ? cellWidth(row.usage) : row.usageWidth + 2 + cellWidth(row.description);
      expect(used).toBeLessThanOrEqual(width);
    }
    const words = (text: string) => text.split(/\s+/u).filter(Boolean);
    expect(rows.flatMap((row) => words(row.description))).toEqual(COMMANDS.flatMap((entry) => words(entry.description)));
  }
});

describe("chat management commands", () => {
  test("/clear always names who it clears, and never means a new chat", () => {
    expect(parseCommand("/clear claude", 1)).toEqual({ type: "clear", agent: "claude" });
    expect(parseCommand("/clear all", 1)).toEqual({ type: "clear", agent: "all" });
    expect(parseCommand("/clear", 1).type).toBe("unknown");
    expect(parseCommand("/new", 1)).toEqual({ type: "new_chat" });
  });

  test("/stop defaults to the focused peer and accepts one peer or all", () => {
    expect(parseCommand("/stop", 1)).toEqual({ type: "stop", agent: null });
    expect(parseCommand("/stop all", 1)).toEqual({ type: "stop", agent: "all" });
    expect(parseCommand("/stop codex", 0)).toEqual({ type: "stop", agent: "codex" });
    expect(parseCommand("/interrupt", 1)).toEqual({ type: "stop", agent: null });
  });

  test("export, handoff, save, chats, and resume parse with their arguments", () => {
    expect(parseCommand("/export", 0)).toEqual({ type: "export", handoff: false, path: null });
    expect(parseCommand("/handoff notes/next.md", 0)).toEqual({ type: "export", handoff: true, path: "notes/next.md" });
    expect(parseCommand("/save", 0)).toEqual({ type: "save" });
    expect(parseCommand("/chats", 0)).toEqual({ type: "chats" });
    expect(parseCommand("/resume", 0)).toEqual({ type: "chats" });
    expect(parseCommand("/resume 2", 0)).toEqual({ type: "resume", chat: "2" });
  });

  test("@peer addresses one peer from any tab, and an unknown name stays text", () => {
    expect(parseCommand("@claude check the store", 0, ["codex", "claude"])).toEqual({
      type: "send",
      target: "claude",
      text: "check the store",
    });
    expect(parseCommand("@nobody hello", 1, ["codex", "claude"])).toEqual({
      type: "send",
      target: "codex",
      text: "@nobody hello",
    });
  });

  test("completion offers peers after @, all for /stop, and archived chats for /resume", () => {
    expect(commandSuggestions("@cl", ["codex", "claude"]).map((entry) => entry.completion)).toEqual(["@claude "]);
    expect(commandSuggestions("/stop a", ["codex", "claude"]).map((entry) => entry.completion)).toEqual(["/stop all"]);
    const chats = [
      { id: "2026-09-20T10-00-00.000Z-aaaa1111", title: "fix the queue", current: true },
      { id: "2026-09-19T10-00-00.000Z-bbbb2222", title: "review the docs" },
    ];
    expect(commandSuggestions("/resume ", ["codex"], chats).map((entry) => entry.description)).toEqual(["review the docs"]);
  });
});
