import type { ActivitySummary } from "../activity/types.ts";
import type { AgentId } from "../models.ts";
import type { PersistedEvent, TeamAgent, TeamMessage, TeamSnapshot } from "../state/types.ts";

/**
 * The chat as a list of entries, independent of how any client draws it.
 *
 * The terminal UI lays these out into rows, and exports and `/copy` turn them
 * into Markdown. Keeping them here, outside the UI, is what lets the service
 * and the CLI produce the same record the screen shows.
 */
export type TranscriptEntry =
  | {
      readonly kind: "activity";
      readonly key: string;
      readonly timestamp: number;
      readonly summary: ActivitySummary;
    }
  | {
      readonly kind: "message";
      readonly key: string;
      readonly timestamp: number;
      readonly sender: string;
      readonly audience: string;
      readonly accent: AgentId | null;
      readonly system: boolean;
      readonly priority: TeamMessage["priority"];
      readonly body: string;
    }
  | {
      /** What a peer said or thought, rendered as prose. */
      readonly kind: "speech";
      readonly key: string;
      readonly timestamp: number;
      readonly agent: AgentId | null;
      readonly thinking: boolean;
      readonly body: string;
    }
  | {
      /** One unit of work: a command, an edit, a lookup. */
      readonly kind: "work";
      readonly key: string;
      readonly timestamp: number;
      readonly agent: AgentId | null;
      readonly verb: string;
      readonly detail: string;
      readonly state: "running" | "done" | "failed";
    }
  | {
      /** Everything else the service wants on the record. */
      readonly kind: "note";
      readonly key: string;
      readonly timestamp: number;
      readonly agent: AgentId | null;
      readonly type: string;
      readonly summary: string;
      readonly requestId: string | null;
    };

/** Entries are capped by default so a long session cannot grow a render tree
 * without bound. The service keeps the durable history. */
const MAX_ENTRIES = 300;

export function buildEntries(
  snapshot: TeamSnapshot,
  filter: AgentId | null,
  limit = MAX_ENTRIES,
): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  const activityProviders = new Set(
    snapshot.activities.map((activity) => `${activity.agent}\0${activity.providerEventId}`),
  );

  for (const message of snapshot.messages) {
    if (filter && message.sender !== filter && !message.recipients.includes(filter)) continue;
    entries.push({
      kind: "message",
      key: `m${message.id}`,
      timestamp: message.createdAt,
      sender: senderLabel(message.sender),
      audience: audienceLabel(message.recipients, snapshot.agents),
      accent: isPeer(message.sender) ? message.sender : null,
      system: message.sender === "watari",
      priority: message.priority,
      body: message.body,
    });
  }

  for (const event of snapshot.events) {
    if (filter && event.agent !== filter) continue;
    if (
      event.agent &&
      event.providerEventId &&
      WORK_TYPES.has(event.type) &&
      activityProviders.has(`${event.agent}\0${event.providerEventId}`)
    ) continue;
    entries.push(toEntry(event));
  }

  for (const activity of snapshot.activities) {
    if (filter && activity.agent !== filter) continue;
    entries.push({
      kind: "activity",
      key: activity.id,
      timestamp: activity.startedAt,
      summary: activity,
    });
  }

  entries.sort((left, right) => left.timestamp - right.timestamp || left.key.localeCompare(right.key));
  return Number.isFinite(limit) ? entries.slice(-limit) : entries;
}

const SPEECH_TYPES = new Set(["assistant", "reasoning"]);
const WORK_TYPES = new Set(["tool_start", "tool_end", "edit", "diff"]);

/**
 * Classifies a persisted event. Provider identifiers are deliberately left out
 * of everything except an approval, which is the one case where the reader has
 * to type the identifier back.
 */
function toEntry(event: PersistedEvent): TranscriptEntry {
  const key = `e${event.id}`;
  if (SPEECH_TYPES.has(event.type)) {
    return {
      kind: "speech",
      key,
      timestamp: event.createdAt,
      agent: event.agent,
      thinking: event.type === "reasoning",
      body: event.summary.trim(),
    };
  }
  if (WORK_TYPES.has(event.type)) {
    // Adapters join the verb to what it acted on with a double space, so the
    // split has to happen before any whitespace is collapsed.
    const summary = event.summary.replace(/[\r\n]+/gu, " ");
    const failed = /\s+failed$/u.test(summary);
    const [verb = "work", ...rest] = summary.replace(/\s+failed$/u, "").split(/\s{2,}/u);
    return {
      kind: "work",
      key,
      timestamp: event.createdAt,
      agent: event.agent,
      verb: singleLine(verb),
      detail: singleLine(rest.join(" ")),
      state: failed ? "failed" : event.type === "tool_start" ? "running" : "done",
    };
  }
  return {
    kind: "note",
    key,
    timestamp: event.createdAt,
    agent: event.agent,
    type: event.type,
    summary: singleLine(event.summary),
    requestId: event.type === "approval" ? event.providerEventId : null,
  };
}

