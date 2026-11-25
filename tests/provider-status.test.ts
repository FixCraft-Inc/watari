import { describe, expect, test } from "bun:test";

import {
  ProviderStatusCache,
  StatusHttpError,
  capacityNotice,
  capacityNoticeKind,
  readCodexLbStatus,
  readTeamClaudeStatus,
  watariStatusSnapshot,
  type ProviderStatusSnapshot,
} from "../src/watari/provider-status.ts";
import {
  ProviderStatusService,
  handleProviderStatusRequest,
  type ProviderStatusReader,
} from "../src/watari/provider-status-api.ts";

const now = 1_800_000_000_000;
const clock = () => now;
const iso = (ms: number) => new Date(ms).toISOString();

/** A row shaped like CodexLB's `AccountSummary`, which serializes camelCase. */
function codexRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    accountId: "acc_codex_a",
    email: "fixture-a@example.invalid",
    alias: null,
    displayName: "Codex A",
    planType: "pro",
    seatType: null,
    routingPolicy: "normal",
    status: "active",
    usage: { primaryRemainingPercent: 80, secondaryRemainingPercent: 60, monthlyRemainingPercent: null },
    resetAtPrimary: iso(now + 60 * 60_000),
    resetAtSecondary: iso(now + 3 * 86_400_000),
    // The OAuth token refresh time. It is not a quota sample and is old here.
    lastRefreshAt: iso(now - 9 * 86_400_000),
    creditsBalance: null,
    creditsUnlimited: null,
    ...overrides,
  };
}

/** A row shaped like TeamClaude's `getStatus().accounts[]`. */
function claudeRow(
  name: string,
  quota: { u5?: number | null; u7?: number | null; seenAt?: number | null; reset?: number } = {},
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const seenAt = quota.seenAt === undefined ? now - 30_000 : quota.seenAt;
  return {
    name,
    type: "oauth",
    provider: "anthropic",
    priority: 0,
    disabled: false,
    cordoned: false,
    status: "active",
    unavailable: null,
    sessions: 1,
    onExtraUsage: false,
    quota: {
      unified5h: quota.u5 ?? null,
      unified5hReset: quota.reset ?? now + 2 * 60 * 60_000,
      unified5hSeenAt: quota.u5 === undefined || quota.u5 === null ? null : seenAt,
      unified7d: quota.u7 ?? null,
      unified7dReset: now + 5 * 86_400_000,
      unified7dSeenAt: quota.u7 === undefined || quota.u7 === null ? null : seenAt,
    },
    ...overrides,
  };
}

const readTeam = (status: Record<string, unknown>, staleAfterMs?: number) =>
  readTeamClaudeStatus("http://127.0.0.1:3456", async () => status, {
    now: clock,
    ...(staleAfterMs ? { staleAfterMs } : {}),
  });

/** A CodexLB without the provider-status route: 404 there, dashboard list instead. */
const readCodex = (status: Record<string, unknown>) =>
  readCodexLbStatus("http://127.0.0.1:2455", async (url) => {
    if (url.endsWith("/api/provider-status")) throw new StatusHttpError(404, "not found");
    return status;
  }, { now: clock });

/** A CodexLB with `GET /api/provider-status`. */
const readProjection = (accounts: unknown[]) => {
  const urls: string[] = [];
  const status = readCodexLbStatus("http://127.0.0.1:2455", async (url) => {
    urls.push(url);
    return { schemaVersion: 1, source: "codexlb", generatedAt: iso(now), accounts };
  }, { now: clock });
  return { status, urls };
};

function projectionRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    accountId: "acc_p",
    alias: null,
    displayName: "k***@example.invalid",
    planType: "pro",
    seatType: null,
    status: "active",
    eligible: true,
    eligibilityReason: null,
    routingPolicy: "preserve",
    usageSampledAt: iso(now - 60_000),
    primary: { remainingPercent: 0.5, usedPercent: 99.5, resetAt: iso(now + 3_600_000), windowMinutes: 300 },
    secondary: { remainingPercent: 40, usedPercent: 60, resetAt: iso(now + 86_400_000), windowMinutes: 10080 },
    credits: { has: true, unlimited: false, balance: 3 },
    subscription: { activeStart: iso(now - 20 * 86_400_000), activeUntil: iso(now + 10 * 86_400_000), lastChecked: iso(now - 20 * 86_400_000), source: "openai_id_token" },
    ...overrides,
  };
}

