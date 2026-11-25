/**
 * Provider status is deliberately a read-only, credential-free boundary.
 *
 * The callbacks used by the HTTP adapters may be backed by an authenticated
 * client owned by CodexLB or TeamClaude, but Watari never receives or stores
 * the credential itself. Unknown and stale observations stay unknown to the
 * capacity evaluator, so an incomplete status response cannot drain a provider.
 *
 * Observation times matter. A quota value only proves exhaustion when the
 * provider says when it sampled it. A value without a provider sample time is
 * kept as `derived` evidence: good enough to show and to warn about, never
 * enough to claim that every account is drained.
 */

import { redactSecrets, stripTerminalControl } from "./security/redaction.ts";

export type ProviderId = "codex" | "claude" | "watari" | (string & {});
export type StatusSource = "codexlb" | "teamclaude" | "watari" | (string & {});
export type Freshness = "fresh" | "stale" | "unknown";
export type Confidence = "observed" | "derived" | "unknown";
export type CapacityState = "healthy" | "limited" | "nearly_exhausted" | "unavailable" | "unknown";

export interface QuotaWindow {
  /** Percent already used, or null when the provider did not report it. */
  readonly usedPercent: number | null;
  /** Percent remaining, or null when the provider did not report it. */
  readonly remainingPercent: number | null;
  readonly resetAt: number | null;
  /** Window length as the provider reports it (300 is five hours, 10080 a week). */
  readonly windowMinutes: number | null;
  /** The provider's own sample time, or the read time when it reported none. */
  readonly observedAt: number | null;
  readonly freshness: Freshness;
  readonly source: StatusSource;
  /**
   * `observed`: the provider reported the sample time. `derived`: the value is
   * the provider's current belief but its sample time is the read time.
   */
  readonly confidence: Confidence;
}

export interface BillingStatus {
  /** Only populated when the provider explicitly supplies a billing date. */
  readonly nextBillingAt: number | null;
  readonly renewalAt: number | null;
  readonly detail: string | null;
  /**
   * When the subscription is paid through, as the provider's own account data
   * states it (CodexLB reads OpenAI's id token claim). Usually the next bill
   * date when the plan renews. Null when not reported.
   */
  readonly paidThroughAt: number | null;
  /** When the current paid period began, as the provider states it. */
  readonly periodStartAt: number | null;
  /**
   * When the provider last checked that date. A passed date checked before it
   * passed is stale data, not proof that the subscription ended.
   */
  readonly paidThroughCheckedAt: number | null;
  /** Provider-reported credit balance, or null when not reported. */
  readonly creditBalance: number | null;
  readonly creditsUnlimited: boolean | null;
  /** True while the provider says the account is billing past included quota. */
  readonly extraUsageActive: boolean | null;
  readonly source: StatusSource;
}

export interface ProviderRoute {
  readonly accountAlias: string | null;
  readonly sessionId: string | null;
  readonly source: StatusSource;
  readonly confidence: Confidence;
}

/** A provider-owned binding of one conversation to one account. */
export interface SessionPin {
  /** As the provider reports it. Providers may shorten the id. */
  readonly sessionId: string;
  readonly accountAlias: string | null;
  readonly since: number | null;
  readonly lastUsedAt: number | null;
  readonly source: StatusSource;
}

export interface ObservedProviderUsage {
  readonly model: string;
  readonly kind: string;
  readonly attempts: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly lastOutcome: string;
  readonly lastObservedAt: number;
  /** An explicit Retry-After, not a quota reset. */
  readonly retryAt: number | null;
}

export interface ProviderAccountStatus {
  readonly observedUsage?: readonly ObservedProviderUsage[];
  readonly provider: ProviderId;
  /** The provider's own key for this account, as its control API expects it. */
  readonly accountId: string | null;
  readonly accountAlias: string | null;
  readonly displayName: string | null;
  readonly plan: string | null;
  readonly tier: string | null;
  /** null means the provider did not say whether the account can serve. */
  readonly eligible: boolean | null;
  readonly status: string | null;
  /** Explicit provider preference only, null when the provider did not say. */
  readonly preferred: boolean | null;
  /** Provider routing policy/name, kept opaque to Watari. */
  readonly preference: string | null;
  readonly priority: number | null;
  readonly eligibilityReason: string | null;
  /** The provider's own suggested fix for an unavailable account, if it gave one. */
  readonly remedy: string | null;
  readonly primary: QuotaWindow | null;
  readonly secondary: QuotaWindow | null;
  readonly billing: BillingStatus | null;
  /** Banked manual usage resets the provider reports, or null when not reported. */
  readonly resetCredits: number | null;
  readonly resetCreditsExpireAt: number | null;
  /** Age of the provider's credit sample, separate from the live routing row. */
  readonly resetCreditsFreshness: Freshness;
  /** Models the provider would route this account for, or null when not reported. */
  readonly models: readonly string[] | null;
  /** When this account row was observed (the provider's live status read). */
  readonly lastObservedAt: number | null;
  readonly freshness: Freshness;
  readonly route: ProviderRoute | null;
  readonly activeSessions: number | null;
  readonly source: StatusSource;
  readonly confidence: Confidence;
}

