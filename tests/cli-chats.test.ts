import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { exportProjectChat, listProjectChats } from "../src/watari/chats.ts";
import { parseArguments } from "../src/watari/cli.ts";
import { importArchivedChat, restoreArchivedChat } from "../src/watari/resume.ts";
import { ChatArchive } from "../src/watari/state/chat-archive.ts";
import { resolveStateLocation } from "../src/watari/state/location.ts";
import { TeamStore } from "../src/watari/state/store.ts";

/** Offline CLI paths only: no service is running and no harness is started. */
const saved = process.env.XDG_STATE_HOME;
const directories: string[] = [];

afterEach(() => {
  if (saved === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = saved;
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function project() {
  const root = mkdtempSync(join(tmpdir(), "watari-cli-chats-"));
  directories.push(root);
  process.env.XDG_STATE_HOME = join(root, "state");
  const context = { launchDirectory: join(root, "checkout"), repositoryRoot: null };
  return { root, context, location: resolveStateLocation(context) };
}

function seedChat(databasePath: string, text: string): TeamStore {
  const store = new TeamStore(databasePath);
  store.registerAgent({
    id: "codex",
    backend: "codex-app-server",
    displayName: "Codex",
    provider: "codex",
    model: null,
    effort: null,
    mode: "managed",
    unrestricted: true,
  });
  const goal = store.createGoal({ instruction: text, initialAddressee: "codex", participants: ["codex"] });
  store.addMessage({ goalId: goal.id, sender: "user", recipients: ["codex"], kind: "user", body: text });
  return store;
}

describe("chat commands", () => {
  test("parse with their flags", () => {
    expect(parseArguments(["chats", "--json"])).toEqual({ command: "chats", path: ".", json: true });
    expect(parseArguments(["export", "/work", "--out", "next.md", "--handoff"])).toEqual({
      command: "export",
      path: "/work",
      out: "next.md",
      handoff: true,
      json: false,
    });
    expect(parseArguments(["resume", "--chat", "2", "--no-ui"])).toMatchObject({ command: "resume", archive: "2", restoreOnly: true });
    expect(parseArguments(["import", "state.json", ".", "--no-ui"])).toEqual({
      command: "import",
      archive: "state.json",
      path: ".",
      restoreOnly: true,
    });
    expect(() => parseArguments(["export", "--out"])).toThrow();
  });

  test("export writes the open chat from the database when no service runs, and a handoff refuses", async () => {
    const { root, context, location } = project();
    seedChat(location.databasePath, "Tidy the queue module.").close();

    const result = await exportProjectChat(context, { path: join(root, "chat.md"), handoff: false });
    expect(result.path).toBe(join(root, "chat.md"));
    const markdown = readFileSync(result.path, "utf8");
    expect(markdown).toContain("# Tidy the queue module.");
    expect(markdown).toContain("## Conversation");
    await expect(exportProjectChat(context, { handoff: true })).rejects.toThrow("needs Watari running");
  });

  test("offline export includes the latest saved handoff, including removed peers", async () => {
    const { root, context, location } = project();
    const store = seedChat(location.databasePath, "Continue the review.");
    store.recordHandoff({ requestId: "unrequested", agent: "codex", source: "tool", content: "Old checkpoint." });
    store.recordHandoff({ requestId: "unrequested", agent: "codex", source: "tool", content: "Final checkpoint, engine uncompiled." });
    store.registerAgent({ id: "reviewer", backend: "claude", displayName: "Reviewer" });
    store.recordHandoff({ requestId: "unrequested", agent: "reviewer", source: "tool", content: "Review findings preserved." });
    store.unregisterAgent("reviewer");
    store.close();

    const result = await exportProjectChat(context, { path: join(root, "chat.md"), handoff: false });
    const markdown = readFileSync(result.path, "utf8");
    expect(markdown).toContain("## AGENT codex");
    expect(markdown).toContain("Final checkpoint, engine uncompiled.");
    expect(markdown).not.toContain("Old checkpoint.");
    expect(markdown).toContain("## AGENT reviewer");
    expect(markdown).toContain("Review findings preserved.");
    expect(result.handoffs).toContainEqual({ agent: "codex", source: "tool" });
    expect(result.handoffs).toContainEqual({ agent: "reviewer", source: "tool" });
  });

  test("chats lists archives and resume restores one by its number", async () => {
    const { context, location } = project();
    const store = seedChat(location.databasePath, "Archived chat about the parser.");
    const archive = new ChatArchive(location.chatsDirectory);
    archive.activate(Date.now(), "chat-one");
    archive.finish(store.snapshot({ full: true }));
    store.resetConversation();
    store.close();

    const chats = await listProjectChats(context);
    expect(chats.map((chat) => chat.title)).toEqual(["Archived chat about the parser."]);
    const restored = await restoreArchivedChat(context, "1");
    expect(restored).toMatchObject({ live: false, messages: 1 });
    const reopened = new TeamStore(location.databasePath);
    try {
      expect(reopened.activeGoal()?.instruction).toBe("Archived chat about the parser.");
    } finally {
      reopened.close();
    }
  });

  test("imports a copied archive with the shared goal and coordination state", async () => {
    const source = project();
    const original = seedChat(source.location.databasePath, "Finish the migration.");
    const goal = original.activeGoal();
    if (!goal) throw new Error("test goal was not created");
    original.createClaim({ goalId: goal.id, claimant: "codex", summary: "migration code", paths: ["src/migrate.ts"], state: "active" });
    original.createTodos({ goalId: goal.id, author: "codex", items: [{ title: "run the migration", assignee: "codex" }] });
    original.createFinding({ author: "codex", severity: "high", summary: "old schema still present" });
    const archive = new ChatArchive(join(source.root, "archives"));
    archive.activate(Date.now(), "portable");
    const savedArchive = join(source.root, "archives", `${archive.id}.json`);
    archive.finish(original.snapshot({ full: true }), original.activityRecords());
    original.close();

    const target = project();
    const targetStore = new TeamStore(target.location.databasePath);
    targetStore.registerAgent({
      id: "codex",
      backend: "codex-app-server",
      displayName: "Codex",
      provider: "codex",
      model: null,
      effort: null,
      mode: "managed",
      unrestricted: true,
    });
    targetStore.close();
    const imported = await importArchivedChat(target.context, savedArchive);
    expect(imported).toMatchObject({ live: false, messages: 1, claims: 1, todos: 1, findings: 1 });
    const reopened = new TeamStore(target.location.databasePath);
    try {
      expect(reopened.activeGoal()?.instruction).toBe("Finish the migration.");
      expect(reopened.claims()).toHaveLength(1);
      expect(reopened.todos()).toHaveLength(1);
      expect(reopened.findings()).toHaveLength(1);
    } finally {
      reopened.close();
    }
    // Keep this assertion explicit: the path passed to import is the archive,
    // not a Markdown handoff that cannot be restored losslessly.
    expect(readFileSync(savedArchive, "utf8")).toContain('"claims"');
  });

  test("imports completed goals so linked TODOs and claims remain valid", async () => {
    const source = project();
    const original = seedChat(source.location.databasePath, "Finish the Android review.");
    const goal = original.activeGoal();
    if (!goal) throw new Error("test goal was not created");
    original.createClaim({ goalId: goal.id, claimant: "codex", summary: "review files", paths: ["android/"] });
    original.createTodos({ goalId: goal.id, author: "codex", items: [{ title: "publish the review", assignee: "codex" }] });
    original.completeGoal(goal.id);
    const archive = new ChatArchive(join(source.root, "archives"));
    archive.activate(Date.now(), "completed");
    const savedArchive = join(source.root, "archives", `${archive.id}.json`);
    archive.finish(original.snapshot({ full: true }));
    original.close();

    const target = project();
    const targetStore = new TeamStore(target.location.databasePath);
    targetStore.registerAgent({
      id: "codex",
      backend: "codex-app-server",
      displayName: "Codex",
      provider: "codex",
      model: null,
      effort: null,
      mode: "managed",
      unrestricted: true,
    });
    targetStore.close();
    const imported = await importArchivedChat(target.context, savedArchive);
    expect(imported).toMatchObject({ live: false, messages: 1, claims: 1, todos: 1, goal: null });
    const restored = new TeamStore(target.location.databasePath);
    try {
      expect(restored.goals()).toHaveLength(1);
      expect(restored.goals()[0]?.state).toBe("complete");
      expect(restored.claims()).toHaveLength(1);
      expect(restored.todos()).toHaveLength(1);
    } finally {
      restored.close();
    }
  });

  test("imports historical peer identities into an empty database without configuring harnesses", async () => {
    const source = project();
    const original = seedChat(source.location.databasePath, "Keep the review history.");
    original.registerAgent({ id: "reviewer", backend: "claude", displayName: "Reviewer" });
    const goal = original.activeGoal()!;
    original.createClaim({ goalId: goal.id, claimant: "reviewer", summary: "review", paths: ["src/"] });
    original.createFinding({ author: "reviewer", severity: "low", summary: "historical finding" });
    // Removed peers are absent from snapshot.agents, but history still names them.
    original.unregisterAgent("reviewer");
    const archive = new ChatArchive(join(source.root, "archives"));
    archive.activate(Date.now(), "historical");
    const path = join(source.root, "archives", `${archive.id}.json`);
    archive.finish(original.snapshot({ full: true }));
    original.close();
    const target = project();
    expect(await importArchivedChat(target.context, path)).toMatchObject({ messages: 1, claims: 1, findings: 1 });
    const restored = new TeamStore(target.location.databasePath);
    try {
      expect(restored.agents()).toEqual([]);
      expect(restored.claims()[0]?.claimant).toBe("reviewer");
      expect(restored.findings()[0]?.author).toBe("reviewer");
      expect(restored.snapshot().messages[0]?.recipients).toEqual(["codex"]);
    } finally {
      restored.close();
    }
  });
});