describe("CodexLB adapter", () => {
  test("reads the camelCase dashboard schema, including reset times and plan", async () => {
    const status = await readCodex({ accounts: [codexRow({ alias: "work", routingPolicy: "preserve", priority: 2 })] });
    const account = status.accounts[0]!;
    expect(account).toMatchObject({
      accountAlias: "work",
      displayName: "Codex A",
      plan: "pro",
      eligible: true,
      preference: "preserve",
      priority: 2,
      preferred: null,
      freshness: "fresh",
    });
    expect(account.primary).toMatchObject({ remainingPercent: 80, usedPercent: 20, resetAt: now + 60 * 60_000 });
    expect(account.secondary?.resetAt).toBe(now + 3 * 86_400_000);
    expect(status.capacity).toBe("healthy");
    expect(status.allEligibleUnavailable).toBe(false);
  });

  test("never uses the token refresh time as a quota sample time", async () => {
    const status = await readCodex({ accounts: [codexRow()] });
    const primary = status.accounts[0]!.primary!;
    expect(primary.confidence).toBe("derived");
    expect(primary.observedAt).toBe(now);
    expect(primary.freshness).toBe("fresh");
  });

  test("an old provider usage sample time makes the windows stale", async () => {
    const status = await readCodex({ accounts: [codexRow({
      usageRefreshedAt: iso(now - 60 * 60_000),
      usage: { primaryRemainingPercent: 0, secondaryRemainingPercent: 0 },
    })] });
    expect(status.accounts[0]!.primary).toMatchObject({ confidence: "observed", freshness: "stale" });
    expect(status.capacity).toBe("unknown");
    expect(status.allEligibleUnavailable).toBeNull();
    expect(capacityNotice(status)).toBeNull();
  });

  test("derived zero-remaining windows warn but never prove exhaustion", async () => {
    const status = await readCodex({ accounts: [
      codexRow({ usage: { primaryRemainingPercent: 0, secondaryRemainingPercent: 50 } }),
      codexRow({ accountId: "acc_codex_b", usage: { primaryRemainingPercent: 1, secondaryRemainingPercent: 50 } }),
    ] });
    expect(status.capacity).toBe("nearly_exhausted");
    expect(status.allEligibleUnavailable).toBe(false);
    expect(capacityNoticeKind(status)).toBe("advisory");
  });

  test("maps non-active statuses to explicit ineligibility with a reason", async () => {
    const status = await readCodex({ accounts: [
      codexRow({ status: "rate_limited" }),
      codexRow({ accountId: "acc_b", status: "deactivated", deactivationReason: "workspace removed" }),
    ] });
    expect(status.accounts.map((account) => [account.eligible, account.eligibilityReason])).toEqual([
      [false, "rate_limited"],
      [false, "workspace removed"],
    ]);
    // CodexLB's live status is explicit evidence, so no eligible account is left.
    expect(status.capacity).toBe("unavailable");
    expect(status.allEligibleUnavailable).toBe(true);
    expect(capacityNoticeKind(status)).toBe("checkpoint");
  });

  test("reports provider credits as billing and nothing else", async () => {
    const status = await readCodex({ accounts: [codexRow({ creditsBalance: 12.5, creditsUnlimited: false }), codexRow({ accountId: "b" })] });
    expect(status.accounts[0]!.billing).toMatchObject({ creditBalance: 12.5, creditsUnlimited: false, nextBillingAt: null, renewalAt: null });
    expect(status.accounts[1]!.billing).toBeNull();
  });

  test("a missing account list is a read failure, not an empty provider", async () => {
    const status = await readCodex({ detail: "unexpected" });
    expect(status).toMatchObject({ reachable: false, capacity: "unknown", allEligibleUnavailable: null, accounts: [] });
    expect(status.error).toContain("no account list");
  });
});

