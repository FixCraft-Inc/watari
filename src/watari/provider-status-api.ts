/**
 * Provider-neutral read boundary for a browser dashboard or an agent.
 *
 * This module deliberately contains no provider client, credential handling,
 * mutation, or routing logic. Callers inject one status reader per provider,
 * and the provider owns authentication and account selection. The HTTP helper
 * returns a plain response description, so the web server that mounts it keeps
 * its own listener, authentication, and static-file policy.
 */

import {
  capacityNotice,
  capacityNoticeKind,
  staleProviderStatus,
  type CapacityNoticeKind,
  type CapacityState,
  type Confidence,
  type Freshness,
  type ProviderId,
  type ProviderStatusSnapshot,
  type StatusSource,
} from "./provider-status.ts";
import { planAccountUse, type UsePlanEntry } from "./provider-usage-plan.ts";
import { redactSecrets, stripTerminalControl } from "./security/redaction.ts";

export type ProviderGroup = "codex" | "claude" | "watari" | "other";
export type ProviderTheme = "codex-light-blue" | "claude-orange" | "neutral";

export interface ProviderStatusReader {
  readonly provider: ProviderId;
  readonly source: StatusSource;
  /** Must stop work when `signal` aborts. The service also stops waiting. */
  readonly read: (signal: AbortSignal) => Promise<ProviderStatusSnapshot>;
}

export interface ProviderStatusGroup {
  readonly provider: ProviderId;
  readonly group: ProviderGroup;
  readonly label: string;
  readonly theme: ProviderTheme;
  readonly source: StatusSource;
  readonly reachable: boolean;
  readonly freshness: Freshness;
  readonly capacity: CapacityState;
  readonly allEligibleUnavailable: boolean | null;
  readonly observedAt: number | null;
  readonly confidence: Confidence;
  readonly noticeKind: CapacityNoticeKind | null;
  readonly notice: string | null;
  readonly error: string | null;
  /** Suggested spending order for the accounts that can serve. Advice only. */
  readonly useOrder: readonly UsePlanEntry[];
  readonly snapshot: ProviderStatusSnapshot;
}

export interface ProviderStatusDocument {
  readonly schemaVersion: 1;
  readonly generatedAt: number;
  readonly providers: readonly ProviderStatusGroup[];
}

export interface ProviderStatusServiceOptions {
  readonly now?: () => number;
  readonly staleAfterMs?: number;
  /** Deadline for one read attempt of one provider. */
  readonly readTimeoutMs?: number;
  /**
   * Extra attempts after a failed read. A retry repeats the same provider's
   * read-only status request. It never reaches another provider or account.
   */
  readonly retries?: number;
  readonly retryDelayMs?: number;
  /** A refresh requested this soon after the last one reuses its result. */
  readonly minRefreshIntervalMs?: number;
}

const DEFAULT_STALE_AFTER_MS = 5 * 60_000;
const DEFAULT_READ_TIMEOUT_MS = 5_000;
const DEFAULT_RETRIES = 1;
const DEFAULT_RETRY_DELAY_MS = 250;
const MAX_RETRIES = 3;
const MAX_ERROR_LENGTH = 256;
const GROUP_ORDER: readonly ProviderGroup[] = ["codex", "claude", "watari", "other"];

function groupFor(provider: ProviderId): ProviderGroup {
  if (provider === "codex") return "codex";
  if (provider === "claude") return "claude";
  if (provider === "watari") return "watari";
  return "other";
}

function descriptor(provider: ProviderId): Pick<ProviderStatusGroup, "group" | "label" | "theme"> {
  const group = groupFor(provider);
  if (group === "codex") return { group, label: "ChatGPT / Codex", theme: "codex-light-blue" };
  if (group === "claude") return { group, label: "Claude / TeamClaude", theme: "claude-orange" };
  if (group === "watari") return { group, label: "Watari agents", theme: "neutral" };
  return { group, label: provider === "gemini-web" ? "Gemini Web" : provider, theme: "neutral" };
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return stripTerminalControl(redactSecrets(message)).slice(0, MAX_ERROR_LENGTH) || "provider status unavailable";
}

function unknownSnapshot(reader: ProviderStatusReader, error: string | null): ProviderStatusSnapshot {
  return {
    provider: reader.provider,
    source: reader.source,
    observedAt: null,
    freshness: "unknown",
    reachable: false,
    accounts: [],
    currentRoute: null,
    sessionPins: [],
    allEligibleUnavailable: null,
    capacity: "unknown",
    error,
  };
}

