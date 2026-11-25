/**
 * Browser runtime for the provider dashboard.
 *
 * `dashboardRuntime` is served as its own source text, so it must stay
 * self-contained: nothing inside it may refer to a module-level value. Types
 * are fine because they are erased. `view` turns the API document into plain
 * display data and `arrange` sorts and filters account rows. Both are pure and
 * tested. `mount` builds DOM nodes from them with `textContent`, never HTML.
 *
 * Absent data is shown as absent. Nothing here invents a quota value, a reset
 * or billing date, or an exhausted state the provider did not report.
 */

export type Tone = "good" | "warn" | "bad" | "muted" | "info";
export type StatusKind = "serve" | "near" | "out" | "login" | "off" | "unknown";
export type SortKey = "use" | "name" | "status" | "short" | "long" | "ends";
export type RowFilter = "all" | "serve" | "unavailable";

export interface Fact {
  readonly label: string;
  readonly value: string;
  readonly tone: Tone | null;
  readonly title: string | null;
  readonly code?: boolean;
}

export interface Meter {
  readonly percentLeft: number | null;
  readonly text: string;
  readonly detail: string;
  readonly tone: Tone;
  /** The provider reports no such window for this account. */
  readonly absent: boolean;
  readonly title: string | null;
}

export interface AccountStatusView {
  readonly kind: StatusKind;
  readonly label: string;
  readonly glyph: string;
  readonly tone: Tone;
  readonly reason: string | null;
}

export interface AccountRow {
  readonly key: string;
  readonly name: string;
  readonly alias: string | null;
  readonly current: boolean;
  /** Suggested spending position, 1 first. Null when the account cannot serve now. */
  readonly use: { readonly rank: number; readonly reason: string } | null;
  readonly status: AccountStatusView;
  readonly short: Meter;
  readonly long: Meter;
  readonly plan: string | null;
  /** The provider's current routing setting: a policy, or a priority. */
  readonly routing: string | null;
  readonly paid: string | null;
  readonly ends: string | null;
  readonly endsDetail: string;
  readonly endsTone: Tone | null;
  readonly endsTitle: string | null;
  readonly details: readonly Fact[];
  readonly order: {
    readonly use: number;
    readonly name: string;
    readonly status: number;
    readonly short: number;
    readonly long: number;
    readonly ends: number;
  };
}

export interface PoolCell {
  readonly label: string;
  readonly fill: number | null;
  readonly kind: StatusKind;
}

export interface PinView {
  readonly session: string;
  readonly account: string;
  readonly since: string;
  readonly lastUsed: string;
}

export interface GroupView {
  readonly provider: string;
  readonly label: string;
  readonly theme: string;
  readonly source: string;
  readonly state: { readonly text: string; readonly tone: Tone; readonly glyph: string };
  readonly headline: string;
  readonly facts: readonly Fact[];
  readonly cells: readonly PoolCell[];
  readonly notice: { readonly kind: string; readonly text: string } | null;
  readonly error: string | null;
  readonly empty: string | null;
  readonly shortLabel: string;
  readonly longLabel: string;
  /** False when the provider reports no plan or billing date for any account. */
  readonly billingColumns: boolean;
  readonly rows: readonly AccountRow[];
  readonly pins: readonly PinView[];
}

export interface RoutingView {
  readonly mode: "off" | "suggest" | "auto";
  readonly planned: readonly string[];
  readonly idle: string | null;
  readonly last: { readonly text: string; readonly ok: boolean } | null;
  readonly error: string | null;
}

export interface DashboardView {
  readonly generatedAt: string;
  readonly groups: readonly GroupView[];
}

export interface Arrangement {
  readonly sort: SortKey;
  readonly descending: boolean;
  readonly filter: RowFilter;
  readonly query: string;
}

interface UiEvent {
  readonly key?: string;
  preventDefault(): void;
}

interface DomNode {
  textContent: string | null;
  className: string;
  value: string;
  disabled: boolean;
  readonly style: { setProperty(name: string, value: string): void };
  append(...nodes: (DomNode | string)[]): void;
  replaceChildren(...nodes: (DomNode | string)[]): void;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  removeAttribute(name: string): void;
  addEventListener(type: string, handler: (event: UiEvent) => void): void;
  focus(): void;
}

interface Storage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface BrowserGlobals {
  readonly document: {
    createElement(tag: string): DomNode;
    getElementById(id: string): DomNode | null;
    querySelector(selector: string): DomNode | null;
    readonly activeElement: DomNode | null;
  };
  readonly location: { readonly hash: string; readonly pathname: string };
  readonly history: { replaceState(data: unknown, unused: string, url: string): void };
  readonly sessionStorage: Storage;
  readonly localStorage: Storage;
  fetch(input: string, init: {
    readonly method?: string;
    readonly headers: Record<string, string>;
    readonly body?: string;
    readonly cache: string;
    readonly credentials: string;
  }): Promise<{ readonly status: number; readonly ok: boolean; json(): Promise<unknown> }>;
  setTimeout(callback: () => void, ms: number): number;
  clearTimeout(id: number): void;
}

export interface DashboardRuntime {
  readonly view: (document: unknown, now: number) => DashboardView;
  readonly routingView: (state: unknown, provider: string, now: number) => RoutingView | null;
  readonly arrange: (rows: readonly AccountRow[], arrangement: Arrangement) => AccountRow[];
  readonly mount: (globals: unknown) => void;
}