describe("CodexLB provider-status projection", () => {
  test("is read first and carries sample time, eligibility, and the paid-through date", async () => {
    const { status, urls } = readProjection([projectionRow()]);
    const snapshot = await status;
    expect(urls).toEqual(["http://127.0.0.1:2455/api/provider-status"]);
    const account = snapshot.accounts[0]!;
    expect(account).toMatchObject({ accountAlias: "acc_p", displayName: "k***@example.invalid", plan: "pro", eligible: true, preference: "preserve" });
    expect(account.primary).toMatchObject({ remainingPercent: 0.5, confidence: "observed", observedAt: now - 60_000, resetAt: now + 3_600_000 });
    expect(account.billing).toMatchObject({
      paidThroughAt: now + 10 * 86_400_000, paidThroughCheckedAt: now - 20 * 86_400_000,
      creditBalance: 3, creditsUnlimited: false, nextBillingAt: null,
    });
  });

  test("provider-sampled windows can prove the pool drained", async () => {
    const drained = await readProjection([
      projectionRow({ primary: { remainingPercent: 0, resetAt: iso(now + 3_600_000) } }),
      projectionRow({ accountId: "acc_q", primary: { remainingPercent: 0, resetAt: iso(now + 600_000) } }),
    ]).status;
    expect(drained.allEligibleUnavailable).toBe(true);
    expect(capacityNoticeKind(drained)).toBe("checkpoint");
    expect(capacityNotice(drained, now)).toContain("Every ChatGPT/Codex account CodexLB can route to is out of quota");
    expect(capacityNotice(drained, now)).toContain("resets in about 10 minutes");

    const roomy = await readProjection([projectionRow(), projectionRow({ accountId: "acc_q", primary: { remainingPercent: 70 } })]).status;
    expect(roomy.capacity).toBe("healthy");
    expect(capacityNoticeKind(roomy)).toBeNull();
  });

  test("an account with only a weekly limit is judged by that window", async () => {
    const weeklyOnly = (accountId: string, remaining: number) =>
      projectionRow({ accountId, primary: null, secondary: { remainingPercent: remaining, resetAt: iso(now + 86_400_000), windowMinutes: 10080 } });
    const roomy = await readProjection([weeklyOnly("a", 0), weeklyOnly("b", 60)]).status;
    expect(roomy.accounts[1]!.primary).toBeNull();
    expect(roomy.accounts[1]!.secondary).toMatchObject({ windowMinutes: 10080, remainingPercent: 60 });
    expect(roomy.capacity).toBe("healthy");
    expect(roomy.allEligibleUnavailable).toBe(false);
    expect(capacityNoticeKind(roomy)).toBeNull();

    const drained = await readProjection([weeklyOnly("a", 0), weeklyOnly("b", 0)]).status;
    expect(drained.allEligibleUnavailable).toBe(true);
    expect(capacityNoticeKind(drained)).toBe("checkpoint");
  });

  test("keeps the provider's window lengths", async () => {
    const account = (await readProjection([projectionRow()]).status).accounts[0]!;
    expect([account.primary?.windowMinutes, account.secondary?.windowMinutes]).toEqual([300, 10080]);
    const claude = (await readTeam({ accounts: [claudeRow("claude-a", { u5: 0.1, u7: 0.2 })] })).accounts[0]!;
    expect([claude.primary?.windowMinutes, claude.secondary?.windowMinutes]).toEqual([300, 10080]);
  });

  test("uses the projection's explicit eligibility and reason", async () => {
    const snapshot = await readProjection([projectionRow({ status: "rate_limited", eligible: false, eligibilityReason: "rate_limited", subscription: null })]).status;
    expect(snapshot.accounts[0]).toMatchObject({ eligible: false, eligibilityReason: "rate_limited" });
    expect(snapshot.accounts[0]!.billing?.paidThroughAt).toBeNull();
  });

  test("falls back to the dashboard list only on 404, never past an auth refusal", async () => {
    const refused = await readCodexLbStatus("http://127.0.0.1:2455", async (url) => {
      if (url.endsWith("/api/provider-status")) throw new StatusHttpError(401, "requires authentication");
      return { accounts: [codexRow()] };
    }, { now: clock });
    expect(refused).toMatchObject({ reachable: false, accounts: [] });
    expect(refused.error).toContain("requires authentication");
  });
});

