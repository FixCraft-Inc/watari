import { describe, expect, test } from "bun:test";

import type { AgentEvent } from "../src/watari/models.ts";
import { blockId } from "../src/watari/agents/claude.ts";
import { TranscriptWriter, type TranscriptSink } from "../src/watari/service/transcript-writer.ts";

interface Row {
  type: string;
  summary: string;
  providerEventId: string | undefined;
}

function recorder(): { sink: TranscriptSink; rows: Row[] } {
  const rows: Row[] = [];
  const sink: TranscriptSink = {
    insert(event) {
      rows.push({ type: event.kind, summary: event.summary, providerEventId: event.providerEventId });
      return rows.length - 1;
    },
    update(id, summary, options) {
      const row = rows[id];
      if (!row) throw new Error(`no row ${id}`);
      row.summary = summary;
      if (options?.type) row.type = options.type;
    },
  };
  return { sink, rows };
}

function event(partial: Partial<AgentEvent> & Pick<AgentEvent, "kind" | "summary">): AgentEvent {
  return { agent: "codex", timestamp: 1, ...partial };
}

describe("streaming assistant text", () => {
  test("many deltas become one row of prose", () => {
    const { sink, rows } = recorder();
    const writer = new TranscriptWriter(sink);
    for (const word of ["The ", "delivery ", "queue ", "is ", "bounded."]) {
      writer.write(event({ kind: "assistant", summary: word, rawType: "item/agentMessage/delta", providerEventId: "msg_1" }));
    }

    expect(rows).toHaveLength(1);
    expect(rows[0]?.summary).toBe("The delivery queue is bounded.");
  });

  test("OpenCode ACP chunks share the same streaming rows", () => {
    const { sink, rows } = recorder();
    const writer = new TranscriptWriter(sink);
    writer.write(event({ kind: "assistant", summary: "hello ",
      rawType: "session/update/agent_message_chunk",
      providerEventId: "message-1",
    }));
    writer.write(event({ kind: "assistant", summary: "world",
      rawType: "session/update/agent_message_chunk",
      providerEventId: "message-1",
    }));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.summary).toBe("hello world");
  });

  test("two messages stay two rows", () => {
    const { sink, rows } = recorder();
    const writer = new TranscriptWriter(sink);
    writer.write(event({ kind: "assistant", summary: "first", rawType: "text_delta", providerEventId: "msg_1" }));
    writer.write(event({ kind: "assistant", summary: "second", rawType: "text_delta", providerEventId: "msg_2" }));

    expect(rows.map((row) => row.summary)).toEqual(["first", "second"]);
  });

  test("the whole block replaces what streamed rather than repeating it", () => {
    const { sink, rows } = recorder();
    const writer = new TranscriptWriter(sink);
    writer.write(event({ kind: "assistant", summary: "I", rawType: "text_delta", providerEventId: "msg_1" }));
    writer.write(event({ kind: "assistant", summary: "'ll start", rawType: "text_delta", providerEventId: "msg_1" }));
    writer.write(event({ kind: "assistant", summary: "I'll start.", rawType: "assistant_text", providerEventId: "msg_1" }));

    expect(rows).toHaveLength(1);
    expect(rows[0]?.summary).toBe("I'll start.");
  });

  test("a completed Codex item supplies the final text", () => {
    const { sink, rows } = recorder();
    const writer = new TranscriptWriter(sink);
    writer.write(event({ kind: "assistant", summary: "agent message", rawType: "item/started", providerEventId: "it_1" }));
    writer.write(event({ kind: "assistant", summary: "par", rawType: "item/agentMessage/delta", providerEventId: "it_1" }));
    writer.write(
      event({
        kind: "assistant",
        summary: "agent message",
        rawType: "item/completed",
        providerEventId: "it_1",
        payload: { type: "agentMessage", id: "it_1", text: "partial became whole." },
      }),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.summary).toBe("partial became whole.");
  });

  test("reasoning summaries join into one block", () => {
    const { sink, rows } = recorder();
    const writer = new TranscriptWriter(sink);
    writer.write(
      event({
        kind: "reasoning",
        summary: "reasoning",
        rawType: "item/completed",
        providerEventId: "rs_1",
        payload: { type: "reasoning", summary: ["Checked the queue.", "Bounded already."] },
      }),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.summary).toBe("Checked the queue.\n\nBounded already.");
  });

  test("an empty closing block does not erase what streamed", () => {
    const { sink, rows } = recorder();
    const writer = new TranscriptWriter(sink);
    writer.write(event({ kind: "reasoning", summary: "weighing the ", rawType: "thinking_delta", providerEventId: "b1" }));
    writer.write(event({ kind: "reasoning", summary: "queue bounds.", rawType: "thinking_delta", providerEventId: "b1" }));
    writer.write(event({ kind: "reasoning", summary: "", rawType: "assistant_thinking", providerEventId: "b1" }));

    expect(rows).toHaveLength(1);
    expect(rows[0]?.summary).toBe("weighing the queue bounds.");
  });

  test("an empty block on its own never opens a row", () => {
    const { sink, rows } = recorder();
    const writer = new TranscriptWriter(sink);
    writer.write(event({ kind: "reasoning", summary: "   ", rawType: "assistant_thinking", providerEventId: "b2" }));

    expect(rows).toHaveLength(0);
  });

  test("an empty streaming delta never opens a row", () => {
    const { sink, rows } = recorder();
    const writer = new TranscriptWriter(sink);
    writer.write(event({ kind: "reasoning", summary: "", rawType: "thinking_delta", providerEventId: "msg_1#0" }));

    expect(rows).toHaveLength(0);
  });

  test("identical final blocks in one Claude message are shown once", () => {
    const { sink, rows } = recorder();
    const writer = new TranscriptWriter(sink);
    writer.write(event({ kind: "assistant", summary: "One statement.", rawType: "assistant_text", providerEventId: "msg_1#0" }));
    writer.write(event({ kind: "assistant", summary: "One statement.", rawType: "assistant_text", providerEventId: "msg_1#1" }));

    expect(rows.map((row) => row.summary)).toEqual(["One statement."]);
  });

  test("a reindexed Claude final block reuses its identical sibling stream", () => {
    const { sink, rows } = recorder();
    const writer = new TranscriptWriter(sink);
    writer.write(event({ agent: "claude", kind: "assistant", summary: "One ", rawType: "text_delta", providerEventId: "msg_live#1" }));
    writer.write(event({ agent: "claude", kind: "assistant", summary: "statement.", rawType: "text_delta", providerEventId: "msg_live#1" }));
    writer.write(event({ agent: "claude", kind: "assistant", summary: "One statement.", rawType: "assistant_text", providerEventId: "msg_live#0" }));

    expect(rows).toEqual([{ type: "assistant", summary: "One statement.", providerEventId: "msg_live#1" }]);
  });

  test("distinct Claude sibling blocks remain distinct", () => {
    const { sink, rows } = recorder();
    const writer = new TranscriptWriter(sink);
    writer.write(event({ agent: "claude", kind: "assistant", summary: "First.", rawType: "text_delta", providerEventId: "msg_live#1" }));
    writer.write(event({ agent: "claude", kind: "assistant", summary: "Second.", rawType: "assistant_text", providerEventId: "msg_live#0" }));

    expect(rows.map((row) => row.summary)).toEqual(["First.", "Second."]);
  });

  test("a restart does not append to the previous session's row", () => {
    const { sink, rows } = recorder();
    const writer = new TranscriptWriter(sink);
    writer.write(event({ kind: "assistant", summary: "before", rawType: "text_delta", providerEventId: "msg_1" }));
    writer.reset("codex");
    writer.write(event({ kind: "assistant", summary: "after", rawType: "text_delta", providerEventId: "msg_1" }));

    expect(rows.map((row) => row.summary)).toEqual(["before", "after"]);
  });
});

