import type { AgentId } from "../models.ts";
import type { AgentRuntimeState, ClaimState, MessagePriority } from "../state/types.ts";

/**
 * Watari design tokens.
 *
 * Identity colour follows the native harness, never the alias: two Claude
 * agents read as Claude whatever they are called, and renaming one changes
 * nothing. The person at the keyboard keeps a neutral identity of their own so
 * they are never mistaken for a provider, and the semantic ramp is separate
 * again so status never has to borrow an identity colour. Every state that uses
 * colour also carries a glyph and a word, so a monochrome or colour-blind
 * terminal loses nothing.
 */
export interface Theme {
  readonly mode: "dark" | "light";
  readonly base: string;
  readonly surface: string;
  readonly raised: string;
  readonly rule: string;
  readonly ruleSoft: string;
  readonly text: string;
  readonly muted: string;
  readonly faint: string;
  /** Watari's own mark, cursor, and panel titles. Owned by no provider. */
  readonly brand: string;
  /** The person at the keyboard. Neutral by design. */
  readonly user: string;
  readonly codex: string;
  readonly claude: string;
  readonly opencode: string;
  readonly qwen: string;
  /**
   * A vendor's colour seen through OpenCode.
   *
   * OpenCode is a harness over other people's models, so an OpenCode agent
   * keeps OpenCode's own identity and only leans towards the model provider:
   * each of these sits half way between that provider's colour and OpenCode's,
   * which reads as "Claude, but through OpenCode" rather than as Claude.
   */
  readonly viaClaude: string;
  readonly viaCodex: string;
  readonly viaQwen: string;
  /** Base for a harness Watari has no accent for yet. */
  readonly peer: string;
  readonly ok: string;
  readonly warn: string;
  readonly danger: string;
  readonly info: string;
  readonly urgent: string;
  readonly selectionBg: string;
}

const DARK: Theme = {
  mode: "dark",
  base: "#0d1014",
  surface: "#151a21",
  raised: "#1e2630",
  rule: "#28323e",
  ruleSoft: "#1a212a",
  text: "#d5dce6",
  muted: "#8d99a8",
  faint: "#5f6a77",
  brand: "#2fc4b2",
  user: "#b8bcc2",
  codex: "#79c6f7",
  claude: "#f2913f",
  opencode: "#fdfcfc",
  viaClaude: "#f8c79e",
  viaCodex: "#bbe1fa",
  viaQwen: "#dcc4fe",
  qwen: "#bb8cff",
  peer: "#7f8b9a",
  ok: "#5fc46a",
  warn: "#e0bf4d",
  danger: "#f4677f",
  info: "#4f9ed6",
  urgent: "#ff6a4a",
  selectionBg: "#2b3644",
};

/**
 * Light mode inverts the lightness of an identity rather than its hue, which is
 * why OpenCode's near-white becomes graphite here: the same "no hue of its own"
 * identity, at the only lightness that stays readable on paper.
 */
const LIGHT: Theme = {
  mode: "light",
  base: "#fbfaf7",
  surface: "#f1efe9",
  raised: "#e6e3da",
  rule: "#d5d1c6",
  ruleSoft: "#e6e3da",
  text: "#23262d",
  muted: "#5b6470",
  faint: "#87909c",
  brand: "#0f7a68",
  user: "#5a6472",
  codex: "#16679f",
  claude: "#9c5305",
  opencode: "#141719",
  viaClaude: "#58350f",
  viaCodex: "#153f5c",
  viaQwen: "#412b6f",
  qwen: "#6d3fc4",
  peer: "#5b6470",
  ok: "#2c7a31",
  warn: "#87680c",
  danger: "#bb2f47",
  info: "#1a6a90",
  urgent: "#c33a12",
  selectionBg: "#dbe3ee",
};

/**
 * Terminals without truecolor quantise to the xterm-256 cube, which can crush
 * two Watari hues into one cell colour. These variants are already exact
 * xterm-256 entries, so the quantisation is a no-op and the hues stay apart.
 */
