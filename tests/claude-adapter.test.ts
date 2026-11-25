import { describe, expect, test } from "bun:test";

import { ClaudeStreamAdapter } from "../src/watari/agents/claude-stream.ts";
import { resolveProjectContext } from "../src/watari/project/checkout.ts";
import type { AgentEvent } from "../src/watari/models.ts";

const fake = `${import.meta.dir}/fakes/fake-claude.ts`;

describe("ClaudeStreamAdapter", () => {
  test("normalizes stream-json without a provider UI", async () => {
    process.env.WATARI_FAKE_SECRET = "synthetic-claude-secret";
    const adapter = new ClaudeStreamAdapter({
      executable: process.execPath,
      commandPrefix: [process.execPath, fake],
    });
    const events: AgentEvent[] = [];
    try {
      await adapter.start(resolveProjectContext("."));
      await adapter.send({ kind: "message", text: "fixture" });
      for await (const event of adapter.events()) {
        events.push(event);
        if (event.summary.includes("turn completed")) {
          break;
        }
      }
    } finally {
      await adapter.stop();
      delete process.env.WATARI_FAKE_SECRET;
    }
    expect(adapter.capabilities().approvals).toBe(false);
    expect(events.some((event) => event.kind === "assistant")).toBe(true);
    expect(events.some((event) => event.kind === "reasoning")).toBe(true);
    expect(events.some((event) => event.kind === "tool_start")).toBe(true);
    expect(JSON.stringify(events)).not.toContain("synthetic-claude-secret");
    expect(JSON.stringify(events)).toContain("stdin_tty=false");
  });

  test("reports malformed lines and continues", async () => {
    process.env.WATARI_FAKE_MODE = "malformed";
    const adapter = new ClaudeStreamAdapter({
      executable: process.execPath,
      commandPrefix: [process.execPath, fake],
    });
    const events: AgentEvent[] = [];
    try {
      await adapter.start(resolveProjectContext("."));
      await adapter.send({ kind: "message", text: "fixture" });
      for await (const event of adapter.events()) {
        events.push(event);
        if (event.summary.includes("turn completed")) {
          break;
        }
      }
    } finally {
      await adapter.stop();
      delete process.env.WATARI_FAKE_MODE;
    }
    expect(events.some((event) => event.rawType === "malformed_jsonl")).toBe(true);
    expect(events.some((event) => event.kind === "assistant")).toBe(true);
  });
});
