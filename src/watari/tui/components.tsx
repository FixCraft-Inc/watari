import { For, Show } from "solid-js";
import type { MouseEvent } from "@opentui/core";

import type { AgentId } from "../models.ts";
import type { ProviderStatusDocument } from "../provider-status-api.ts";
import type {
  AgentRuntimeState,
  BridgeStatus,
  PersistedEvent,
  TeamAgent,
  TeamFinding,
  TeamSnapshot,
} from "../state/types.ts";
import { COMMANDS, KEYS, type CommandDoc } from "./commands.ts";
import { cellWidth, joinMeta, padEnd, relativeAge, summarizePaths, truncate, wrapText } from "./format.ts";
import { panelBudget, type PanelBudget } from "./panel.ts";
import type { RowSpan, TranscriptRow } from "./transcript.ts";
import {
  GLYPHS,
  bridgeStyle,
  claimStyle,
  providerOf,
  severityStyle,
  stateStyle,
  type Accents,
  type Theme,
} from "./theme.ts";

const BOLD = 1;
const DIM = 2;

function attributes(span: RowSpan): number {
  return (span.bold ? BOLD : 0) | (span.dim ? DIM : 0);
}

/** A transcript row. Single-span rows skip the flex box so long transcripts
 * stay cheap to lay out. */
export function Row(props: { readonly row: TranscriptRow }) {
  const first = (): RowSpan => props.row.spans[0] ?? { text: " ", color: "" };
  return (
    <Show
      when={props.row.spans.length > 1 || props.row.trailing}
      fallback={
        <text fg={first().color} attributes={attributes(first())} selectable>
          {first().text}
        </text>
      }
    >
      <box style={{ flexDirection: "row", height: 1, width: "100%" }}>
        <For each={props.row.spans}>
          {(span) => (
            <text fg={span.color} attributes={attributes(span)} selectable style={{ flexShrink: 0 }}>
              {span.text}
            </text>
          )}
        </For>
        <Show when={props.row.trailing}>
          <box style={{ flexGrow: 1, flexShrink: 1, minWidth: 2 }} />
          <For each={props.row.trailing}>
            {(span) => (
              <text fg={span.color} attributes={attributes(span)} style={{ flexShrink: 0 }}>
                {span.text}
              </text>
            )}
          </For>
          <text> </text>
        </Show>
      </box>
    </Show>
  );
}

/** Hairline used to separate regions. Watari never boxes a region it can rule. */
export function Rule(props: { readonly theme: Theme; readonly width: number; readonly color?: string }) {
  return <text fg={props.color ?? props.theme.rule} style={{ flexShrink: 0 }}>{GLYPHS.ruleLight.repeat(Math.max(0, props.width))}</text>;
}

/**
 * One row of identity and live team state.
 *
 * The peer list is spelled out while it fits and collapses to a count of what
 * each state holds when it does not, so a six-agent team reads as calmly as a
 * two-agent one instead of pushing the project path off the row.
 */
export function Header(props: {
  readonly theme: Theme;
  readonly project: string;
  readonly agents: readonly TeamAgent[];
  readonly accents: Accents;
  readonly spinner: string;
  readonly width: number;
}) {
  const room = () =>
    Math.max(0, props.width - 2 - cellWidth(`${BRAND_LABEL}  ${props.project}`) - 2);
  const summary = () => headerPeers(props.agents, props.theme, props.accents, props.spinner, room());

  return (
    <box
      style={{
        height: 1,
        width: "100%",
        flexShrink: 0,
        flexDirection: "row",
        backgroundColor: props.theme.surface,
        paddingLeft: 1,
        paddingRight: 1,
      }}
    >
      {/* The one filled block in the chrome, so the app is recognisable at a
          glance and the project path beside it reads as a location, not a title. */}
      <text fg={props.theme.base} bg={props.theme.brand} attributes={BOLD}>
        {BRAND_LABEL}
      </text>
      <text fg={props.theme.faint}>{`  ${props.project}`}</text>
      <box style={{ flexGrow: 1 }} />
      <For each={summary()}>
        {(span) => (
          <text fg={span.color} attributes={attributes(span)} style={{ flexShrink: 0 }}>
            {span.text}
          </text>
        )}
      </For>
    </box>
  );
}

const BRAND_LABEL = ` ${GLYPHS.mark} watari `;

function spansWidth(spans: readonly RowSpan[]): number {
  return spans.reduce((total, span) => total + cellWidth(span.text), 0);
}

/** Every peer named, or the same information counted, whichever fits. */
function headerPeers(
  agents: readonly TeamAgent[],
  theme: Theme,
  accents: Accents,
  spinner: string,
  room: number,
): readonly RowSpan[] {
  if (agents.length === 0) {
    const empty: readonly RowSpan[] = [{ text: "no agents yet  ·  ctrl+p adds one", color: theme.faint }];
    return spansWidth(empty) <= room ? empty : [];
  }

  const named: RowSpan[] = [];
  for (const [index, agent] of agents.entries()) {
    const accent = accents(agent.id);
    const style = stateStyle(agent.state);
    if (index > 0) named.push({ text: `  ${GLYPHS.bullet}  `, color: theme.rule });
    named.push({ text: `${style.animated ? spinner : style.glyph} `, color: style.color(theme, accent) });
    named.push({ text: agent.id, color: accent });
    named.push({ text: ` ${style.label}`, color: theme.muted });
  }
  if (spansWidth(named) <= room) return named;

  const counted: RowSpan[] = [{ text: `${agents.length} peers`, color: theme.muted }];
  const order: readonly AgentRuntimeState[] = ["busy", "waiting", "failed", "starting", "stopped"];
  for (const state of order) {
    const count = agents.filter((agent) => agent.state === state).length;
    if (count === 0) continue;
    const style = stateStyle(state);
    counted.push({ text: `  ${GLYPHS.bullet}  `, color: theme.rule });
    counted.push({ text: `${count} ${style.label}`, color: style.color(theme, theme.peer) });
  }
  while (counted.length > 1 && spansWidth(counted) > room) counted.splice(-2, 2);
  return spansWidth(counted) <= room ? counted : [];
}

