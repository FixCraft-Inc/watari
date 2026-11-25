import { describe, expect, test } from "bun:test";

import { claudeTeamHooks } from "../src/watari/agents/claude.ts";

const signal = new AbortController().signal;

function batchInput(agentId?: string) {
  return {
    hook_event_name: "PostToolBatch" as const,
    session_id: "session",
    transcript_path: "/tmp/transcript.jsonl",
    cwd: "/tmp",
    tool_calls: [],
    ...(agentId ? { agent_id: agentId } : {}),
  };
}

function stopInput() {
  return {
    hook_event_name: "Stop" as const,
    session_id: "session",
    transcript_path: "/tmp/transcript.jsonl",
    cwd: "/tmp",
    stop_hook_active: false,
  };
}

describe("Claude team hooks", () => {
  test("mail waiting at a finished tool batch reaches the model inside its turn", async () => {
    const hooks = claudeTeamHooks({
      atToolBoundary: async () => "[WATARI MAIL: 1 message]",
      beforeTurnEnd: async () => null,
    });
    const batch = hooks.PostToolBatch?.[0]?.hooks[0];
    expect(await batch?.(batchInput(), undefined, { signal })).toEqual({
      hookSpecificOutput: { hookEventName: "PostToolBatch", additionalContext: "[WATARI MAIL: 1 message]" },
    });
  });

  test("a subagent's batch is left alone and takes no mail", async () => {
    let asked = 0;
    const hooks = claudeTeamHooks({
      atToolBoundary: async () => {
        asked += 1;
        return "mail";
      },
      beforeTurnEnd: async () => null,
    });
    const batch = hooks.PostToolBatch?.[0]?.hooks[0];
    expect(await batch?.(batchInput("subagent-1"), undefined, { signal })).toEqual({});
    expect(asked).toBe(0);
  });

  test("the end of a turn is blocked only while there is something to read", async () => {
    const answers: (string | null)[] = ["[WATARI REMINDER]", null];
    const hooks = claudeTeamHooks({
      atToolBoundary: async () => null,
      beforeTurnEnd: async () => answers.shift() ?? null,
    });
    const stop = hooks.Stop?.[0]?.hooks[0];
    expect(await stop?.(stopInput(), undefined, { signal })).toEqual({
      decision: "block",
      reason: "[WATARI REMINDER]",
    });
    expect(await stop?.(stopInput(), undefined, { signal })).toEqual({});
  });
});