const DARK_256: Theme = {
  ...DARK,
  base: "#121212",
  surface: "#1c1c1c",
  raised: "#303030",
  rule: "#3a3a3a",
  ruleSoft: "#262626",
  text: "#d0d0d0",
  muted: "#949494",
  faint: "#6c6c6c",
  brand: "#00d7af",
  user: "#b2b2b2",
  codex: "#87d7ff",
  claude: "#ff8700",
  opencode: "#eeeeee",
  viaClaude: "#ffaf87",
  viaCodex: "#afd7ff",
  viaQwen: "#d7afff",
  qwen: "#af87ff",
  peer: "#949494",
  ok: "#5faf5f",
  warn: "#d7af5f",
  danger: "#ff5f87",
  info: "#5fafd7",
  urgent: "#ff5f5f",
  selectionBg: "#303030",
};

const LIGHT_256: Theme = {
  ...LIGHT,
  base: "#ffffff",
  surface: "#eeeeee",
  raised: "#e4e4e4",
  rule: "#bcbcbc",
  ruleSoft: "#dadada",
  text: "#262626",
  muted: "#585858",
  faint: "#878787",
  brand: "#008787",
  user: "#4e4e4e",
  codex: "#005faf",
  claude: "#af5f00",
  opencode: "#1c1c1c",
  viaClaude: "#875f5f",
  viaCodex: "#5f5f87",
  viaQwen: "#875faf",
  qwen: "#5f00d7",
  peer: "#585858",
  ok: "#008700",
  warn: "#875f00",
  danger: "#af0000",
  info: "#005f87",
  urgent: "#d70000",
  selectionBg: "#d0d0d0",
};

export type ThemePreference = "dark" | "light" | "auto";

export function readThemePreference(env: Record<string, string | undefined>): ThemePreference {
  const raw = env["WATARI_THEME"]?.trim().toLowerCase();
  return raw === "dark" || raw === "light" ? raw : "auto";
}

export function hasTrueColor(env: Record<string, string | undefined>): boolean {
  const colorterm = env["COLORTERM"]?.toLowerCase() ?? "";
  if (colorterm.includes("truecolor") || colorterm.includes("24bit")) {
    return true;
  }
  const term = env["TERM"] ?? "";
  return term.includes("direct") || term.includes("kitty");
}

export function selectTheme(mode: "dark" | "light", trueColor: boolean): Theme {
  if (mode === "light") {
    return trueColor ? LIGHT : LIGHT_256;
  }
  return trueColor ? DARK : DARK_256;
}

/**
 * Who this identity runs on.
 *
 * The stored provider is authoritative; the backend name is the fallback for a
 * snapshot written before providers were recorded, and it always begins with
 * the harness that produced it (`codex-app-server`, `claude-agent-sdk`,
 * `opencode-acp`, `<provider>-external-mcp`).
 */
export function providerOf(agent: AccentSource | null | undefined): string | null {
  const named = agent?.provider?.trim().toLowerCase();
  if (named) return named;
  const backend = agent?.backend?.trim().toLowerCase();
  const head = backend?.split("-")[0];
  return head ? head : null;
}

/**
 * Model-provider ids, as the multi-provider harnesses spell them, mapped onto
 * the identity Watari already has a colour for. A router prefix is stepped
 * over, so `openrouter/anthropic/claude-sonnet-4-5` is still Anthropic.
 */
const MODEL_PROVIDER_ACCENTS: Readonly<Record<string, "claude" | "codex" | "qwen">> = {
  anthropic: "claude",
  claude: "claude",
  openai: "codex",
  codex: "codex",
  qwen: "qwen",
  alibaba: "qwen",
  dashscope: "qwen",
};

/** The model provider inside an OpenCode-style `provider/model` identifier. */
export function modelProviderOf(model: string | null | undefined): string | null {
  const segments = (model ?? "").toLowerCase().split("/").filter(Boolean);
  if (segments.length < 2) return null;
  const known = segments.slice(0, -1).find((segment) => segment in MODEL_PROVIDER_ACCENTS);
  return known ?? segments[0] ?? null;
}

