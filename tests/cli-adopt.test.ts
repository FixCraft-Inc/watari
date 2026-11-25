import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { adoptConversation } from "../src/watari/adopt.ts";
import { parseArguments } from "../src/watari/cli.ts";
import { CoordinatorRuntime } from "../src/watari/service/runtime.ts";
import { resolveStateLocation } from "../src/watari/state/location.ts";
import { TeamStore } from "../src/watari/state/store.ts";
import { loadProjectConfig } from "../src/watari/team/config.ts";
import { FakeAdapter } from "./fakes/fake-adapter.ts";

/** Offline only: no service is running and no harness is started. */
const saved = process.env.XDG_STATE_HOME;
const directories: string[] = [];

afterEach(() => {
  if (saved === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = saved;
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function project(agents?: unknown[]) {
  const root = mkdtempSync(join(tmpdir(), "watari-cli-adopt-"));
  directories.push(root);
  process.env.XDG_STATE_HOME = join(root, "state");
  const context = { launchDirectory: join(root, "checkout"), repositoryRoot: null };
  const location = resolveStateLocation(context);
  if (agents) {
    mkdirSync(location.directory, { recursive: true });
    writeFileSync(location.configPath, JSON.stringify({ schemaVersion: 1, agents }));
  }
  return { context, location };
}

function storedSession(databasePath: string, agent: string): string | null {
  const store = new TeamStore(databasePath);
  try {
    return store.agents().find((entry) => entry.id === agent)?.sessionId ?? null;
  } finally {
    store.close();
  }
}

describe("watari adopt", () => {
  test("parses an alias, a session id, and an optional path", () => {
    expect(parseArguments(["adopt", "qwen", "8dd63212-6727-4798-a4a3-ebe0aeb0eb28", "/work"])).toEqual({
      command: "adopt",
      agent: "qwen",
      sessionId: "8dd63212-6727-4798-a4a3-ebe0aeb0eb28",
      path: "/work",
    });
    expect(parseArguments(["adopt", "codex", "thread-1"])).toMatchObject({ path: "." });
    expect(() => parseArguments(["adopt", "codex"])).toThrow("adopt needs an agent alias");
    expect(() => parseArguments(["adopt", "codex", "thread-1", "--force"])).toThrow();
  });

  test("records the conversation for the next service, which resumes it and leaves the others fresh", async () => {
    const { context, location } = project([
      { alias: "codex", provider: "codex", model: "gpt-test", effort: "xhigh" },
      { alias: "claude", provider: "claude" },
      { alias: "qwen", provider: "qwen" },
    ]);
    const adopted = await adoptConversation(context, "codex", "01a19638-e0d5-7f61-a45d-ba973e8516d3");
    expect(adopted).toEqual({
      agent: "codex",
      provider: "codex",
      sessionId: "01a19638-e0d5-7f61-a45d-ba973e8516d3",
      replaced: null,
    });
    await adoptConversation(context, "qwen", "8dd63212-6727-4798-a4a3-ebe0aeb0eb28");

    const adapters = { codex: new FakeAdapter("codex"), claude: new FakeAdapter("claude"), qwen: new FakeAdapter("qwen") };
    const runtime = new CoordinatorRuntime({
      project: context,
      databasePath: location.databasePath,
      chatsDirectory: location.chatsDirectory,
      roster: loadProjectConfig(location.configPath).agents,
      adapters,
    });
    await runtime.start();
    try {
      expect(adapters.codex.resumedSession).toBe("01a19638-e0d5-7f61-a45d-ba973e8516d3");
      expect(adapters.qwen.resumedSession).toBe("8dd63212-6727-4798-a4a3-ebe0aeb0eb28");
      expect(adapters.claude.resumedSession).toBeNull();
    } finally {
      await runtime.stop();
    }
  });

  test("names the conversation it replaces", async () => {
    const { context, location } = project();
    await adoptConversation(context, "codex", "thread-first");
    const second = await adoptConversation(context, "codex", "thread-second");
    expect(second.replaced).toBe("thread-first");
    expect(storedSession(location.databasePath, "codex")).toBe("thread-second");
  });

  test("refuses an unconfigured alias, an external agent, and a malformed id", async () => {
    const { context } = project([
      { alias: "codex", provider: "codex" },
      { alias: "outside", provider: "claude", mode: "external" },
    ]);
    await expect(adoptConversation(context, "qwen", "session-1")).rejects.toThrow("not configured: qwen");
    await expect(adoptConversation(context, "outside", "session-1")).rejects.toThrow("external agent");
    await expect(adoptConversation(context, "codex", "../../etc/passwd")).rejects.toThrow("not a provider session id");
  });
});