describe("TeamClaude adapter", () => {
  test("keeps over-limit fractional utilization exhausted instead of reading it as percent", async () => {
    const status = await readTeam({ accounts: [claudeRow("claude-a", { u5: 1.01, u7: 1.02 })] });
    expect(status.accounts[0]!.primary).toMatchObject({ usedPercent: 100, remainingPercent: 0 });
    expect(status.accounts[0]!.secondary).toMatchObject({ usedPercent: 100, remainingPercent: 0 });
    expect(status.allEligibleUnavailable).toBe(true);
    expect(capacityNoticeKind(status, now)).toBe("checkpoint");
  });

  test("reads quota, session pins, the current route, and extra-usage billing", async () => {
    const status = await readTeam({
      currentAccounts: { anthropic: "claude-a" },
      defaultTargets: { anthropic: "claude-b" },
      sessionPins: [{ session: "1a2b3c4d", account: "claude-a", since: now - 60_000, lastUsed: now - 5_000 }],
      accounts: [
        claudeRow("claude-a", { u5: 0.2, u7: 0.4 }),
        claudeRow("claude-b", { u5: 0.5 }, { onExtraUsage: true }),
      ],
    });
    // defaultTargets is where an unrouted request lands now, so it wins.
    expect(status.currentRoute).toMatchObject({ accountAlias: "claude-b" });
    expect(status.sessionPins).toEqual([{
      sessionId: "1a2b3c4d", accountAlias: "claude-a", since: now - 60_000, lastUsedAt: now - 5_000, source: "teamclaude",
    }]);
    expect(status.accounts[0]!.primary).toMatchObject({ usedPercent: 20, remainingPercent: 80, confidence: "observed" });
    // TeamClaude always reports onExtraUsage. It never reports a billing date.
    expect(status.accounts[0]!.billing).toEqual({
      nextBillingAt: null, renewalAt: null, detail: null, paidThroughAt: null, periodStartAt: null, paidThroughCheckedAt: null,
      creditBalance: null, creditsUnlimited: null,
      extraUsageActive: false, source: "teamclaude",
    });
    expect(status.accounts[1]!.billing).toMatchObject({ extraUsageActive: true, nextBillingAt: null, renewalAt: null });
    const silent = await readTeam({ accounts: [{ ...claudeRow("claude-c", { u5: 0.1 }), onExtraUsage: undefined }] });
    expect(silent.accounts[0]!.billing).toBeNull();
    expect(status.accounts[0]!.activeSessions).toBe(1);
  });

  test("keeps only Anthropic rows because CodexLB owns Codex accounts", async () => {
    const status = await readTeam({ accounts: [
      claudeRow("claude-a", { u5: 0.1 }),
      { ...claudeRow("codex-in-teamclaude", { u5: 0.1 }), provider: "openai" },
    ] });
    expect(status.accounts.map((account) => account.accountAlias)).toEqual(["claude-a"]);
  });

  test("uses TeamClaude's unavailable verdict for eligibility", async () => {
    const status = await readTeam({ accounts: [
      claudeRow("claude-a", { u5: 0.1 }, { unavailable: "throttled" }),
      claudeRow("claude-b", { u5: 0.1 }, { status: "error", unavailable: null }),
      claudeRow("claude-c", { u5: 0.1 }, { cordoned: true }),
    ] });
    expect(status.accounts.map((account) => [account.eligible, account.eligibilityReason])).toEqual([
      [false, "throttled"],
      [true, null],
      [false, "cordoned"],
    ]);
  });

  test("plan and tier stay unreported when TeamClaude does not send them", async () => {
    const status = await readTeam({ accounts: [claudeRow("claude-a", { u5: 0.1 })] });
    expect(status.accounts[0]).toMatchObject({ plan: null, tier: null, preferred: null });
  });
});