function groupSnapshot(snapshot: ProviderStatusSnapshot, now: number): ProviderStatusGroup {
  const details = descriptor(snapshot.provider);
  return {
    provider: snapshot.provider,
    ...details,
    source: snapshot.source,
    reachable: snapshot.reachable,
    freshness: snapshot.freshness,
    capacity: snapshot.capacity,
    allEligibleUnavailable: snapshot.allEligibleUnavailable,
    observedAt: snapshot.observedAt,
    confidence: snapshot.accounts.some((account) => account.confidence === "observed") ? "observed" : "unknown",
    noticeKind: capacityNoticeKind(snapshot, now),
    notice: capacityNotice(snapshot, now),
    error: snapshot.error === null ? null : safeError(snapshot.error),
    useOrder: planAccountUse(snapshot, now),
    snapshot,
  };
}

function ordered(groups: readonly ProviderStatusGroup[]): ProviderStatusGroup[] {
  return [...groups].sort((left, right) => {
    const byGroup = GROUP_ORDER.indexOf(left.group) - GROUP_ORDER.indexOf(right.group);
    return byGroup || left.provider.localeCompare(right.provider);
  });
}

function positive(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive and finite`);
  return value;
}

class ReadFailure extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
  }
}

/** Resolves after `ms`, or rejects as soon as `signal` aborts. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new ReadFailure("status refresh cancelled", false));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new ReadFailure("status refresh cancelled", false));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * One read-only status service shared by a UI and agent-facing consumers.
 *
 * Reads run concurrently and each provider is isolated: a failure, timeout,
 * or cancellation in one leaves the others intact. A failed refresh marks the
 * previous observation stale. It never turns a provider into an exhausted
 * state and never retries through another provider or account.
 */
export class ProviderStatusService {
  readonly #readers: readonly ProviderStatusReader[];
  readonly #now: () => number;
  readonly #staleAfterMs: number;
  readonly #readTimeoutMs: number;
  readonly #retries: number;
  readonly #retryDelayMs: number;
  readonly #minRefreshIntervalMs: number;
  readonly #snapshots = new Map<ProviderId, ProviderStatusSnapshot>();
  readonly #closed = new AbortController();
  #inFlight: Promise<ProviderStatusDocument> | null = null;
  #lastRefreshAt: number | null = null;

  constructor(readers: readonly ProviderStatusReader[], options: ProviderStatusServiceOptions = {}) {
    const providers = new Set<ProviderId>();
    for (const reader of readers) {
      if (providers.has(reader.provider)) throw new Error(`duplicate provider status reader: ${reader.provider}`);
      providers.add(reader.provider);
    }
    this.#readers = [...readers];
    this.#now = options.now ?? (() => Date.now());
    this.#staleAfterMs = positive(options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS, "staleAfterMs");
    this.#readTimeoutMs = positive(options.readTimeoutMs ?? DEFAULT_READ_TIMEOUT_MS, "readTimeoutMs");
    const retries = options.retries ?? DEFAULT_RETRIES;
    if (!Number.isInteger(retries) || retries < 0 || retries > MAX_RETRIES) {
      throw new Error(`retries must be an integer from 0 to ${MAX_RETRIES}`);
    }
    this.#retries = retries;
    this.#retryDelayMs = Math.max(0, options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
    this.#minRefreshIntervalMs = Math.max(0, options.minRefreshIntervalMs ?? 0);
  }

  get closed(): boolean {
    return this.#closed.signal.aborted;
  }

  /**
   * Refresh every provider. Concurrent callers share one refresh, and a call
   * inside the minimum interval reuses the last result without reading unless
   * it is forced (a person pressed Refresh).
   */
  refresh(options: { readonly force?: boolean } = {}): Promise<ProviderStatusDocument> {
    if (this.#inFlight) return this.#inFlight;
    const last = this.#lastRefreshAt;
    const recent = last !== null && this.#now() - last < this.#minRefreshIntervalMs;
    if (this.closed || (recent && !options.force)) {
      return Promise.resolve(this.snapshot());
    }
    const work = this.#refreshAll().finally(() => {
      this.#inFlight = null;
      this.#lastRefreshAt = this.#now();
    });
    this.#inFlight = work;
    return work;
  }

  /** Cancel in-flight reads. Later refreshes return the last snapshot. */
  close(): void {
    this.#closed.abort();
  }

  async #refreshAll(): Promise<ProviderStatusDocument> {
    const results = await Promise.all(this.#readers.map(async (reader) => {
      try {
        return await this.#readWithRetry(reader);
      } catch (error) {
        const message = safeError(error);
        const previous = this.#snapshots.get(reader.provider);
        return previous ? staleProviderStatus(previous, message, false) : unknownSnapshot(reader, message);
      }
    }));
    // A close() that raced the reads keeps the snapshots it already had.
    if (!this.closed) results.forEach((snapshot) => this.#snapshots.set(snapshot.provider, snapshot));
    return this.snapshot();
  }

  async #readWithRetry(reader: ProviderStatusReader): Promise<ProviderStatusSnapshot> {
    let failure: ReadFailure = new ReadFailure("status read did not run", false);
    for (let attempt = 0; attempt <= this.#retries; attempt += 1) {
      if (attempt > 0) await pause(this.#retryDelayMs, this.#closed.signal);
      try {
        return await this.#readOnce(reader);
      } catch (error) {
        failure = error instanceof ReadFailure ? error : new ReadFailure(safeError(error), true);
        if (!failure.retryable) break;
      }
    }
    throw failure;
  }

  async #readOnce(reader: ProviderStatusReader): Promise<ProviderStatusSnapshot> {
    const closed = this.#closed.signal;
    const timeoutMs = this.#readTimeoutMs;
    const snapshot = await new Promise<ProviderStatusSnapshot>((resolve, reject) => {
      const attempt = new AbortController();
      let settled = false;
      const finish = (settle: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        closed.removeEventListener("abort", onClose);
        settle();
      };
      // The deadline and close() abort the reader as well as stop waiting,
      // so a reader that ignores its signal cannot hold the refresh.
      const timer = setTimeout(() => {
        attempt.abort();
        finish(() => reject(new ReadFailure(`status read timed out after ${timeoutMs}ms`, true)));
      }, timeoutMs);
      const onClose = (): void => {
        attempt.abort();
        finish(() => reject(new ReadFailure("status refresh cancelled", false)));
      };
      if (closed.aborted) {
        onClose();
        return;
      }
      closed.addEventListener("abort", onClose, { once: true });
      Promise.resolve()
        .then(() => reader.read(attempt.signal))
        .then((value) => finish(() => resolve(value)), (error: unknown) => finish(() => reject(error)));
    });
    if (snapshot.provider !== reader.provider || snapshot.source !== reader.source) {
      throw new ReadFailure(`status reader identity mismatch for ${reader.provider}`, false);
    }
    // Adapters report transport failures as an unreachable snapshot. Keep the
    // last good observation, marked stale, rather than replacing it.
    if (!snapshot.reachable) throw new ReadFailure(snapshot.error ?? "provider status unreachable", true);
    return snapshot;
  }

  /** Return the latest document, aging observations without a network read. */
  snapshot(): ProviderStatusDocument {
    const now = this.#now();
    const groups = this.#readers.map((reader) => {
      const snapshot = this.#snapshots.get(reader.provider) ?? unknownSnapshot(reader, null);
      const observedAt = snapshot.observedAt;
      const stale = observedAt === null || now - observedAt > this.#staleAfterMs;
      return groupSnapshot(stale ? staleProviderStatus(snapshot, snapshot.error) : snapshot, now);
    });
    return { schemaVersion: 1, generatedAt: now, providers: ordered(groups) };
  }
}

export interface ProviderStatusHttpRequest {
  readonly method: string;
  readonly url: string;
}

export interface ProviderStatusHttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export type ProviderStatusAuthorize = (request: ProviderStatusHttpRequest) => boolean | Promise<boolean>;

export const PROVIDER_STATUS_PATH = "/api/provider-status";

/**
 * Mountable read-only route for `/api/provider-status`.
 *
 * Authorization is mandatory at the seam: the route has no implicit CORS or
 * browser authentication policy. A caller must supply a local/authenticated
 * boundary before exposing it on a socket or LAN listener.
 */
export async function handleProviderStatusRequest(
  request: ProviderStatusHttpRequest,
  service: ProviderStatusService,
  authorize: ProviderStatusAuthorize,
): Promise<ProviderStatusHttpResponse | null> {
  let url: URL;
  try {
    url = new URL(request.url, "http://watari.local");
  } catch {
    return null;
  }
  if (url.pathname !== PROVIDER_STATUS_PATH) return null;
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  } as const;
  if (request.method !== "GET") {
    return { status: 405, headers: { ...headers, Allow: "GET" }, body: JSON.stringify({ error: "method not allowed" }) };
  }
  let authorized = false;
  try {
    authorized = await authorize(request);
  } catch {
    authorized = false;
  }
  if (!authorized) {
    return { status: 401, headers, body: JSON.stringify({ error: "authentication required" }) };
  }
  try {
    const force = url.searchParams.get("refresh") === "1";
    return { status: 200, headers, body: JSON.stringify(await service.refresh({ force })) };
  } catch {
    // Reader failures are isolated in ProviderStatusService. This fallback is
    // for a programming/serialization error and must not disclose internals.
    return { status: 503, headers, body: JSON.stringify({ error: "provider status unavailable" }) };
  }
}
