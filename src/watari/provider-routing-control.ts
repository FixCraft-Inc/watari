/**
 * Watari steering CodexLB and TeamClaude toward the best account order.
 *
 * Each provider keeps choosing the account for every request. Watari only sets
 * the one knob each provider exposes for preference, through that provider's
 * own control route on loopback, with no credential:
 *
 * - CodexLB routing policy: free accounts and the most urgent paid account get
 *   `burn_first`, weekly-only accounts kept in reserve get `preserve`
 *   (fallback only), and the rest stay `normal`. CodexLB itself only routes a
 *   model to an account whose plan has it.
 * - TeamClaude priority (lower is preferred): ranked accounts get their rank.
 *
 * The rank comes from `planAccountUse`. Only differences are sent. A provider
 * whose status is stale, unreachable, or without a ranked account is left
 * alone. In `auto` mode changes are applied at most once per interval per
 * provider. In `suggest` mode they are only shown.
 */

import type { ProviderStatusDocument, ProviderStatusGroup } from "./provider-status-api.ts";
import type { ProviderAccountStatus, ProviderId } from "./provider-status.ts";
import type { UsePlanEntry } from "./provider-usage-plan.ts";

export type RoutingMode = "off" | "suggest" | "auto";
export const ROUTING_MODES: readonly RoutingMode[] = ["off", "suggest", "auto"];

export interface RoutingChange {
  readonly provider: ProviderId;
  readonly accountId: string;
  readonly account: string;
  readonly setting: "routing policy" | "priority";
  readonly from: string | null;
  readonly to: string;
  readonly reason: string;
}

export interface RoutingLogEntry {
  readonly at: number;
  readonly provider: ProviderId;
  readonly account: string;
  readonly setting: RoutingChange["setting"];
  readonly from: string | null;
  readonly to: string;
  readonly ok: boolean;
  readonly error: string | null;
  readonly trigger: "auto" | "manual";
}

export interface ProviderRoutingState {
  readonly mode: RoutingMode;
  readonly planned: readonly RoutingChange[];
  /** Why there is no plan, when there is none. */
  readonly idle: string | null;
  readonly lastAppliedAt: number | null;
  readonly lastError: string | null;
}

export interface RoutingState {
  readonly providers: Readonly<Record<string, ProviderRoutingState>>;
  readonly log: readonly RoutingLogEntry[];
}

/** One provider's control route. Implementations call the provider, never Watari state. */
export interface RoutingController {
  readonly provider: ProviderId;
  readonly setting: RoutingChange["setting"];
  /** The setting each account should have, or null to leave it alone. */
  desired(account: ProviderAccountStatus, use: UsePlanEntry | null, useOrder: readonly UsePlanEntry[]): string | null;
  /** The setting as the provider reports it now. */
  current(account: ProviderAccountStatus): string | null;
  apply(change: RoutingChange, signal: AbortSignal): Promise<void>;
}

export interface RoutingSettingsStore {
  load(): { readonly modes: Readonly<Record<string, RoutingMode>>; readonly log: readonly RoutingLogEntry[] };
  save(settings: { readonly modes: Readonly<Record<string, RoutingMode>>; readonly log: readonly RoutingLogEntry[] }): void;
}

export interface ProviderRouterOptions {
  readonly controllers: readonly RoutingController[];
  readonly store?: RoutingSettingsStore;
  readonly defaultMode?: RoutingMode;
  readonly now?: () => number;
  /** Auto mode changes a provider at most this often. */
  readonly minIntervalMs?: number;
  readonly applyTimeoutMs?: number;
}

const DEFAULT_MIN_INTERVAL_MS = 5 * 60_000;
const MAX_LOG = 100;

function weeklyOnly(account: ProviderAccountStatus): boolean {
  const windows = [account.primary, account.secondary].filter((window) => window !== null);
  return windows.length > 0 && windows.every((window) => window.windowMinutes !== null && window.windowMinutes >= 24 * 60);
}

/**
 * CodexLB: free accounts burn first (CodexLB only routes a model to an account
 * whose plan has it, so this spends free quota on the models it offers), the
 * most urgent paid account burns first, weekly-only reserve accounts are
 * preserved, and the rest are normal.
 */
export function codexLbController(apply: RoutingController["apply"]): RoutingController {
  return {
    provider: "codex",
    setting: "routing policy",
    desired: (account, use, useOrder) => {
      if (use?.tier === "free") return "burn_first";
      if (use?.tier === "reserve" || (use === null && weeklyOnly(account))) return "preserve";
      const firstPaid = useOrder.find((entry) => entry.tier === "paid");
      return use !== null && firstPaid !== undefined && use.rank === firstPaid.rank ? "burn_first" : "normal";
    },
    current: (account) => account.preference,
    apply,
  };
}

/** TeamClaude: ranked accounts get their rank as priority, lower first. */
export function teamClaudeController(apply: RoutingController["apply"]): RoutingController {
  return {
    provider: "claude",
    setting: "priority",
    desired: (_account, use) => (use ? String(use.rank - 1) : null),
    current: (account) => (account.priority === null ? null : String(account.priority)),
    apply,
  };
}