export interface TabDescriptor {
  readonly label: string;
  readonly agent: AgentId | null;
  readonly accent: string;
  readonly marker: string;
  readonly markerColor: string;
}

/**
 * Tabs are named by an underline rather than by brackets, so switching chats
 * never shifts the labels sideways.
 *
 * A roster wider than the terminal is windowed around the focused chat with
 * plain ‹ › markers rather than allowed to run off the edge, so the tab a
 * message is about to be sent to is always the one on screen.
 */
export function TabStrip(props: {
  readonly theme: Theme;
  readonly tabs: readonly TabDescriptor[];
  readonly active: number;
  readonly width: number;
  readonly counters: readonly RowSpan[];
  /** Select a tab (or one of the window arrows) with the mouse. */
  readonly onTabClick?: (index: number) => void;
}) {
  /** Label row and underline row are laid out from one list of cells, so they
   * cannot drift apart when the roster is windowed. */
  const cells = (): readonly TabCell[] => {
    const room = props.width - spansWidth(props.counters) - 2;
    const window = tabWindow(props.tabs.map(tabCell), props.active, room);
    const out: TabCell[] = [];
    if (window.start > 0) {
      out.push({ key: "left", label: ` ${GLYPHS.more.left}`, marker: "", accent: props.theme.faint, markerColor: props.theme.faint, active: false, tabIndex: Math.max(0, props.active - 1) });
    }
    for (const [index, tab] of props.tabs.slice(window.start, window.end).entries()) {
      out.push({
        key: tab.label,
        label: `  ${tab.label}`,
        marker: tab.marker ? ` ${tab.marker}  ` : "  ",
        accent: tab.accent,
        markerColor: tab.markerColor,
        active: props.active === window.start + index,
        tabIndex: window.start + index,
      });
    }
    if (window.end < props.tabs.length) {
      out.push({ key: "right", label: `${GLYPHS.more.right} `, marker: "", accent: props.theme.faint, markerColor: props.theme.faint, active: false, tabIndex: Math.min(props.tabs.length - 1, props.active + 1) });
    }
    return out;
  };
  const used = () => cells().reduce((total, cell) => total + cellWidth(cell.label) + cellWidth(cell.marker), 0);

  return (
    <box style={{ flexDirection: "column", width: "100%", height: 2, flexShrink: 0 }}>
      <box style={{ flexDirection: "row", height: 1, width: "100%", paddingRight: 1 }}>
        <For each={cells()}>
          {(cell) => (
            <box
              style={{ flexDirection: "row", flexShrink: 0, backgroundColor: cell.active ? props.theme.raised : props.theme.base }}
              onMouseDown={(event: MouseEvent) => {
                if (event.button !== 0 || cell.tabIndex === undefined) return;
                event.preventDefault();
                event.stopPropagation();
                props.onTabClick?.(cell.tabIndex);
              }}
            >
              <text
                fg={cell.active ? cell.accent : props.theme.muted}
                attributes={cell.active ? BOLD : 0}
                selectable={false}
              >
                {cell.label}
              </text>
              <text fg={cell.markerColor} selectable={false}>{cell.marker}</text>
            </box>
          )}
        </For>
        <box style={{ flexGrow: 1 }} />
        <For each={props.counters}>
          {(span) => (
            <text fg={span.color} attributes={attributes(span)} style={{ flexShrink: 0 }}>
              {span.text}
            </text>
          )}
        </For>
      </box>
      <box style={{ flexDirection: "row", height: 1, width: "100%" }}>
        <For each={cells()}>
          {(cell) => (
            <text
              fg={cell.active ? cell.accent : props.theme.ruleSoft}
              style={{ flexShrink: 0 }}
              selectable={false}
              onMouseDown={(event: MouseEvent) => {
                if (event.button !== 0 || cell.tabIndex === undefined) return;
                event.preventDefault();
                event.stopPropagation();
                props.onTabClick?.(cell.tabIndex);
              }}
            >
              {(cell.active ? GLYPHS.ruleHeavy : GLYPHS.ruleLight).repeat(
                cellWidth(cell.label) + cellWidth(cell.marker),
              )}
            </text>
          )}
        </For>
        <text fg={props.theme.ruleSoft} style={{ flexGrow: 1 }}>
          {GLYPHS.ruleLight.repeat(Math.max(0, props.width - used()))}
        </text>
      </box>
    </box>
  );
}

interface TabCell {
  readonly key: string;
  readonly label: string;
  readonly marker: string;
  readonly accent: string;
  readonly markerColor: string;
  readonly active: boolean;
  readonly tabIndex?: number;
}

function tabCell(tab: TabDescriptor): string {
  return `  ${tab.label}${tab.marker ? ` ${tab.marker}` : ""}  `;
}