export interface ProviderStatusSnapshot {
  readonly provider: ProviderId;
  readonly source: StatusSource;
  readonly observedAt: number | null;
  readonly freshness: Freshness;
  readonly reachable: boolean;
  readonly accounts: readonly ProviderAccountStatus[];
  readonly currentRoute: ProviderRoute | null;
  readonly sessionPins: readonly SessionPin[];
  /** null means there is not enough fresh eligibility evidence to decide. */
  readonly allEligibleUnavailable: boolean | null;
  readonly capacity: CapacityState;
  readonly error: string | null;
}

/** A status endpoint answered with a non-success HTTP status. */
export class StatusHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "StatusHttpError";
  }
}

export interface JsonReader {
  /** The implementation may authenticate this request. It must not expose how. */
  (url: string, signal?: AbortSignal): Promise<unknown>;
}

export interface StatusAdapterOptions {
  readonly now?: () => number;
  readonly staleAfterMs?: number;
  readonly signal?: AbortSignal;
}

const DEFAULT_STALE_AFTER_MS = 5 * 60_000;
const MAX_STATUS_ACCOUNTS = 256;
const MAX_SESSION_PINS = 256;
const MAX_STATUS_TEXT = 1_024;
/** A positive balance is still capacity, however small. */
export const DRAINED_REMAINING_PERCENT = 0;
const NEARLY_EXHAUSTED_REMAINING_PERCENT = 1;
/** At or below this remaining percentage a window is advisory. */
export const ADVISORY_REMAINING_PERCENT = 10;

function safeError(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return (stripTerminalControl(redactSecrets(message)).slice(0, MAX_STATUS_TEXT) || fallback);
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = stripTerminalControl(value).trim();
  return trimmed ? trimmed.slice(0, MAX_STATUS_TEXT) : null;
}

function first(recordValue: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (recordValue[key] !== undefined) return recordValue[key];
  }
  return undefined;
}

function numberFrom(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER ? value : null;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && Math.abs(parsed) <= Number.MAX_SAFE_INTEGER ? parsed : null;
  }
  return null;
}

function bool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function count(value: unknown): number | null {
  const parsed = numberFrom(value);
  return parsed !== null && Number.isInteger(parsed) && parsed >= 0 && parsed <= 1_000_000 ? parsed : null;
}

function preference(value: Record<string, unknown>): {
  readonly preferred: boolean | null;
  readonly preference: string | null;
  readonly priority: number | null;
} {
  const priorityValue = numberFrom(first(value, ["priority", "rank"]));
  return {
    preferred: bool(first(value, ["preferred", "isPreferred", "is_preferred"])),
    preference: text(first(value, ["preference", "routingPolicy", "routing_policy", "distribution"])),
    priority: priorityValue !== null && Math.abs(priorityValue) <= 1_000_000 ? priorityValue : null,
  };
}

