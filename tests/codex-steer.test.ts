import { describe, expect, test } from "bun:test";

import { CodexAdapter } from "../src/watari/agents/codex.ts";
import { InputDeferredError, type AgentEvent } from "../src/watari/models.ts";
import { resolveProjectContext } from "../src/watari/project/checkout.ts";

const fake = `${import.meta.dir}/fakes/fake-codex.ts`;

async function withFakeCodex(
  mode: string,
  run: (adapter: CodexAdapter, events: AgentEvent[]) => Promise<void>,
): Promise<void> {
  process.env.WATARI_FAKE_MODE = mode;
  const adapter = new CodexAdapter({
    executable: process.execPath,
    commandPrefix: [process.execPath, fake],
  });
  const events: AgentEvent[] = [];
  const collecting = (async () => {
    for await (const event of adapter.events()) events.push(event);
  })();
  try {
    await adapter.start(resolveProjectContext("."));
    await run(adapter, events);
  } finally {
    await adapter.stop();
    delete process.env.WATARI_FAKE_MODE;
    await collecting;
  }
}

describe("steering a Codex turn", () => {
  test("input that races the end of a turn opens the next turn instead of failing", async () => {
    await withFakeCodex("steer-race", async (adapter, events) => {
      await adapter.send({ kind: "message", text: "first" });
      await waitUntil(() => events.some((event) => event.rawType === "turn/started"));
      await adapter.send({ kind: "message", text: "second" });
      await waitUntil(() => events.filter((event) => event.rawType === "watari/test/turn-start").length === 2);
      expect(events.some((event) => event.kind === "error")).toBe(false);
    });
  });

  test("a turn that refuses to be steered defers the input instead of failing the peer", async () => {
    await withFakeCodex("steer-refused", async (adapter, events) => {
      await adapter.send({ kind: "message", text: "first" });
      await waitUntil(() => events.some((event) => event.rawType === "turn/started"));
      await expect(adapter.send({ kind: "message", text: "second" })).rejects.toBeInstanceOf(InputDeferredError);
    });
  });
});

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition was not reached in time");
    await Bun.sleep(5);
  }
}