function isPeer(sender: string): sender is AgentId {
  return sender !== "user" && sender !== "watari";
}

function senderLabel(sender: string): string {
  return sender === "user" ? "you" : sender;
}

function audienceLabel(recipients: readonly AgentId[], agents: readonly TeamAgent[]): string {
  if (recipients.length === 0) return "nobody";
  if (agents.length > 0 && recipients.length >= agents.length) return "everyone";
  const labels = new Map(agents.map((agent) => [agent.id.toLowerCase(), agent.displayName.trim() || agent.id]));
  return recipients.map((recipient) => labels.get(recipient.toLowerCase()) ?? recipient).join(", ");
}

export function pendingApprovals(snapshot: TeamSnapshot): readonly PersistedEvent[] {
  const answered = new Set<string>();
  for (const event of snapshot.events) {
    if (event.type === "approval_answered" && event.providerEventId) answered.add(event.providerEventId);
  }
  return snapshot.events.filter(
    (event) => event.type === "approval" && event.providerEventId !== null && !answered.has(event.providerEventId),
  );
}

/**
 * The newest thing a reader would mean by "that answer".
 *
 * Reasoning and routine steps are skipped: a reader who asks for the last reply
 * wants the reply, not the thinking that preceded it.
 */
export function lastSpokenEntry(entries: readonly TranscriptEntry[]): TranscriptEntry | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry) continue;
    if (entry.kind === "message") return entry;
    if (entry.kind === "speech" && !entry.thinking) return entry;
  }
  return null;
}

/** Resolves a speaker to what the chat calls it: its display name, "you", or "watari". */
export function speakerNames(agents: readonly TeamAgent[]): (agent: string | null | undefined) => string {
  const labels = new Map<string, string>();
  for (const agent of agents) {
    labels.set(agent.id.toLowerCase(), agent.displayName.trim() || agent.id);
  }
  return (agent) => {
    if (!agent) return "watari";
    const key = agent.toLowerCase();
    if (key === "user" || key === "you") return "you";
    if (key === "watari") return "watari";
    return labels.get(key) ?? agent;
  };
}

/**
 * The Markdown source the model wrote, not rendered rows: the source pastes
 * usefully into an editor or an issue, and rows carry one terminal's wrap width.
 */
export function markdownSource(body: string): string {
  return body.replace(/\r\n?/gu, "\n").replace(/[ \t]+$/gmu, "").trim();
}

/** One entry as the Markdown a reader would paste somewhere else. */
export function entryMarkdown(entry: TranscriptEntry, name: (agent: string | null | undefined) => string): string {
  switch (entry.kind) {
    case "message":
      return `**${name(entry.sender)} → ${entry.audience}**\n\n${markdownSource(entry.body)}`;
    case "speech":
      return `**${name(entry.agent)}${entry.thinking ? " (thinking)" : ""}**\n\n${markdownSource(entry.body)}`;
    case "work":
      return `- ${name(entry.agent)} ${entry.verb} ${entry.detail}${entry.state === "failed" ? " (failed)" : ""}`;
    case "activity":
      return `- ${name(entry.summary.agent)} ${entry.summary.title} ${entry.summary.preview} (${entry.summary.state})`;
    default:
      return `- ${name(entry.agent)} ${entry.type}: ${entry.summary}`;
  }
}

/**
 * The visible conversation as Markdown.
 *
 * Reasoning is left out. It is provider-internal context that the peers did not
 * address to anybody, and including it would make a pasted transcript several
 * times longer than the conversation it is meant to record.
 */
export function entriesMarkdown(
  entries: readonly TranscriptEntry[],
  name: (agent: string | null | undefined) => string,
): string {
  const parts: string[] = [];
  for (const entry of entries) {
    if (entry.kind === "speech" && entry.thinking) continue;
    parts.push(entryMarkdown(entry, name));
  }
  return parts.join("\n\n").trim();
}

function singleLine(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}
