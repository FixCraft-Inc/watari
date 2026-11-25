import { describe, expect, test } from "bun:test";

import type { ProviderAccountStatus, ProviderStatusSnapshot, QuotaWindow } from "../src/watari/provider-status.ts";
import { planAccountUse } from "../src/watari/provider-usage-plan.ts";

const now = 1_800_000_000_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function window(remainingPercent: number, windowMinutes: number | null, resetIn: number): QuotaWindow {
  return {
    usedPercent: 100 - remainingPercent,
    remainingPercent,
    resetAt: now + resetIn,
    windowMinutes,
    observedAt: now - 60_000,
    freshness: "fresh",
    source: "codexlb",
    confidence: "observed",
  };
}

function account(alias: string, fields: Partial<ProviderAccountStatus> = {}): ProviderAccountStatus {
  return {
    provider: "codex",
    accountId: alias,
    accountAlias: alias,
    displayName: alias,
    plan: "plus",
    tier: null,
    eligible: true,
    status: "active",
    preferred: null,
    preference: null,
    priority: null,
    eligibilityReason: null,
    remedy: null,
    primary: window(80, 300, 3 * HOUR),
    secondary: window(60, 10080, 4 * DAY),
    billing: null,
    resetCredits: null,
    resetCreditsExpireAt: null,
    resetCreditsFreshness: "unknown",
    models: null,
    lastObservedAt: now,
    freshness: "fresh",
    route: null,
    activeSessions: null,
    source: "codexlb",
    confidence: "observed",
    ...fields,
  };
}

function snapshot(accounts: ProviderAccountStatus[], fields: Partial<ProviderStatusSnapshot> = {}): ProviderStatusSnapshot {
  return {
    provider: "codex",
    source: "codexlb",
    observedAt: now,
    freshness: "fresh",
    reachable: true,
    accounts,
    currentRoute: null,
    sessionPins: [],
    allEligibleUnavailable: false,
    capacity: "healthy",
    error: null,
    ...fields,
  };
}

const ending = (inMs: number) => ({
  nextBillingAt: null, renewalAt: null, detail: null, paidThroughAt: now + inMs, periodStartAt: null,
  paidThroughCheckedAt: null, creditBalance: null, creditsUnlimited: null, extraUsageActive: null, source: "codexlb",
});

const billing = (endsIn: number, periodMs = 30 * DAY) => ({
  nextBillingAt: null, renewalAt: null, detail: null, paidThroughAt: now + endsIn, periodStartAt: now + endsIn - periodMs,
  paidThroughCheckedAt: null, creditBalance: null, creditsUnlimited: null, extraUsageActive: null, source: "codexlb",
});

describe("account use order", () => {
  test("spends free accounts first, then paid by urgency, then no-data, and keeps weekly-only last", () => {
    const plan = planAccountUse(snapshot([
      account("weekly-only", { primary: null, secondary: window(90, 10080, 2 * DAY) }),
      account("calm", { primary: window(70, 300, 4 * HOUR), secondary: window(60, 10080, 6 * DAY) }),
      account("urgent", { primary: window(60, 300, 30 * 60_000) }),
      account("no-data", { primary: null, secondary: null }),
      account("free", { plan: "free", primary: null, secondary: null }),
    ]), now);
    expect(plan.map((entry) => [entry.rank, entry.accountAlias, entry.tier])).toEqual([
      [1, "free", "free"],
      [2, "urgent", "paid"],
      [3, "calm", "paid"],
      [4, "no-data", "unknown"],
      [5, "weekly-only", "reserve"],
    ]);
    expect(plan[0]!.reason).toBe("Free plan, spent first for the models it has");
    expect(plan[1]!.reason).toBe("Its 5-hour window resets in 30 min with 60% left");
    expect(plan[1]!.urgency).toBeGreaterThan(plan[2]!.urgency);
    expect(plan[4]!.reason).toContain("kept in reserve");
  });

  test("weighs a 5-hour, a weekly, and a paid period on one scale", () => {
    // 50% left with 10% of the 5-hour window to go: pace 5.
    // 80% left with 1 day of the week to go: pace 5.6.
    const plan = planAccountUse(snapshot([
      account("short", { primary: window(50, 300, 30 * 60_000), secondary: window(90, 10080, 6 * DAY) }),
      account("week", { primary: window(90, 300, 4 * HOUR), secondary: window(80, 10080, DAY) }),
    ]), now);
    expect(plan.map((entry) => entry.accountAlias)).toEqual(["week", "short"]);
    expect(plan[0]!.reason).toBe("Its weekly window resets in 24h with 80% left");
  });

  test("a plan about to end outranks a calm account and pulls a weekly-only account out of reserve", () => {
    const plan = planAccountUse(snapshot([
      account("calm", { primary: window(80, 300, 4 * HOUR), secondary: window(80, 10080, 6 * DAY) }),
      account("ending", { primary: null, secondary: window(70, 10080, 5 * DAY), billing: billing(2 * DAY) }),
    ]), now);
    expect(plan.map((entry) => [entry.accountAlias, entry.tier])).toEqual([["ending", "paid"], ["calm", "paid"]]);
    expect(plan[0]!.reason).toBe("Its paid period ends in 2 days with 70% left");
  });

  test("manual resets raise urgency", () => {
    const plan = planAccountUse(snapshot([
      account("plain", { primary: window(60, 300, 2 * HOUR) }),
      account("resettable", { primary: window(60, 300, 2 * HOUR), resetCredits: 2, resetCreditsFreshness: "fresh" }),
    ]), now);
    expect(plan.map((entry) => entry.accountAlias)).toEqual(["resettable", "plain"]);
    expect(plan[0]!.reason).toContain("2 banked manual resets (save for weekly exhaustion)");
    expect(plan[0]!.urgency).toBeCloseTo(plan[1]!.urgency * 1.5, 1);
  });

  test("keeps positive balances usable and ignores stale or expired reset credits", () => {
    const plan = planAccountUse(snapshot([
      account("tiny", { primary: window(0.5, 300, HOUR) }),
      account("stale-credit", { resetCredits: 2, resetCreditsFreshness: "stale" }),
      account("expired-credit", { resetCredits: 2, resetCreditsFreshness: "fresh", resetCreditsExpireAt: now - 1 }),
    ]), now);
    expect(plan.map((entry) => entry.accountAlias)).toContain("tiny");
    for (const entry of plan) expect(entry.reason).not.toContain("banked");
  });

  test("leaves out accounts that cannot serve and stays empty for stale or unreachable status", () => {
    const accounts = [
      account("spent", { eligible: false, eligibilityReason: "quota_exceeded" }),
      account("drained", { primary: window(0, 300, HOUR) }),
      account("old", { freshness: "stale" }),
      account("ok"),
    ];
    expect(planAccountUse(snapshot(accounts), now).map((entry) => entry.accountAlias)).toEqual(["ok"]);
    expect(planAccountUse(snapshot(accounts, { freshness: "stale" }), now)).toEqual([]);
    expect(planAccountUse(snapshot(accounts, { reachable: false }), now)).toEqual([]);
  });

  test("treats a primary window of unknown length as the 5-hour one", () => {
    const plan = planAccountUse(snapshot([
      account("reserve", { primary: null, secondary: window(90, null, DAY) }),
      account("short", { primary: window(50, null, HOUR), secondary: window(90, null, DAY) }),
    ]), now);
    expect(plan.map((entry) => [entry.accountAlias, entry.tier])).toEqual([["short", "paid"], ["reserve", "reserve"]]);
  });
});