describe("work items", () => {
  test("a start and its result share one row that ends as completed", () => {
    const { sink, rows } = recorder();
    const writer = new TranscriptWriter(sink);
    writer.write(event({ kind: "tool_start", summary: "bash  bun test", rawType: "tool_use", providerEventId: "toolu_1" }));
    writer.write(event({ kind: "tool_end", summary: "bash  bun test", rawType: "tool_result", providerEventId: "toolu_1" }));

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: "tool_end", summary: "bash  bun test" });
  });

  test("a failure is carried onto the row it opened", () => {
    const { sink, rows } = recorder();
    const writer = new TranscriptWriter(sink);
    writer.write(event({ kind: "tool_start", summary: "bash  rm -rf /", rawType: "tool_use", providerEventId: "toolu_2" }));
    writer.write(event({ kind: "tool_end", summary: "bash  rm -rf /  failed", rawType: "tool_result", providerEventId: "toolu_2" }));

    expect(rows).toHaveLength(1);
    expect(rows[0]?.summary).toBe("bash  rm -rf /  failed");
  });

  test("an unmatched result still gets recorded", () => {
    const { sink, rows } = recorder();
    const writer = new TranscriptWriter(sink);
    writer.write(event({ kind: "tool_end", summary: "edit  a.ts", rawType: "tool_result", providerEventId: "toolu_3" }));

    expect(rows).toHaveLength(1);
  });

  test("two concurrent tool calls do not collapse into each other", () => {
    const { sink, rows } = recorder();
    const writer = new TranscriptWriter(sink);
    writer.write(event({ kind: "tool_start", summary: "bash  one", rawType: "tool_use", providerEventId: "a" }));
    writer.write(event({ kind: "tool_start", summary: "bash  two", rawType: "tool_use", providerEventId: "b" }));
    writer.write(event({ kind: "tool_end", summary: "bash  two", rawType: "tool_result", providerEventId: "b" }));

    expect(rows.map((row) => row.type)).toEqual(["tool_start", "tool_end"]);
  });
});

