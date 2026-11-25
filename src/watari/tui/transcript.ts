import type { ActivitySummary } from "../activity/types.ts";
import type { TeamAgent } from "../state/types.ts";
import {
  entriesMarkdown,
  entryMarkdown,
  speakerNames,
  type TranscriptEntry,
} from "../chat/entries.ts";
import { cellWidth, clockTime, padEnd, truncate } from "./format.ts";
import { parseBlocks, renderProse } from "./markdown.ts";
import { GLYPHS, createAccents, eventColor, priorityStyle, type Accents, type Theme } from "./theme.ts";

// The chat model is core. It is re-exported here so the TUI keeps one import.
export {
  buildEntries,
  lastSpokenEntry,
  pendingApprovals,
  type TranscriptEntry,
} from "../chat/entries.ts";

/** One coloured run inside a transcript row. */
export interface RowSpan {
  readonly text: string;
  readonly color: string;
  readonly bold?: boolean;
  readonly dim?: boolean;
}

/** A single rendered terminal row. `trailing` is pushed to the right edge. */
export interface TranscriptRow {
  readonly key: string;
  readonly spans: readonly RowSpan[];
  readonly trailing?: readonly RowSpan[];
  readonly activity?: ActivitySummary;
}

type WorkEntry = Extract<TranscriptEntry, { kind: "work" }>;

/**
 * Everything the layout needs to know about who is speaking.
 *
 * Names and colours come from the live roster rather than from the alias, so a
 * peer called `reviewer` is drawn in its harness's colour and titled the way
 * its own client titles it. The name column is measured once from that roster,
 * so a long alias cannot ragged-edge the activity lines under it.
 */
export interface TranscriptView {
  readonly theme: Theme;
  readonly accent: Accents;
  readonly name: (agent: string | null | undefined) => string;
  readonly nameColumn: number;
  /** Configured peers, in roster order, as the welcome screen names them. */
  readonly peers: readonly string[];
}

const MIN_NAME_COLUMN = 8;
const MAX_NAME_COLUMN = 16;

export function transcriptView(theme: Theme, agents: readonly TeamAgent[]): TranscriptView {
  const name = speakerNames(agents);
  const widest = Math.max(
    MIN_NAME_COLUMN - 1,
    ...agents.map((agent) => cellWidth(agent.displayName.trim() || agent.id)),
  );
  return {
    theme,
    accent: createAccents(theme, agents),
    name,
    nameColumn: Math.min(MAX_NAME_COLUMN, widest + 1),
    peers: agents.map((agent) => agent.displayName.trim() || agent.id),
  };
}

const GUTTER = 3;
/**
 * The one column every transcript row puts its marker in.
 *
 * A marker is whatever says what kind of row this is: a message's coloured
 * rail, a step's outcome glyph, a note's bullet, an activity card's disclosure
 * triangle. Each was drawn at its own depth, so a rail started a line two
 * columns in, a triangle three, and a check four, and the left edge of the pane
 * read as ragged even though every row was internally tidy. Marker in one
 * column, body in the next, and the body edge runs straight down the pane.
 */
function marker(glyph: string): string {
  return ` ${glyph} `;
}
/** Reasoning is context, not the answer, so a long block is capped. */
const MAX_THINKING_LINES = 8;
/** A run of routine steps longer than this is collapsed to its recent tail. */
const MAX_WORK_RUN = 7;
const WORK_RUN_TAIL = 5;

/**
 * Lays entries out into terminal rows. Messages keep a coloured rail down their
 * whole block so a wrapped paragraph never reads as several separate lines;
 * routine activity stays on one dim line so it cannot shout over the peers.
 */
export function layoutTranscript(
  entries: readonly TranscriptEntry[],
  view: TranscriptView,
  width: number,
): TranscriptRow[] {
  const theme = view.theme;
  const rows: TranscriptRow[] = [];
  const bodyWidth = Math.max(8, width - GUTTER - 1);
  let previous: TranscriptEntry["kind"] | null = null;
  let index = 0;

  while (index < entries.length) {
    const entry = entries[index];
    if (!entry) break;

    // Consecutive steps are one run so a long build does not push the answer
    // that follows it off the top of the pane.
    if (entry.kind === "work") {
      let end = index;
      while (entries[end]?.kind === "work") end += 1;
      if (previous === "message" || previous === "speech") {
        rows.push(blank(`${entry.key}-gap`, theme));
      }
      pushWorkRun(rows, entries.slice(index, end) as WorkEntry[], view, width);
      previous = "work";
      index = end;
      continue;
    }

    const prose = entry.kind === "message" || entry.kind === "speech";
    if (prose ? previous !== null : previous === "message" || previous === "speech") {
      rows.push(blank(`${entry.key}-gap`, theme));
    }
    if (entry.kind === "message") {
      pushMessage(rows, entry, view, bodyWidth);
    } else if (entry.kind === "speech") {
      pushSpeech(rows, entry, view, bodyWidth);
    } else if (entry.kind === "activity") {
      rows.push({ key: entry.key, spans: [], activity: entry.summary });
    } else {
      pushNote(rows, entry, view, width);
    }
    previous = entry.kind;
    index += 1;
  }

  return rows;
}

