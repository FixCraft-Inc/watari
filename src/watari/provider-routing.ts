/**
 * Continuation ownership and retry policy over provider status.
 *
 * Watari never picks an account. CodexLB and TeamClaude do. What Watari does
 * decide is whether a turn may go back to the provider unpinned (so the
 * provider can walk its siblings), must go back pinned to the account that owns
 * its continuation state, or should stop at a safe checkpoint. State owned by
 * one account (a previous response id, turn state, a bridge, a file or session
 * pin) never moves to another account unless the caller holds proof that it is
 * account-neutral.
 */

import {
  ADVISORY_REMAINING_PERCENT,
  DRAINED_REMAINING_PERCENT,
  availableManualResetCredits,
  capacityNoticeKind,
  type CapacityNoticeKind,
  type ProviderAccountStatus,
  type ProviderStatusSnapshot,
  type QuotaWindow,
} from "./provider-status.ts";

export type ContinuationOwner = "previous_response" | "turn_state" | "bridge" | "file_pin" | "session_pin";

export type Continuation =
  /** No continuation state. */
  | { readonly kind: "independent" }
  /** Locality only, such as a prompt cache. Any eligible account may serve. */
  | { readonly kind: "soft"; readonly accountAlias: string }
  /** State that only the owning account holds. */
  | {
      readonly kind: "hard";
      readonly accountAlias: string;
      readonly owner: ContinuationOwner;
      /**
       * Why this state is reproducible on any account (for example, it is
       * replayed from a local transcript), or null when there is no proof.
       */
      readonly accountNeutralProof: string | null;
    };

export type ContinuationAction =
  /** Send unpinned. The provider chooses among its eligible accounts. */
  | "any_eligible"
  /** Send pinned to the owner. No sibling may serve it. */
  | "owner_only"
  /** The owner freshly cannot serve. Finish the current step and record a checkpoint. */
  | "checkpoint";

export interface ContinuationDecision {
  readonly action: ContinuationAction;
  readonly accountAlias: string | null;
  /** Advisory or checkpoint notice for the agent, or null for none. */
  readonly notice: CapacityNoticeKind | null;
  /** True when status evidence was too weak to judge the owner. */
  readonly evidenceUnknown: boolean;
  readonly reason: string;
}

/** The owning account of state that cannot move, or null when it may move. */
function pinnedOwner(continuation: Continuation): string | null {
  return continuation.kind === "hard" && !continuation.accountNeutralProof?.trim() ? continuation.accountAlias : null;
}

function freshWindows(account: ProviderAccountStatus): QuotaWindow[] {
  return [account.primary, account.secondary]
    .filter((window): window is QuotaWindow => window !== null && window.freshness === "fresh");
}

function findAccount(status: ProviderStatusSnapshot, alias: string): ProviderAccountStatus | null {
  return status.accounts.find((account) => account.accountAlias === alias) ?? null;
}

/**
 * The provider's own session pin for `sessionId`, as a hard continuation, or
 * null when the provider reports no pin. Providers may shorten ids, so a
 * reported id matches when the full id starts with it.
 */
export function continuationFromSessionPin(status: ProviderStatusSnapshot, sessionId: string): Continuation | null {
  const pin = status.sessionPins.find((entry) => entry.sessionId === sessionId || sessionId.startsWith(entry.sessionId));
  if (!pin?.accountAlias) return null;
  return { kind: "hard", accountAlias: pin.accountAlias, owner: "session_pin", accountNeutralProof: null };
}