/** The widest run of tabs that fits and still contains the focused one. */
export function tabWindow(
  cells: readonly string[],
  active: number,
  room: number,
): { readonly start: number; readonly end: number } {
  const widths = cells.map((cell) => cellWidth(cell));
  const total = widths.reduce((sum, width) => sum + width, 0);
  if (total <= room || cells.length === 0) return { start: 0, end: cells.length };

  const focus = Math.min(Math.max(active, 0), cells.length - 1);
  let start = focus;
  let end = focus + 1;
  // Two cells of chrome per side for the ‹ › markers that say there is more.
  let used = (widths[focus] ?? 0) + 2 + (end < cells.length ? 2 : 0);
  while (true) {
    const before = start > 0 ? widths[start - 1] ?? 0 : Infinity;
    const after = end < cells.length ? widths[end] ?? 0 : Infinity;
    if (before === Infinity && after === Infinity) break;
    if (after <= before) {
      if (used + after > room) break;
      used += after;
      end += 1;
    } else {
      if (used + before > room) break;
      used += before;
      start -= 1;
    }
  }
  return { start, end };
}

/**
 * The one instruction the whole team is working from.
 *
 * The meta line deliberately does not repeat peer state: the header, the tabs,
 * and the side panel all carry that already, and a fourth copy of it is what
 * turns a status area into wallpaper. It answers the questions nothing else
 * does — which goal this is, how long it has been open, and when it last moved.
 */
export function GoalStrip(props: {
  readonly theme: Theme;
  readonly snapshot: TeamSnapshot;
  readonly width: number;
  readonly now: number;
  readonly compact: boolean;
}) {
  const goal = () => props.snapshot.activeGoal;
  const meta = (): string => {
    const active = goal();
    if (!active) return "";
    const moved = Math.max(active.updatedAt, active.createdAt);
    return joinMeta([
      active.id.replace(/^goal-/u, "").slice(0, 8),
      `open ${relativeAge(active.createdAt, props.now)}`,
      active.state === "active" ? `last move ${sinceLabel(moved, props.now)}` : active.state,
    ]);
  };

  return (
    <box style={{ flexDirection: "column", width: "100%", height: props.compact ? 1 : 2, flexShrink: 0, paddingLeft: 1 }}>
      <box style={{ flexDirection: "row", height: 1 }}>
        <text fg={goal() ? props.theme.brand : props.theme.faint}>{`${GLYPHS.rail} `}</text>
        <text fg={props.theme.faint}>{"goal  "}</text>
        <text fg={goal() ? props.theme.text : props.theme.faint} selectable>
          {goal()
            ? truncate(goal()?.instruction ?? "", Math.max(10, props.width - 10))
            : "none yet, your next message opens one"}
        </text>
      </box>
      <Show when={!props.compact}>
        <text fg={props.theme.faint}>{`${" ".repeat(8)}${truncate(meta(), Math.max(10, props.width - 10))}`}</text>
      </Show>
    </box>
  );
}

function SectionHeading(props: { readonly theme: Theme; readonly label: string; readonly width: number }) {
  return (
    <box style={{ flexDirection: "row", height: 1, flexShrink: 0 }}>
      <text fg={props.theme.muted} style={{ flexShrink: 0 }}>{`${props.label} `}</text>
      <text fg={props.theme.ruleSoft} style={{ flexShrink: 1 }}>
        {GLYPHS.ruleLight.repeat(Math.max(0, props.width - cellWidth(props.label) - 1))}
      </text>
    </box>
  );
}

/** Widest usage column the help panel will spend, before descriptions suffer. */
const HELP_USAGE_MAX = 22;

function claimsLabel(budget: PanelBudget): string {
  if (budget.hiddenClaims > 0) return `claims +${budget.hiddenClaims}`;
  return budget.claims.length > 0 ? "claims" : "claims  none";
}

/**
 * Whether another peer checked a finding. A refutation wins over any
 * confirmation, because a disagreement is what the user has to look at.
 */
function verdictMark(finding: TeamFinding): { readonly glyph: string; readonly refuted: boolean } | null {
  const verdicts = finding.verdicts ?? [];
  if (verdicts.some((entry) => entry.verdict === "refuted")) return { glyph: "✗", refuted: true };
  if (verdicts.some((entry) => entry.verdict === "confirmed")) return { glyph: "✓", refuted: false };
  return null;
}

function findingsLabel(budget: PanelBudget): string {
  if (budget.hiddenFindings > 0) return `findings +${budget.hiddenFindings}`;
  return budget.findings.length > 0 ? "findings" : "findings  none open";
}

function todosLabel(budget: PanelBudget): string {
  return budget.hiddenTodos > 0 ? `todo +${budget.hiddenTodos}` : "todo";
}

/** Glyph and colour for a TODO item's state, so the list reads at a glance. */
function todoStyle(theme: Theme, state: string): { readonly glyph: string; readonly color: string } {
  if (state === "doing") return { glyph: "◐", color: theme.brand };
  if (state === "blocked") return { glyph: "✕", color: theme.danger };
  return { glyph: "○", color: theme.faint };
}

