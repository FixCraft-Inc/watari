/**
 * Tells running agents about their provider's pool capacity, and nothing else.
 *
 * The monitor polls the read-only provider status and posts a notice only when
 * a provider's pool changes state: limited (every routable account at 90% or
 * more), out of quota (checkpoint), or recovered after a checkpoint. It never
 * repeats a notice, never treats a stale, unknown, or unreachable reading as a
 * change, and never wakes an idle agent. The caller posts notices as passive
 * mail, which rides along with the agent's next boundary.
 */

import {
  capacityNoticeKind,
  type CapacityNoticeKind,
  type ProviderId,
  type ProviderStatusSnapshot,
} from "../provider-status.ts";
import type { ProviderStatusDocument } from "../provider-status-api.ts";

export interface CapacityStatusSource {
  refresh(options?: { readonly force?: boolean }): Promise<ProviderStatusDocument>;
  close?(): void;
}

export type CapacityNoticeChange = CapacityNoticeKind | "recovered";

export interface CapacityNoticePost {
  readonly provider: ProviderId;
  readonly change: CapacityNoticeChange;
  readonly body: string;
}

export interface CapacityMonitorOptions {
  readonly source: CapacityStatusSource;
  /** Posts one notice. The runtime decides who on that provider receives it. */
  readonly post: (notice: CapacityNoticePost) => void;
  /** Retires unread notices silently, including those from a prior service. */
  readonly withdraw?: (provider: ProviderId) => void;
  readonly intervalMs?: number;
}

const DEFAULT_INTERVAL_MS = 60_000;
const MIN_INTERVAL_MS = 5_000;

const RECOVERED: Readonly<Record<string, string>> = {
  codex: "CodexLB has a ChatGPT/Codex account with capacity again. You can resume the work you paused.",
  claude: "TeamClaude has a Claude account with capacity again. You can resume the work you paused.",
};

const RANK: Readonly<Record<CapacityNoticeKind, number>> = { advisory: 1, checkpoint: 2 };

/**
 * What changed for one provider, given the last state it announced. `null`
 * means post nothing. Only evidence that is fresh and reachable counts.
 */
export function capacityChange(
  previous: CapacityNoticeKind | null,
  snapshot: ProviderStatusSnapshot,
): { readonly next: CapacityNoticeKind | null; readonly change: CapacityNoticeChange | null } {
  // An absent or old reading is not a recovery and not a limit.
  if (!snapshot.reachable || snapshot.freshness !== "fresh" || snapshot.capacity === "unknown") {
    return { next: previous, change: null };
  }
  const current = capacityNoticeKind(snapshot);
  if (current === previous) return { next: current, change: null };
  if (current !== null && (previous === null || RANK[current] > RANK[previous])) {
    return { next: current, change: current };
  }
  // Credits, an auth problem or incomplete quota data are not recovery. Keep
  // remembering a checkpoint until the pool proves an account can serve.
  if (previous === "checkpoint") {
    if (snapshot.allEligibleUnavailable !== false) return { next: previous, change: null };
    return { next: current, change: current === "advisory" ? "advisory" : "recovered" };
  }
  return { next: current, change: null };
}

export class CapacityMonitor {
  readonly #source: CapacityStatusSource;
  readonly #post: CapacityMonitorOptions["post"];
  readonly #withdraw: CapacityMonitorOptions["withdraw"];
  readonly #intervalMs: number;
  readonly #announced = new Map<ProviderId, CapacityNoticeKind | null>();
  #timer: ReturnType<typeof setInterval> | null = null;
  #checking: Promise<void> | null = null;
  #stopped = false;

  constructor(options: CapacityMonitorOptions) {
    this.#source = options.source;
    this.#post = options.post;
    this.#withdraw = options.withdraw;
    this.#intervalMs = Math.max(MIN_INTERVAL_MS, options.intervalMs ?? DEFAULT_INTERVAL_MS);
  }

  start(): void {
    if (this.#timer || this.#stopped) return;
    void this.check();
    this.#timer = setInterval(() => void this.check(), this.#intervalMs);
    this.#timer.unref?.();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    this.#source.close?.();
  }

  /** One poll. Overlapping calls share it. A failed read changes nothing. */
  check(): Promise<void> {
    if (this.#checking) return this.#checking;
    const work = this.#checkOnce().finally(() => {
      this.#checking = null;
    });
    this.#checking = work;
    return work;
  }

  async #checkOnce(): Promise<void> {
    let document: ProviderStatusDocument;
    try {
      document = await this.#source.refresh();
    } catch {
      return;
    }
    if (this.#stopped) return;
    for (const group of document.providers) {
      const status = group.snapshot;
      if (status.reachable && status.freshness === "fresh" && status.capacity !== "unknown"
        && capacityNoticeKind(status) === null) this.#withdraw?.(group.provider);
      const previous = this.#announced.get(group.provider) ?? null;
      const { next, change } = capacityChange(previous, group.snapshot);
      this.#announced.set(group.provider, next);
      if (change === null) continue;
      const body = change === "recovered"
        ? RECOVERED[group.provider] ?? `${group.label} has capacity again. You can resume the work you paused.`
        : group.notice;
      if (body) this.#post({ provider: group.provider, change, body });
    }
  }
}
