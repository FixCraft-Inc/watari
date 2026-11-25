import { describe, expect, test } from "bun:test";

import {
  REQUIRED_TEAM_TOOLS,
  probeTeamBridge,
  readToolAnswer,
  summarizeBridges,
  unknownBridge,
  withProviderReport,
} from "../src/watari/team/bridge-check.ts";
import { TEAM_TOOL_CATALOG } from "../src/watari/team/tool-catalog.ts";

describe("reading a team tool answer", () => {
  test("the team envelope decides, not the transport", () => {
    expect(readToolAnswer({ content: [{ type: "text", text: '{"ok":true,"agents":[]}' }] })).toEqual({
      ok: true,
      error: "",
    });
    expect(
      readToolAnswer({ content: [{ type: "text", text: '{"ok":false,"error":"alias not registered"}' }] }),
    ).toEqual({ ok: false, error: "alias not registered" });
  });

  test("an MCP-level error is reported with its text", () => {
    expect(
      readToolAnswer({ isError: true, content: [{ type: "text", text: "socket refused" }] }),
    ).toEqual({ ok: false, error: "socket refused" });
  });

  test("content that is not the envelope is a failure, not a pass", () => {
    expect(readToolAnswer({ content: [{ type: "text", text: "hello" }] }).ok).toBe(false);
    expect(readToolAnswer({ content: [] }).ok).toBe(false);
    expect(readToolAnswer(null).ok).toBe(false);
  });
});

describe("probing a bridge", () => {
  test("an executable that does not exist fails without throwing", async () => {
    const status = await probeTeamBridge({
      agent: "codex",
      command: ["/nonexistent/watari-binary", "mcp", "--agent", "codex"],
      timeoutMs: 2_000,
    });

    expect(status.state).toBe("failed");
    expect(status.agent).toBe("codex");
    expect(status.detail).not.toBe("");
    expect(status.tools).toEqual([]);
  });

  test("a command that answers nothing times out rather than hanging", async () => {
    const started = Date.now();
    const status = await probeTeamBridge({
      agent: "claude",
      command: ["sh", "-c", "sleep 30"],
      timeoutMs: 300,
    });

    expect(status.state).toBe("failed");
    expect(status.detail).toContain("300ms");
    // The point of the timeout is that a wedged bridge cannot hold a send.
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 10_000);

  test("the required tool list is the whole coordination vocabulary", () => {
    expect([...REQUIRED_TEAM_TOOLS]).toEqual(TEAM_TOOL_CATALOG.map((entry) => entry.name));
    for (const name of ["team_send", "team_todo", "team_wake", "team_availability"]) {
      expect(REQUIRED_TEAM_TOOLS).toContain(name);
    }
  });
});

describe("provider reports", () => {
  test("a provider failure overrides a passing probe, because the model cannot see it", () => {
    const measured = { ...unknownBridge("claude"), state: "ready" as const, detail: "roster answered" };
    const folded = withProviderReport(measured, {
      state: "failed",
      detail: "Claude reports the team server needs-auth",
    });

    expect(folded.state).toBe("failed");
    expect(folded.detail).toContain("needs-auth");
    expect(folded.providerReported).toBe("failed");
  });

  test("a healthy provider report is recorded without changing the measurement", () => {
    const measured = { ...unknownBridge("codex"), state: "ready" as const, detail: "roster answered" };
    const folded = withProviderReport(measured, { state: "connected", detail: "loaded" });

    expect(folded.state).toBe("ready");
    expect(folded.detail).toBe("roster answered");
    expect(folded.providerReported).toBe("connected");
  });

  test("a pending report never promotes an unchecked bridge", () => {
    const folded = withProviderReport(unknownBridge("codex"), { state: "pending", detail: "starting" });
    expect(folded.state).toBe("unknown");
  });
});

describe("summaries", () => {
  test("each peer is named with its verdict", () => {
    expect(
      summarizeBridges([
        { ...unknownBridge("codex"), state: "ready" },
        { ...unknownBridge("claude"), state: "failed" },
      ]),
    ).toBe("codex ok  ·  claude failed");
  });

  test("no configured bridge says so plainly", () => {
    expect(summarizeBridges([])).toBe("no team bridges are configured");
  });
});
