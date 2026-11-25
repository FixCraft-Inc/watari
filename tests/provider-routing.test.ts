import { describe, expect, test } from "bun:test";

import { readTeamClaudeStatus, staleProviderStatus } from "../src/watari/provider-status.ts";
import {
  continuationFromSessionPin,
  planContinuation,
  planRetry,
  type Continuation,
} from "../src/watari/provider-routing.ts";

const now = 1_800_000_000_000;

function row(name: string, u5: number | null, overrides: Record<string, unknown> = {}, seenAt: number | null = now - 1_000) {
  return {
    name,
    provider: "anthropic",
    status: "active",
    unavailable: null,
    quota: { unified5h: u5, unified5hSeenAt: u5 === null ? null : seenAt, unified5hReset: now + 3_600_000 },
    ...overrides,
  };
}

const status = (accounts: unknown[], extra: Record<string, unknown> = {}) =>
  readTeamClaudeStatus("http://127.0.0.1:3456", async () => ({ accounts, ...extra }), { now: () => now });

const hard = (accountAlias: string, accountNeutralProof: string | null = null): Continuation => ({
  kind: "hard",
  accountAlias,
  owner: "previous_response",
  accountNeutralProof,
});

describe("continuation ownership", () => {
  test("independent and soft work may use any eligible account", async () => {
    const snapshot = await status([row("a", 0.99), row("b", 0.2)]);
    for (const continuation of [{ kind: "independent" }, { kind: "soft", accountAlias: "a" }] as const) {
      const decision = planContinuation(snapshot, continuation);
      // One account is low, but a sibling has room: no notice at all.
      expect(decision).toMatchObject({ action: "any_eligible", accountAlias: null, notice: null });
    }
  });

  test("a hard continuation stays on its owner even when a sibling has room", async () => {
    const snapshot = await status([row("a", 0.5), row("b", 0.1)]);
    expect(planContinuation(snapshot, hard("a"))).toMatchObject({ action: "owner_only", accountAlias: "a", notice: null });
  });

  test("a freshly drained owner asks for a checkpoint instead of moving to a sibling", async () => {
    const snapshot = await status([row("a", 1), row("b", 0.1)]);
    const decision = planContinuation(snapshot, hard("a"));
    expect(decision).toMatchObject({ action: "checkpoint", accountAlias: "a", notice: "checkpoint", evidenceUnknown: false });
  });

  test("positive owner quota and banked resets never ask for a proactive stop", async () => {
    const low = await status([row("a", 0.99)]);
    expect(planContinuation(low, hard("a"))).toMatchObject({ action: "owner_only", notice: "advisory" });
    const banked = await status([row("a", 1, {
      unavailable: "capped",
      quota: { unified5h: 1, unified5hSeenAt: now, resetCredits: { available: 1, seenAt: now } },
    })]);
    expect(planContinuation(banked, hard("a"))).toMatchObject({ action: "owner_only", accountAlias: "a", notice: null });
  });

  test("an ineligible owner asks for a checkpoint", async () => {
    const snapshot = await status([row("a", 0.2, { unavailable: "credential" }), row("b", 0.1)]);
    expect(planContinuation(snapshot, hard("a"))).toMatchObject({ action: "checkpoint", notice: "checkpoint" });
  });

  test("proof that the state is account-neutral lets it move", async () => {
    const snapshot = await status([row("a", 1), row("b", 0.1)]);
    const decision = planContinuation(snapshot, hard("a", "replayed from the local transcript"));
    expect(decision).toMatchObject({ action: "any_eligible", accountAlias: null });
    expect(planContinuation(snapshot, hard("a", "   ")).action).toBe("checkpoint");
  });

  test("weak evidence keeps the owner and claims nothing", async () => {
    const unsampled = await status([row("a", 1, {}, null), row("b", 0.1)]);
    expect(planContinuation(unsampled, hard("a"))).toMatchObject({ action: "owner_only", notice: "advisory" });

    const fresh = await status([row("a", 1), row("b", 0.1)]);
    const stale = staleProviderStatus(fresh, "read failed", false);
    expect(planContinuation(stale, hard("a"))).toMatchObject({ action: "owner_only", notice: null, evidenceUnknown: true });

    const absent = await status([row("b", 0.1)]);
    expect(planContinuation(absent, hard("a"))).toMatchObject({ action: "owner_only", evidenceUnknown: true });
  });

  test("a provider session pin is a hard continuation", async () => {
    const snapshot = await status([row("a", 1), row("b", 0.1)], {
      sessionPins: [{ session: "abcd1234", account: "a", since: now - 10_000, lastUsed: now - 1_000 }],
    });
    const continuation = continuationFromSessionPin(snapshot, "abcd1234-full-session-id");
    expect(continuation).toEqual({ kind: "hard", accountAlias: "a", owner: "session_pin", accountNeutralProof: null });
    expect(planContinuation(snapshot, continuation!).action).toBe("checkpoint");
    expect(continuationFromSessionPin(snapshot, "ffff0000")).toBeNull();
  });

  test("all accounts drained stops independent work at a checkpoint too", async () => {
    const snapshot = await status([row("a", 1), row("b", 1)]);
    expect(planContinuation(snapshot, { kind: "independent" })).toMatchObject({ action: "checkpoint", notice: "checkpoint" });
  });
});

describe("retry policy", () => {
  const independent: Continuation = { kind: "independent" };

  test("cancellation, visible partial output, and auth failures are final", () => {
    expect(planRetry({ attempt: 1, failure: "cancelled", continuation: independent, outputVisible: false }).action).toBe("stop");
    expect(planRetry({ attempt: 1, failure: "timeout", continuation: independent, outputVisible: true }).action).toBe("stop");
    expect(planRetry({ attempt: 1, failure: "auth", continuation: independent, outputVisible: false }).action).toBe("stop");
  });

  test("independent work is retried unpinned with bounded backoff", () => {
    const first = planRetry({ attempt: 1, failure: "timeout", continuation: independent, outputVisible: false });
    const second = planRetry({ attempt: 2, failure: "rate_limited", continuation: independent, outputVisible: false });
    expect(first).toMatchObject({ action: "retry_unpinned", delayMs: 500 });
    expect(second).toMatchObject({ action: "retry_unpinned", delayMs: 1_000 });
    expect(planRetry({ attempt: 3, failure: "timeout", continuation: independent, outputVisible: false }).action).toBe("stop");
  });

  test("a hard continuation is never retried on another account", () => {
    const owned = hard("a");
    expect(planRetry({ attempt: 1, failure: "timeout", continuation: owned, outputVisible: false }).action).toBe("retry_owner");
    expect(planRetry({ attempt: 1, failure: "server", continuation: owned, outputVisible: false }).action).toBe("retry_owner");
    for (const failure of ["rate_limited", "quota_exhausted"] as const) {
      const decision = planRetry({ attempt: 1, failure, continuation: owned, outputVisible: false });
      expect(decision.action).toBe("stop");
      expect(decision.reason).toContain("cannot move");
    }
  });

  test("account-neutral proof allows a sibling retry after an account limit", () => {
    const proven = hard("a", "replayed from the local transcript");
    expect(planRetry({ attempt: 1, failure: "quota_exhausted", continuation: proven, outputVisible: false }).action)
      .toBe("retry_unpinned");
  });
});