describe("bookkeeping chatter", () => {
  test("token, rate limit, and status churn never reaches the transcript", () => {
    const { sink, rows } = recorder();
    const writer = new TranscriptWriter(sink);
    for (const rawType of [
      "thread/tokenUsage/updated",
      "account/rateLimits/updated",
      "thread/status/changed",
      "serverRequest/resolved",
      "rate_limit_event",
      "tool_progress",
    ]) {
      writer.write(event({ kind: "status", summary: `Codex event: ${rawType}`, rawType }));
    }
    writer.write(event({ kind: "usage", summary: "token estimate updated" }));
    writer.write(event({ kind: "tool_output", summary: "command output" }));

    expect(rows).toHaveLength(0);
  });

  test("Codex plan, diff, and remote-control churn is dropped too", () => {
    const { sink, rows } = recorder();
    const writer = new TranscriptWriter(sink);
    for (const rawType of [
      "turn/diff/updated",
      "turn/plan/updated",
      "remoteControl/status/changed",
      "mcpServer/startupStatus/updated",
      "item/commandExecution/terminalInteraction",
    ]) {
      writer.write(event({ kind: "status", summary: `Codex event: ${rawType}`, rawType }));
    }
    writer.write(event({ kind: "diff", summary: "Codex updated the turn diff", rawType: "turn/diff/updated" }));

    expect(rows).toHaveLength(0);
  });

  test("errors, warnings, and approvals are always kept", () => {
    const { sink, rows } = recorder();
    const writer = new TranscriptWriter(sink);
    writer.write(event({ kind: "error", summary: "transport reset" }));
    writer.write(event({ kind: "warning", summary: "contested path" }));
    writer.write(event({ kind: "approval", summary: "bash: rm", providerEventId: "req_1" }));
    writer.write(event({ kind: "session", summary: "thread started" }));

    expect(rows.map((row) => row.type)).toEqual(["error", "warning", "approval", "session"]);
  });
});

describe("Claude stream keys", () => {
  test("blocks of one message are distinct, and one block is stable", () => {
    expect(blockId("msg_1", 0)).toBe(blockId("msg_1", 0));
    expect(blockId("msg_1", 0)).not.toBe(blockId("msg_1", 1));
    expect(blockId("msg_1", 0)).not.toBe(blockId("msg_2", 0));
  });

  test("every delta of one block lands on one row", () => {
    const { sink, rows } = recorder();
    const writer = new TranscriptWriter(sink);
    const key = blockId("msg_7", 0);
    for (const fragment of ["I", "'ll start by underst", "anding the project."]) {
      writer.write(
        event({ agent: "claude", kind: "assistant", summary: fragment, rawType: "text_delta", providerEventId: key }),
      );
    }
    writer.write(
      event({
        agent: "claude",
        kind: "assistant",
        summary: "I'll start by understanding the project.",
        rawType: "assistant_text",
        providerEventId: key,
      }),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.summary).toBe("I'll start by understanding the project.");
  });

  test("text and thinking in one message stay separate rows", () => {
    const { sink, rows } = recorder();
    const writer = new TranscriptWriter(sink);
    writer.write(
      event({ agent: "claude", kind: "reasoning", summary: "weighing it", rawType: "thinking_delta", providerEventId: blockId("msg_8", 0) }),
    );
    writer.write(
      event({ agent: "claude", kind: "assistant", summary: "here is the answer", rawType: "text_delta", providerEventId: blockId("msg_8", 1) }),
    );

    expect(rows.map((row) => row.type)).toEqual(["reasoning", "assistant"]);
  });
});
