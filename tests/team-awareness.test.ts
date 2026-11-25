import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentId } from "../src/watari/models.ts";
import { formatCheckoutMap, parseStatus, readCheckoutFacts } from "../src/watari/project/checkout-map.ts";
import { EditOverlapWatch } from "../src/watari/service/edit-overlap.ts";
import { CoordinatorRuntime } from "../src/watari/service/runtime.ts";
import { TeamStore } from "../src/watari/state/store.ts";
import type { TeamClaim } from "../src/watari/state/types.ts";
import { TeamApplicationService } from "../src/watari/team/service.ts";
import { IdentityBoundTeamTools } from "../src/watari/team/tools.ts";
import { FakeAdapter } from "./fakes/fake-adapter.ts";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function claim(claimant: AgentId, paths: string[], id = "c1a2b3c4"): TeamClaim {
  return {
    id,
    goalId: "goal",
    claimant,
    summary: "decoder rewrite",
    paths,
    state: "active",
    note: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("edit overlap watch", () => {
  const live = new Set<AgentId>(["codex", "claude"]);

  test("an edit inside another peer's claim is reported once, with the claim", () => {
    const watch = new EditOverlapWatch("/repo");
    const first = watch.record({
      goalId: "goal",
      editor: "codex",
      paths: ["/repo/src/decoder/frame.ts"],
      claims: [claim("claude", ["src/decoder/**"])],
      live,
    });
    expect(first).toEqual([{
      path: "src/decoder/frame.ts",
      editor: "codex",
      other: "claude",
      claim: { id: "c1a2b3c4", summary: "decoder rewrite" },
    }]);
    expect(watch.record({
      goalId: "goal",
      editor: "codex",
      paths: ["src/decoder/frame.ts"],
      claims: [claim("claude", ["src/decoder/**"])],
      live,
    })).toEqual([]);
  });

  test("two peers changing one unclaimed file is reported, and a new goal starts over", () => {
    const watch = new EditOverlapWatch("/repo");
    expect(watch.record({ goalId: "goal", editor: "codex", paths: ["README.md"], claims: [], live })).toEqual([]);
    expect(watch.record({ goalId: "goal", editor: "claude", paths: ["/repo/README.md"], claims: [], live }))
      .toEqual([{ path: "README.md", editor: "claude", other: "codex", claim: null }]);
    expect(watch.record({ goalId: "next", editor: "claude", paths: ["README.md"], claims: [], live })).toEqual([]);
  });

  test("offline peers and files outside the checkout are ignored", () => {
    const watch = new EditOverlapWatch("/repo");
    expect(watch.record({
      goalId: "goal",
      editor: "codex",
      paths: ["/repo/src/a.ts", "/elsewhere/b.ts"],
      claims: [claim("claude", ["src"])],
      live: new Set<AgentId>(["codex"]),
    })).toEqual([]);
  });
});

describe("checkout map", () => {
  test("parses porcelain status with renames and odd names", () => {
    expect(parseStatus(" M src/a.ts\0R  new name.ts\0old name.ts\0?? notes/x.md\0")).toEqual([
      { status: "M", path: "src/a.ts" },
      { status: "R", path: "new name.ts" },
      { status: "??", path: "notes/x.md" },
    ]);
  });

  test("lists the layout by size and bounds the changed files", () => {
    const text = formatCheckoutMap({
      branch: "main",
      tracked: ["src/a.ts", "src/b.ts", "docs/x.md", "README.md"],
      changes: Array.from({ length: 33 }, (_value, index) => ({ status: "M", path: `src/f${index}.ts` })),
    });
    expect(text).toContain("Branch main. Tracked files by top-level entry: src/ 2, docs/ 1, README.md.");
    expect(text).toContain("Uncommitted changes, 33 files: M src/f0.ts,");
    expect(text).toContain("+3 more in src/ (3).");
    expect(formatCheckoutMap({ branch: null, tracked: [], changes: [] })).toContain("No uncommitted changes.");
  });

  test("reads a real repository without taking the index lock", () => {
    const directory = mkdtempSync(join(tmpdir(), "watari-map-"));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const run = (...args: string[]) => {
      // A disposable fixture must not invoke the owner's signing agent.
      const result = Bun.spawnSync(["git", "-C", directory, "-c", "user.email=t@t", "-c", "user.name=t",
        "-c", "commit.gpgsign=false", ...args]);
      expect(result.exitCode, result.stderr.toString()).toBe(0);
    };
    run("init", "-q", "-b", "main");
    mkdirSync(join(directory, "src"));
    writeFileSync(join(directory, "src", "a.ts"), "a\n");
    run("add", "-A");
    run("commit", "-qm", "init");
    writeFileSync(join(directory, "src", "a.ts"), "b\n");
    writeFileSync(join(directory, "new.txt"), "n\n");

    const facts = readCheckoutFacts(directory);
    expect(facts).toMatchObject({ branch: "main", tracked: ["src/a.ts"] });
    expect(facts?.changes).toEqual([{ status: "M", path: "src/a.ts" }, { status: "??", path: "new.txt" }]);
    expect(readCheckoutFacts(join(directory, "missing"))).toBeNull();
  });
});

describe("runtime conflict notices", () => {
  test("an edit inside a live peer's claim sends both peers an urgent notice", async () => {
    const codex = new FakeAdapter("codex");
    const claude = new FakeAdapter("claude");
    const runtime = new CoordinatorRuntime({
      project: { launchDirectory: "/tmp/project", repositoryRoot: "/tmp/project" },
      databasePath: ":memory:",
      adapters: { codex, claude },
    });
    cleanups.push(() => runtime.stop());
    await runtime.start();
    await runtime.sendUserMessage("all", "Harden the decoder.");
    await runtime.callTeamTool("claude", "team_claim", { scope: "decoder", paths: ["src/decoder/**"] });

    codex.emit("edit", "edit src/decoder/frame.ts", {
      rawType: "item/completed",
      providerEventId: "patch-1",
      payload: {
        type: "fileChange",
        status: "completed",
        changes: [{ path: "/tmp/project/src/decoder/frame.ts", kind: { type: "update" }, diff: "" }],
      },
    });
    await waitUntil(() => runtime.snapshot().messages.some((message) => message.body.startsWith("Edit overlap")));

    const notice = runtime.snapshot().messages.find((message) => message.body.startsWith("Edit overlap"));
    expect(notice).toMatchObject({ sender: "watari", priority: "urgent", recipients: ["claude", "codex"] });
    expect(notice?.body).toContain("src/decoder/frame.ts: codex just changed it, and it is inside claude's claim");
  });
});

describe("progress reports", () => {
  test("closing a delegated TODO tells its author, and the last one asks for the report", async () => {
    const store = new TeamStore(":memory:");
    cleanups.push(() => store.close());
    store.registerAgent({ id: "codex", backend: "codex", displayName: "Codex" });
    store.registerAgent({ id: "claude", backend: "claude", displayName: "Claude" });
    store.createGoal({ instruction: "Split it", initialAddressee: null, participants: ["codex", "claude"] });
    const service = new TeamApplicationService({ store });
    const codex = new IdentityBoundTeamTools({ agent: "codex", service });
    const claude = new IdentityBoundTeamTools({ agent: "claude", service });
    await codex.call("team_todo", {
      action: "add",
      items: [{ title: "parser", assignee: "claude" }, { title: "lexer", assignee: "claude" }],
    });

    await claude.call("team_todo", { action: "update", id: 1, state: "done", note: "tests pass" });
    const breadcrumb = store.pendingInbox("codex").at(-1);
    expect(breadcrumb).toMatchObject({ sender: "watari", delivery: "passive" });
    expect(breadcrumb?.body).toBe("claude marked TODO #1 done: parser\nNote: tests pass");

    await claude.call("team_todo", { action: "update", id: 2, state: "dropped" });
    const last = store.pendingInbox("codex").at(-1);
    expect(last?.body).toContain("All 2 TODOs for this goal are done or dropped.");
    expect(last?.delivery ?? "normal").toBe("normal");
  });

  test("team_status says what a working peer is doing", async () => {
    const store = new TeamStore(":memory:");
    cleanups.push(() => store.close());
    store.registerAgent({ id: "codex", backend: "codex", displayName: "Codex" });
    store.registerAgent({ id: "claude", backend: "claude", displayName: "Claude" });
    store.setAgentState("claude", "busy");
    store.saveActivity({
      summary: {
        id: "act_000000000000000000000001",
        agent: "claude",
        kind: "command",
        state: "running",
        title: "bun test",
        preview: "",
        providerEventId: "call-1",
        revision: 1,
        startedAt: 1,
        updatedAt: 2,
        hasDetail: false,
      },
      detail: {
        kind: "command",
        command: "bun test",
        cwd: null,
        outputMode: "combined",
        stdout: "",
        stderr: "",
        exitCode: null,
        durationMs: null,
        interrupted: false,
        retention: {
          truncated: false,
          originalBytes: 0,
          retainedBytes: 0,
          omittedBytes: 0,
          originalLines: 0,
          retainedLines: 0,
          omittedLines: 0,
        },
      },
    });
    const codex = new IdentityBoundTeamTools({ agent: "codex", service: new TeamApplicationService({ store }) });

    const status = await codex.call("team_status", {});
    expect(status).toMatchObject({
      ok: true,
      value: { peers: expect.arrayContaining([expect.objectContaining({ id: "claude", doing: "running bun test" })]) },
    });
  });
});

async function waitUntil(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition was not reached in time");
    await Bun.sleep(5);
  }
}
