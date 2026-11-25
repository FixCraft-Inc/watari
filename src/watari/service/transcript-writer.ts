import type { AgentEvent } from "../models.ts";

/**
 * Turns a raw provider event stream into a readable transcript.
 *
 * Native harnesses stream assistant text one fragment at a time and narrate
 * every tool call twice, once on start and once on completion. Persisting each
 * of those verbatim produced a transcript of single words and internal
 * identifiers. This writer keeps one durable row per assistant message, per
 * reasoning block, and per unit of work, growing that row as the provider
 * streams into it, and drops the bookkeeping chatter that carries nothing a
 * reader can act on.
 */
export interface TranscriptSink {
  /** Persists a new event row and returns its id. */
  insert(event: AgentEvent): number;
  /** Rewrites an existing row as a provider streams into it or finishes it. */
  update(
    id: number,
    summary: string,
    options?: { readonly payload?: unknown; readonly type?: string },
  ): void;
}

/** Fragments of a larger message. Each one appends to the open row. */
const TEXT_DELTAS = new Set([
  "text_delta",
  "thinking_delta",
  "item/agentMessage/delta",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/textDelta",
  "session/update/agent_message_chunk",
  "session/update/agent_thought_chunk",
]);

/** Whole blocks. These are authoritative and replace whatever streamed in. */
const TEXT_BLOCKS = new Set(["assistant_text", "assistant_thinking"]);

/** Protocol bookkeeping with nothing for a reader to act on. */
const NOISE_RAW_TYPES = new Set([
  "thread/tokenUsage/updated",
  "thread/status/changed",
  "account/rateLimits/updated",
  "serverRequest/resolved",
  "mcpServer/elicitation/request",
  "rate_limit_event",
  "result_after_error",
  "system/status",
  "system/thinking_tokens",
  "tool_progress",
  "user_tool_result",
  "command/exec/outputDelta",
  "process/outputDelta",
  "item/commandExecution/outputDelta",
  "turn/diff/updated",
  "turn/plan/updated",
  "remoteControl/status/changed",
  "mcpServer/startupStatus/updated",
  "item/commandExecution/terminalInteraction",
  "item/tool/requestUserInput",
  "session/update/plan",
]);

const NOISE_KINDS = new Set<AgentEvent["kind"]>(["usage", "tool_output"]);

const WORK_KINDS = new Set<AgentEvent["kind"]>(["tool_start", "tool_end", "edit"]);

interface OpenStream {
  readonly id: number;
  readonly family: string | null;
  text: string;
}

export class TranscriptWriter {
  readonly #sink: TranscriptSink;
  readonly #streams = new Map<string, OpenStream>();
  readonly #work = new Map<string, number>();
  readonly #completedBlocks = new Map<string, { readonly family: string; readonly text: string }>();

  constructor(sink: TranscriptSink) {
    this.#sink = sink;
  }

  write(event: AgentEvent): void {
    if (this.#isNoise(event)) {
      return;
    }
    if (event.kind === "assistant" || event.kind === "reasoning") {
      this.#writeText(event);
      return;
    }
    if (WORK_KINDS.has(event.kind)) {
      this.#writeWork(event);
      return;
    }
    this.#sink.insert(event);
  }