function blank(key: string, theme: Theme): TranscriptRow {
  return { key, spans: [{ text: " ", color: theme.faint }] };
}

function pushMessage(
  rows: TranscriptRow[],
  entry: Extract<TranscriptEntry, { kind: "message" }>,
  view: TranscriptView,
  bodyWidth: number,
): void {
  const theme = view.theme;
  const priority = priorityStyle(theme, entry.priority);
  const accent = entry.system
    ? priority?.color ?? theme.warn
    : view.accent(entry.accent ?? entry.sender);
  const rail: RowSpan = { text: ` ${GLYPHS.rail} `, color: accent };

  const header: RowSpan[] = [
    rail,
    { text: view.name(entry.sender), color: accent, bold: true },
    { text: ` ${GLYPHS.arrow} `, color: theme.faint },
    { text: entry.audience, color: theme.muted },
  ];
  if (priority) {
    header.push({ text: `  ${priority.label}`, color: priority.color, bold: true });
  }

  rows.push({
    key: `${entry.key}-h`,
    spans: header,
    trailing: [{ text: clockTime(entry.timestamp), color: theme.faint }],
  });

  const lines = renderProse(entry.body, theme, bodyWidth, {
    bodyColor: entry.system ? theme.warn : theme.text,
  });
  for (const [index, line] of lines.entries()) {
    rows.push({ key: `${entry.key}-b${index}`, spans: [rail, ...line.spans] });
  }
}

/**
 * A peer's own output. It gets the same rail treatment as a peer message
 * because it is the same thing to a reader: one voice speaking in paragraphs.
 * Reasoning uses a lighter rail and is capped, since it is context rather than
 * the answer.
 */
function pushSpeech(
  rows: TranscriptRow[],
  entry: Extract<TranscriptEntry, { kind: "speech" }>,
  view: TranscriptView,
  bodyWidth: number,
): void {
  const theme = view.theme;
  const accent = view.accent(entry.agent);
  const rail: RowSpan = {
    text: ` ${entry.thinking ? GLYPHS.railSoft : GLYPHS.rail} `,
    color: entry.thinking ? theme.faint : accent,
  };

  rows.push({
    key: `${entry.key}-h`,
    spans: [
      rail,
      {
        text: entry.thinking ? view.name(entry.agent).toLowerCase() : view.name(entry.agent),
        color: entry.thinking ? theme.faint : accent,
        bold: !entry.thinking,
      },
      ...(entry.thinking ? [{ text: "  thinking", color: theme.faint }] : []),
    ],
    trailing: [{ text: clockTime(entry.timestamp), color: theme.faint }],
  });

  const lines = renderProse(entry.body, theme, bodyWidth, {
    bodyColor: entry.thinking ? theme.muted : theme.text,
    ...(entry.thinking ? { muted: true } : {}),
  });
  const shown = entry.thinking ? lines.slice(0, MAX_THINKING_LINES) : lines;
  for (const [index, line] of shown.entries()) {
    rows.push({ key: `${entry.key}-b${index}`, spans: [rail, ...line.spans] });
  }
  const hidden = lines.length - shown.length;
  if (hidden > 0) {
    rows.push({
      key: `${entry.key}-more`,
      spans: [rail, { text: `${GLYPHS.ellipsis} ${hidden} more thinking lines`, color: theme.faint }],
    });
  }
}

/**
 * A run of consecutive steps.
 *
 * Everything unfinished or failed is always shown, because that is what a
 * reader is looking for. A long tail of successful routine steps is collapsed
 * to a count so a hundred-file search cannot bury the answer that follows it.
 */
function pushWorkRun(
  rows: TranscriptRow[],
  run: readonly WorkEntry[],
  view: TranscriptView,
  width: number,
): void {
  const theme = view.theme;
  const shown =
    run.length <= MAX_WORK_RUN
      ? run
      : run.filter(
          (entry, index) =>
            entry.state !== "done" || index >= run.length - WORK_RUN_TAIL,
        );
  const hidden = run.length - shown.length;

  if (hidden > 0) {
    const first = shown[0] ?? run[0];
    rows.push({
      key: `${first?.key ?? "run"}-collapsed`,
      spans: [
        { text: marker(GLYPHS.bullet), color: theme.faint },
        { text: padEnd(view.name(run[0]?.agent), view.nameColumn), color: theme.faint, dim: true },
        { text: `${hidden} earlier steps`, color: theme.faint },
      ],
    });
  }
  for (const entry of shown) {
    pushWork(rows, entry, view, width);
  }
}

