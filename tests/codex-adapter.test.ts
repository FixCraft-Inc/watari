import { describe, expect, test } from "bun:test";

import { CodexAdapter } from "../src/watari/agents/codex.ts";
import { resolveProjectContext } from "../src/watari/project/checkout.ts";
import type { AgentEvent } from "../src/watari/models.ts";
import { TeamStore } from "../src/watari/state/store.ts";
import { IdentityBoundTeamTools } from "../src/watari/team/tools.ts";
import { TeamApplicationService } from "../src/watari/team/service.ts";

const fake = `${import.meta.dir}/fakes/fake-codex.ts`;

describe("CodexAdapter", () => {
  test("prompt permissions explicitly replace an unrestricted thread posture on resume", async () => {
    const previous = process.env.WATARI_FAKE_MODE;
    process.env.WATARI_FAKE_MODE = "profile";
    const unrestricted = new CodexAdapter({ executable: process.execPath, commandPrefix: [process.execPath, fake], unrestricted: true });
    const restricted = new CodexAdapter({ executable: process.execPath, commandPrefix: [process.execPath, fake], unrestricted: false });
    const before: AgentEvent[] = [];
    const after: AgentEvent[] = [];
    const collect = async (adapter: CodexAdapter, events: AgentEvent[]) => {
      for await (const event of adapter.events()) events.push(event);
    };
    const collectors = [collect(unrestricted, before), collect(restricted, after)];
    try {
      await unrestricted.start(resolveProjectContext("."));
      await unrestricted.prepare();
      await until(() => before.some((event) => event.rawType === "watari/test/thread-profile"));
      const session = unrestricted.sessionId!;
      await unrestricted.stop();
      await restricted.start(resolveProjectContext("."));
      await restricted.resume(session);
      await until(() => after.some((event) => event.rawType === "watari/test/thread-profile"));
      expect(before.find((event) => event.rawType === "watari/test/thread-profile")?.payload)
        .toMatchObject({ sandbox: "danger-full-access", approvalPolicy: "never" });
      expect(after.find((event) => event.rawType === "watari/test/thread-profile")?.payload)
        .toMatchObject({ threadId: session, sandbox: "workspace-write", approvalPolicy: "on-request" });
    } finally {
      await unrestricted.stop();
      await restricted.stop();
      await Promise.all(collectors);
      if (previous === undefined) delete process.env.WATARI_FAKE_MODE;
      else process.env.WATARI_FAKE_MODE = previous;
    }
  });

  test("discovers native models without starting a turn and preserves an alias", async () => {
    const adapter = new CodexAdapter({
      executable: process.execPath,
      commandPrefix: [process.execPath, fake],
      agent: "reviewer",
    });
    try {
      await adapter.start(resolveProjectContext("."));
      expect(await adapter.availableModels()).toEqual([{
        id: "fake-model",
        displayName: "Fake Model",
        description: "deterministic fixture",
        efforts: ["low", "high"],
        isDefault: true,
      }]);
      const iterator = adapter.events()[Symbol.asyncIterator]();
      expect((await iterator.next()).value?.agent).toBe("reviewer");
    } finally {
      await adapter.stop();
    }
  });

  test("sub-agent turns and errors do not move this agent's turn, so steering still works", async () => {
    process.env.WATARI_FAKE_MODE = "subagents";
    const adapter = new CodexAdapter({ executable: process.execPath, commandPrefix: [process.execPath, fake] });
    const events: AgentEvent[] = [];
    try {
      await adapter.start(resolveProjectContext("."));
      void (async () => {
        for await (const event of adapter.events()) events.push(event);
      })();
      await adapter.send({ kind: "message", text: "start the review" });
      await until(() => events.some((event) => event.rawType === "watari/test/subagent-done"));

      expect(events.some((event) => event.rawType === "subagent/turn/completed")).toBe(true);
      expect(events.some((event) => event.rawType === "turn/completed")).toBe(false);
      expect(events.filter((event) => event.kind === "error")).toEqual([]);
      expect(events.find((event) => event.rawType === "error")?.summary).toBe(
        "Codex sub-agent: sub-agent hit a snag",
      );
      expect(adapter.sessionId).toBe("thread-fake");

      await adapter.send({ kind: "message", text: "peer mail mid-turn" });
      await until(() => events.some((event) => event.rawType === "watari/test/steered"));
      expect(events.find((event) => event.rawType === "watari/test/steered")?.payload).toEqual({
        expectedTurnId: "turn-fake",
      });
    } finally {
      await adapter.stop();
      delete process.env.WATARI_FAKE_MODE;
    }
  });

  test("a steer refused for naming the wrong turn is offered to the turn Codex names", async () => {
    process.env.WATARI_FAKE_MODE = "stale-turn";
    const adapter = new CodexAdapter({ executable: process.execPath, commandPrefix: [process.execPath, fake] });
    const events: AgentEvent[] = [];
    try {
      await adapter.start(resolveProjectContext("."));
      void (async () => {
        for await (const event of adapter.events()) events.push(event);
      })();
      await adapter.send({ kind: "message", text: "start" });
      await until(() => events.some((event) => event.rawType === "turn/started"));
      await adapter.send({ kind: "message", text: "steer me" });
      await until(() => events.some((event) => event.rawType === "watari/test/steered"));
      expect(events.find((event) => event.rawType === "watari/test/steered")?.payload).toEqual({
        expectedTurnId: "turn-fake",
      });
    } finally {
      await adapter.stop();
      delete process.env.WATARI_FAKE_MODE;
    }
  });

  test("a retrying error is a warning, and a terminal error keeps its readable message", async () => {
    process.env.WATARI_FAKE_MODE = "turn-errors";
    const adapter = new CodexAdapter({ executable: process.execPath, commandPrefix: [process.execPath, fake] });
    const errors: AgentEvent[] = [];
    try {
      await adapter.start(resolveProjectContext("."));
      await adapter.send({ kind: "message", text: "fixture" });
      for await (const event of adapter.events()) {
        if (event.rawType === "error") errors.push(event);
        if (event.summary.includes("turn completed")) break;
      }
    } finally {
      await adapter.stop();
      delete process.env.WATARI_FAKE_MODE;
    }
    expect(errors.map((event) => [event.kind, event.summary])).toEqual([
      ["warning", "Codex is retrying after: stream disconnected before completion (responseStreamDisconnected)"],
      ["error", "You've hit your usage limit. (usageLimitExceeded)"],
    ]);
  });

  test("passes the configured model and effort through the native protocol", async () => {
    process.env.WATARI_FAKE_MODE = "profile";
    const adapter = new CodexAdapter({
      executable: process.execPath,
      commandPrefix: [process.execPath, fake],
      model: "gpt-test",
      effort: "high",
    });
    const profiles: AgentEvent[] = [];
    try {
      await adapter.start(resolveProjectContext("."));
      await adapter.send({ kind: "message", text: "fixture" });
      for await (const event of adapter.events()) {
        if (event.rawType?.startsWith("watari/test/")) profiles.push(event);
        if (event.summary.includes("turn completed")) break;
      }
    } finally {
      await adapter.stop();
      delete process.env.WATARI_FAKE_MODE;
    }
    expect(profiles.find((event) => event.rawType === "watari/test/thread-profile")?.payload).toMatchObject({
      model: "gpt-test",
    });
    expect(profiles.find((event) => event.rawType === "watari/test/turn-profile")?.payload).toMatchObject({
      model: "gpt-test",
      effort: "high",
    });
  });

  test.each(["approval", "approval-number"])("normalizes native protocol events and %s IDs through transcript strings", async (mode) => {
    const originalMode = process.env.WATARI_FAKE_MODE;
    const originalSecret = process.env.WATARI_FAKE_SECRET;
    process.env.WATARI_FAKE_MODE = mode;
    process.env.WATARI_FAKE_SECRET = "synthetic-secret-value";
    const adapter = new CodexAdapter({
      executable: process.execPath,
      commandPrefix: [process.execPath, fake],
    });
    const events: AgentEvent[] = [];
    try {
      await adapter.start(resolveProjectContext("."));
      await adapter.send({ kind: "message", text: "fixture" });
      const iterator = adapter.events()[Symbol.asyncIterator]();
      while (true) {
        const next = await iterator.next();
        if (next.done) {
          break;
        }
        events.push(next.value);
        if (next.value.kind === "approval") {
          await adapter.send({
            kind: "approval_response",
            requestId: next.value.providerEventId!,
            decision: "decline",
          });
        }
        if (next.value.summary.includes("turn completed")) {
          break;
        }
      }
    } finally {
      await adapter.stop();
      restoreEnvironment("WATARI_FAKE_MODE", originalMode);
      restoreEnvironment("WATARI_FAKE_SECRET", originalSecret);
    }
    expect(events.some((event) => event.kind === "assistant")).toBe(true);
    expect(events.some((event) => event.kind === "reasoning")).toBe(true);
    expect(events.some((event) => event.kind === "diff")).toBe(true);
    expect(events.some((event) => event.rawType === "future/event")).toBe(true);
    expect(JSON.stringify(events)).not.toContain("synthetic-secret-value");
    expect(JSON.stringify(events)).toContain("stdin_tty=false");
  });

  test("survives malformed and partial JSONL", async () => {
    for (const mode of ["malformed", "partial", "invalid-shape"] as const) {
      process.env.WATARI_FAKE_MODE = mode;
      const adapter = new CodexAdapter({
        executable: process.execPath,
        commandPrefix: [process.execPath, fake],
      });
      await adapter.start(resolveProjectContext("."));
      await adapter.stop();
      const events: AgentEvent[] = [];
      for await (const event of adapter.events()) {
        events.push(event);
      }
      expect(events.some((event) => event.rawType === "initialize")).toBe(true);
      if (mode === "malformed") {
        expect(events.some((event) => event.rawType === "malformed_jsonl")).toBe(true);
      } else if (mode === "invalid-shape") {
        expect(events.some((event) => event.rawType === "invalid_notification")).toBe(true);
      }
    }
    delete process.env.WATARI_FAKE_MODE;
  });

  test("handles large tool output without blocking turn completion", async () => {
    process.env.WATARI_FAKE_MODE = "huge";
    const adapter = new CodexAdapter({
      executable: process.execPath,
      commandPrefix: [process.execPath, fake],
    });
    const startedAt = Date.now();
    try {
      await adapter.start(resolveProjectContext("."));
      await adapter.send({ kind: "message", text: "fixture" });
      for await (const event of adapter.events()) {
        if (event.summary.includes("turn completed")) {
          break;
        }
      }
    } finally {
      await adapter.stop();
      delete process.env.WATARI_FAKE_MODE;
    }
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  test("binds a dynamic team tool call to Codex", async () => {
    process.env.WATARI_FAKE_MODE = "team-tools";
    const store = new TeamStore(":memory:");
    store.registerAgent({ id: "codex", backend: "codex", displayName: "Codex" });
    store.registerAgent({ id: "claude", backend: "claude", displayName: "Claude" });
    const adapter = new CodexAdapter({
      executable: process.execPath,
      commandPrefix: [process.execPath, fake],
      teamTools: new IdentityBoundTeamTools({
        agent: "codex",
        service: new TeamApplicationService({ store }),
      }),
    });
    try {
      await adapter.start(resolveProjectContext("."));
      await adapter.send({ kind: "message", text: "fixture" });
      for await (const event of adapter.events()) {
        if (event.summary.includes("turn completed")) break;
      }
      expect(store.inbox("claude")[0]?.sender).toBe("codex");
    } finally {
      await adapter.stop();
      store.close();
      delete process.env.WATARI_FAKE_MODE;
    }
  });

  test("injects the identity-bound stdio MCP command into the Codex thread", async () => {
    process.env.WATARI_FAKE_MODE = "mcp-config";
    const adapter = new CodexAdapter({
      executable: process.execPath,
      commandPrefix: [process.execPath, fake],
      teamMcpCommand: ["/opt/watari", "mcp", "--agent", "codex", "/work/project"],
    });
    let configEvent: AgentEvent | null = null;
    try {
      await adapter.start(resolveProjectContext("."));
      await adapter.send({ kind: "message", text: "fixture" });
      for await (const event of adapter.events()) {
        if (event.rawType === "watari/test/mcp-config") {
          configEvent = event;
          break;
        }
      }
    } finally {
      await adapter.stop();
      delete process.env.WATARI_FAKE_MODE;
    }
    expect(configEvent?.payload).toMatchObject({
      config: {
        mcp_servers: {
          watari: {
            command: "/opt/watari",
            args: ["mcp", "--agent", "codex", "/work/project"],
            required: true,
          },
        },
      },
      hasDynamicTools: false,
      hasDeveloperInstructions: true,
    });
  });

  test("reports an unexpected provider exit", async () => {
    process.env.WATARI_FAKE_MODE = "crash";
    const adapter = new CodexAdapter({
      executable: process.execPath,
      commandPrefix: [process.execPath, fake],
    });
    let exitEvent: AgentEvent | null = null;
    try {
      await adapter.start(resolveProjectContext("."));
      for await (const event of adapter.events()) {
        if (event.rawType === "process_exit") {
          exitEvent = event;
          break;
        }
      }
    } finally {
      await adapter.stop();
      delete process.env.WATARI_FAKE_MODE;
    }
    expect(exitEvent?.kind).toBe("error");
    expect(exitEvent?.summary).toContain("code 7");
  });

  test("treats an unexpected clean provider exit as offline", async () => {
    process.env.WATARI_FAKE_MODE = "clean-exit";
    const adapter = new CodexAdapter({
      executable: process.execPath,
      commandPrefix: [process.execPath, fake],
    });
    let exitEvent: AgentEvent | null = null;
    try {
      await adapter.start(resolveProjectContext("."));
      for await (const event of adapter.events()) {
        if (event.rawType === "process_exit") {
          exitEvent = event;
          break;
        }
      }
    } finally {
      await adapter.stop();
      delete process.env.WATARI_FAKE_MODE;
    }
    expect(exitEvent).toMatchObject({ kind: "error", summary: expect.stringContaining("code 0") });
  });
});

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

async function until(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition was not reached in time");
    await Bun.sleep(5);
  }
}