describe("capacity notices", () => {
  test("one account at 90% or 99% with a sibling that has room raises nothing", async () => {
    for (const used of [0.9, 0.99]) {
      const status = await readTeam({ accounts: [claudeRow("claude-a", { u5: used }), claudeRow("claude-b", { u5: 0.4 })] });
      expect(status.capacity).toBe("healthy");
      expect(status.allEligibleUnavailable).toBe(false);
      expect(capacityNoticeKind(status)).toBeNull();
      expect(capacityNotice(status, now)).toBeNull();
    }
  });

  test("every eligible account at 90% or more is an advisory warning", async () => {
    const status = await readTeam({ accounts: [
      claudeRow("claude-a", { u5: 0.92 }),
      claudeRow("claude-b", { u5: 0.95, u7: 0.5 }),
      claudeRow("claude-c", { u5: 0.2 }, { disabled: true }),
    ] });
    expect(status.capacity).toBe("limited");
    expect(capacityNoticeKind(status)).toBe("advisory");
    const text = capacityNotice(status, now)!;
    expect(text).toContain("Every Claude account TeamClaude can route to is at 90% or more");
    expect(text).toContain("resets in about 2 hours");
    expect(text).toContain("UTC");
    expect(text).not.toContain("Finish the step");
  });

  test("a sibling whose quota is unknown keeps a low pool from warning", async () => {
    const status = await readTeam({ accounts: [claudeRow("claude-a", { u5: 0.95 }), claudeRow("claude-b")] });
    expect(status.capacity).toBe("unknown");
    expect(capacityNoticeKind(status)).toBeNull();
  });

  test("positive remaining quota never asks for a checkpoint, even without an alternate", async () => {
    for (const used of [0.95, 0.99, 0.995]) {
      for (const sibling of [{ disabled: true }, { unavailable: "capped" }, { cordoned: true }]) {
        const status = await readTeam({ accounts: [
          claudeRow("claude-a", { u5: used }),
          claudeRow("claude-b", { u5: 0.2 }, sibling),
        ] });
        expect(status.allEligibleUnavailable).toBe(false);
        expect(capacityNoticeKind(status)).toBe("advisory");
        const text = capacityNotice(status, now)!;
        expect(text).toContain("Keep going");
        expect(text).not.toContain("stop at a clean point");
      }
    }
  });

  test("every eligible account drained asks for a checkpoint", async () => {
    const drained = await readTeam({ accounts: [claudeRow("claude-a", { u5: 1, u7: 0.5 }), claudeRow("claude-b", { u5: 1, u7: 1 })] });
    expect(drained.allEligibleUnavailable).toBe(true);
    expect(capacityNoticeKind(drained)).toBe("checkpoint");
    expect(capacityNotice(drained, now)).toContain("Finish the step you are on and stop at a clean point");
    expect(capacityNotice(drained, now)).toContain("the exact next step");

    const ineligible = await readTeam({ accounts: [
      claudeRow("claude-a", { u5: 0.5 }, { unavailable: "throttled" }),
      claudeRow("claude-b", { u5: 0.5 }, { unavailable: "billing" }),
    ] });
    expect(ineligible.capacity).toBe("unavailable");
    expect(ineligible.allEligibleUnavailable).toBe(true);
    expect(capacityNoticeKind(ineligible)).toBe("checkpoint");
  });

  test("accounts that all need a new login are unavailable but never a quota checkpoint", async () => {
    const broken = (name: string) => claudeRow(name, {}, {
      status: "error",
      unavailable: "error",
      errorReason: { code: "refresh_rejected", detail: "refresh token expired", remedy: "teamclaude login" },
    });
    const status = await readTeam({ accounts: [broken("claude-a"), broken("claude-b")] });
    expect(status.capacity).toBe("unavailable");
    expect(status.allEligibleUnavailable).toBe(true);
    expect(status.accounts[0]).toMatchObject({ eligible: false, eligibilityReason: "refresh rejected", remedy: "teamclaude login" });
    expect(capacityNoticeKind(status)).toBeNull();

    // One spent account among broken ones is a real quota checkpoint.
    const mixed = await readTeam({ accounts: [broken("claude-a"), claudeRow("claude-b", { u5: 1 })] });
    expect(capacityNoticeKind(mixed)).toBe("checkpoint");
  });

  test("Codex banked resets suppress checkpoints only with exhausted weekly quota", async () => {
    for (const weekly of [0, 40]) {
      const status = await readProjection([
        projectionRow({
          eligible: false, status: "quota_exceeded", eligibilityReason: "quota_exceeded",
          primary: { remainingPercent: 0, windowMinutes: 300 },
          secondary: { remainingPercent: weekly, windowMinutes: 10080 },
          resetCredits: { available: 2, nearestExpiresAt: iso(now + 86_400_000) },
        }),
        projectionRow({ accountId: "spent", primary: { remainingPercent: 0 } }),
      ]).status;
      expect(status.allEligibleUnavailable).toBe(true);
      expect(status.accounts[0]).toMatchObject({ resetCredits: 2, resetCreditsFreshness: "fresh" });
      expect(capacityNoticeKind(status, now)).toBe(weekly === 0 ? null : "checkpoint");
      if (weekly === 0) expect(capacityNotice(status, now)).toBeNull();
      else expect(capacityNotice(status, now)).toContain("stop at a clean point");
    }
  });

  test("TeamClaude preserves credit observations without treating credits as serving capacity", async () => {
    for (const weekly of [1, 0.4]) {
      const status = await readTeam({ accounts: [{
        ...claudeRow("a", {}, { unavailable: "capped" }),
        quota: {
          unified5h: 1, unified5hSeenAt: now, unified7d: weekly, unified7dSeenAt: now,
          // The reset count stays visible even when weekly quota remains.
          resetCredits: { available: 1, applicable: 0, seenAt: now, expiresAt: now + 86_400_000 },
        },
      }] });
      expect(status).toMatchObject({ capacity: "unavailable", allEligibleUnavailable: true });
      expect(status.accounts[0]).toMatchObject({
        resetCredits: 1, resetCreditsExpireAt: now + 86_400_000, resetCreditsFreshness: "fresh",
      });
      expect(capacityNoticeKind(status, now)).toBe(weekly === 1 ? null : "checkpoint");
    }
  });

  test("banked resets need a fresh observed exhausted weekly window to suppress a checkpoint", async () => {
    for (const secondary of [
      null,
      { remainingPercent: 0, windowMinutes: 300 },
      { remainingPercent: 0, windowMinutes: 10080, resetAt: iso(now - 1) },
      { remainingPercent: null, windowMinutes: 10080 },
    ]) {
      const status = await readProjection([projectionRow({
        eligible: false, status: "quota_exceeded", eligibilityReason: "quota_exceeded",
        primary: { remainingPercent: 0, windowMinutes: 300 }, secondary,
        resetCredits: { available: 2, nearestExpiresAt: iso(now + 86_400_000) },
      })]).status;
      expect(capacityNoticeKind(status, now)).toBe("checkpoint");
    }
  });

  test("expired, stale, unknown and zero credits do not suppress a real checkpoint", async () => {
    for (const resets of [
      { available: 1, seenAt: now, expiresAt: now - 1 },
      { available: 1, seenAt: now - 600_000 },
      { available: 1 },
      { available: 0, seenAt: now },
    ]) {
      const status = await readTeam({ accounts: [{
        ...claudeRow("a"),
        quota: { unified7d: 1, unified7dSeenAt: now, resetCredits: resets },
      }] });
      expect(capacityNoticeKind(status, now)).toBe("checkpoint");
    }
    const expired = await readProjection([projectionRow({
      primary: { remainingPercent: 0 }, resetCredits: { available: 1, nearestExpiresAt: iso(now - 1) },
    })]).status;
    expect(capacityNoticeKind(expired, now)).toBe("checkpoint");
  });

  test("credits on disabled or auth-broken siblings cannot restore the pool", async () => {
    for (const status of ["disabled", "reauth_required", "error"]) {
      const pool = await readProjection([
        projectionRow({ primary: { remainingPercent: 0 } }),
        projectionRow({
          accountId: "broken", eligible: false, status, eligibilityReason: "quota_exceeded",
          resetCredits: { available: 2 },
        }),
      ]).status;
      expect(capacityNoticeKind(pool, now)).toBe("checkpoint");
    }
  });

  test("stale quota samples stay unknown", async () => {
    const status = await readTeam({ accounts: [claudeRow("claude-a", { u5: 1, u7: 1, seenAt: now - 10_000 })] }, 1_000);
    expect(status.accounts[0]!.primary?.freshness).toBe("stale");
    expect(status.capacity).toBe("unknown");
    expect(status.allEligibleUnavailable).toBeNull();
    expect(capacityNotice(status, now)).toBeNull();
  });

  test("a window whose reset already passed is stale", async () => {
    const status = await readTeam({ accounts: [claudeRow("claude-a", { u5: 1, reset: now - 1 })] });
    expect(status.accounts[0]!.primary?.freshness).toBe("stale");
    expect(status.allEligibleUnavailable).toBeNull();
  });

  test("missing quota, unknown eligibility, and missing sample times stay unknown", async () => {
    const missing = await readTeam({ accounts: [claudeRow("claude-a")] });
    expect(missing.capacity).toBe("unknown");
    expect(missing.allEligibleUnavailable).toBeNull();

    const unknownEligibility = await readTeam({ accounts: [{ name: "claude-a", status: "mystery", quota: { unified5h: 1, unified5hSeenAt: now } }] });
    expect(unknownEligibility.accounts[0]!.eligible).toBeNull();
    expect(unknownEligibility.allEligibleUnavailable).toBeNull();

    const unsampled = await readTeam({ accounts: [claudeRow("claude-a", { u5: 1, seenAt: null })] });
    expect(unsampled.accounts[0]!.primary?.confidence).toBe("derived");
    expect(unsampled.allEligibleUnavailable).toBeNull();
    expect(capacityNoticeKind(unsampled)).toBe("advisory");

    const empty = await readTeam({ accounts: [] });
    expect(empty).toMatchObject({ reachable: true, capacity: "unknown", allEligibleUnavailable: null });
  });

  test("a reader failure is unknown, never drained", async () => {
    const failed = await readCodexLbStatus("http://127.0.0.1:2455", async () => {
      throw new Error("connect ECONNREFUSED");
    }, { now: clock });
    expect(failed).toMatchObject({ reachable: false, capacity: "unknown", allEligibleUnavailable: null });
    expect(capacityNotice(failed)).toBeNull();
  });

  test("one stale account keeps a fresh ineligible sibling from proving exhaustion", () => {
    const status = watariStatusSnapshot([
      { id: "a", displayName: "A", sessionId: null, state: "failed", updatedAt: now },
      { id: "b", displayName: "B", sessionId: null, state: "ready", updatedAt: now - 10_000 },
    ], { now: clock, staleAfterMs: 1_000 });
    expect(status.allEligibleUnavailable).toBeNull();
    expect(status.capacity).toBe("unknown");
  });

  test("the cache ages an old observation into unknown", () => {
    const cache = new ProviderStatusCache(1_000);
    cache.put(watariStatusSnapshot([{ id: "qwen", displayName: "Qwen", sessionId: null, state: "ready", updatedAt: now - 10_000 }], {
      now: () => now - 10_000,
      staleAfterMs: 1_000,
    }));
    const stale = cache.get("watari", now);
    expect(stale).toMatchObject({ freshness: "stale", capacity: "unknown", allEligibleUnavailable: null });
    expect(stale?.accounts[0]?.freshness).toBe("stale");
  });
});