/** One unit of work on one line: what ran, on what, and how it ended. */
function pushWork(
  rows: TranscriptRow[],
  entry: WorkEntry,
  view: TranscriptView,
  width: number,
): void {
  const theme = view.theme;
  const accent = view.accent(entry.agent);
  const glyph =
    entry.state === "running"
      ? GLYPHS.workRunning
      : entry.state === "failed"
      ? GLYPHS.workFailed
      : GLYPHS.workDone;
  const glyphColor =
    entry.state === "running" ? theme.muted : entry.state === "failed" ? theme.danger : theme.ok;

  const head: RowSpan[] = [
    { text: marker(glyph), color: glyphColor },
    { text: padEnd(view.name(entry.agent), view.nameColumn), color: accent, dim: true },
    { text: padEnd(entry.verb, 7), color: entry.state === "failed" ? theme.danger : theme.muted },
  ];
  const used = head.reduce((total, span) => total + cellWidth(span.text), 0);
  rows.push({
    key: entry.key,
    spans: [...head, { text: truncate(entry.detail, Math.max(8, width - used - 2)), color: theme.faint }],
  });
}

/** Service and provider notices. Loud ones keep a timestamp; the rest do not. */
function pushNote(
  rows: TranscriptRow[],
  entry: Extract<TranscriptEntry, { kind: "note" }>,
  view: TranscriptView,
  width: number,
): void {
  const theme = view.theme;
  const accent = view.accent(entry.agent);
  const color = eventColor(theme, entry.type);
  const loud = entry.type === "error" || entry.type === "warning" || entry.type === "approval";
  const label = view.name(entry.agent);

  const head: RowSpan[] = [
    { text: marker(GLYPHS.bullet), color: theme.faint },
    { text: padEnd(label, view.nameColumn), color: entry.agent ? accent : theme.faint, dim: !loud },
  ];
  if (loud) {
    head.push({ text: padEnd(entry.type.replace(/_/gu, " "), 9), color, bold: true });
  }
  const used = head.reduce((total, span) => total + cellWidth(span.text), 0);
  const trailing = loud ? clockTime(entry.timestamp) : "";
  const room = Math.max(8, width - used - (trailing ? cellWidth(trailing) + 4 : 2));
  const detail = entry.requestId ? `${entry.summary}  ${entry.requestId}` : entry.summary;

  rows.push({
    key: entry.key,
    spans: [...head, { text: truncate(detail, room), color: loud ? theme.muted : theme.faint }],
    ...(trailing ? { trailing: [{ text: trailing, color: theme.faint }] } : {}),
  });
}

/** Shown before the first goal exists, in place of an empty pane. */
export function welcomeRows(view: TranscriptView, width: number): TranscriptRow[] {
  const theme = view.theme;
  const indent = " ".repeat(GUTTER);
  const room = Math.max(20, width - GUTTER - 1);
  const rows: TranscriptRow[] = [
    blank("w-top", theme),
    {
      key: "w-title",
      spans: [
        { text: marker(GLYPHS.mark), color: theme.brand },
        { text: "watari", color: theme.text, bold: true },
      ],
    },
    {
      key: "w-tagline",
      spans: [{ text: indent + truncate("native coding agents, one checkout, equal peers", room), color: theme.faint }],
    },
    blank("w-gap", theme),
    ...rosterRows(view, room, indent),
    blank("w-gap2", theme),
  ];
  // Say what the next keystroke will actually do. A message goes to the tab it
  // was typed in, and broadcasting is the deliberate act, not the default.
  const steps: readonly (readonly [string, string])[] = [
    ["send", "your first message opens the shared goal and goes to the peer whose tab you are on."],
    ["share", "global (ctrl+t) or /all is the explicit broadcast to every ready peer."],
    ["close", "later messages follow up inside that goal until you run /done."],
  ];
  const label = Math.max(...steps.map(([name]) => cellWidth(name)));
  const hang = indent + " ".repeat(3 + label + 2);
  for (const [index, [name, text]] of steps.entries()) {
    const wrapped = renderProse(text, theme, Math.max(12, width - cellWidth(hang) - 1), { bodyColor: theme.muted });
    for (const [line, prose] of wrapped.entries()) {
      rows.push({
        key: `w-step-${index}-${line}`,
        spans: line === 0
          ? [
            { text: `${indent}${index + 1}  `, color: theme.brand, bold: true },
            { text: `${padEnd(name, label)}  `, color: theme.text },
            ...prose.spans,
          ]
          : [{ text: hang, color: theme.faint }, ...prose.spans],
      });
    }
  }
  rows.push(blank("w-gap3", theme));
  rows.push(...keyRows(theme, room, indent));
  return rows;
}