/** Time left until a moment, in the short units the panel uses for ages. */
function timeLeft(until: number, now: number): string {
  const minutes = Math.max(0, Math.round((until - now) / 60_000));
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** What a sleeping peer is waiting for, short enough for the panel's second row. */
function wakeLabel(wake: NonNullable<TeamSnapshot["wakes"]>[number]): string {
  const condition = wake.condition;
  switch (condition.kind) {
    case "timer":
      return "its timer";
    case "pid":
      return `process ${condition.pid} exits`;
    case "path":
      return `${condition.path} exists`;
    case "command":
      return `${condition.argv[0] ?? "its check"} succeeds`;
  }
}

/** Each list measures its own usage column, so the short keys do not pay for
 * the long commands and both descriptions get the room that is left. */
interface HelpRow {
  readonly key: string;
  /** Empty on a description's continuation row. */
  readonly usage: string;
  readonly usageWidth: number;
  readonly description: string;
}

/** Lays entries out to `width`, wrapping descriptions under themselves. */
export function helpRows(entries: readonly CommandDoc[], width: number): readonly HelpRow[] {
  const widest = Math.min(HELP_USAGE_MAX, Math.max(4, ...entries.map((entry) => cellWidth(entry.usage))));
  // Too narrow for side by side: every usage takes its own row, and its
  // description is indented under it.
  const stacked = width - widest - 2 < 12;
  const usageWidth = stacked ? 0 : widest;
  const room = Math.max(1, width - usageWidth - 2);
  const rows: HelpRow[] = [];
  for (const entry of entries) {
    // A usage longer than its column gets the row to itself.
    const ownRow = stacked || cellWidth(entry.usage) > usageWidth;
    if (ownRow) rows.push({ key: `${entry.usage}:usage`, usage: truncate(entry.usage, width), usageWidth: width, description: "" });
    for (const [index, line] of wrapText(entry.description, room).entries()) {
      rows.push({
        key: `${entry.usage}:${index}`,
        usage: index === 0 && !ownRow ? entry.usage : "",
        usageWidth,
        description: line,
      });
    }
  }
  return rows;
}

function HelpList(props: { readonly theme: Theme; readonly rows: readonly HelpRow[] }) {
  return (
    <For each={props.rows}>
      {(row) => (
        <box style={{ flexDirection: "row", height: 1, flexShrink: 0 }}>
          <text fg={props.theme.text} style={{ flexShrink: 0 }} selectable>
            {row.description === "" ? row.usage : padEnd(row.usage, row.usageWidth + 2)}
          </text>
          <text fg={props.theme.muted} style={{ flexShrink: 0 }}>
            {row.description}
          </text>
        </box>
      )}
    </For>
  );
}

/** Reads as English next to an age: "now" stays "just now", "4m" becomes ago. */
function sinceLabel(timestamp: number, now: number): string {
  const age = relativeAge(timestamp, now);
  return age === "now" ? "just now" : `${age} ago`;
}

/** Standing team state that would otherwise scroll out of the transcript. */
export function SidePanel(props: {
  readonly theme: Theme;
  readonly snapshot: TeamSnapshot;
  readonly accents: Accents;
  readonly width: number;
  readonly height: number;
  readonly now: number;
}) {
  const inner = () => props.width - 2;
  const budget = () => panelBudget(props.snapshot, props.height);
  const claims = () => budget().claims;
  const findings = () => budget().findings;
  const todos = () => budget().todos;
  /** One name column for the whole roster, so the states line up. */
  const nameWidth = () => {
    const widest = Math.max(5, ...props.snapshot.agents.map((peer) => cellWidth(peer.id)));
    return Math.max(5, Math.min(14, inner() - 12, widest));
  };

  return (
    <box
      style={{
        flexDirection: "column",
        width: props.width,
        flexShrink: 0,
        overflow: "hidden",
        paddingLeft: 1,
        paddingRight: 1,
      }}
    >
      <SectionHeading theme={props.theme} label="peers" width={inner()} />
      <For each={props.snapshot.agents}>
        {(agent) => {
          const accent = props.accents(agent.id);
          const style = stateStyle(agent.state);
          const bridge = () =>
            props.snapshot.bridges?.find((entry) => entry.agent === agent.id) ?? null;
          const look = () => bridgeStyle(props.theme, bridge()?.state ?? "unknown");
          /* Two rows per peer, always. The first is who and how they are, with
             the bridge as a glyph on the right; the second is the one sentence
             that matters, which is the bridge's when the bridge is the problem
             and the harness's the rest of the time. Nothing repeats a word the
             row above already said. */
          const second = (): { readonly text: string; readonly color: string } => {
            const state = bridge()?.state;
            if (state === "failed") {
              return { text: "team bridge unreachable", color: props.theme.danger };
            }
            if (state === "checking") {
              return { text: "checking team bridge", color: props.theme.muted };
            }
            if (agent.availability === "dnd") {
              const left = agent.availabilityUntil ? `, ${timeLeft(agent.availabilityUntil, props.now)} left` : "";
              return { text: `dnd: ${agent.availabilityReason ?? "focused"}${left}`, color: props.theme.warn };
            }
            const wake = props.snapshot.wakes?.find((entry) => entry.agent === agent.id && entry.state === "pending");
            if (wake && agent.state !== "busy") {
              return { text: `sleeping until ${wakeLabel(wake)}`, color: props.theme.muted };
            }
            return { text: agent.detail ?? peerSetup(agent), color: props.theme.faint };
          };
          return (
            <box style={{ flexDirection: "column" }}>
              <box style={{ flexDirection: "row", height: 1 }}>
                <text fg={accent} attributes={BOLD} selectable style={{ flexShrink: 0 }}>
                  {padEnd(truncate(agent.id, nameWidth()), nameWidth() + 1)}
                </text>
                <text fg={style.color(props.theme, accent)} style={{ flexShrink: 1 }}>
                  {style.label}
                </text>
                <box style={{ flexGrow: 1, minWidth: 1 }} />
                {/* The word only where there is no second line to carry it:
                    a broken or in-flight bridge spells itself out below. */}
                <text fg={look().color} style={{ flexShrink: 0 }}>
                  {bridge()?.state === "ready" ? `${look().glyph} ${look().short}` : look().glyph}
                </text>
              </box>
              <text fg={second().color} selectable>{truncate(second().text, inner())}</text>
            </box>
          );
        }}
      </For>

      <Show when={claims().length > 0 || budget().hiddenClaims === 0}>
        <text> </text>
        <SectionHeading theme={props.theme} label={claimsLabel(budget())} width={inner()} />
      </Show>
      <Show when={claims().length > 0}>
        <For each={claims()}>
          {(claim) => {
            const style = claimStyle(props.theme, claim.state);
            return (
              <box style={{ flexDirection: "column" }}>
                <box style={{ flexDirection: "row", height: 1 }}>
                  <text fg={style.color}>{`${style.glyph} `}</text>
                  <text fg={props.accents(claim.claimant)}>{padEnd(truncate(claim.claimant, 7), 8)}</text>
                  <text fg={props.theme.muted} selectable>{truncate(claim.summary, inner() - 10)}</text>
                </box>
                <text fg={props.theme.faint} selectable>{`  ${summarizePaths(claim.paths, inner() - 2)}`}</text>
              </box>
            );
          }}
        </For>
      </Show>

      <Show when={findings().length > 0 || budget().hiddenFindings === 0}>
        <text> </text>
        <SectionHeading theme={props.theme} label={findingsLabel(budget())} width={inner()} />
      </Show>
      <Show when={findings().length > 0}>
        <For each={findings()}>
          {(finding) => {
            const style = severityStyle(props.theme, finding.severity);
            const mark = verdictMark(finding);
            return (
              <box style={{ flexDirection: "column" }}>
                <box style={{ flexDirection: "row", height: 1 }}>
                  <text fg={style.color}>{`${style.glyph} `}</text>
                  <text fg={style.color}>{padEnd(finding.severity, 9)}</text>
                  <text fg={props.accents(finding.author)}>{truncate(finding.author, inner() - 16)}</text>
                  <box style={{ flexGrow: 1 }} />
                  <Show when={mark}>
                    <text fg={mark?.refuted ? props.theme.danger : props.theme.ok}>{`${mark?.glyph} `}</text>
                  </Show>
                  <text fg={props.theme.faint}>{relativeAge(finding.createdAt, props.now)}</text>
                </box>
                <text fg={props.theme.muted} selectable>{`  ${truncate(finding.summary, inner() - 2)}`}</text>
              </box>
            );
          }}
        </For>
      </Show>

      <Show when={todos().length > 0}>
        <text> </text>
        <SectionHeading theme={props.theme} label={todosLabel(budget())} width={inner()} />
        <For each={todos()}>
          {(todo) => {
            const style = todoStyle(props.theme, todo.state);
            return (
              <box style={{ flexDirection: "row", height: 1 }}>
                <text fg={style.color}>{`${style.glyph} `}</text>
                <text fg={todo.assignee ? props.accents(todo.assignee) : props.theme.faint}>
                  {padEnd(truncate(todo.assignee ?? "open", 7), 8)}
                </text>
                <text fg={props.theme.muted} selectable>{truncate(`#${todo.id} ${todo.title}`, inner() - 10)}</text>
              </box>
            );
          }}
        </For>
      </Show>
    </box>
  );
}

/** What a peer is configured as, for when it has not said anything yet. Named
 * the way the picker names it rather than by its internal backend id. */
function peerSetup(agent: TeamAgent): string {
  return joinMeta([providerOf(agent) ?? "unconfigured", agent.model ?? "provider default"]);
}

/**
 * Approvals block a native turn, so they get the one tinted strip in the app.
 *
 * The strip spells out the exact commands rather than binding a key, because a
 * mistyped key here answers for a native harness that is waiting mid-turn. The
 * bare `/approve` and `/decline` forms answer this same request when it is the
 * only one visible.
 */
export function ApprovalStrip(props: {
  readonly theme: Theme;
  readonly approval: PersistedEvent;
  readonly accents: Accents;
  readonly waiting: number;
  readonly width: number;
}) {
  const agent = () => props.approval.agent ?? "peer";
  const id = () => props.approval.providerEventId ?? "";
  const commands = () => `  /approve ${agent()} ${id()}    /decline ${agent()} ${id()}`;
  const hint = () => `    ${GLYPHS.bullet}  /approve on its own answers this one`;
  /** One string rather than a conditional child: the strip is exactly two rows
   * and must not gain or lose one as the terminal is resized. */
  const answer = () =>
    cellWidth(commands()) + cellWidth(hint()) <= props.width - 2
      ? `${commands()}${hint()}`
      : commands();
  return (
    <box
      style={{
        flexDirection: "column",
        width: "100%",
        height: 2,
        flexShrink: 0,
        backgroundColor: props.theme.raised,
        paddingLeft: 1,
        paddingRight: 1,
      }}
    >
      <box style={{ flexDirection: "row", height: 1 }}>
        <text fg={props.theme.urgent} attributes={BOLD}>
          {`${GLYPHS.severityMedium} approval  `}
        </text>
        <text fg={props.accents(props.approval.agent)}>{agent()}</text>
        <text fg={props.theme.text} selectable>
          {`  ${truncate(props.approval.summary, Math.max(10, props.width - 30))}`}
        </text>
        <box style={{ flexGrow: 1 }} />
        <text fg={props.theme.warn}>{props.waiting > 1 ? `+${props.waiting - 1} more waiting` : ""}</text>
      </box>
      <text fg={props.theme.muted} selectable>{answer()}</text>
    </box>
  );
}

/**
 * Every key and command, each column sized to what it holds.
 *
 * A description that does not fit wraps under itself rather than losing its
 * end, because the part a truncation drops ("…, report", "…, or findings") is
 * usually the part that tells two commands apart.
 */
export function HelpOverlay(props: { readonly theme: Theme; readonly width: number; readonly height: number }) {
  const panelWidth = () => Math.min(124, Math.max(44, props.width - 4));
  const inner = () => panelWidth() - 6;
  const twoColumn = () => inner() >= 76;
  const keysWidth = () => (twoColumn() ? Math.min(54, Math.max(38, Math.floor(inner() * 0.42))) : inner());
  const commandsWidth = () => (twoColumn() ? inner() - keysWidth() - 3 : inner());
  const keyRows = () => helpRows(KEYS, keysWidth());
  // Chat commands sit under the keys, which leaves the team commands a column
  // of their own and keeps the whole panel on one screen.
  const chatRows = () => helpRows(COMMANDS.filter((entry) => entry.group === "chat"), keysWidth());
  const commandRows = () => helpRows(COMMANDS.filter((entry) => entry.group !== "chat"), commandsWidth());
  const leftRows = () => keyRows().length + chatRows().length + 3;
  const panelHeight = () =>
    4 + (twoColumn() ? Math.max(leftRows(), commandRows().length + 1) : leftRows() + commandRows().length + 2);
  const top = () => Math.max(1, Math.floor((props.height - panelHeight()) / 2));

  return (
    <box
      style={{
        position: "absolute",
        left: Math.max(0, Math.floor((props.width - panelWidth()) / 2)),
        top: top(),
        width: panelWidth(),
        flexDirection: "column",
        maxHeight: Math.max(6, props.height - 2),
        overflow: "hidden",
        backgroundColor: props.theme.surface,
        borderStyle: "rounded",
        borderColor: props.theme.rule,
        paddingLeft: 2,
        paddingRight: 2,
        zIndex: 10,
      }}
      title={` ${GLYPHS.mark} watari `}
      titleColor={props.theme.brand}
      bottomTitle=" esc closes "
    >
      <text> </text>
      <box style={{ flexDirection: twoColumn() ? "row" : "column" }}>
        <box style={{ flexDirection: "column", width: keysWidth() }}>
          <SectionHeading theme={props.theme} label="keys" width={keysWidth()} />
          <HelpList theme={props.theme} rows={keyRows()} />
          <box style={{ height: 1, flexShrink: 0 }} />
          <SectionHeading theme={props.theme} label="chats" width={keysWidth()} />
          <HelpList theme={props.theme} rows={chatRows()} />
        </box>
        <Show when={twoColumn()} fallback={<text> </text>}>
          <box style={{ width: 3 }} />
        </Show>
        <box style={{ flexDirection: "column", width: commandsWidth() }}>
          <SectionHeading theme={props.theme} label="team" width={commandsWidth()} />
          <HelpList theme={props.theme} rows={commandRows()} />
        </box>
      </box>
      <text> </text>
    </box>
  );
}

/**
 * What `/` can still become, with what each one does.
 *
 * The list stays a plain prefix match: a command palette that reorders itself
 * as you type is impossible to build muscle memory against, and these are keys
 * a reader types every few minutes.
 */
export function CommandPalette(props: {
  readonly theme: Theme;
  readonly entries: readonly CommandDoc[];
  readonly selected: number;
  readonly width: number;
  readonly height: number;
  /** Rows under the palette that it must not cover: the composer and status line. */
  readonly below: number;
}) {
  const shown = () => props.entries.slice(0, PALETTE_ROWS);
  const hidden = () => props.entries.length - shown().length;
  const panelWidth = () => Math.min(72, Math.max(38, props.width - 4));
  return (
    <box
      style={{
        position: "absolute",
        left: 2,
        top: Math.max(1, props.height - props.below - shown().length - (hidden() > 0 ? 3 : 2)),
        width: panelWidth(),
        flexDirection: "column",
        backgroundColor: props.theme.surface,
        borderStyle: "rounded",
        borderColor: props.theme.rule,
        paddingLeft: 1,
        paddingRight: 1,
        zIndex: 9,
      }}
      title=" commands "
      titleColor={props.theme.brand}
      bottomTitle=" ↑↓ choose · tab complete · enter runs "
    >
      <For each={shown()}>
        {(entry, index) => {
          const active = () => index() === props.selected;
          return (
            <box style={{ height: 1, flexDirection: "row", backgroundColor: active() ? props.theme.raised : props.theme.surface }}>
              <text fg={active() ? props.theme.brand : props.theme.faint}>
                {active() ? `${GLYPHS.chevron} ` : "  "}
              </text>
              <text fg={active() ? props.theme.text : props.theme.muted} attributes={active() ? BOLD : 0}>
                {padEnd(truncate(entry.usage, 22), 23)}
              </text>
              <text fg={props.theme.faint}>
                {truncate(entry.description, Math.max(8, panelWidth() - 29))}
              </text>
            </box>
          );
        }}
      </For>
      <Show when={hidden() > 0}>
        <text fg={props.theme.faint}>{`  ${hidden()} more, keep typing`}</text>
      </Show>
    </box>
  );
}

const PALETTE_ROWS = 8;

/**
 * Project-local agent overview.
 *
 * Aliases are people and providers are the harness behind them: the tab, the
 * team identity, and the transcript stay put when a model or even a provider
 * changes underneath. The guided picker handles the common add and change
 * paths; the exact commands stay visible for reproducible configuration.
 */
export function AgentOverlay(props: {
  readonly theme: Theme;
  readonly agents: readonly TeamAgent[];
  readonly accents: Accents;
  readonly focused: AgentId | null;
  readonly bridges?: readonly BridgeStatus[];
  readonly width: number;
  readonly height: number;
}) {
  const panelWidth = () => Math.min(92, Math.max(52, props.width - 8));
  const inner = () => panelWidth() - 6;
  return (
    <box
      style={{
        position: "absolute",
        left: Math.max(0, Math.floor((props.width - panelWidth()) / 2)),
        top: Math.max(1, Math.floor((props.height - Math.min(props.agents.length * 3 + 11, props.height - 2)) / 2)),
        width: panelWidth(),
        maxHeight: Math.max(10, props.height - 2),
        flexDirection: "column",
        overflow: "hidden",
        backgroundColor: props.theme.surface,
        borderStyle: "rounded",
        borderColor: props.theme.rule,
        paddingLeft: 2,
        paddingRight: 2,
        zIndex: 11,
      }}
      title={` ${GLYPHS.mark} agents `}
      titleColor={props.theme.brand}
      bottomTitle=" ctrl+p add · ctrl+m model · esc closes "
    >
      <text fg={props.theme.text}>Aliases are conversations. Providers are the native harness behind them.</text>
      <text fg={props.theme.faint}>Watari injects its team bridge into managed sessions and checks it before sending.</text>
      <text> </text>
      <For each={props.agents}>
        {(agent) => {
          const accent = props.accents(agent.id);
          const focused = () => props.focused === agent.id;
          const bridge = () => props.bridges?.find((entry) => entry.agent === agent.id) ?? null;
          const style = stateStyle(agent.state);
          return (
            <box style={{ flexDirection: "column", height: 3 }}>
              <box style={{ flexDirection: "row", height: 1 }}>
                <text fg={focused() ? props.theme.brand : props.theme.faint}>
                  {focused() ? `${GLYPHS.chevron} ` : "  "}
                </text>
                <text fg={accent} attributes={BOLD} selectable>
                  {padEnd(truncate(agent.id, 16), 18)}
                </text>
                <text fg={props.theme.text} selectable>
                  {truncate(
                    joinMeta([providerOf(agent) ?? "unconfigured", agent.model || "provider default"]),
                    Math.max(12, inner() - 20),
                  )}
                </text>
              </box>
              <box style={{ flexDirection: "row", height: 1 }}>
                <text fg={props.theme.faint} selectable>
                  {`    ${truncate(
                    joinMeta([
                      agent.mode ?? "managed",
                      `effort ${agent.effort ?? "default"}`,
                      `permissions ${agent.unrestricted === true ? "bypass" : "ask"}`,
                    ]),
                    Math.max(12, inner() - 20),
                  )}`}
                </text>
                <box style={{ flexGrow: 1 }} />
                <text fg={style.color(props.theme, accent)}>{style.label}</text>
              </box>
              <box style={{ flexDirection: "row", height: 1 }}>
                <Show when={bridge()}>
                  {(status: () => BridgeStatus) => {
                    const look = bridgeStyle(props.theme, status().state);
                    return <text fg={look.color}>{`    ${look.glyph} team bridge ${look.label}  `}</text>;
                  }}
                </Show>
                <text fg={props.theme.muted} selectable>
                  {truncate(agent.detail ?? "not started", inner() - 4)}
                </text>
              </box>
            </box>
          );
        }}
      </For>
      <text> </text>
      <SectionHeading theme={props.theme} label="advanced commands" width={inner()} />
      <text fg={props.theme.text} selectable>{"/models                    guided add from the native catalog"}</text>
      <text fg={props.theme.text} selectable>{"/agent set review claude permissions=prompt"}</text>
      <text fg={props.theme.text} selectable>{"/agent remove review"}</text>
      <text fg={props.theme.faint}>Use mode=external for a provider-owned process that joins through watari mcp.</text>
    </box>
  );
}

/** Read-only provider capacity and routing facts, refreshed from the service. */
export function ProviderStatusOverlay(props: {
  readonly theme: Theme;
  readonly document: ProviderStatusDocument | null;
  readonly busy: boolean;
  readonly width: number;
  readonly height: number;
}) {
  const panelWidth = () => Math.min(110, Math.max(60, props.width - 8));
  const inner = () => panelWidth() - 6;
  const capacityColor = (capacity: string): string => {
    if (capacity === "healthy") return props.theme.ok;
    if (capacity === "unknown") return props.theme.faint;
    return props.theme.warn;
  };
  return (
    <box
      style={{
        position: "absolute",
        left: Math.max(0, Math.floor((props.width - panelWidth()) / 2)),
        top: Math.max(1, Math.floor((props.height - Math.min((props.document?.providers.length ?? 1) * 6 + 8, props.height - 2)) / 2)),
        width: panelWidth(),
        maxHeight: Math.max(10, props.height - 2),
        flexDirection: "column",
        overflow: "hidden",
        backgroundColor: props.theme.surface,
        borderStyle: "rounded",
        borderColor: props.theme.rule,
        paddingLeft: 2,
        paddingRight: 2,
        zIndex: 12,
      }}
      title={` ${GLYPHS.mark} provider status `}
      titleColor={props.theme.brand}
      bottomTitle=" r/enter refresh · esc closes "
    >
      <Show when={!props.document && props.busy}>
        <text fg={props.theme.muted}>Reading CodexLB and TeamClaude status…</text>
      </Show>
      <Show when={!props.document && !props.busy}>
        <text fg={props.theme.faint}>No provider status source is configured.</text>
      </Show>
      <For each={props.document?.providers ?? []}>
        {(group) => {
          const order = group.useOrder.slice(0, 3).map((entry) => `${entry.rank}. ${entry.accountAlias ?? "account"}`).join("  ");
          return (
            <box style={{ flexDirection: "column", height: 6, flexShrink: 0 }}>
              <box style={{ flexDirection: "row", height: 1 }}>
                <text fg={props.theme.text} attributes={BOLD}>{truncate(group.label, Math.max(16, inner() - 34))}</text>
                <box style={{ flexGrow: 1 }} />
                <text fg={capacityColor(group.capacity)}>{`${group.capacity} · ${group.freshness}`}</text>
              </box>
              <text fg={props.theme.muted}>{truncate(
                group.reachable ? `routing ${group.snapshot.currentRoute?.accountAlias ?? "provider chooses"}` : `unreachable${group.error ? `: ${group.error}` : ""}`,
                inner(),
              )}</text>
              <text fg={props.theme.faint}>{truncate(order ? `use order  ${order}` : "use order  not reported", inner())}</text>
              <text fg={group.notice ? props.theme.warn : props.theme.faint}>{truncate(group.notice ?? "no capacity notice", inner())}</text>
              <text fg={props.theme.faint}>{group.observedAt ? `observed ${relativeAge(group.observedAt, props.document?.generatedAt ?? Date.now())} ago` : "not observed"}</text>
              <text> </text>
            </box>
          );
        }}
      </For>
      <Show when={props.document && !props.busy}>
        <text fg={props.theme.faint}>Status reads are provider-owned and credential-free.</text>
      </Show>
    </box>
  );
}

/** An archived chat as the picker lists it. */
export interface ChatPickerEntry {
  readonly id: string;
  readonly title: string;
  readonly updatedAt: number;
  readonly messages: number;
  readonly current: boolean;
}

/**
 * Archived chats, newest first. Enter reopens one, with each agent's own
 * conversation resumed, after archiving the chat that is open now.
 */
export function ChatsOverlay(props: {
  readonly theme: Theme;
  readonly chats: readonly ChatPickerEntry[];
  readonly selected: number;
  readonly now: number;
  readonly width: number;
  readonly height: number;
}) {
  const panelWidth = () => Math.min(100, Math.max(52, props.width - 8));
  const inner = () => panelWidth() - 6;
  const visibleCount = () => Math.max(3, Math.min(props.chats.length, props.height - 10));
  const start = () => Math.max(
    0,
    Math.min(props.selected - Math.floor(visibleCount() / 2), props.chats.length - visibleCount()),
  );
  const visible = () => props.chats.slice(start(), start() + visibleCount());
  return (
    <box
      style={{
        position: "absolute",
        left: Math.max(0, Math.floor((props.width - panelWidth()) / 2)),
        top: Math.max(1, Math.floor((props.height - visibleCount() - 6) / 2)),
        width: panelWidth(),
        flexDirection: "column",
        backgroundColor: props.theme.surface,
        borderStyle: "rounded",
        borderColor: props.theme.rule,
        paddingLeft: 2,
        paddingRight: 2,
        zIndex: 12,
      }}
      title={` ${GLYPHS.mark} chats `}
      titleColor={props.theme.brand}
      bottomTitle=" ↑ ↓ choose · enter resumes · esc closes "
    >
      <text fg={props.theme.faint}>
        {truncate("Resuming archives the open chat and brings each agent's own conversation back.", inner())}
      </text>
      <text> </text>
      <For each={props.chats.length === 0 ? [true] : []}>
        {() => <text fg={props.theme.muted}>{"  no archived chats yet; /new archives the open one"}</text>}
      </For>
      <For each={visible()}>
        {(chat, index) => {
          const position = () => start() + index();
          const active = () => position() === props.selected;
          const age = () => relativeAge(chat.updatedAt, props.now);
          const meta = () => `${chat.messages} msg · ${age() === "now" ? "just now" : `${age()} ago`}`;
          return (
            <box style={{ flexDirection: "row", height: 1, backgroundColor: active() ? props.theme.raised : props.theme.surface }}>
              <text fg={active() ? props.theme.brand : props.theme.faint}>
                {active() ? `${GLYPHS.chevron} ` : "  "}
              </text>
              <text fg={props.theme.faint}>{padEnd(String(position() + 1), 3)}</text>
              <text fg={active() ? props.theme.text : props.theme.muted} attributes={active() ? BOLD : 0}>
                {truncate(chat.title, Math.max(12, inner() - cellWidth(meta()) - 16))}
              </text>
              <text fg={props.theme.ok}>{chat.current ? "  open" : ""}</text>
              <box style={{ flexGrow: 1 }} />
              <text fg={props.theme.faint}>{meta()}</text>
            </box>
          );
        }}
      </For>
    </box>
  );
}