/** Colour for one native harness. Never a function of the alias. */
export function providerAccent(theme: Theme, provider: string | null | undefined): string {
  const id = provider?.trim().toLowerCase();
  if (!id) return theme.peer;
  if (id === "codex") return theme.codex;
  if (id === "claude") return theme.claude;
  if (id === "opencode") return theme.opencode;
  if (id === "qwen") return theme.qwen;
  // A harness Watari has no accent for yet still needs a stable, distinct one.
  const ramp = [theme.info, theme.ok, theme.qwen, theme.warn, theme.codex, theme.claude] as const;
  return ramp[hash(id) % ramp.length] ?? theme.peer;
}

/**
 * The colour one agent is drawn in.
 *
 * A single-vendor harness is its own identity. OpenCode is not: it is a harness
 * over many providers' models, so it keeps its own near-white identity and
 * takes a washed-out tint of the model provider's colour when Watari has one —
 * Claude through OpenCode reads as a paler orange than Claude itself, and a
 * provider Watari has no colour for stays plain OpenCode.
 */
export function identityAccent(
  theme: Theme,
  provider: string | null | undefined,
  model?: string | null,
): string {
  const harness = provider?.trim().toLowerCase();
  if (harness !== "opencode") return providerAccent(theme, harness);
  const vendor = MODEL_PROVIDER_ACCENTS[modelProviderOf(model) ?? ""];
  if (vendor === "claude") return theme.viaClaude;
  if (vendor === "codex") return theme.viaCodex;
  if (vendor === "qwen") return theme.viaQwen;
  return theme.opencode;
}

/** The minimum an accent needs to know about a peer. */
export interface AccentSource {
  readonly id: AgentId;
  readonly provider?: string | undefined;
  readonly backend?: string | undefined;
  readonly model?: string | null | undefined;
}

/** Resolves any transcript speaker — a peer, the user, or Watari — to a colour. */
export type Accents = (who: string | null | undefined) => string;

/**
 * Builds the accent lookup for one roster.
 *
 * Aliases are people and providers are the harness behind them, so the colour
 * is looked up through the roster rather than read off the name: `reviewer` on
 * Claude is Claude-coloured, and two Claude agents share one identity colour
 * while their names, glyphs, and tabs keep them apart.
 */
export function createAccents(theme: Theme, agents: readonly AccentSource[]): Accents {
  const byAlias = new Map<string, string>();
  for (const agent of agents) {
    byAlias.set(agent.id.toLowerCase(), identityAccent(theme, providerOf(agent), agent.model));
  }
  return (who) => {
    if (!who) return theme.muted;
    const key = who.toLowerCase();
    if (key === "user" || key === "you") return theme.user;
    if (key === "watari") return theme.muted;
    // An identity this roster does not know — a peer that has been removed, or
    // a name read back from an archived chat — falls back to its own name,
    // which is a provider name often enough to be right and stable otherwise.
    return byAlias.get(key) ?? providerAccent(theme, key);
  };
}

function hash(value: string): number {
  let total = 0;
  for (const character of value) {
    total = (total * 31 + character.codePointAt(0)!) >>> 0;
  }
  return total;
}

/** Watari's own glyph set. Box-drawing and geometric shapes only, so any
 * terminal with a normal monospace font renders them at one cell wide. */
export const GLYPHS = {
  mark: "⇌",
  rail: "┃",
  railSoft: "┆",
  workRunning: "⋯",
  workDone: "✓",
  workFailed: "✕",
  bullet: "·",
  chevron: "▸",
  arrow: "→",
  ruleLight: "─",
  ruleHeavy: "━",
  divider: "│",
  ellipsis: "…",
  more: { left: "‹", right: "›" },
  spinner: ["◜", "◝", "◞", "◟"],
  ready: "○",
  waiting: "◔",
  failed: "✕",
  stopped: "·",
  starting: "◌",
  severityHigh: "▲",
  severityMedium: "△",
  severityLow: "·",
  contested: "≠",
  claim: "●",
} as const;

