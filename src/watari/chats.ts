import type { ProjectContext } from "./models.ts";
import { readCheckoutFacts } from "./project/checkout-map.ts";
import { connectIfRunning } from "./resume.ts";
import type { ChatExportResult } from "./service/runtime.ts";
import { listArchivedChats, type ChatListEntry } from "./state/chat-library.ts";
import { resolveStateLocation } from "./state/location.ts";
import { TeamStore } from "./state/store.ts";
import { chatExportMarkdown, resolveExportPath, UNREQUESTED_HANDOFF, writeExportFile } from "./team/export.ts";

/**
 * The project's archived chats. A running service also marks the one it has
 * open. Without one, the list is read straight from the archive directory.
 */
export async function listProjectChats(project: ProjectContext): Promise<readonly ChatListEntry[]> {
  const location = resolveStateLocation(project);
  const client = await connectIfRunning(location.socketPath);
  if (client) {
    try {
      return await client.listChats();
    } finally {
      client.close();
    }
  }
  return listArchivedChats(location.chatsDirectory).map((chat) => ({ ...chat, current: false }));
}

/**
 * Writes the open chat as Markdown.
 *
 * A handoff has to ask the agents, so it needs the running service. A plain
 * export does not: with no service it is written from the project database,
 * which holds the whole chat whether the last service stopped or crashed.
 */
export async function exportProjectChat(
  project: ProjectContext,
  options: { readonly path?: string; readonly handoff: boolean },
): Promise<ChatExportResult> {
  const location = resolveStateLocation(project);
  const client = await connectIfRunning(location.socketPath);
  if (client) {
    try {
      return await client.exportChat({ handoff: options.handoff, ...(options.path ? { path: options.path } : {}) });
    } finally {
      client.close();
    }
  }
  if (options.handoff) {
    throw new Error("a handoff asks the agents for their context, so it needs Watari running: open `watari .` first");
  }
  const store = new TeamStore(location.databasePath);
  try {
    if (!store.hasUserMessages()) throw new Error("this project has no open chat to export; `watari chats` lists archived ones");
    const path = resolveExportPath({
      requested: options.path ?? null,
      launchDirectory: project.launchDirectory,
      exportsDirectory: location.exportsDirectory,
      kind: "chat",
    });
    const handoffs = store.handoffs(UNREQUESTED_HANDOFF);
    writeExportFile(path, chatExportMarkdown({
      snapshot: store.snapshot({ full: true }),
      project,
      exportedAt: Date.now(),
      checkout: readCheckoutFacts(project.repositoryRoot ?? project.launchDirectory),
      handoffs,
    }));
    return { path, handoffs: handoffs.map((handoff) => ({ agent: handoff.agent, source: handoff.source })) };
  } finally {
    store.close();
  }
}