/** The roster in identity colours, so the first screen already teaches them. */
function rosterRows(view: TranscriptView, room: number, indent: string): TranscriptRow[] {
  const theme = view.theme;
  const peers = view.peers;
  const tail = peers.length > 1 ? "  share this checkout as equal peers" : "  shares this checkout with you";
  const named = peers.join("  ·  ");
  if (peers.length > 0 && cellWidth(named) + cellWidth(tail) <= room) {
    const spans: RowSpan[] = [{ text: indent, color: theme.faint }];
    for (const [index, peer] of peers.entries()) {
      if (index > 0) spans.push({ text: `  ${GLYPHS.bullet}  `, color: theme.rule });
      spans.push({ text: peer, color: view.accent(peer), bold: true });
    }
    spans.push({ text: tail, color: theme.muted });
    return [{ key: "w-roster", spans }];
  }
  return renderProse(rosterSentence(peers), theme, room, { bodyColor: theme.muted }).map((prose, index) => ({
    key: `w-roster-${index}`,
    spans: [{ text: indent, color: theme.faint }, ...prose.spans],
  }));
}

/** The keys a first-time reader needs, packed into as few rows as fit. */
function keyRows(theme: Theme, room: number, indent: string): TranscriptRow[] {
  const hints: readonly (readonly [string, string])[] = [
    ["ctrl+g", "help"],
    ["ctrl+p", "add an agent"],
    ["ctrl+shift+c", "copy"],
    ["ctrl+c", "clear, twice to detach"],
  ];
  const rows: TranscriptRow[] = [];
  let spans: RowSpan[] = [];
  let used = 0;
  for (const [key, description] of hints) {
    const text = ` ${truncate(description, Math.max(4, room - cellWidth(key) - 1))}`;
    const needed = cellWidth(key) + cellWidth(text);
    if (used > 0 && used + 4 + needed > room) {
      rows.push({ key: `w-keys-${rows.length}`, spans: [{ text: indent, color: theme.faint }, ...spans] });
      spans = [];
      used = 0;
    }
    if (used > 0) {
      spans.push({ text: "    ", color: theme.faint });
      used += 4;
    }
    spans.push({ text: key, color: theme.text, bold: true });
    spans.push({ text, color: theme.faint });
    used += needed;
  }
  if (spans.length > 0) rows.push({ key: `w-keys-${rows.length}`, spans: [{ text: indent, color: theme.faint }, ...spans] });
  return rows;
}

/** Names the peers that are actually configured, rather than assuming two. */
function rosterSentence(peers: readonly string[]): string {
  if (peers.length === 0) return "no agent is configured yet; ctrl+p adds one from its native catalog.";
  if (peers.length === 1) return `${peers[0]} shares this checkout with you.`;
  const last = peers.at(-1) ?? "";
  return `${peers.slice(0, -1).join(", ")} and ${last} share this checkout as equal peers.`;
}

/**
 * A dragged selection as the reader meant it, without Watari's scaffolding.
 *
 * The rail down the left of a message is what makes a wrapped paragraph read as
 * one voice, and the terminal's selection cannot know it is decoration: it is
 * text in the same buffer as the words. Dropping the drag origin from the
 * selection is not an option either, because a selection has to be able to
 * start there. So Watari, which drew the rail, removes it again on the way to
 * the clipboard, and turns its quote marker back into Markdown while it is
 * there.
 */
export function plainSelection(text: string): string {
  const lines = text.split("\n").map((line) =>
    line
      .replace(/^ [\u2503\u2506] /u, "")
      .replace(/^\u2506 /u, "> ")
      .trimEnd(),
  );
  return lines.join("\n").replace(/\n{3,}/gu, "\n\n").trim();
}

/**
 * The newest fenced code block in the conversation, as plain text.
 *
 * A long fence is clipped on screen, so without this the only way to get the
 * whole thing was to scroll and drag. Reasoning is skipped for the same reason
 * it is skipped by "the last reply": it is context, not the answer.
 */
export function lastCodeBlock(entries: readonly TranscriptEntry[]): string | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry) continue;
    if (entry.kind !== "message" && entry.kind !== "speech") continue;
    if (entry.kind === "speech" && entry.thinking) continue;
    const blocks = parseBlocks(entry.body).filter((block) => block.kind === "code");
    const last = blocks.at(-1);
    if (last && last.kind === "code" && last.lines.length > 0) return last.lines.join("\n");
  }
  return null;
}

/** One entry as the Markdown a reader would paste somewhere else. */
export function entryToMarkdown(entry: TranscriptEntry, view: TranscriptView): string {
  return entryMarkdown(entry, view.name);
}

/** The visible conversation as Markdown, reasoning left out. */
export function transcriptToMarkdown(
  entries: readonly TranscriptEntry[],
  view: TranscriptView,
): string {
  return entriesMarkdown(entries, view.name);
}