export interface StateStyle {
  readonly glyph: string;
  readonly label: string;
  readonly color: (theme: Theme, accent: string) => string;
  readonly animated?: boolean;
}

const STATE_STYLES: Record<AgentRuntimeState, StateStyle> = {
  starting: { glyph: GLYPHS.starting, label: "starting", color: (theme) => theme.muted },
  ready: { glyph: GLYPHS.ready, label: "ready", color: (_theme, accent) => accent },
  busy: { glyph: GLYPHS.spinner[0]!, label: "working", color: (_theme, accent) => accent, animated: true },
  waiting: { glyph: GLYPHS.waiting, label: "waiting", color: (theme) => theme.warn },
  failed: { glyph: GLYPHS.failed, label: "failed", color: (theme) => theme.danger },
  stopped: { glyph: GLYPHS.stopped, label: "stopped", color: (theme) => theme.faint },
};

export function stateStyle(state: AgentRuntimeState): StateStyle {
  return STATE_STYLES[state];
}

export function priorityStyle(
  theme: Theme,
  priority: MessagePriority,
): { readonly label: string; readonly color: string } | null {
  if (priority === "urgent") return { label: "urgent", color: theme.urgent };
  if (priority === "stop") return { label: "stop", color: theme.danger };
  return null;
}

export function severityStyle(
  theme: Theme,
  severity: "info" | "low" | "medium" | "high" | "critical",
): { readonly glyph: string; readonly color: string } {
  if (severity === "critical") return { glyph: GLYPHS.severityHigh, color: theme.danger };
  if (severity === "high") return { glyph: GLYPHS.severityHigh, color: theme.urgent };
  if (severity === "medium") return { glyph: GLYPHS.severityMedium, color: theme.warn };
  if (severity === "low") return { glyph: GLYPHS.severityLow, color: theme.muted };
  return { glyph: GLYPHS.severityLow, color: theme.faint };
}

export function claimStyle(
  theme: Theme,
  state: ClaimState,
): { readonly glyph: string; readonly color: string; readonly label: string } {
  if (state === "contested") return { glyph: GLYPHS.contested, color: theme.danger, label: "contested" };
  if (state === "proposed") return { glyph: GLYPHS.ready, color: theme.muted, label: "proposed" };
  if (state === "superseded") return { glyph: GLYPHS.bullet, color: theme.faint, label: "superseded" };
  if (state === "released") return { glyph: GLYPHS.bullet, color: theme.faint, label: "released" };
  return { glyph: GLYPHS.claim, color: theme.ok, label: "active" };
}

/**
 * Health of a peer's coordination bridge.
 *
 * Deliberately quieter than the peer's own run state: a working bridge is the
 * expected case and should not compete for attention, while a broken one is the
 * single reason two peers would edit the same file believing they had agreed
 * not to, so it takes the danger colour outright.
 */
export function bridgeStyle(
  theme: Theme,
  state: "unknown" | "checking" | "ready" | "failed",
): {
  readonly glyph: string;
  readonly color: string;
  readonly label: string;
  /** What fits beside a peer's name in the side panel. */
  readonly short: string;
} {
  if (state === "ready") return { glyph: GLYPHS.workDone, color: theme.ok, label: "ok", short: "ok" };
  if (state === "failed") {
    return { glyph: GLYPHS.workFailed, color: theme.danger, label: "unreachable", short: "down" };
  }
  if (state === "checking") {
    return { glyph: GLYPHS.starting, color: theme.muted, label: "checking", short: "check" };
  }
  return { glyph: GLYPHS.bullet, color: theme.faint, label: "not checked yet", short: "" };
}

/** Event kinds share the transcript's dim register; only the label carries the
 * distinction so a long run of activity never shouts over the conversation. */
export function eventColor(theme: Theme, type: string): string {
  if (type === "error") return theme.danger;
  if (type === "warning") return theme.warn;
  if (type === "approval") return theme.urgent;
  if (type === "diff" || type === "patch" || type === "edit") return theme.info;
  return theme.faint;
}