/** Decide how the next turn of `continuation` should reach the provider. */
export function planContinuation(status: ProviderStatusSnapshot, continuation: Continuation): ContinuationDecision {
  const notice = capacityNoticeKind(status);
  const alias = pinnedOwner(continuation);
  if (alias === null) {
    const movable = continuation.kind === "hard" ? "account-neutral by proof" : continuation.kind;
    return {
      action: notice === "checkpoint" ? "checkpoint" : "any_eligible",
      accountAlias: null,
      notice,
      evidenceUnknown: status.allEligibleUnavailable === null,
      reason: notice === "checkpoint"
        ? "every eligible account is freshly drained"
        : `${movable} work may use any eligible account`,
    };
  }

  const owned = (
    action: ContinuationAction,
    ownerNotice: CapacityNoticeKind | null,
    evidenceUnknown: boolean,
    reason: string,
  ): ContinuationDecision => ({ action, accountAlias: alias, notice: ownerNotice, evidenceUnknown, reason });

  if (!status.reachable || status.freshness !== "fresh") {
    return owned("owner_only", null, true, "status is stale or unreachable, so the owner is tried as usual");
  }
  const owner = findAccount(status, alias);
  if (!owner || owner.freshness !== "fresh") {
    return owned("owner_only", null, true, "the owner is not in a fresh status row, which is not proof it cannot serve");
  }
  if (availableManualResetCredits(owner, Date.now()) > 0) {
    return owned("owner_only", null, owner.eligible === null,
      "the owner has banked manual resets, so no proactive quota stop is sent and its state stays with it");
  }
  if (owner.eligible === false) {
    return owned("checkpoint", "checkpoint", false,
      `the owner is ineligible (${owner.eligibilityReason ?? owner.status ?? "no reason given"}) and its state cannot move`);
  }
  const windows = freshWindows(owner);
  if (owner.eligible === true && windows.some((window) => window.confidence === "observed" && window.remainingPercent !== null
    && window.remainingPercent <= DRAINED_REMAINING_PERCENT)) {
    return owned("checkpoint", "checkpoint", false, "the owner is freshly drained and its state cannot move");
  }
  const low = windows.some((window) => window.remainingPercent !== null && window.remainingPercent <= ADVISORY_REMAINING_PERCENT);
  return owned("owner_only", low ? "advisory" : null, owner.eligible === null,
    low ? "the owner is near its limit, and its state stays with it" : "the owner can serve its own continuation");
}

export type TurnFailure =
  | "cancelled"
  | "timeout"
  | "transport"
  | "server"
  | "rate_limited"
  | "quota_exhausted"
  | "auth";

export interface RetryRequest {
  /** Attempts already made, starting at 1 after the first failure. */
  readonly attempt: number;
  readonly failure: TurnFailure;
  readonly continuation: Continuation;
  /** Output already reached the user or the transcript. */
  readonly outputVisible: boolean;
  readonly maxAttempts?: number;
}

export type RetryAction = "retry_owner" | "retry_unpinned" | "stop";

export interface RetryDecision {
  readonly action: RetryAction;
  readonly delayMs: number;
  readonly reason: string;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 8_000;

function backoff(attempt: number): number {
  return Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1));
}

/**
 * Whether a failed turn may be sent again, and how.
 *
 * Cancellation is final. Visible partial output is not replayed, because a
 * second attempt would duplicate it. A hard continuation without proof is only
 * ever retried on its owner, and only for transient failures. When the owner
 * is rate-limited or out of quota it stops rather than moving to a sibling.
 */
export function planRetry(request: RetryRequest): RetryDecision {
  const maxAttempts = request.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const stop = (reason: string): RetryDecision => ({ action: "stop", delayMs: 0, reason });
  if (request.failure === "cancelled") return stop("the turn was cancelled");
  if (request.outputVisible) return stop("output was already visible, and a retry would duplicate it");
  if (request.failure === "auth") return stop("the provider refused authentication, which a retry cannot fix");
  if (request.attempt >= maxAttempts) return stop(`gave up after ${request.attempt} attempts`);
  const transient = request.failure === "timeout" || request.failure === "transport" || request.failure === "server";
  if (pinnedOwner(request.continuation) !== null) {
    if (!transient) {
      return stop("the owning account cannot serve right now, and its continuation cannot move to another account");
    }
    return { action: "retry_owner", delayMs: backoff(request.attempt), reason: "transient failure, retried on the owning account" };
  }
  return {
    action: "retry_unpinned",
    delayMs: backoff(request.attempt),
    reason: transient
      ? "transient failure, retried through the provider's own account selection"
      : "account limit, retried so the provider can serve it from a sibling",
  };
}