function fixedSnapshot(provider: "codex" | "claude", accounts = 1): Promise<ProviderStatusSnapshot> {
  return provider === "codex"
    ? readCodex({ accounts: Array.from({ length: accounts }, (_, index) => codexRow({ accountId: `codex-${index}` })) })
    : readTeam({ accounts: Array.from({ length: accounts }, (_, index) => claudeRow(`claude-${index}`, { u5: 0.2 })) });
}

function reader(provider: "codex" | "claude", read: ProviderStatusReader["read"]): ProviderStatusReader {
  return { provider, source: provider === "codex" ? "codexlb" : "teamclaude", read };
}

describe("provider status service", () => {
  test("groups providers with stable labels and themes", async () => {
    const service = new ProviderStatusService([
      reader("claude", () => fixedSnapshot("claude")),
      reader("codex", () => fixedSnapshot("codex")),
    ], { now: clock });
    const document = await service.refresh();
    expect(document.schemaVersion).toBe(1);
    expect(document.providers.map((group) => [group.provider, group.label, group.theme, group.freshness])).toEqual([
      ["codex", "ChatGPT / Codex", "codex-light-blue", "fresh"],
      ["claude", "Claude / TeamClaude", "claude-orange", "fresh"],
    ]);
  });

  test("a failed refresh keeps the last observation, stale, and redacts the error", async () => {
    let healthy = true;
    const service = new ProviderStatusService([reader("codex", async () => {
      if (!healthy) throw new Error("Bearer sk-123456789012");
      return fixedSnapshot("codex");
    })], { now: clock, retries: 0 });
    await service.refresh();
    healthy = false;
    const failed = (await service.refresh()).providers[0]!;
    expect(failed).toMatchObject({ freshness: "stale", capacity: "unknown", allEligibleUnavailable: null, reachable: false, notice: null });
    expect(failed.snapshot.accounts).toHaveLength(1);
    expect(failed.error).toContain("[REDACTED]");
    expect(failed.error).not.toContain("sk-123456789012");
  });

  test("an unreachable adapter result keeps the previous observation instead of erasing it", async () => {
    let reachable = true;
    const service = new ProviderStatusService([reader("codex", (signal) => readCodexLbStatus(
      "http://127.0.0.1:2455",
      async () => {
        if (!reachable) throw new Error("connect ECONNREFUSED");
        return { accounts: [codexRow()] };
      },
      { now: clock, signal },
    ))], { now: clock, retries: 0 });
    await service.refresh();
    reachable = false;
    const group = (await service.refresh()).providers[0]!;
    expect(group.reachable).toBe(false);
    expect(group.freshness).toBe("stale");
    expect(group.snapshot.accounts.map((account) => account.accountAlias)).toEqual(["acc_codex_a"]);
    expect(group.error).toContain("ECONNREFUSED");
  });

  test("a reader that never answers times out and its signal is aborted", async () => {
    let seen: AbortSignal | null = null;
    const service = new ProviderStatusService([reader("codex", (signal) => {
      seen = signal;
      return new Promise<never>(() => undefined);
    })], { now: clock, readTimeoutMs: 20, retries: 0 });
    const group = (await service.refresh()).providers[0]!;
    expect(group).toMatchObject({ reachable: false, freshness: "unknown", capacity: "unknown", allEligibleUnavailable: null });
    expect(group.error).toContain("timed out");
    expect((seen as AbortSignal | null)?.aborted).toBe(true);
  });

  test("a transient failure is retried on the same reader only", async () => {
    const calls: string[] = [];
    const service = new ProviderStatusService([
      reader("codex", async () => {
        calls.push("codex");
        if (calls.filter((name) => name === "codex").length === 1) throw new Error("socket hang up");
        return fixedSnapshot("codex");
      }),
      reader("claude", async () => {
        calls.push("claude");
        return fixedSnapshot("claude");
      }),
    ], { now: clock, retries: 1, retryDelayMs: 1 });
    const document = await service.refresh();
    expect(document.providers.every((group) => group.freshness === "fresh")).toBe(true);
    expect(calls.filter((name) => name === "codex")).toHaveLength(2);
    expect(calls.filter((name) => name === "claude")).toHaveLength(1);
  });

  test("an identity mismatch is not retried", async () => {
    let calls = 0;
    const service = new ProviderStatusService([reader("codex", async () => {
      calls += 1;
      return fixedSnapshot("claude");
    })], { now: clock, retries: 2, retryDelayMs: 1 });
    const group = (await service.refresh()).providers[0]!;
    expect(calls).toBe(1);
    expect(group.error).toContain("identity mismatch");
  });

  test("one failing provider does not affect another", async () => {
    const service = new ProviderStatusService([
      reader("codex", () => fixedSnapshot("codex")),
      reader("claude", async () => {
        throw new Error("TeamClaude is not running");
      }),
    ], { now: clock, retries: 0 });
    const [codex, claude] = (await service.refresh()).providers;
    expect(codex).toMatchObject({ reachable: true, freshness: "fresh", capacity: "healthy" });
    expect(claude).toMatchObject({ reachable: false, freshness: "unknown", capacity: "unknown", notice: null });
    expect(claude?.error).toContain("not running");
  });

  test("close() cancels in-flight reads and keeps the previous document", async () => {
    let signal: AbortSignal | null = null;
    let first = true;
    const service = new ProviderStatusService([reader("codex", (readSignal) => {
      if (first) {
        first = false;
        return fixedSnapshot("codex");
      }
      signal = readSignal;
      return new Promise<never>(() => undefined);
    })], { now: clock, readTimeoutMs: 60_000, retries: 3, retryDelayMs: 1 });
    await service.refresh();
    const pending = service.refresh();
    await Promise.resolve();
    service.close();
    const document = await pending;
    expect((signal as AbortSignal | null)?.aborted).toBe(true);
    expect(document.providers[0]).toMatchObject({ freshness: "fresh", reachable: true });
    expect(service.closed).toBe(true);
    expect((await service.refresh()).providers[0]?.freshness).toBe("fresh");
  });

  test("concurrent refreshes share one read and the minimum interval reuses it", async () => {
    let calls = 0;
    let time = now;
    const service = new ProviderStatusService([reader("codex", async () => {
      calls += 1;
      return fixedSnapshot("codex");
    })], { now: () => time, minRefreshIntervalMs: 5_000 });
    await Promise.all([service.refresh(), service.refresh(), service.refresh()]);
    expect(calls).toBe(1);
    time += 1_000;
    await service.refresh();
    expect(calls).toBe(1);
    time += 5_000;
    await service.refresh();
    expect(calls).toBe(2);
  });

  test("the snapshot ages without a read", async () => {
    let time = now;
    const service = new ProviderStatusService([reader("codex", () => fixedSnapshot("codex"))], {
      now: () => time,
      staleAfterMs: 1_000,
    });
    await service.refresh();
    time += 2_000;
    expect(service.snapshot().providers[0]).toMatchObject({ freshness: "stale", capacity: "unknown", allEligibleUnavailable: null });
  });
});

describe("provider status HTTP seam", () => {
  test("requires caller authorization and is read-only", async () => {
    const service = new ProviderStatusService([], { now: clock });
    const unauthorized = await handleProviderStatusRequest({ method: "GET", url: "/api/provider-status" }, service, () => false);
    expect(unauthorized?.status).toBe(401);

    const authorized = await handleProviderStatusRequest({ method: "GET", url: "/api/provider-status" }, service, () => true);
    expect(authorized?.status).toBe(200);
    expect(authorized?.headers["Access-Control-Allow-Origin"]).toBeUndefined();
    expect(JSON.parse(authorized?.body ?? "{}")).toMatchObject({ schemaVersion: 1, providers: [] });

    const mutation = await handleProviderStatusRequest({ method: "POST", url: "/api/provider-status" }, service, () => {
      throw new Error("must not authorize a mutation");
    });
    expect(mutation?.status).toBe(405);

    const throwing = await handleProviderStatusRequest({ method: "GET", url: "/api/provider-status" }, service, () => {
      throw new Error("authorizer failed");
    });
    expect(throwing?.status).toBe(401);
    expect(await handleProviderStatusRequest({ method: "GET", url: "/elsewhere" }, service, () => true)).toBeNull();
  });
});
