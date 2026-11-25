import { afterEach, describe, expect, test } from "bun:test";

import { redactSummary } from "../src/watari/security/redaction.ts";
import { CoordinatorRuntime } from "../src/watari/service/runtime.ts";
import { PersistedEventSchema } from "../src/watari/state/schemas.ts";
import { TeamStore } from "../src/watari/state/store.ts";
import { FakeAdapter } from "./fakes/fake-adapter.ts";

const runtimes: CoordinatorRuntime[] = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.stop()));
});

describe("bounded provider text", () => {
  test("a clipped summary, note included, still fits the local API", () => {
    const summary = redactSummary("reasoning ".repeat(7_000));
    expect(summary.length).toBeLessThanOrEqual(64 * 1024);
    expect(summary).toMatch(/\[TRUNCATED \d+ CHARACTERS\]$/u);
    expect(PersistedEventSchema.safeParse({
      id: 1,
      agent: "claude",
      type: "reasoning",
      summary,
      providerEventId: null,
      createdAt: 1,
    }).success).toBe(true);
  });

  test("a status detail is clipped, and an empty one is cleared, instead of throwing", () => {
    const store = new TeamStore(":memory:");
    store.registerAgent({ id: "codex", backend: "codex", displayName: "Codex" });
    store.setAgentState("codex", "failed", { detail: "x".repeat(10_000) });
    expect(store.agents()[0]?.detail?.length).toBeLessThanOrEqual(4_000);
    store.setAgentState("codex", "ready", { detail: "   " });
    expect(store.agents()[0]?.detail).toBeNull();
    store.close();
  });

  test("a huge provider error marks the peer failed and tells the others briefly", async () => {
    const codex = new FakeAdapter("codex");
    const claude = new FakeAdapter("claude");
    const runtime = new CoordinatorRuntime({
      project: { launchDirectory: "/tmp/project", repositoryRoot: "/tmp/project" },
      databasePath: ":memory:",
      adapters: { codex, claude },
    });
    runtimes.push(runtime);
    await runtime.start();
    await runtime.sendUserMessage("all", "Review the tree.");

    codex.emit("error", `upstream failure ${"detail ".repeat(8_000)}`);
    const deadline = Date.now() + 3_000;
    while (runtime.snapshot().agents.find((agent) => agent.id === "codex")?.state !== "failed") {
      if (Date.now() > deadline) throw new Error("codex was not marked failed");
      await Bun.sleep(5);
    }
    const notice = runtime.snapshot().messages.find((message) => message.body.includes("is offline"));
    expect(notice?.recipients).toEqual(["claude"]);
    expect(notice?.body.length).toBeLessThan(600);
  });
});
