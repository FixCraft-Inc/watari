import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

import type { ProjectContext } from "./models.ts";
import { RuntimeClient, ServiceProtocolError } from "./service/client.ts";
import { findArchivedChat, readArchive } from "./state/chat-library.ts";
import { resolveStateLocation } from "./state/location.ts";
import { TeamStore, type RestoreSummary } from "./state/store.ts";

export interface RestoredChat extends RestoreSummary {
  /** The archive the chat came from. */
  readonly archive: string;
  /** A running service switched to it, rather than the database being restored for the next one. */
  readonly live: boolean;
}

/**
 * Puts an archived chat back so it continues, conversations included where the
 * providers kept them.
 *
 * `chat` is an archive id, an unambiguous id prefix, a 1-based position in
 * `watari chats`, or a path. Without it the newest archive is used. A running
 * service switches to the chat itself, archiving the one it has open. With no
 * service, the chat goes into the project database for the next one to start.
 */
export async function restoreArchivedChat(project: ProjectContext, chat?: string): Promise<RestoredChat> {
  const location = resolveStateLocation(project);
  const client = await connectIfRunning(location.socketPath);
  if (client) {
    try {
      // The newest archive may be the chat the service has open.
      const query = chat ?? (await client.listChats()).find((entry) => !entry.current)?.id;
      if (!query) throw new Error("there is no other archived chat to resume");
      const resumed = await client.resumeChat(query);
      return { ...resumed, archive: resumed.chatId, live: true };
    } finally {
      client.close();
    }
  }
  const path = chat?.includes("/") ? chat : findArchivedChat(location.chatsDirectory, chat ?? "1")?.path;
  if (!path) throw new Error(`no archived chat matches ${chat ?? "the newest"} in ${location.chatsDirectory}`);
  const store = new TeamStore(location.databasePath);
  try {
    return { archive: path, live: false, ...store.restoreChat(readArchive(path)) };
  } finally {
    store.close();
  }
}

/**
 * Imports an archive copied from another Watari session into this project.
 *
 * This is deliberately an offline operation. A running service owns the
 * database and must be stopped (or the normal `resume --chat` flow used) so
 * that a partial import can never race a live writer.
 */
export async function importArchivedChat(project: ProjectContext, inputPath: string): Promise<RestoredChat> {
  const location = resolveStateLocation(project);
  let client: RuntimeClient | null = null;
  try {
    client = await RuntimeClient.connect(location.socketPath);
  } catch (error) {
    // A stale socket or a stopped service is safe to recover from. An
    // incompatible live service must be surfaced instead of allowing an
    // offline importer to race its database writer.
    if (error instanceof ServiceProtocolError) throw error;
  }
  if (client) {
    client.close();
    throw new Error("stop the running Watari service before importing a chat archive");
  }
  const path = resolve(project.launchDirectory, inputPath);
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error(`chat archive does not exist: ${path}`);
  }
  const store = new TeamStore(location.databasePath);
  try {
    return { archive: path, live: false, ...store.restoreChat(readArchive(path)) };
  } finally {
    store.close();
  }
}

/** A client for the project's service, or null when none is running. */
export async function connectIfRunning(socketPath: string): Promise<RuntimeClient | null> {
  try {
    return await RuntimeClient.connect(socketPath);
  } catch {
    return null;
  }
}