export function dashboardRuntime(): DashboardRuntime {
  const NOT_REPORTED = "Not reported";
  const TOKEN_KEY = "watari-provider-dashboard-token";
  const AUTO_KEY = "watari-provider-dashboard-auto";
  const AUTO_CHOICES: readonly (readonly [number, string])[] = [
    [0, "Off"],
    [30_000, "Every 30 seconds"],
    [60_000, "Every minute"],
    [300_000, "Every 5 minutes"],
  ];
  const SOURCE_NAMES: Record<string, string> = { codexlb: "CodexLB", teamclaude: "TeamClaude", watari: "Watari", "gemini-web": "Gemini Web" };
  const STATUS_ORDER: Record<StatusKind, number> = { serve: 0, near: 1, unknown: 2, out: 3, login: 4, off: 5 };
  const QUOTA_REASON = /quota|rate.?limit|throttl|capped|exhaust|usage.?limit/iu;
  const LOGIN_REASON = /login|refresh rejected|reauth|credential|token/iu;

  type Rec = Record<string, unknown>;

  function rec(value: unknown): Rec | null {
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Rec : null;
  }

  function list(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
  }

  function str(value: unknown): string | null {
    return typeof value === "string" && value.trim() ? value.trim() : null;
  }

  function num(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }

  function flag(value: unknown): boolean | null {
    return typeof value === "boolean" ? value : null;
  }

  function percent(value: number): string {
    const rounded = Math.round(value * 10) / 10;
    return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}%`;
  }

  function span(ms: number): string {
    const minutes = Math.round(Math.abs(ms) / 60_000);
    if (minutes < 1) return "under a minute";
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.floor(minutes / 60);
    if (hours < 48) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
    const days = Math.floor(hours / 24);
    return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`;
  }

  function absolute(ms: number): string {
    return new Date(ms).toLocaleString(undefined, {
      year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
    });
  }

  function day(ms: number): string {
    return new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }

  function days(ms: number, now: number): string {
    const count = Math.round(Math.abs(ms - now) / 86_400_000);
    if (count === 0) return "today";
    const unit = `${count} day${count === 1 ? "" : "s"}`;
    return ms > now ? `in ${unit}` : `${unit} ago`;
  }

  function ago(ms: number, now: number): string {
    return ms > now ? `${span(ms - now)} ahead of this clock` : `${span(now - ms)} ago`;
  }

  function sourceName(value: unknown): string {
    const source = str(value);
    return source ? SOURCE_NAMES[source] ?? source : NOT_REPORTED;
  }

  function fact(label: string, value: string | null, tone: Tone | null = null, title: string | null = null): Fact {
    return { label, value: value ?? NOT_REPORTED, tone: value === null ? "muted" : tone, title };
  }

  function windowName(minutes: number | null): string | null {
    if (minutes === null || minutes <= 0) return null;
    if (minutes === 10_080) return "Weekly";
    if (minutes % 1_440 === 0) return `${minutes / 1_440}-day`;
    if (minutes % 60 === 0) return `${minutes / 60}-hour`;
    return `${minutes}-minute`;
  }

  /** The tightest fresh window of an account, which is how much room it has. */
  function headroom(account: Rec): number | null {
    const known = [account["primary"], account["secondary"]]
      .map(rec)
      .filter((window): window is Rec => window !== null && window["freshness"] === "fresh")
      .map((window) => num(window["remainingPercent"]))
      .filter((value): value is number => value !== null);
    return known.length > 0 ? Math.min(...known) : null;
  }

  function statusOf(account: Rec): AccountStatusView {
    if (account["freshness"] !== "fresh") {
      return { kind: "unknown", label: "Unknown", glyph: "?", tone: "muted", reason: "This reading is out of date" };
    }
    const eligible = flag(account["eligible"]);
    const reason = str(account["eligibilityReason"]);
    const status = str(account["status"]);
    if (eligible === false) {
      const why = `${reason ?? ""} ${status ?? ""}`;
      if (LOGIN_REASON.test(why)) return { kind: "login", label: "Needs login", glyph: "!", tone: "bad", reason };
      if (QUOTA_REASON.test(why)) return { kind: "out", label: "Out of quota", glyph: "■", tone: "bad", reason };
      return { kind: "off", label: "Unavailable", glyph: "–", tone: "muted", reason: reason ?? status };
    }
    if (eligible === null) {
      return { kind: "unknown", label: "Unknown", glyph: "?", tone: "muted", reason: reason ?? "The provider did not say whether it can serve" };
    }
    const room = headroom(account);
    if (room !== null && room <= 1) return { kind: "out", label: "Out of quota", glyph: "■", tone: "bad", reason: "At its limit" };
    if (room !== null && room <= 10) return { kind: "near", label: "Near limit", glyph: "▲", tone: "warn", reason: `${percent(room)} left` };
    return { kind: "serve", label: "Can serve", glyph: "✓", tone: "good", reason: null };
  }

  function meter(raw: unknown, siblingReported: boolean, now: number): Meter {
    const window = rec(raw);
    if (!window) {
      return siblingReported
        ? { percentLeft: null, text: "No limit", detail: "", tone: "muted", absent: true,
            title: "The provider reports no such window for this account, so the other window decides its room." }
        : { percentLeft: null, text: NOT_REPORTED, detail: "", tone: "muted", absent: false, title: null };
    }
    const remaining = num(window["remainingPercent"]);
    const resetAt = num(window["resetAt"]);
    const observedAt = num(window["observedAt"]);
    const fresh = window["freshness"] === "fresh";
    let detail = "";
    if (resetAt !== null) detail = resetAt <= now ? "reset passed" : `resets in ${span(resetAt - now)}`;
    let sample: string;
    if (!fresh) sample = "This reading is out of date.";
    else if (window["confidence"] === "observed" && observedAt !== null) sample = `Sampled ${ago(observedAt, now)}.`;
    else if (window["confidence"] === "derived") sample = "The provider did not say when it sampled this.";
    else sample = "Sample time unknown.";
    let tone: Tone = "good";
    if (!fresh || remaining === null) tone = "muted";
    else if (remaining <= 1) tone = "bad";
    else if (remaining <= 10) tone = "warn";
    return {
      percentLeft: remaining,
      text: remaining === null ? NOT_REPORTED : `${percent(remaining)} left`,
      detail,
      tone,
      absent: false,
      title: [resetAt === null ? null : `Resets ${absolute(resetAt)}.`, sample].filter(Boolean).join(" "),
    };
  }

  function rowOf(
    raw: unknown,
    index: number,
    currentAlias: string | null,
    uses: ReadonlyMap<string, { readonly rank: number; readonly reason: string }>,
    now: number,
  ): AccountRow {
    const account = rec(raw) ?? {};
    const alias = str(account["accountAlias"]);
    const use = alias === null ? null : uses.get(alias) ?? null;
    const displayName = str(account["displayName"]);
    const name = displayName ?? alias ?? "Unnamed account";
    const status = statusOf(account);
    const primaryReported = rec(account["primary"]) !== null;
    const secondaryReported = rec(account["secondary"]) !== null;
    const short = meter(account["primary"], secondaryReported, now);
    const long = meter(account["secondary"], primaryReported, now);
    const billing = rec(account["billing"]);
    const paidAt = billing ? num(billing["periodStartAt"]) : null;
    const endsAt = billing ? num(billing["paidThroughAt"]) : null;
    const checkedAt = billing ? num(billing["paidThroughCheckedAt"]) : null;
    const source = sourceName(account["source"]);
    let ends: string | null = null;
    let endsDetail = "";
    let endsTone: Tone | null = null;
    let endsTitle: string | null = null;
    if (endsAt !== null) {
      const checked = checkedAt === null
        ? ""
        : ` The provider last checked it on ${day(checkedAt)}, and a payment after that shows once it checks again.`;
      if (endsAt > now) {
        ends = day(endsAt);
        endsDetail = days(endsAt, now);
        endsTone = endsAt - now <= 7 * 86_400_000 ? "warn" : null;
        endsTitle = `Paid through ${absolute(endsAt)}. It does not renew by itself.${checked}`;
      } else {
        ends = `Ended ${day(endsAt)}`;
        endsDetail = days(endsAt, now);
        endsTone = "muted";
        endsTitle = `The paid period ended ${absolute(endsAt)}.${checked}`;
      }
    }
    const remedy = str(account["remedy"]);
    const credits = billing ? num(billing["creditBalance"]) : null;
    const unlimited = billing ? flag(billing["creditsUnlimited"]) : null;
    const extra = billing ? flag(billing["extraUsageActive"]) : null;
    const priority = num(account["priority"]);
    const sessions = num(account["activeSessions"]);
    const preferred = flag(account["preferred"]);
    const observedAt = num(account["lastObservedAt"]);
    const details: Fact[] = [];
    if (use) details.push(fact("Use order", `${use.rank}. ${use.reason}`));
    if (status.reason) details.push(fact("Why", status.reason, status.tone === "bad" ? "bad" : null));
    if (remedy) details.push(fact("Fix", remedy, "warn", "The provider's own suggested fix"));
    for (const raw of list(account["observedUsage"]).slice(0, 64)) {
      const usage = rec(raw);
      if (!usage) continue;
      const attempts = num(usage["attempts"]), succeeded = num(usage["succeeded"]), failed = num(usage["failed"]);
      if (attempts === null || succeeded === null || failed === null) continue;
      const retryAt = num(usage["retryAt"]);
      const detail = `${attempts} submissions · ${succeeded} completed · ${failed} failed · last: ${str(usage["lastOutcome"]) ?? "unknown"}`
        + (retryAt === null ? "" : ` · retry after ${absolute(retryAt)} (not a reset)`);
      details.push(fact(`${str(usage["model"]) ?? "unknown"} / ${str(usage["kind"]) ?? "unknown"}`, detail, null,
        "Observed bridge submissions only. Other browser usage is not counted; remaining quota and limit scope are unknown."));
    }
    details.push(
      fact("Plan", str(account["plan"])),
      fact("Tier", str(account["tier"])),
      fact("Routing policy", str(account["preference"])),
      fact("Preferred", preferred === null ? null : preferred ? "Yes" : "No"),
      fact("Priority", priority === null ? null : String(priority)),
      fact("Active sessions", sessions === null ? null : String(sessions)),
    );
    if (paidAt !== null) details.push(fact("Paid", absolute(paidAt)));
    if (endsAt !== null) details.push(fact(endsAt > now ? "Ends" : "Ended", absolute(endsAt)));
    if (checkedAt !== null) {
      details.push(fact("Billing last checked", absolute(checkedAt), null, "When the provider last confirmed the paid period"));
    }
    const resets = num(account["resetCredits"]);
    if (resets !== null) {
      const expires = num(account["resetCreditsExpireAt"]);
      details.push(fact("Manual resets", resets === 0 ? "None available"
        : `${resets} available${expires === null ? "" : `, the first expires ${day(expires)}`}`, resets > 0 ? "good" : null));
    }
    const models = list(account["models"]).filter((model): model is string => typeof model === "string");
    if (Array.isArray(account["models"])) {
      details.push(fact("Models", models.length > 0 ? models.join(", ") : "None", null, "Models the provider would route this account for"));
    }
    if (credits !== null) details.push(fact("Credit balance", String(credits)));
    if (unlimited !== null) details.push(fact("Unlimited credits", unlimited ? "Yes" : "No"));
    if (extra !== null) details.push(fact("Extra usage", extra ? "On, billed past included quota" : "Off", extra ? "warn" : null));
    const note = billing ? str(billing["detail"]) : null;
    if (note && !(extra === true && note.includes("extra usage"))) details.push(fact("Billing note", note));
    if (alias !== null && alias !== name) details.push({ ...fact("Account ID", alias), code: true });
    details.push(
      fact("Source", source),
      fact("Read", observedAt === null ? null : ago(observedAt, now), null, observedAt === null ? null : absolute(observedAt)),
    );
    return {
      key: `${alias ?? name}#${index}`,
      name,
      alias: alias !== null && alias !== name ? alias : null,
      current: alias !== null && alias === currentAlias,
      use,
      status,
      short,
      long,
      plan: str(account["plan"]),
      routing: str(account["preference"]) ?? (priority === null ? null : `priority ${priority}`),
      paid: paidAt === null ? null : day(paidAt),
      ends,
      endsDetail,
      endsTone,
      endsTitle,
      details,
      order: {
        use: use?.rank ?? Number.POSITIVE_INFINITY,
        name: name.toLowerCase(),
        status: STATUS_ORDER[status.kind],
        short: short.percentLeft ?? -1,
        long: long.percentLeft ?? -1,
        ends: endsAt ?? Number.POSITIVE_INFINITY,
      },
    };
  }

  function columnName(accounts: readonly Rec[], key: "primary" | "secondary", fallback: string): string {
    const names = new Set(accounts
      .map((account) => rec(account[key]))
      .filter((window): window is Rec => window !== null)
      .map((window) => windowName(num(window["windowMinutes"]))));
    if (names.size !== 1) return fallback;
    return [...names][0] ?? fallback;
  }

  function groupView(raw: unknown, now: number): GroupView {
    const group = rec(raw) ?? {};
    const snapshot = rec(group["snapshot"]) ?? {};
    const accounts = list(snapshot["accounts"]).map((account) => rec(account) ?? {});
    const route = rec(snapshot["currentRoute"]);
    const currentAlias = str(route?.["accountAlias"]);
    const reachable = group["reachable"] === true;
    const fresh = group["freshness"] === "fresh";
    const uses = new Map<string, { readonly rank: number; readonly reason: string }>();
    for (const entry of list(group["useOrder"])) {
      const item = rec(entry);
      const alias = str(item?.["accountAlias"]);
      const rank = num(item?.["rank"]);
      if (alias !== null && rank !== null) uses.set(alias, { rank, reason: str(item?.["reason"]) ?? "" });
    }
    const rows = accounts.map((account, index) => rowOf(account, index, currentAlias, uses, now));
    const serving = (row: AccountRow) => row.status.kind === "serve" || row.status.kind === "near";
    const canServe = rows.filter(serving).length;

    const resets = accounts.flatMap((account, index) => {
      const row = rows[index];
      if (!row || row.status.kind === "serve") return [];
      return [account["primary"], account["secondary"]].map(rec)
        .map((window) => (window ? num(window["resetAt"]) : null))
        .filter((value): value is number => value !== null && value > now);
    });
    const nextReset = resets.length > 0 ? Math.min(...resets) : null;
    const ends = accounts.map((account, index) => {
      const billing = rec(account["billing"]);
      return { at: billing ? num(billing["paidThroughAt"]) : null, name: rows[index]?.name ?? "" };
    }).filter((entry): entry is { at: number; name: string } => entry.at !== null && entry.at > now)
      .sort((left, right) => left.at - right.at);
    const sampled = accounts.flatMap((account) => [account["primary"], account["secondary"]].map(rec))
      .filter((window): window is Rec => window !== null && window["confidence"] === "observed")
      .map((window) => num(window["observedAt"]))
      .filter((value): value is number => value !== null);
    const observedAt = num(group["observedAt"]);
    const sessionRoute = str(route?.["sessionId"]);
    const currentName = rows.find((row) => row.current)?.name ?? currentAlias;

    const facts: Fact[] = [];
    const first = rows.filter((row) => row.use !== null).sort((left, right) => left.order.use - right.order.use)[0];
    if (first?.use) facts.push(fact("Use next", first.name, null, first.use.reason));
    if (nextReset !== null) facts.push(fact("Next reset", `in ${span(nextReset - now)}`, null, absolute(nextReset)));
    if (ends[0]) {
      facts.push(fact("Next plan end", `${day(ends[0].at)}, ${ends[0].name}`, ends[0].at - now <= 7 * 86_400_000 ? "warn" : null));
    }
    if (currentName) facts.push(fact("Routing to", sessionRoute ? `${currentName} (session ${sessionRoute})` : currentName));
    if (sampled.length > 0) facts.push(fact("Usage sampled", ago(Math.max(...sampled), now)));
    const billingColumns = rows.some((row) => row.plan !== null || row.paid !== null || row.ends !== null);
    if (rows.length > 0 && !billingColumns) facts.push(fact("Plans and billing", `Not reported by ${sourceName(group["source"])}`, "muted"));
    facts.push(fact("Read", observedAt === null ? null : ago(observedAt, now), null, observedAt === null ? null : absolute(observedAt)));

    const noticeText = str(group["notice"]);
    const state: GroupView["state"] = !reachable
      ? { text: "Not reachable", tone: "bad", glyph: "✕" }
      : fresh ? { text: "Live", tone: "good", glyph: "●" } : { text: "Out of date", tone: "warn", glyph: "◌" };
    const room = (row: AccountRow) => Math.max(0, Math.min(row.short.percentLeft ?? 100, row.long.percentLeft ?? 100));
    return {
      provider: str(group["provider"]) ?? "provider",
      label: str(group["label"]) ?? str(group["provider"]) ?? "Provider",
      theme: str(group["theme"]) ?? "neutral",
      source: sourceName(group["source"]),
      state,
      headline: rows.length === 0
        ? "No account data"
        : `${canServe} of ${rows.length} account${rows.length === 1 ? "" : "s"} can serve`,
      facts,
      cells: rows.map((row) => ({
        label: `${row.name}: ${row.status.label}${serving(row) ? `, ${percent(room(row))} left` : ""}`,
        fill: serving(row) ? room(row) : row.status.kind === "unknown" ? null : 0,
        kind: row.status.kind,
      })),
      notice: noticeText ? { kind: str(group["noticeKind"]) ?? "advisory", text: noticeText } : null,
      error: str(group["error"]),
      empty: rows.length > 0
        ? null
        : reachable ? "The provider reported no accounts." : "No account data, because the provider status could not be read.",
      shortLabel: columnName(accounts, "primary", "Primary"),
      longLabel: columnName(accounts, "secondary", "Secondary"),
      billingColumns,
      rows,
      pins: list(snapshot["sessionPins"]).flatMap((rawPin): PinView[] => {
        const pin = rec(rawPin);
        const session = str(pin?.["sessionId"]);
        if (!pin || !session) return [];
        const since = num(pin["since"]);
        const lastUsed = num(pin["lastUsedAt"]);
        return [{
          session,
          account: str(pin["accountAlias"]) ?? NOT_REPORTED,
          since: since === null ? NOT_REPORTED : ago(since, now),
          lastUsed: lastUsed === null ? NOT_REPORTED : ago(lastUsed, now),
        }];
      }),
    };
  }

  function view(document: unknown, now: number): DashboardView {
    const root = rec(document) ?? {};
    const generatedAt = num(root["generatedAt"]);
    return {
      generatedAt: generatedAt === null ? NOT_REPORTED : absolute(generatedAt),
      groups: list(root["providers"]).map((group) => groupView(group, now)),
    };
  }

  function routingView(state: unknown, provider: string, now: number): RoutingView | null {
    const root = rec(state);
    const entry = rec(rec(root?.["providers"])?.[provider]);
    if (!entry) return null;
    const modeValue = str(entry["mode"]);
    const mode = modeValue === "off" || modeValue === "auto" ? modeValue : "suggest";
    const planned = list(entry["planned"]).flatMap((raw): string[] => {
      const change = rec(raw);
      if (!change) return [];
      const from = str(change["from"]) ?? "unset";
      return [`${str(change["account"]) ?? "account"}: ${str(change["setting"]) ?? "setting"} ${from} to ${str(change["to"]) ?? "?"}`];
    });
    const lastEntry = list(root?.["log"]).map(rec).find((item) => item !== null && item["provider"] === provider) ?? null;
    const last = lastEntry
      ? {
          ok: lastEntry["ok"] === true,
          text: `${ago(num(lastEntry["at"]) ?? now, now)}: ${str(lastEntry["account"]) ?? "account"} ${str(lastEntry["setting"]) ?? ""} set to ${str(lastEntry["to"]) ?? "?"}${lastEntry["ok"] === true ? "" : `, failed: ${str(lastEntry["error"]) ?? "no reason"}`}`,
        }
      : null;
    return { mode, planned, idle: str(entry["idle"]), last, error: str(entry["lastError"]) };
  }

  function arrange(rows: readonly AccountRow[], arrangement: Arrangement): AccountRow[] {
    const query = arrangement.query.trim().toLowerCase();
    const kept = rows.filter((row) => {
      const serves = row.status.kind === "serve" || row.status.kind === "near";
      if (arrangement.filter === "serve" && !serves) return false;
      if (arrangement.filter === "unavailable" && serves) return false;
      return !query || row.name.toLowerCase().includes(query) || (row.alias ?? "").toLowerCase().includes(query)
        || (row.plan ?? "").toLowerCase().includes(query);
    });
    const direction = arrangement.descending ? -1 : 1;
    return kept.sort((left, right) => {
      const a = left.order[arrangement.sort];
      const b = right.order[arrangement.sort];
      const primary = typeof a === "string" && typeof b === "string" ? a.localeCompare(b) : Number(a) - Number(b);
      return primary * direction || left.order.status - right.order.status || left.order.name.localeCompare(right.order.name);
    });
  }

  function mount(rawGlobals: unknown): void {
    const g = rawGlobals as BrowserGlobals;
    const doc = g.document;
    const main = doc.getElementById("main");
    const nav = doc.getElementById("jump");
    const status = doc.getElementById("status");
    const refreshButton = doc.getElementById("refresh");
    const autoSelect = doc.getElementById("auto");
    if (!main || !status) return;

    const el = (tag: string, className = "", text: string | null = null): DomNode => {
      const node = doc.createElement(tag);
      if (className) node.className = className;
      if (text !== null) node.textContent = text;
      return node;
    };
    const say = (message: string, tone: Tone = "muted"): void => {
      status.className = `status tone-${tone}`;
      status.textContent = message;
    };
    // Declared before anything that can render, so no message reads it early.
    let latest: unknown = null;
    /** Until data arrives, the page body says what is happening. */
    const page = (title: string, detail: string, tone: Tone = "muted"): void => {
      if (latest !== null) return;
      const panel = el("div", `page-message tone-${tone}`);
      panel.append(el("h2", "", title), el("p", "", detail));
      main.setAttribute("data-order", "message");
      main.replaceChildren(panel);
    };
    const stored = (storage: Storage, key: string): string | null => {
      try {
        return storage.getItem(key);
      } catch {
        return null;
      }
    };
    const store = (storage: Storage, key: string, value: string | null): void => {
      try {
        if (value === null) storage.removeItem(key);
        else storage.setItem(key, value);
      } catch {
        // Storage can be unavailable. The setting then lasts for this page only.
      }
    };

    let token: string | null = null;
    const match = /(?:^#|&)token=([A-Za-z0-9_-]{16,128})(?:&|$)/u.exec(g.location.hash);
    if (match?.[1]) {
      token = match[1];
      // The server keeps this token stable in the user's private state. Keep
      // the browser copy just as durable, so reopening the browser does not
      // require the printed link again. Also mirror it to sessionStorage for
      // browsers that clear local storage when a private tab ends.
      store(g.localStorage, TOKEN_KEY, token);
      store(g.sessionStorage, TOKEN_KEY, token);
      g.history.replaceState(null, "", g.location.pathname);
    } else {
      token = stored(g.localStorage, TOKEN_KEY);
      if (!token) {
        token = stored(g.sessionStorage, TOKEN_KEY);
        if (token) store(g.localStorage, TOKEN_KEY, token);
      }
    }
    page(token ? "Reading provider status" : "Restoring dashboard access",
      token ? "CodexLB and TeamClaude are being read. This takes a few seconds." :
        "The saved browser session is being restored. This takes a few seconds.");

    interface Section {
      readonly root: DomNode;
      readonly title: DomNode;
      readonly state: DomNode;
      readonly headline: DomNode;
      readonly strip: DomNode;
      readonly facts: DomNode;
      readonly banners: DomNode;
      readonly filters: DomNode;
      readonly search: DomNode;
      readonly table: DomNode;
      readonly pins: DomNode;
      readonly routing: DomNode;
      arrangement: Arrangement;
    }
    const sections = new Map<string, Section>();
    const open = new Set<string>();
    let routingState: unknown = null;
    let routingBusy: string | null = null;
    let lastSuccess: number | null = null;
    let loading = false;
    let failures = 0;
    let timer: number | null = null;
    const savedText = stored(g.localStorage, AUTO_KEY);
    const savedAuto = savedText === null ? Number.NaN : Number(savedText);
    let autoMs = AUTO_CHOICES.some(([ms]) => ms === savedAuto) ? savedAuto : 30_000;

    const factList = (items: readonly Fact[], className: string): DomNode => {
      const dl = el("dl", className);
      for (const item of items) {
        const row = el("div", "fact");
        const value = el("dd", [item.tone ? `tone-${item.tone}` : "", item.code ? "code" : ""].filter(Boolean).join(" "), item.value);
        if (item.title) value.setAttribute("title", item.title);
        row.append(el("dt", "", item.label), value);
        dl.append(row);
      }
      return dl;
    };

    const meterCell = (data: Meter): DomNode => {
      const td = el("td", `meter tone-${data.tone}${data.absent ? " absent" : ""}`);
      if (data.title) td.setAttribute("title", data.title);
      td.append(el("span", "meter-value", data.text));
      if (data.percentLeft !== null) {
        const bar = el("span", "bar");
        bar.setAttribute("aria-hidden", "true");
        const fillBar = el("span", "bar-fill");
        fillBar.style.setProperty("--fill", `${Math.max(0, Math.min(100, data.percentLeft))}%`);
        bar.append(fillBar);
        td.append(bar);
      }
      if (data.detail) td.append(el("span", "meter-detail", data.detail));
      return td;
    };

    const sortHeader = (section: Section, key: SortKey, label: string): DomNode => {
      const th = el("th");
      th.setAttribute("scope", "col");
      const active = section.arrangement.sort === key;
      if (active) th.setAttribute("aria-sort", section.arrangement.descending ? "descending" : "ascending");
      const button = el("button", `sort${active ? " active" : ""}`, label);
      button.setAttribute("type", "button");
      button.setAttribute("data-focus", `${section.root.getAttribute("id")}:sort:${key}`);
      button.addEventListener("click", () => {
        section.arrangement = {
          ...section.arrangement,
          sort: key,
          descending: active ? !section.arrangement.descending : key === "short" || key === "long",
        };
        render();
      });
      th.append(button);
      return th;
    };

    const plainHeader = (label: string): DomNode => {
      const th = el("th", "", label);
      th.setAttribute("scope", "col");
      return th;
    };

    const tableFor = (section: Section, group: GroupView): DomNode => {
      const rows = arrange(group.rows, section.arrangement);
      const table = el("table", "accounts");
      const head = el("tr");
      head.append(
        sortHeader(section, "use", "Use"),
        sortHeader(section, "name", "Account"),
        sortHeader(section, "status", "Status"),
        sortHeader(section, "short", group.shortLabel),
        sortHeader(section, "long", group.longLabel),
        plainHeader("Routing"),
      );
      if (group.billingColumns) head.append(plainHeader("Plan"), plainHeader("Paid"), sortHeader(section, "ends", "Ends"));
      const columns = group.billingColumns ? "9" : "6";
      const thead = el("thead");
      thead.append(head);
      const tbody = el("tbody");
      for (const row of rows) {
        const expanded = open.has(row.key);
        const tr = el("tr", `account${expanded ? " expanded" : ""}`);
        const nameCell = el("td", "name");
        const toggle = el("button", "expand");
        toggle.setAttribute("type", "button");
        toggle.setAttribute("aria-expanded", expanded ? "true" : "false");
        toggle.setAttribute("data-focus", `row:${row.key}`);
        toggle.append(el("span", "chevron", expanded ? "▾" : "▸"), el("span", "account-name", row.name));
        toggle.addEventListener("click", () => {
          if (open.has(row.key)) open.delete(row.key);
          else open.add(row.key);
          render();
        });
        nameCell.append(toggle);
        if (row.current) nameCell.append(el("span", "route-mark", "Routing here"));
        const statusCell = el("td", `state tone-${row.status.tone}`);
        statusCell.append(el("span", "glyph", row.status.glyph), el("span", "", row.status.label));
        if (row.status.reason) statusCell.setAttribute("title", row.status.reason);
        const endsCell = el("td", `ends${row.endsTone ? ` tone-${row.endsTone}` : ""}`);
        if (row.endsTitle) endsCell.setAttribute("title", row.endsTitle);
        endsCell.append(el("span", row.ends ? "" : "missing", row.ends ?? NOT_REPORTED));
        if (row.endsDetail) endsCell.append(el("span", "meter-detail", row.endsDetail));
        const useCell = el("td", `use${row.use ? "" : " missing"}`, row.use ? String(row.use.rank) : "–");
        if (row.use) useCell.setAttribute("title", row.use.reason);
        else useCell.setAttribute("title", "Not in the use order, because it cannot serve now");
        tr.append(useCell, nameCell, statusCell, meterCell(row.short), meterCell(row.long),
          el("td", row.routing ? "routing-cell" : "missing", row.routing ?? NOT_REPORTED));
        if (group.billingColumns) {
          tr.append(
            el("td", row.plan ? "" : "missing", row.plan ?? NOT_REPORTED),
            el("td", row.paid ? "" : "missing", row.paid ?? NOT_REPORTED),
            endsCell,
          );
        }
        tbody.append(tr);
        if (expanded) {
          const detailRow = el("tr", "details");
          const cell = el("td");
          cell.setAttribute("colspan", columns);
          cell.append(factList(row.details, "facts detail-facts"));
          detailRow.append(cell);
          tbody.append(detailRow);
        }
      }
      if (rows.length === 0) {
        const tr = el("tr", "none");
        const td = el("td", "", group.rows.length === 0 ? "No accounts." : "No account matches this filter.");
        td.setAttribute("colspan", columns);
        tr.append(td);
        tbody.append(tr);
      }
      table.append(thead, tbody);
      const wrap = el("div", "table-wrap");
      wrap.append(table);
      return wrap;
    };

    const filterButtons = (section: Section, group: GroupView): DomNode[] => {
      const serving = group.rows.filter((row) => row.status.kind === "serve" || row.status.kind === "near").length;
      const choices: readonly (readonly [RowFilter, string])[] = [
        ["all", `All ${group.rows.length}`],
        ["serve", `Can serve ${serving}`],
        ["unavailable", `Unavailable ${group.rows.length - serving}`],
      ];
      return choices.map(([value, label]) => {
        const button = el("button", "chip", label);
        button.setAttribute("type", "button");
        button.setAttribute("aria-pressed", section.arrangement.filter === value ? "true" : "false");
        button.setAttribute("data-focus", `${section.root.getAttribute("id")}:filter:${value}`);
        button.addEventListener("click", () => {
          section.arrangement = { ...section.arrangement, filter: value };
          render();
        });
        return button;
      });
    };

    const sectionFor = (group: GroupView): Section => {
      const existing = sections.get(group.provider);
      if (existing) return existing;
      const id = `provider-${group.provider.replace(/[^a-z0-9-]/giu, "")}`;
      const root = el("section", `provider theme-${group.theme}`);
      root.setAttribute("id", id);
      root.setAttribute("aria-labelledby", `${id}-title`);
      const header = el("header", "provider-head");
      const titleRow = el("div", "title-row");
      const title = el("h2", "provider-title");
      title.setAttribute("id", `${id}-title`);
      const state = el("span", "state-chip");
      titleRow.append(title, state);
      const headline = el("p", "headline");
      const strip = el("div", "strip");
      strip.setAttribute("role", "img");
      const facts = el("div", "provider-facts");
      header.append(titleRow, headline, strip, facts);
      const banners = el("div", "banners");
      const tools = el("div", "tools");
      const filters = el("div", "filters");
      filters.setAttribute("role", "group");
      filters.setAttribute("aria-label", "Show accounts");
      const search = el("input", "search");
      search.setAttribute("type", "search");
      search.setAttribute("placeholder", "Find an account");
      search.setAttribute("aria-label", `Find a ${group.label} account`);
      tools.append(filters, search);
      const table = el("div", "table-slot");
      const pins = el("div", "pins-slot");
      const routing = el("div", "routing-slot");
      root.append(header, banners, routing, tools, table, pins);
      const section: Section = {
        root, title, state, headline, strip, facts, banners, filters, search, table, pins, routing,
        arrangement: { sort: "use", descending: false, filter: "all", query: "" },
      };
      search.addEventListener("input", () => {
        section.arrangement = { ...section.arrangement, query: search.value };
        render();
      });
      sections.set(group.provider, section);
      return section;
    };

    const routingBar = (group: GroupView): DomNode[] => {
      const data = routingView(routingState, group.provider, Date.now());
      if (!data) return [];
      const bar = el("div", "routing");
      const row = el("div", "routing-row");
      row.append(el("span", "routing-label", "Watari routing"));
      const modes = el("div", "filters");
      modes.setAttribute("role", "group");
      modes.setAttribute("aria-label", `Watari routing for ${group.label}`);
      const labels: readonly (readonly [RoutingView["mode"], string])[] = [["off", "Off"], ["suggest", "Suggest only"], ["auto", "Automatic"]];
      for (const [mode, label] of labels) {
        const button = el("button", "chip", label);
        button.setAttribute("type", "button");
        button.setAttribute("aria-pressed", data.mode === mode ? "true" : "false");
        button.setAttribute("data-focus", `${group.provider}:routing:${mode}`);
        button.disabled = routingBusy !== null;
        button.addEventListener("click", () => void control(group.provider, { mode }));
        modes.append(button);
      }
      const apply = el("button", "button button-quiet", routingBusy === group.provider ? "Applying" : "Apply now");
      apply.setAttribute("type", "button");
      apply.disabled = routingBusy !== null || data.planned.length === 0;
      apply.addEventListener("click", () => void control(group.provider, { action: "apply" }));
      row.append(modes, apply);
      bar.append(row);
      const describe = data.planned.length > 0
        ? `${data.mode === "auto" ? "Will set" : "Would set"} ${data.planned.join(", ")}.`
        : data.idle ?? "Routing already matches the use order.";
      bar.append(el("p", "routing-plan", describe));
      if (data.last) bar.append(el("p", `routing-last${data.last.ok ? "" : " tone-bad"}`, `Last change ${data.last.text}`));
      return [bar];
    };

    const fill = (section: Section, group: GroupView): void => {
      section.title.replaceChildren(el("span", "", group.label), el("span", "via", `via ${group.source}`));
      section.state.className = `state-chip tone-${group.state.tone}`;
      section.state.replaceChildren(el("span", "glyph", group.state.glyph), el("span", "", group.state.text));
      section.headline.textContent = group.headline;
      section.strip.setAttribute("aria-label", group.headline);
      section.strip.replaceChildren(...group.cells.map((cell) => {
        const node = el("span", `cell kind-${cell.kind}`);
        node.setAttribute("title", cell.label);
        if (cell.fill !== null) node.style.setProperty("--fill", `${cell.fill}%`);
        return node;
      }));
      section.facts.replaceChildren(factList(group.facts, "facts summary-facts"));
      const banners: DomNode[] = [];
      if (group.notice) {
        const notice = el("p", `banner banner-${group.notice.kind}`, group.notice.text);
        notice.setAttribute("role", "status");
        banners.push(notice);
      }
      if (group.error) banners.push(el("p", "banner banner-error", group.error));
      if (group.empty) banners.push(el("p", "banner banner-empty", group.empty));
      section.banners.replaceChildren(...banners);
      section.routing.replaceChildren(...routingBar(group));
      section.filters.replaceChildren(...filterButtons(section, group));
      section.table.replaceChildren(tableFor(section, group));
      if (group.pins.length > 0) {
        const table = el("table", "pins");
        const head = el("tr");
        head.append(plainHeader("Session"), plainHeader("Account"), plainHeader("Pinned"), plainHeader("Last used"));
        const thead = el("thead");
        thead.append(head);
        const tbody = el("tbody");
        for (const pin of group.pins) {
          const tr = el("tr");
          [pin.session, pin.account, pin.since, pin.lastUsed].forEach((value) => tr.append(el("td", "", value)));
          tbody.append(tr);
        }
        table.append(thead, tbody);
        section.pins.replaceChildren(el("h3", "pins-title", "Sessions pinned to one account"), table);
      } else {
        section.pins.replaceChildren();
      }
    };

    function render(): void {
      if (latest === null) return;
      const focused = doc.activeElement?.getAttribute("data-focus") ?? null;
      const rendered = view(latest, Date.now());
      const roots: DomNode[] = [];
      for (const group of rendered.groups) {
        const section = sectionFor(group);
        fill(section, group);
        roots.push(section.root);
      }
      const order = rendered.groups.map((group) => group.provider).join("|") || "none";
      if (main?.getAttribute("data-order") !== order) {
        main?.setAttribute("data-order", order);
        if (roots.length > 0) main?.replaceChildren(...roots);
        else main?.replaceChildren(el("p", "banner banner-empty", "No provider readers are configured."));
        nav?.replaceChildren(...rendered.groups.map((group) => {
          const link = el("a", `jump-link theme-${group.theme}`, group.label);
          link.setAttribute("href", `#provider-${group.provider.replace(/[^a-z0-9-]/giu, "")}`);
          return link;
        }));
      }
      if (focused) doc.querySelector(`[data-focus="${focused.replace(/["\\]/gu, "")}"]`)?.focus();
    }

    const schedule = (): void => {
      if (timer !== null) g.clearTimeout(timer);
      timer = null;
      const delay = failures > 0 ? Math.min(300_000, 15_000 * failures) : autoMs;
      if (delay > 0) timer = g.setTimeout(() => void poll(false), delay);
    };

    const describe = (): void => {
      if (lastSuccess === null) return;
      const when = new Date(lastSuccess).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      say(failures > 0
        ? `Not answering. Showing data from ${when}.`
        : `Updated ${when}`, failures > 0 ? "warn" : "muted");
    };

    async function readRouting(): Promise<unknown> {
      try {
        const headers: Record<string, string> = {};
        if (token) headers.Authorization = `Bearer ${token}`;
        const response = await g.fetch("/api/routing", {
          headers,
          cache: "no-store",
          credentials: "same-origin",
        });
        return response.ok ? await response.json() : null;
      } catch {
        return null;
      }
    }

    async function control(provider: string, change: Record<string, string>): Promise<void> {
      if (routingBusy !== null) return;
      routingBusy = provider;
      render();
      try {
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (token) headers.Authorization = `Bearer ${token}`;
        const response = await g.fetch("/api/routing", {
          method: "POST",
          headers,
          body: JSON.stringify({ provider, ...change }),
          cache: "no-store",
          credentials: "same-origin",
        });
        if (response.ok) routingState = await response.json();
        else say(`Routing change refused (HTTP ${response.status})`, "bad");
      } catch {
        say("Routing change did not reach the dashboard", "bad");
      } finally {
        routingBusy = null;
        render();
      }
      void poll(true);
    }

    async function poll(force: boolean): Promise<void> {
      if (loading) return;
      loading = true;
      if (refreshButton) {
        refreshButton.disabled = true;
        refreshButton.textContent = "Refreshing";
      }
      try {
        const headers: Record<string, string> = {};
        if (token) headers.Authorization = `Bearer ${token}`;
        const response = await g.fetch(`/api/provider-status${force ? "?refresh=1" : ""}`, {
          headers,
          cache: "no-store",
          credentials: "same-origin",
        });
        if (response.status === 401) {
          store(g.localStorage, TOKEN_KEY, null);
          store(g.sessionStorage, TOKEN_KEY, null);
          if (token) {
            say("This link does not work", "bad");
            page("This link does not work", "Run `watari dashboard --link` to print the current link and open that.", "bad");
          } else {
            say("No access token", "warn");
            page("This link has no access token",
              "Open the full link that `watari dashboard` printed, or run `watari dashboard --link` to print it again. It ends in #token=...", "warn");
          }
          return;
        }
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        routingState = await readRouting();
        latest = data;
        lastSuccess = Date.now();
        failures = 0;
        render();
        describe();
        schedule();
      } catch {
        failures += 1;
        if (lastSuccess === null) {
          say("Not answering", "warn");
          page("The dashboard is not answering",
            "Start it with `watari dashboard`, or install it as a service with `watari dashboard --install`. This page retries on its own.", "warn");
        } else describe();
        schedule();
      } finally {
        loading = false;
        if (refreshButton) {
          refreshButton.disabled = false;
          refreshButton.textContent = "Refresh now";
        }
      }
    }

    if (autoSelect) {
      autoSelect.replaceChildren(...AUTO_CHOICES.map(([ms, label]) => {
        const option = el("option", "", label);
        option.setAttribute("value", String(ms));
        if (ms === autoMs) option.setAttribute("selected", "");
        return option;
      }));
      autoSelect.addEventListener("change", () => {
        const chosen = Number(autoSelect.value);
        autoMs = AUTO_CHOICES.some(([ms]) => ms === chosen) ? chosen : 30_000;
        store(g.localStorage, AUTO_KEY, String(autoMs));
        describe();
        schedule();
      });
    }
    refreshButton?.addEventListener("click", () => void poll(true));
    void poll(false);
  }

  return { view, routingView, arrange, mount };
}