function timestamp(value: unknown): number | null {
  const number = numberFrom(value);
  if (number !== null) {
    // TeamClaude uses epoch milliseconds. Epoch seconds from other providers
    // are tolerated without turning an invalid date into a fabricated reset.
    if (number <= 0) return null;
    return number < 100_000_000_000 ? number * 1_000 : number;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

function clampPercent(value: number | null): number | null {
  return value === null ? null : Math.max(0, Math.min(100, value));
}

function freshness(observedAt: number | null, now: number, staleAfterMs: number): Freshness {
  if (observedAt === null) return "unknown";
  return now - observedAt <= staleAfterMs ? "fresh" : "stale";
}

interface RawWindow {
  /** Percent used (0–100). */
  readonly used?: unknown;
  /** Percent remaining (0–100). */
  readonly remaining?: unknown;
  /** Fraction used (0–1), as TeamClaude reports it. */
  readonly utilization?: unknown;
  readonly resetAt?: unknown;
  readonly windowMinutes?: unknown;
  /** Provider sample time only. Never the read time. */
  readonly sampledAt?: unknown;
}

function windowFrom(source: StatusSource, raw: RawWindow, now: number, staleAfterMs: number): QuotaWindow | null {
  let used = numberFrom(raw.used);
  let remaining = numberFrom(raw.remaining);
  const utilization = numberFrom(raw.utilization);
  if (utilization !== null) {
    // TeamClaude always reports a fraction, including overshoot above 1.
    used = utilization * 100;
    remaining = null;
  }
  used = clampPercent(used);
  remaining = clampPercent(remaining ?? (used === null ? null : 100 - used));
  if (used === null && remaining !== null) used = 100 - remaining;
  const sampledAt = timestamp(raw.sampledAt);
  const resetAt = timestamp(raw.resetAt);
  if (used === null && remaining === null && resetAt === null) return null;
  const observedAt = sampledAt ?? now;
  // A window whose reset already passed describes a finished window. Its
  // percentage says nothing about the window that is running now.
  const windowFreshness = resetAt !== null && resetAt <= now ? "stale" : freshness(observedAt, now, staleAfterMs);
  return {
    usedPercent: used,
    remainingPercent: remaining,
    resetAt,
    windowMinutes: count(raw.windowMinutes) || null,
    observedAt,
    freshness: windowFreshness,
    source,
    confidence: used === null ? "unknown" : sampledAt !== null ? "observed" : "derived",
  };
}

function billingFrom(
  source: StatusSource,
  fields: {
    readonly nextBillingAt?: unknown;
    readonly renewalAt?: unknown;
    readonly detail?: unknown;
    readonly paidThroughAt?: unknown;
    readonly periodStartAt?: unknown;
    readonly paidThroughCheckedAt?: unknown;
    readonly creditBalance?: unknown;
    readonly creditsUnlimited?: unknown;
    readonly extraUsageActive?: unknown;
  },
): BillingStatus | null {
  const billing: BillingStatus = {
    nextBillingAt: timestamp(fields.nextBillingAt),
    renewalAt: timestamp(fields.renewalAt),
    detail: text(fields.detail),
    paidThroughAt: timestamp(fields.paidThroughAt),
    periodStartAt: timestamp(fields.periodStartAt),
    paidThroughCheckedAt: timestamp(fields.paidThroughCheckedAt),
    creditBalance: numberFrom(fields.creditBalance),
    creditsUnlimited: bool(fields.creditsUnlimited),
    extraUsageActive: bool(fields.extraUsageActive),
    source,
  };
  const { source: _source, ...values } = billing;
  return Object.values(values).every((value) => value === null) ? null : billing;
}

function eligibilityFromStatus(status: string | null): boolean | null {
  const value = status?.toLowerCase() ?? null;
  if (!value) return null;
  if (["active", "ready", "available", "healthy", "allowed"].includes(value)) return true;
  if ([
    "disabled", "paused", "blocked", "error", "failed", "exhausted", "unavailable", "rate_limited",
    "quota_exceeded", "reauth_required", "deactivated", "cordoned", "throttled",
  ].includes(value)) return false;
  return null;
}

function route(source: StatusSource, accountAlias: string | null, raw: unknown): ProviderRoute | null {
  const value = record(raw);
  const sessionId = text(value ? first(value, ["sessionId", "session_id", "conversationId", "conversation_id"]) : undefined);
  if (accountAlias === null && sessionId === null) return null;
  return { accountAlias, sessionId, source, confidence: "observed" };
}

function isDrained(window: QuotaWindow): boolean {
  return window.remainingPercent !== null && window.remainingPercent <= DRAINED_REMAINING_PERCENT;
}

function windowsOf(account: ProviderAccountStatus): QuotaWindow[] {
  return [account.primary, account.secondary].filter((window): window is QuotaWindow => window !== null);
}

/**
 * Pool capacity, judged by the best account the provider can still route to.
 *
 * CodexLB and TeamClaude move work off a spent account themselves, so one
 * account near its limit says nothing about the pool while a sibling has room.
 * The tightest fresh window of each eligible account is its headroom, and the
 * largest headroom decides. An eligible account with no known window could
 * have room, so it keeps a low pool `unknown` rather than `limited`. Every
 * account must be freshly and explicitly ineligible for `unavailable`.
 */
function capacity(accounts: readonly ProviderAccountStatus[], reachable: boolean): CapacityState {
  if (!reachable || accounts.length === 0) return "unknown";
  const eligible = accounts.filter((account) => account.freshness === "fresh" && account.eligible === true);
  if (eligible.length === 0) {
    return accounts.every((account) => account.freshness === "fresh" && account.eligible === false)
      ? "unavailable"
      : "unknown";
  }
  let best: number | null = null;
  let someUnknown = false;
  for (const account of eligible) {
    const known = windowsOf(account)
      .filter((window) => window.freshness === "fresh" && window.remainingPercent !== null)
      .map((window) => window.remainingPercent as number);
    if (known.length === 0) {
      someUnknown = true;
      continue;
    }
    const headroom = Math.min(...known);
    best = best === null ? headroom : Math.max(best, headroom);
  }
  if (best !== null && best > ADVISORY_REMAINING_PERCENT) return "healthy";
  if (best === null || someUnknown) return "unknown";
  return best <= NEARLY_EXHAUSTED_REMAINING_PERCENT ? "nearly_exhausted" : "limited";
}

/**
 * `true` only with fresh evidence for every account: each is explicitly
 * ineligible, or eligible with a provider-sampled window at or below the
 * drained threshold. One account with fresh usable capacity proves `false`.
 * Anything else is `null`.
 */
function allEligibleUnavailable(accounts: readonly ProviderAccountStatus[]): boolean | null {
  if (accounts.length === 0) return null;
  let unknown = false;
  for (const account of accounts) {
    if (account.freshness !== "fresh") {
      unknown = true;
      continue;
    }
    if (account.eligible === false) continue;
    if (account.eligible !== true) {
      unknown = true;
      continue;
    }
    const windows = windowsOf(account).filter((window) => window.freshness === "fresh");
    if (windows.some((window) => window.confidence === "observed" && isDrained(window))) continue;
    const allKnown = windows.length > 0 && windows.length === windowsOf(account).length
      && windows.every((window) => window.remainingPercent !== null);
    if (allKnown && !windows.some(isDrained)) return false;
    unknown = true;
  }
  return unknown ? null : true;
}

function snapshot(
  provider: ProviderId,
  source: StatusSource,
  accounts: readonly ProviderAccountStatus[],
  currentRoute: ProviderRoute | null,
  sessionPins: readonly SessionPin[],
  now: number,
  staleAfterMs: number,
  reachable: boolean,
  error: string | null,
): ProviderStatusSnapshot {
  const observed = accounts.map((account) => account.lastObservedAt).filter((value): value is number => value !== null);
  const observedAt = observed.length > 0 ? Math.max(...observed) : reachable ? now : null;
  return {
    provider,
    source,
    observedAt,
    freshness: observedAt === null ? "unknown" : freshness(observedAt, now, staleAfterMs),
    reachable,
    accounts,
    currentRoute,
    sessionPins,
    allEligibleUnavailable: reachable ? allEligibleUnavailable(accounts) : null,
    capacity: capacity(accounts, reachable),
    error,
  };
}

function unreachable(provider: ProviderId, source: StatusSource, now: number, staleAfterMs: number, error: string): ProviderStatusSnapshot {
  return snapshot(provider, source, [], null, [], now, staleAfterMs, false, error);
}

interface AccountFields {
  readonly accountId?: unknown;
  readonly accountAlias: unknown;
  readonly displayName: unknown;
  readonly plan: unknown;
  readonly tier: unknown;
  readonly status: unknown;
  readonly eligible: boolean | null;
  readonly eligibilityReason: unknown;
  readonly remedy?: unknown;
  readonly preferenceFrom: Record<string, unknown>;
  readonly primary: RawWindow | null;
  readonly secondary: RawWindow | null;
  readonly billing: BillingStatus | null;
  readonly activeSessions: unknown;
  readonly resetCredits?: unknown;
  readonly resetCreditsExpireAt?: unknown;
  readonly resetCreditsSampledAt?: unknown;
  readonly models?: unknown;
}

function account(
  provider: ProviderId,
  source: StatusSource,
  fields: AccountFields,
  observedAt: number,
  staleAfterMs: number,
): ProviderAccountStatus {
  const accountAlias = text(fields.accountAlias);
  const primary = fields.primary ? windowFrom(source, fields.primary, observedAt, staleAfterMs) : null;
  const secondary = fields.secondary ? windowFrom(source, fields.secondary, observedAt, staleAfterMs) : null;
  return {
    provider,
    accountId: text(fields.accountId) ?? accountAlias,
    accountAlias,
    displayName: text(fields.displayName),
    plan: text(fields.plan),
    tier: text(fields.tier),
    eligible: fields.eligible,
    status: text(fields.status),
    ...preference(fields.preferenceFrom),
    eligibilityReason: text(fields.eligibilityReason),
    remedy: text(fields.remedy),
    primary,
    secondary,
    billing: fields.billing,
    resetCredits: count(fields.resetCredits),
    resetCreditsExpireAt: timestamp(fields.resetCreditsExpireAt),
    resetCreditsFreshness: freshness(timestamp(fields.resetCreditsSampledAt === undefined
      ? observedAt : fields.resetCreditsSampledAt), observedAt, staleAfterMs),
    models: Array.isArray(fields.models)
      ? fields.models.filter((model): model is string => typeof model === "string" && model.length <= 200).slice(0, 200)
      : null,
    // The status endpoints report live routing state, so the row is observed
    // at read time. Quota windows carry their own sample times above.
    lastObservedAt: observedAt,
    freshness: "fresh",
    route: null,
    activeSessions: count(fields.activeSessions),
    source,
    confidence: accountAlias || primary || secondary ? "observed" : "unknown",
  };
}

function adapterOptions(options: StatusAdapterOptions): { readonly now: () => number; readonly staleAfterMs: number } {
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  if (!Number.isFinite(staleAfterMs) || staleAfterMs <= 0) throw new Error("staleAfterMs must be positive and finite");
  return { now: options.now ?? (() => Date.now()), staleAfterMs };
}

/** CodexLB serializes its dashboard models in camelCase. snake_case is accepted too. */
function pick(value: Record<string, unknown>, camel: string, snake: string): unknown {
  return value[camel] !== undefined ? value[camel] : value[snake];
}

/** One row of CodexLB's `GET /api/provider-status` projection. */
function codexAccountFromProjection(value: Record<string, unknown>, observedAt: number, staleAfterMs: number): ProviderAccountStatus {
  const status = text(value["status"]);
  const eligible = typeof value["eligible"] === "boolean" ? value["eligible"] : eligibilityFromStatus(status);
  const sampledAt = value["usageSampledAt"] ?? null;
  const windowOf = (raw: unknown): RawWindow | null => {
    const window = record(raw);
    return window
      ? { remaining: window["remainingPercent"], resetAt: window["resetAt"], windowMinutes: window["windowMinutes"], sampledAt }
      : null;
  };
  const credits = record(value["credits"]) ?? {};
  const subscription = record(value["subscription"]) ?? {};
  const resets = record(value["resetCredits"]);
  return account("codex", "codexlb", {
    accountId: value["accountId"],
    accountAlias: text(value["alias"]) ?? value["accountId"],
    displayName: value["displayName"],
    plan: value["planType"],
    tier: value["seatType"],
    status,
    eligible,
    eligibilityReason: eligible === false ? value["eligibilityReason"] ?? status : null,
    preferenceFrom: value,
    primary: windowOf(value["primary"]),
    secondary: windowOf(value["secondary"]),
    billing: billingFrom("codexlb", {
      paidThroughAt: subscription["activeUntil"],
      periodStartAt: subscription["activeStart"],
      paidThroughCheckedAt: subscription["lastChecked"],
      creditBalance: credits["balance"],
      creditsUnlimited: credits["unlimited"],
    }),
    activeSessions: undefined,
    resetCredits: resets?.["available"],
    resetCreditsExpireAt: resets?.["nearestExpiresAt"],
    models: value["models"],
  }, observedAt, staleAfterMs);
}

/**
 * One row of CodexLB's dashboard account list (`GET /api/accounts`), the
 * fallback for a CodexLB without the provider-status route. Its `lastRefreshAt`
 * is the OAuth token refresh time, not a quota sample, so it never stands in
 * for one, and these windows stay `derived` evidence.
 */
function codexAccountFromDashboard(value: Record<string, unknown>, observedAt: number, staleAfterMs: number): ProviderAccountStatus {
  const usage = record(value["usage"]) ?? {};
  const status = text(value["status"]);
  const eligible = eligibilityFromStatus(status);
  const sampledAt = pick(value, "usageRefreshedAt", "usage_refreshed_at") ?? null;
  return account("codex", "codexlb", {
    accountId: pick(value, "accountId", "account_id"),
    accountAlias: text(value["alias"]) ?? pick(value, "accountId", "account_id"),
    displayName: pick(value, "displayName", "display_name") ?? value["email"],
    plan: pick(value, "planType", "plan_type"),
    tier: pick(value, "seatType", "seat_type"),
    status,
    eligible,
    eligibilityReason: eligible === false
      ? text(pick(value, "deactivationReason", "deactivation_reason")) ?? status
      : null,
    preferenceFrom: value,
    primary: {
      remaining: pick(usage, "primaryRemainingPercent", "primary_remaining_percent"),
      resetAt: pick(value, "resetAtPrimary", "reset_at_primary"),
      windowMinutes: pick(value, "windowMinutesPrimary", "window_minutes_primary"),
      sampledAt,
    },
    secondary: {
      remaining: pick(usage, "secondaryRemainingPercent", "secondary_remaining_percent"),
      resetAt: pick(value, "resetAtSecondary", "reset_at_secondary"),
      windowMinutes: pick(value, "windowMinutesSecondary", "window_minutes_secondary"),
      sampledAt,
    },
    billing: billingFrom("codexlb", {
      creditBalance: pick(value, "creditsBalance", "credits_balance"),
      creditsUnlimited: pick(value, "creditsUnlimited", "credits_unlimited"),
    }),
    activeSessions: undefined,
  }, observedAt, staleAfterMs);
}

/**
 * Read CodexLB through a caller-owned transport.
 *
 * `GET /api/provider-status` is CodexLB's credential-free projection, with the
 * usage sample time and the subscription paid-through date. A CodexLB that
 * predates it answers 404, and the reader then falls back to the dashboard
 * account list, whose quota windows can warn but never prove exhaustion.
 */
export async function readCodexLbStatus(
  baseUrl: string,
  readJson: JsonReader,
  options: StatusAdapterOptions = {},
): Promise<ProviderStatusSnapshot> {
  const { now, staleAfterMs } = adapterOptions(options);
  const observedAt = now();
  try {
    let root: Record<string, unknown> | null;
    let projection = true;
    try {
      root = record(await readJson(new URL("/api/provider-status", baseUrl).toString(), options.signal));
    } catch (error) {
      if (!(error instanceof StatusHttpError && error.status === 404)) throw error;
      projection = false;
      root = record(await readJson(new URL("/api/accounts", baseUrl).toString(), options.signal));
    }
    const rows = root?.["accounts"];
    if (!Array.isArray(rows)) throw new Error("CodexLB status response has no account list");
    const accounts = rows.slice(0, MAX_STATUS_ACCOUNTS).map((row) => projection
      ? codexAccountFromProjection(record(row) ?? {}, observedAt, staleAfterMs)
      : codexAccountFromDashboard(record(row) ?? {}, observedAt, staleAfterMs));
    const current = text(first(root ?? {}, ["currentAccount", "current_account"]));
    return snapshot("codex", "codexlb", accounts, route("codexlb", current, root?.["currentRoute"]), [], observedAt, staleAfterMs, true, null);
  } catch (error) {
    return unreachable("codex", "codexlb", observedAt, staleAfterMs, safeError(error, "CodexLB status unavailable"));
  }
}

const TEAMCLAUDE_CLAUDE_PROVIDER = "anthropic";

/**
 * Read TeamClaude's `GET /teamclaude/status`.
 *
 * TeamClaude can also pool ChatGPT/Codex accounts. CodexLB owns those, so only
 * Anthropic rows are read here. `unavailable: null` is TeamClaude's explicit
 * "this account can serve", and a reason string is explicit ineligibility.
 */
export async function readTeamClaudeStatus(
  baseUrl: string,
  readJson: JsonReader,
  options: StatusAdapterOptions = {},
): Promise<ProviderStatusSnapshot> {
  const { now, staleAfterMs } = adapterOptions(options);
  const observedAt = now();
  try {
    const root = record(await readJson(new URL("/teamclaude/status", baseUrl).toString(), options.signal));
    const rows = root?.["accounts"];
    if (!Array.isArray(rows)) throw new Error("TeamClaude status response has no account list");
    const claudeRows = rows.map((row) => record(row) ?? {})
      .filter((value) => value["provider"] === undefined || value["provider"] === null || value["provider"] === TEAMCLAUDE_CLAUDE_PROVIDER)
      .slice(0, MAX_STATUS_ACCOUNTS);
    const accounts = claudeRows.map((value) => {
      const quota = record(value["quota"]) ?? {};
      const resets = record(quota["resetCredits"]);
      const disabled = value["disabled"] === true;
      const cordoned = value["cordoned"] === true;
      const hasVerdict = Object.hasOwn(value, "unavailable");
      const verdict = value["unavailable"];
      const eligible = disabled || cordoned
        ? false
        : hasVerdict
          ? verdict === null || verdict === false
          : eligibilityFromStatus(text(value["status"]));
      // An account in `error` carries TeamClaude's own code and remedy, such as
      // refresh_rejected and `teamclaude login`.
      const problem = record(value["errorReason"]);
      const problemCode = text(problem?.["code"])?.replaceAll("_", " ") ?? null;
      const reason = disabled ? "disabled"
        : cordoned ? "cordoned"
        : verdict === "error" && problemCode ? problemCode
        : typeof verdict === "string" ? verdict
        : text(record(verdict)?.["reason"]);
      const window = (key: "unified5h" | "unified7d"): RawWindow | null =>
        quota[key] === undefined || quota[key] === null ? null : {
          utilization: quota[key],
          resetAt: quota[`${key}Reset`],
          windowMinutes: key === "unified5h" ? 300 : 10_080,
          sampledAt: quota[`${key}SeenAt`] ?? null,
        };
      return account("claude", "teamclaude", {
        accountAlias: value["name"],
        displayName: first(value, ["displayName", "label", "name"]),
        plan: first(value, ["plan", "organizationType"]),
        tier: first(value, ["tier", "rateLimitTier"]),
        status: value["status"],
        eligible,
        eligibilityReason: eligible === false ? reason ?? text(value["status"]) : null,
        remedy: eligible === false ? problem?.["remedy"] : null,
        preferenceFrom: value,
        primary: window("unified5h"),
        secondary: window("unified7d"),
        billing: billingFrom("teamclaude", {
          extraUsageActive: value["onExtraUsage"],
          detail: value["onExtraUsage"] === true ? "serving on extra usage, billed past included quota" : undefined,
        }),
        activeSessions: value["sessions"],
        resetCredits: resets?.["available"],
        resetCreditsExpireAt: resets?.["expiresAt"],
        resetCreditsSampledAt: resets?.["seenAt"] ?? null,
      }, observedAt, staleAfterMs);
    });
    const defaultTargets = record(root?.["defaultTargets"]);
    const currentAccounts = record(root?.["currentAccounts"]);
    const current = text(defaultTargets?.[TEAMCLAUDE_CLAUDE_PROVIDER])
      ?? text(currentAccounts?.[TEAMCLAUDE_CLAUDE_PROVIDER])
      ?? text(root?.["currentAccount"]);
    const pins = Array.isArray(root?.["sessionPins"]) ? (root["sessionPins"] as unknown[]) : [];
    const sessionPins = pins.slice(0, MAX_SESSION_PINS).flatMap((raw): SessionPin[] => {
      const pin = record(raw);
      const sessionId = text(pin ? first(pin, ["id", "session"]) : undefined);
      if (!pin || !sessionId) return [];
      return [{
        sessionId,
        accountAlias: text(pin["account"]),
        since: timestamp(pin["since"]),
        lastUsedAt: timestamp(pin["lastUsed"]),
        source: "teamclaude",
      }];
    });
    return snapshot(
      "claude",
      "teamclaude",
      accounts,
      route("teamclaude", current, root?.["currentRoute"] ?? root?.["route"]),
      sessionPins,
      observedAt,
      staleAfterMs,
      true,
      null,
    );
  } catch (error) {
    return unreachable("claude", "teamclaude", observedAt, staleAfterMs, safeError(error, "TeamClaude status unavailable"));
  }
}

/** Convert Watari's own live agent snapshot into the same read-only shape. */
export function watariStatusSnapshot(
  agents: readonly {
    readonly id: string;
    readonly displayName: string;
    readonly provider?: string;
    readonly model?: string | null;
    readonly effort?: string | null;
    readonly sessionId: string | null;
    readonly state: string;
    readonly updatedAt: number;
  }[],
  options: StatusAdapterOptions = {},
): ProviderStatusSnapshot {
  const { now, staleAfterMs } = adapterOptions(options);
  const observedAt = now();
  const accounts = agents.map((agent): ProviderAccountStatus => ({
    provider: "watari",
    accountId: agent.id,
    accountAlias: agent.id,
    displayName: agent.displayName,
    plan: null,
    tier: null,
    eligible: !["failed", "stopped"].includes(agent.state),
    status: agent.state,
    preferred: null,
    preference: null,
    priority: null,
    eligibilityReason: null,
    remedy: null,
    primary: null,
    secondary: null,
    billing: null,
    resetCredits: null,
    resetCreditsExpireAt: null,
    resetCreditsFreshness: "unknown",
    models: null,
    lastObservedAt: agent.updatedAt,
    freshness: freshness(agent.updatedAt, observedAt, staleAfterMs),
    route: route("watari", agent.id, { sessionId: agent.sessionId }),
    activeSessions: agent.state === "busy" ? 1 : 0,
    source: "watari",
    confidence: "observed",
  }));
  return snapshot("watari", "watari", accounts, null, [], observedAt, staleAfterMs, true, null);
}

/** Mark an observation unusable after a failed or overdue refresh. */
export function staleProviderStatus(
  status: ProviderStatusSnapshot,
  error: string | null = null,
  reachable = status.reachable,
): ProviderStatusSnapshot {
  const staleWindow = (window: QuotaWindow | null): QuotaWindow | null =>
    window ? { ...window, freshness: "stale" } : null;
  return {
    ...status,
    reachable,
    freshness: status.observedAt === null ? "unknown" : "stale",
    allEligibleUnavailable: null,
    capacity: "unknown",
    error,
    accounts: status.accounts.map((account) => ({
      ...account,
      freshness: "stale" as const,
      primary: staleWindow(account.primary),
      secondary: staleWindow(account.secondary),
    })),
  };
}

/**
 * A small cache for polling consumers. A read older than the stale window is
 * returned stale, so an old observation cannot become “all exhausted”.
 */
export class ProviderStatusCache {
  readonly #snapshots = new Map<ProviderId, ProviderStatusSnapshot>();
  readonly #staleAfterMs: number;

  constructor(staleAfterMs = DEFAULT_STALE_AFTER_MS) {
    if (!Number.isFinite(staleAfterMs) || staleAfterMs <= 0) throw new Error("staleAfterMs must be positive and finite");
    this.#staleAfterMs = staleAfterMs;
  }

  put(snapshotValue: ProviderStatusSnapshot): void {
    this.#snapshots.set(snapshotValue.provider, snapshotValue);
  }

  get(provider: ProviderId, now = Date.now()): ProviderStatusSnapshot | null {
    const value = this.#snapshots.get(provider);
    if (!value) return null;
    const observedAt = value.observedAt;
    const isStale = observedAt === null || now - observedAt > this.#staleAfterMs;
    return isStale ? staleProviderStatus(value, value.error) : value;
  }
}

export type CapacityNoticeKind = "advisory" | "checkpoint";

/** Ineligibility reasons that mean spent quota, as CodexLB and TeamClaude word them. */
const QUOTA_REASON = /quota|rate[_ -]?limit|throttl|capped|exhaust|usage[_ -]?limit/iu;

/**
 * Whether this account is out of quota on fresh evidence: ineligible for a
 * quota reason, or eligible with a provider-sampled window at its limit. An
 * account that needs a new login, is disabled, or failed is unavailable but
 * not drained.
 */
export function accountQuotaDrained(account: ProviderAccountStatus): boolean {
  if (account.freshness !== "fresh") return false;
  if (account.eligible === false) return QUOTA_REASON.test(`${account.eligibilityReason ?? ""} ${account.status ?? ""}`);
  if (account.eligible !== true) return false;
  return windowsOf(account).some((window) => window.freshness === "fresh" && window.confidence === "observed" && isDrained(window));
}

/** Fresh banked credits on an otherwise operable account, without spending them. */
export function availableManualResetCredits(account: ProviderAccountStatus, now: number): number {
  if (account.freshness !== "fresh" || account.resetCreditsFreshness !== "fresh"
    || (account.resetCreditsExpireAt !== null && account.resetCreditsExpireAt <= now)
    || (account.eligible !== true && !accountQuotaDrained(account))) return 0;
  // A credit cannot repair a disabled account or broken authentication, even
  // when the provider also mentions a quota limit in its reason.
  if (/disabled|paused|cordoned|deactivated|reauth|auth|login|error|failed|blocked|billing|refresh/iu
    .test(`${account.status ?? ""} ${account.eligibilityReason ?? ""}`)) return 0;
  return Math.max(0, account.resetCredits ?? 0);
}

function canResetExhaustedWeek(account: ProviderAccountStatus, now: number): boolean {
  return availableManualResetCredits(account, now) > 0 && windowsOf(account).some((window) =>
    window.windowMinutes === 10_080 && window.freshness === "fresh" && window.confidence === "observed" && isDrained(window)
  );
}

/**
 * Which notice a fresh provider observation warrants, if any.
 *
 * Both are about the pool. While any account the provider can route to has
 * more than 10% left there is no notice at all. `advisory` means every such
 * account is at 90% or more. `checkpoint` needs fresh proof that none of them
 * can serve, that spent quota is part of why, and that no account has a banked
 * manual reset for freshly observed weekly exhaustion. Credits never imply
 * recovery or authorize spending a reset. Five-hour-only exhaustion still
 * warrants a checkpoint, preserving resets for weekly exhaustion. Stale,
 * unknown or unreachable status gives no notice: an absent reading is not a limit.
 */
export function capacityNoticeKind(status: ProviderStatusSnapshot, now = Date.now()): CapacityNoticeKind | null {
  if (status.freshness !== "fresh" || !status.reachable) return null;
  if (status.allEligibleUnavailable === true) {
    if (status.accounts.some((account) => canResetExhaustedWeek(account, now))) return null;
    // No account can serve. That is a quota checkpoint only when spent quota
    // is part of why. Accounts that all need a new login, or were disabled,
    // are an operator problem for the dashboard, not a reason to stop agents.
    return status.accounts.some(accountQuotaDrained) ? "checkpoint" : null;
  }
  if (status.capacity === "limited" || status.capacity === "nearly_exhausted") return "advisory";
  return null;
}

const PROVIDER_LABELS: Readonly<Record<string, string>> = {
  codex: "Every ChatGPT/Codex account CodexLB can route to",
  claude: "Every Claude account TeamClaude can route to",
};

/** The earliest future reset among the windows that hold the pool back. */
export function earliestPoolReset(status: ProviderStatusSnapshot, now: number): number | null {
  const resets = status.accounts.flatMap((account) => windowsOf(account)
    .filter((window) => window.resetAt !== null && window.resetAt > now
      && (account.eligible === false || (window.remainingPercent !== null && window.remainingPercent <= ADVISORY_REMAINING_PERCENT)))
    .map((window) => window.resetAt as number));
  return resets.length > 0 ? Math.min(...resets) : null;
}

function resetPhrase(resetAt: number | null, now: number): string {
  if (resetAt === null) return "The provider did not report when it resets.";
  const minutes = Math.max(1, Math.round((resetAt - now) / 60_000));
  const span = minutes < 90 ? `${minutes} minutes` : `${Math.round(minutes / 60)} hours`;
  const clock = new Date(resetAt).toISOString().slice(0, 16).replace("T", " ");
  return `The first one resets in about ${span} (${clock} UTC).`;
}

/**
 * The text an agent receives. Short on purpose: it is read by agents mid-task
 * and should cost a few lines of context, once per change of state.
 */
export function capacityNotice(status: ProviderStatusSnapshot, now = Date.now()): string | null {
  const kind = capacityNoticeKind(status, now);
  if (!kind) return null;
  const pool = PROVIDER_LABELS[status.provider] ?? `Every ${status.provider} account the provider can route to`;
  const reset = resetPhrase(earliestPoolReset(status, now), now);
  if (kind === "advisory") {
    return `${pool} is at 90% or more of its current limit. ${reset} ` +
      "Keep going with the current task, but keep turns lean: no broad new work and no long exploratory output. " +
      "Keep team state current (files changed, findings, next step) so the work survives a pause.";
  }
  return `${pool} is out of quota, with no usable manual reset for weekly exhaustion. ${reset} ` +
    "Finish the step you are on and stop at a clean point. Record in team state the files you changed, the tests you ran " +
    "and their results, findings, decisions, open TODOs, and the exact next step, so the work resumes cleanly after the reset. " +
    "Do not start new work until then.";
}
