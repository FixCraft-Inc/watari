/** Observed web submissions are evidence, never a subscription quota estimate. */
import type { JsonReader, ProviderAccountStatus, ProviderStatusSnapshot, StatusAdapterOptions } from "./provider-status.ts";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid status object");
  return value as Record<string, unknown>;
}
function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("invalid status count");
  return value;
}
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const OUTCOMES = new Set(["submitted", "success", "quota", "auth", "rejected", "uncertain"]);

export async function readGeminiWebStatus(
  baseUrl: string, readJson: JsonReader, options: StatusAdapterOptions = {},
): Promise<ProviderStatusSnapshot> {
  const now = (options.now ?? Date.now)();
  const base = {
    provider: "gemini-web", source: "gemini-web", currentRoute: null, sessionPins: [],
    allEligibleUnavailable: null, capacity: "unknown",
  } as const;
  try {
    const root = object(await readJson(new URL("/local/status", baseUrl).toString(), options.signal));
    const observedAt = count(root.observed_at);
    if (root.schema !== "gemini-web.status/1" || root.remaining !== null || root.limit_scope !== "unknown"
      || !["connected", "sign_in_required", "session_unavailable"].includes(String(root.state))) throw new Error("invalid status schema");
    if (observedAt > now + 30_000 || now - observedAt > (options.staleAfterMs ?? 300_000)) throw new Error("stale status");
    if (!Array.isArray(root.models) || root.models.length > 128
      || root.models.some((model) => typeof model !== "string" || !MODEL.test(model))) throw new Error("invalid models");
    const observations = object(root.observations);
    if (observations.schema !== "gemini-web.observations/1") throw new Error("invalid observations");
    const entries = Object.entries(object(observations.buckets));
    if (entries.length > 64) throw new Error("too many observation scopes");
    const observedUsage = entries.map(([scope, raw]) => {
      const bucket = object(raw);
      if (typeof bucket.model !== "string" || !MODEL.test(bucket.model)
        || !["chat", "image", "video"].includes(String(bucket.kind))
        || scope !== `${bucket.kind}:${bucket.model}` || !OUTCOMES.has(String(bucket.last_outcome))) throw new Error("invalid scope");
      const attempts = count(bucket.attempts), succeeded = count(bucket.succeeded), failed = count(bucket.failed);
      if (succeeded > attempts || failed > attempts - succeeded) throw new Error("invalid counters");
      return { model: bucket.model, kind: String(bucket.kind), attempts, succeeded, failed,
        lastOutcome: String(bucket.last_outcome), lastObservedAt: count(bucket.last_observed_at), retryAt: count(bucket.retry_at) || null };
    }).sort((left, right) => `${left.model}:${left.kind}`.localeCompare(`${right.model}:${right.kind}`));
    let active = false;
    if (observations.active !== null) {
      const submission = object(observations.active);
      if (typeof submission.id !== "string" || !/^[a-f0-9]{32}$/u.test(submission.id)
        || typeof submission.bucket !== "string" || !Object.hasOwn(object(observations.buckets), submission.bucket)) throw new Error("invalid active submission");
      count(submission.started_at);
      active = true;
    }
    const connected = root.state === "connected";
    const limited = observedUsage.some((item) => item.lastOutcome === "quota" && (item.retryAt === null || item.retryAt > now));
    const account: ProviderAccountStatus = {
      provider: "gemini-web", source: "gemini-web", accountId: "generation-account", accountAlias: "generation-account",
      displayName: "Separate Gemini web account", plan: null, tier: null,
      eligible: connected && !active ? null : false,
      status: active ? "submission active or uncertain" : connected ? "connected; allowance unknown" : "login required",
      eligibilityReason: active ? "A submission is active or needs reconciliation. Remaining allowance is unknown."
        : !connected ? "Sign in privately with gemini-web-account login."
        : limited ? "A model/operation reported a limit. Its account-wide scope and remaining allowance are unknown."
        : "Connected. Google does not report remaining web allowance through this bridge.",
      remedy: !connected ? "gemini-web-account login" : active ? "Check Gemini and reconcile the submission before generating again." : null,
      preferred: null, preference: null, priority: null, primary: null, secondary: null, billing: null,
      resetCredits: null, resetCreditsExpireAt: null, resetCreditsFreshness: "unknown", models: root.models as string[],
      lastObservedAt: observedAt, freshness: "fresh", route: null, activeSessions: active ? 1 : 0, confidence: "observed", observedUsage,
    };
    return { ...base, reachable: true, observedAt, freshness: "fresh", accounts: [account], error: null };
  } catch {
    // Do not propagate arbitrary provider response/error text into the dashboard.
    return { ...base, reachable: false, observedAt: null, freshness: "unknown", accounts: [], error: "Gemini web status unavailable or invalid; check the bridge and SSH tunnel." };
  }
}
