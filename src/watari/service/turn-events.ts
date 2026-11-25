import type { AgentEvent } from "../models.ts";

const TURN_STARTED_EVENTS = new Set(["turn/started", "session/prompt"]);
const TURN_COMPLETED_EVENTS = new Set(["turn/completed", "result", "session/prompt/completed"]);

/** Provider lifecycle comes from protocol events. The summary fallback keeps
 * injected/legacy adapters compatible without treating unrelated "completed"
 * status chatter as a turn boundary. */
export function isTurnStarted(event: AgentEvent): boolean {
  if (event.kind !== "status") return false;
  if (event.rawType && TURN_STARTED_EVENTS.has(event.rawType)) return true;
  return /\bturn\b.*\bstarted\b/iu.test(event.summary);
}

export function isTurnCompleted(event: AgentEvent): boolean {
  if (event.kind !== "status") return false;
  if (event.rawType && TURN_COMPLETED_EVENTS.has(event.rawType)) return true;
  return /\bturn\b.*\bcompleted\b/iu.test(event.summary);
}

/** Codex reports a file change starting as an edit, which is not yet a boundary. */
export function isToolStart(event: AgentEvent): boolean {
  return event.kind === "tool_start" || (event.kind === "edit" && event.rawType === "item/started");
}

export function isToolEnd(event: AgentEvent): boolean {
  return event.kind === "tool_end" || (event.kind === "edit" && event.rawType !== "item/started");
}

/**
 * The harness summarized its own conversation to free context. Claude reports
 * a compact boundary. Codex sends `thread/compacted` and records a
 * `contextCompaction` item, so one compaction may arrive twice.
 */
export function isContextCompaction(event: AgentEvent): boolean {
  if (event.rawType === "system/compact_boundary" || event.rawType === "thread/compacted") return true;
  return event.rawType === "item/completed" &&
    typeof event.payload === "object" &&
    event.payload !== null &&
    (event.payload as { readonly type?: unknown }).type === "contextCompaction";
}

/**
 * A native harness is between steps here: it has just finished a tool call, an
 * edit, or a whole turn. Harnesses accept new input at these points, so this is
 * where queued peer mail is handed over.
 */
export function isSafeBoundary(event: AgentEvent): boolean {
  return isToolEnd(event) || isTurnCompleted(event);
}