  /** Forgets open rows so a restarted session never appends to a stale one. */
  reset(agent: string): void {
    for (const key of [...this.#streams.keys()]) {
      if (key.startsWith(`${agent} `)) this.#streams.delete(key);
    }
    for (const key of [...this.#work.keys()]) {
      if (key.startsWith(`${agent} `)) this.#work.delete(key);
    }
    for (const key of [...this.#completedBlocks.keys()]) {
      if (key.startsWith(`${agent} `)) this.#completedBlocks.delete(key);
    }
  }

  #isNoise(event: AgentEvent): boolean {
    if (NOISE_KINDS.has(event.kind)) return true;
    return event.rawType !== undefined && NOISE_RAW_TYPES.has(event.rawType);
  }

  #writeText(event: AgentEvent): void {
    const raw = event.rawType ?? "";
    const key = this.#key(event.agent, event.kind, event.providerEventId);

    if (TEXT_DELTAS.has(raw)) {
      this.#appendText(key, event, event.summary);
      return;
    }
    if (TEXT_BLOCKS.has(raw)) {
      this.#replaceText(key, event, event.summary);
      return;
    }
    if (raw === "item/started") {
      // The deltas that follow open the row; the marker itself says nothing.
      return;
    }
    if (raw === "item/completed") {
      const final = finalItemText(event.payload);
      if (final) {
        this.#replaceText(key, event, final);
      }
      return;
    }
    this.#sink.insert(event);
  }

  #appendText(key: string, event: AgentEvent, text: string): void {
    const open = this.#streams.get(key);
    if (!open) {
      if (text.trim() === "") return;
      this.#streams.set(key, {
        id: this.#sink.insert({ ...event, summary: text }),
        family: this.#blockIdentity(event)?.family ?? null,
        text,
      });
      return;
    }
    open.text += text;
    this.#sink.update(open.id, open.text);
  }

  #replaceText(key: string, event: AgentEvent, text: string): void {
    const open = this.#streams.get(key);
    if (!open) {
      if (text.trim() === "") return;
      const block = this.#blockIdentity(event);
      const previous = block ? this.#completedBlocks.get(block.scope) : undefined;
      if (block && previous?.family === block.family && previous.text === text) return;
      // The Claude SDK emits one completed content block per assistant message.
      // Its final one-element array is therefore indexed #0 even when the same
      // block streamed under #1 (for example after a thinking block). Reconcile
      // against sibling streams from the provider message before inserting.
      if (
        block &&
        [...this.#streams.values()].some(
          (stream) => stream.family === block.family && stream.text === text,
        )
      ) {
        this.#completedBlocks.set(block.scope, { family: block.family, text });
        return;
      }
      if (block) this.#completedBlocks.set(block.scope, { family: block.family, text });
      this.#streams.set(key, {
        id: this.#sink.insert({ ...event, summary: text }),
        family: block?.family ?? null,
        text,
      });
      return;
    }
    // Claude closes a redacted thinking block with an empty one. Treating that
    // as authoritative would wipe the text that already streamed into the row.
    if (text.trim() === "" && open.text.trim() !== "") {
      return;
    }
    open.text = text;
    const block = this.#blockIdentity(event);
    if (block) this.#completedBlocks.set(block.scope, { family: block.family, text });
    this.#sink.update(open.id, text);
  }

  /** `msg_123#0` and `msg_123#1` are blocks of one provider message. Claude
   * occasionally closes both with the same text; that is one statement. */
  #blockIdentity(event: AgentEvent): { readonly scope: string; readonly family: string } | null {
    const providerEventId = event.providerEventId;
    if (!providerEventId || !/#\d+$/u.test(providerEventId)) return null;
    const scope = `${event.agent} ${event.kind}`;
    return { scope, family: `${scope} ${providerEventId.replace(/#\d+$/u, "")}` };
  }

  #writeWork(event: AgentEvent): void {
    const key = this.#key(event.agent, "work", event.providerEventId);
    const completed = event.kind === "tool_end" || event.rawType === "item/completed";

    if (!completed) {
      if (event.providerEventId === undefined) {
        this.#sink.insert(event);
        return;
      }
      this.#work.set(key, this.#sink.insert(event));
      return;
    }

    const open = event.providerEventId === undefined ? undefined : this.#work.get(key);
    if (open === undefined) {
      this.#sink.insert(event);
      return;
    }
    // One row per unit of work: completion rewrites the row it opened, so the
    // transcript shows what ran rather than that it started and then stopped.
    this.#work.delete(key);
    this.#sink.update(open, event.summary, { payload: event.payload, type: event.kind });
  }

  #key(agent: string, kind: string, providerEventId: string | undefined): string {
    return `${agent} ${kind} ${providerEventId ?? ""}`;
  }
}

/** Codex reports the finished text on the completed thread item. */
function finalItemText(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  if (typeof payload.text === "string" && payload.text.trim() !== "") {
    return payload.text;
  }
  const summary = joinStrings(payload.summary);
  if (summary) return summary;
  return joinStrings(payload.content);
}

function joinStrings(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const parts = value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "");
  return parts.length > 0 ? parts.join("\n\n") : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