function plan(group: ProviderStatusGroup, controller: RoutingController): { changes: RoutingChange[]; idle: string | null } {
  if (!group.reachable) return { changes: [], idle: "The provider could not be read." };
  if (group.freshness !== "fresh") return { changes: [], idle: "The provider's data is out of date." };
  if (group.useOrder.length === 0) return { changes: [], idle: "No account can serve right now, so nothing is changed." };
  const uses = new Map(group.useOrder.map((entry) => [entry.accountAlias, entry]));
  const changes: RoutingChange[] = [];
  for (const account of group.snapshot.accounts) {
    if (!account.accountId || account.freshness !== "fresh") continue;
    const use = uses.get(account.accountAlias) ?? null;
    const to = controller.desired(account, use, group.useOrder);
    const from = controller.current(account);
    if (to === null || to === from) continue;
    changes.push({
      provider: group.provider,
      accountId: account.accountId,
      account: account.displayName ?? account.accountAlias ?? account.accountId,
      setting: controller.setting,
      from,
      to,
      reason: use ? `Use order ${use.rank}: ${use.reason}` : "Not in the use order",
    });
  }
  return { changes, idle: changes.length === 0 ? "Routing already matches the use order." : null };
}

export class ProviderRouter {
  readonly #controllers: ReadonlyMap<ProviderId, RoutingController>;
  readonly #store: RoutingSettingsStore | null;
  readonly #now: () => number;
  readonly #minIntervalMs: number;
  readonly #applyTimeoutMs: number;
  readonly #modes = new Map<ProviderId, RoutingMode>();
  readonly #planned = new Map<ProviderId, { changes: readonly RoutingChange[]; idle: string | null }>();
  readonly #lastAppliedAt = new Map<ProviderId, number>();
  readonly #lastError = new Map<ProviderId, string | null>();
  readonly #defaultMode: RoutingMode;
  #log: RoutingLogEntry[] = [];
  #applying: Promise<void> | null = null;

  constructor(options: ProviderRouterOptions) {
    this.#controllers = new Map(options.controllers.map((controller) => [controller.provider, controller]));
    this.#store = options.store ?? null;
    this.#now = options.now ?? (() => Date.now());
    this.#minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
    this.#applyTimeoutMs = options.applyTimeoutMs ?? 5_000;
    this.#defaultMode = options.defaultMode ?? "suggest";
    const saved = this.#store?.load();
    for (const [provider, mode] of Object.entries(saved?.modes ?? {})) {
      if (ROUTING_MODES.includes(mode)) this.#modes.set(provider, mode);
    }
    this.#log = [...(saved?.log ?? [])].slice(-MAX_LOG);
  }

  mode(provider: ProviderId): RoutingMode {
    return this.#modes.get(provider) ?? this.#defaultMode;
  }

  setMode(provider: ProviderId, mode: RoutingMode): void {
    if (!this.#controllers.has(provider)) throw new Error(`Watari cannot route ${provider}`);
    if (!ROUTING_MODES.includes(mode)) throw new Error(`unknown routing mode: ${mode}`);
    this.#modes.set(provider, mode);
    this.#persist();
  }

  /**
   * Plan every provider from a status document and, for providers in `auto`
   * mode (or the one named by `force`), apply the plan. Calls never overlap.
   */
  async evaluate(document: ProviderStatusDocument, force: ProviderId | null = null): Promise<void> {
    while (this.#applying) await this.#applying;
    const work = this.#evaluate(document, force);
    this.#applying = work.finally(() => {
      this.#applying = null;
    });
    await this.#applying;
  }

  async #evaluate(document: ProviderStatusDocument, force: ProviderId | null): Promise<void> {
    for (const group of document.providers) {
      const controller = this.#controllers.get(group.provider);
      if (!controller) continue;
      const mode = this.mode(group.provider);
      const planned = mode === "off" && force !== group.provider
        ? { changes: [], idle: "Watari does not change this provider's routing." }
        : plan(group, controller);
      this.#planned.set(group.provider, planned);
      const forced = force === group.provider;
      if (planned.changes.length === 0 || (!forced && mode !== "auto")) continue;
      const last = this.#lastAppliedAt.get(group.provider);
      if (!forced && last !== undefined && this.#now() - last < this.#minIntervalMs) continue;
      await this.#apply(controller, planned.changes, forced ? "manual" : "auto");
      this.#planned.set(group.provider, { changes: [], idle: "Applied. The next read shows the result." });
    }
  }

  async #apply(controller: RoutingController, changes: readonly RoutingChange[], trigger: RoutingLogEntry["trigger"]): Promise<void> {
    let error: string | null = null;
    for (const change of changes) {
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), this.#applyTimeoutMs);
      try {
        await controller.apply(change, abort.signal);
        this.#record(change, trigger, null);
      } catch (failure) {
        error = failure instanceof Error ? failure.message : String(failure);
        this.#record(change, trigger, error);
        // A provider that refused one change would likely refuse the rest.
        break;
      } finally {
        clearTimeout(timer);
      }
    }
    this.#lastAppliedAt.set(controller.provider, this.#now());
    this.#lastError.set(controller.provider, error);
    this.#persist();
  }

  #record(change: RoutingChange, trigger: RoutingLogEntry["trigger"], error: string | null): void {
    this.#log.push({
      at: this.#now(),
      provider: change.provider,
      account: change.account,
      setting: change.setting,
      from: change.from,
      to: change.to,
      ok: error === null,
      error,
      trigger,
    });
    this.#log = this.#log.slice(-MAX_LOG);
  }

  #persist(): void {
    this.#store?.save({ modes: Object.fromEntries(this.#modes), log: this.#log });
  }

  state(): RoutingState {
    const providers: Record<string, ProviderRoutingState> = {};
    for (const provider of this.#controllers.keys()) {
      const planned = this.#planned.get(provider);
      providers[provider] = {
        mode: this.mode(provider),
        planned: planned?.changes ?? [],
        idle: planned ? planned.idle : "Waiting for the first read.",
        lastAppliedAt: this.#lastAppliedAt.get(provider) ?? null,
        lastError: this.#lastError.get(provider) ?? null,
      };
    }
    return { providers, log: [...this.#log].reverse().slice(0, 20) };
  }
}
