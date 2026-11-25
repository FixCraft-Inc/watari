/**
 * The order in which a provider's accounts are best spent, weighted so that
 * capacity about to disappear is used before capacity that will last.
 *
 * The measure is pace: the share of a window's quota still left, divided by
 * the share of that window's time still left. Above 1, quota will be lost at
 * the reset unless it is spent faster than an even rate. It compares a 5-hour
 * window, a weekly window, and a paid period on one scale. An account's
 * urgency is its highest pace, and banked manual resets raise it, because
 * that quota can be restored.
 *
 * Tiers come before urgency:
 * 1. Free-plan accounts. Spending them costs nothing, and the provider only
 *    routes a model to an account whose plan has it, so a free account is
 *    used first only for the models it offers.
 * 2. Paid accounts by urgency.
 * 3. Accounts that can serve but report no usage yet.
 * 4. Accounts with only a weekly limit, kept in reserve because they have no
 *    5-hour cap, unless their paid period ends within a week.
 *
 * Accounts that cannot serve now are not ranked. CodexLB and TeamClaude own
 * routing, so this is advice they can be given, not a choice Watari makes.
 */

import {
  DRAINED_REMAINING_PERCENT,
  availableManualResetCredits,
  type ProviderAccountStatus,
  type ProviderStatusSnapshot,
  type QuotaWindow,
} from "./provider-status.ts";

export type UseTier = "free" | "paid" | "unknown" | "reserve";

