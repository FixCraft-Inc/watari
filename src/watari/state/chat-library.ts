import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

import type { ActivityRecord } from "../activity/types.ts";
import type { RestorableChat } from "./store.ts";
import type { TeamGoal } from "./types.ts";

/** One archived chat as a list shows it. */
export interface ChatSummary {
  /** The archive's file name without `.json`, which is also its chat id. */
  readonly id: string;
  readonly path: string;
  readonly startedAt: number;
  readonly updatedAt: number;
  /** The chat's first user message, on one line. */
  readonly title: string;
  readonly goal: string | null;
  readonly messages: number;
  readonly agents: readonly string[];
}

/** A chat as the service lists it, with the one open now marked. */
export interface ChatListEntry extends ChatSummary {
  readonly current: boolean;
}

const TITLE_CHARS = 96;

/**
 * Archived chats, newest first.
 *
 * An archive that cannot be read is skipped rather than failing the list: one
 * truncated file from a crash must not hide every other chat.
 */
export function listArchivedChats(directory: string, limit = 50): readonly ChatSummary[] {
  let names: string[];
  try {
    names = readdirSync(directory).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  const summaries: ChatSummary[] = [];
  // Archive names start with the chat's ISO start time, so name order is age order.
  for (const name of names.sort().reverse()) {
    if (summaries.length >= limit) break;
    const path = join(directory, name);
    const summary = summarizeArchive(path);
    if (summary) summaries.push(summary);
  }
  return summaries;
}

/**
 * Finds an archive by chat id, an unambiguous id prefix, or its 1-based
 * position in the newest-first list.
 */
export function findArchivedChat(directory: string, query: string): ChatSummary | null {
  const chats = listArchivedChats(directory, 500);
  const trimmed = query.trim();
  if (/^\d{1,3}$/u.test(trimmed)) return chats[Number(trimmed) - 1] ?? null;
  const exact = chats.find((chat) => chat.id === trimmed);
  if (exact) return exact;
  const matches = chats.filter((chat) => chat.id.startsWith(trimmed) || chat.id.endsWith(trimmed));
  return matches.length === 1 ? matches[0] ?? null : null;
}

function summarizeArchive(path: string): ChatSummary | null {
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!Array.isArray(value.messages) || !Array.isArray(value.agents)) return null;
  const messages = value.messages as { sender?: unknown; body?: unknown; createdAt?: unknown }[];
  const first = messages.find((message) => message.sender === "user");
  const goal = isRecord(value.activeGoal) && typeof value.activeGoal.instruction === "string"
    ? value.activeGoal.instruction
    : null;
  const createdAt = messages.map((message) => message.createdAt).find((at): at is number => typeof at === "number");
  let updatedAt = createdAt ?? 0;
  try {
    updatedAt = statSync(path).mtimeMs;
  } catch {
    // Keep the chat's own time.
  }
  return {
    id: basename(path, ".json"),
    path,
    startedAt: createdAt ?? updatedAt,
    updatedAt,
    title: oneLine(typeof first?.body === "string" ? first.body : goal ?? "untitled chat"),
    goal,
    messages: messages.length,
    agents: (value.agents as { id?: unknown }[]).map((agent) => agent.id).filter((id): id is string => typeof id === "string"),
  };
}

/** Reads a chat archive back into the shape the store restores. */
export function readArchive(path: string): RestorableChat {
  const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const list = <T>(key: string): T[] => (Array.isArray(value[key]) ? value[key] as T[] : []);
  if (!Array.isArray(value.messages) || !Array.isArray(value.agents)) {
    throw new Error(`${path} is not a Watari chat archive`);
  }
  return {
    activeGoal: (value.activeGoal ?? null) as RestorableChat["activeGoal"],
    goals: list<TeamGoal>("goals"),
    agents: list<RestorableChat["agents"][number]>("agents"),
    messages: list<RestorableChat["messages"][number]>("messages"),
    claims: list<RestorableChat["claims"][number]>("claims"),
    findings: list<RestorableChat["findings"][number]>("findings"),
    todos: list<RestorableChat["todos"][number]>("todos"),
    events: list<RestorableChat["events"][number]>("events"),
    activities: list<ActivityRecord>("activityDetails"),
  };
}

function oneLine(value: string): string {
  const line = value.replace(/\s+/gu, " ").trim();
  return line.length > TITLE_CHARS ? `${line.slice(0, TITLE_CHARS - 1)}…` : line;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