export interface UsePlanEntry {
  readonly accountAlias: string | null;
  /** 1 is the account to use first. */
  readonly rank: number;
  readonly tier: UseTier;
  /** Highest pace, raised by manual resets. 0 when nothing is about to reset. */
  readonly urgency: number;
  readonly reason: string;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ENDING_SOON_MS = 7 * DAY;
const PLAN_END_HORIZON_MS = 30 * DAY;
const DEFAULT_PERIOD_MS = 30 * DAY;
/** A window shorter than a day is the short window (five hours today). */
const SHORT_WINDOW_LIMIT_MINUTES = 24 * 60;
const CREDIT_WEIGHT = 0.25;
const MAX_WEIGHTED_CREDITS = 4;
const TIER_ORDER: Readonly<Record<UseTier, number>> = { free: 0, paid: 1, unknown: 2, reserve: 3 };
const FREE_PLAN = /\bfree\b/iu;

interface Component {
  readonly pace: number;
  readonly text: string;
}

function usable(window: QuotaWindow | null): window is QuotaWindow {
  return window !== null && window.freshness === "fresh" && window.remainingPercent !== null;
}

function minutesOf(window: QuotaWindow, isPrimary: boolean): number {
  return window.windowMinutes ?? (isPrimary ? 300 : 10_080);
}

function isShort(window: QuotaWindow, isPrimary: boolean): boolean {
  return minutesOf(window, isPrimary) < SHORT_WINDOW_LIMIT_MINUTES;
}

function windowName(minutes: number): string {
  if (minutes === 10_080) return "weekly";
  if (minutes % 60 === 0 && minutes < SHORT_WINDOW_LIMIT_MINUTES) return `${minutes / 60}-hour`;
  if (minutes % 1_440 === 0) return `${minutes / 1_440}-day`;
  return `${minutes}-minute`;
}

function duration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 90) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)} days`;
}

function percent(value: number): string {
  return `${Math.round(value)}%`;
}

/** Share of quota left over share of time left, floored so a window about to reset stays finite. */
function pace(remainingPercent: number, msLeft: number, lengthMs: number): number {
  return remainingPercent / 100 / Math.max(msLeft / lengthMs, 0.02);
}

interface Candidate {
  readonly account: ProviderAccountStatus;
  readonly tier: UseTier;
  readonly urgency: number;
  readonly room: number;
  readonly reason: string;
}

function candidate(account: ProviderAccountStatus, now: number): Candidate | null {
  if (account.freshness !== "fresh" || account.eligible !== true) return null;
  const windows = [
    { window: account.primary, primary: true },
    { window: account.secondary, primary: false },
  ].filter((entry): entry is { window: QuotaWindow; primary: boolean } => usable(entry.window));
  const room = windows.length > 0 ? Math.min(...windows.map((entry) => entry.window.remainingPercent as number)) : 100;
  if (windows.length > 0 && room <= DRAINED_REMAINING_PERCENT) return null;

  const components: Component[] = [];
  for (const { window, primary } of windows) {
    if (window.resetAt === null || window.resetAt <= now) continue;
    const left = Math.min(window.remainingPercent as number, room);
    const minutes = minutesOf(window, primary);
    components.push({
      pace: pace(left, window.resetAt - now, minutes * 60_000),
      text: `its ${windowName(minutes)} window resets in ${duration(window.resetAt - now)} with ${percent(window.remainingPercent as number)} left`,
    });
  }
  const endsAt = account.billing?.paidThroughAt ?? null;
  const startsAt = account.billing?.periodStartAt ?? null;
  const endingIn = endsAt !== null && endsAt > now ? endsAt - now : null;
  if (endingIn !== null && endingIn <= PLAN_END_HORIZON_MS) {
    const period = startsAt !== null && startsAt < (endsAt as number) ? (endsAt as number) - startsAt : DEFAULT_PERIOD_MS;
    components.push({ pace: pace(room, endingIn, period), text: `its paid period ends in ${duration(endingIn)} with ${percent(room)} left` });
  }
  const dominant = components.reduce<Component | null>((best, next) => (best === null || next.pace > best.pace ? next : best), null);
  const credits = availableManualResetCredits(account, now);
  const urgency = (dominant?.pace ?? 0) * (1 + CREDIT_WEIGHT * Math.min(credits, MAX_WEIGHTED_CREDITS));
  const creditNote = credits > 0 ? `, with ${credits} banked manual reset${credits === 1 ? "" : "s"} (save for weekly exhaustion)` : "";

  const free = FREE_PLAN.test(account.plan ?? "");
  const weeklyOnly = windows.length > 0 && !windows.some((entry) => isShort(entry.window, entry.primary));
  const tier: UseTier = free
    ? "free"
    : windows.length === 0 ? "unknown"
    : weeklyOnly && (endingIn === null || endingIn > ENDING_SOON_MS) ? "reserve"
    : "paid";
  const detail = dominant ? `${dominant.text}${creditNote}` : null;
  const reason = tier === "free"
    ? `Free plan, spent first for the models it has${detail ? `: ${detail}` : ""}`
    : tier === "reserve"
      ? `Only a weekly limit, so it is kept in reserve${detail ? `: ${detail}` : ""}`
      : tier === "unknown"
        ? "Can serve, but reports no usage yet"
        : detail ? `${detail.charAt(0).toUpperCase()}${detail.slice(1)}` : `${percent(room)} left, nothing resets soon`;
  return { account, tier, urgency, room, reason };
}

/** The suggested spending order for the accounts that can serve now. */
export function planAccountUse(snapshot: ProviderStatusSnapshot, now: number): UsePlanEntry[] {
  if (!snapshot.reachable || snapshot.freshness !== "fresh") return [];
  return snapshot.accounts
    .map((account) => candidate(account, now))
    .filter((entry): entry is Candidate => entry !== null)
    .sort((left, right) => TIER_ORDER[left.tier] - TIER_ORDER[right.tier]
      || right.urgency - left.urgency
      || right.room - left.room
      || (left.account.accountAlias ?? "").localeCompare(right.account.accountAlias ?? ""))
    .map((entry, index) => ({
      accountAlias: entry.account.accountAlias,
      rank: index + 1,
      tier: entry.tier,
      urgency: Math.round(entry.urgency * 100) / 100,
      reason: entry.reason,
    }));
}
