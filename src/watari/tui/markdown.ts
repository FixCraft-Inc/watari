import { cellWidth, truncate } from "./format.ts";
import { GLYPHS, type Theme } from "./theme.ts";
import type { RowSpan } from "./transcript.ts";

/**
 * Renders what a model actually wrote.
 *
 * Both native harnesses answer in Markdown, because that is what their own
 * clients render. Printing that markup verbatim is what makes a transcript read
 * like a log file: the reader sees `**` and triple backticks instead of
 * emphasis and a code block, and a numbered plan collapses into one grey
 * paragraph.
 *
 * This is deliberately a small subset — the constructs a coding model reaches
 * for in a chat reply. Anything it does not recognise falls through as plain
 * text, so an unusual document degrades into exactly what it looks like now
 * rather than into something mangled.
 */

export type InlineStyle = "plain" | "strong" | "emphasis" | "code" | "link";

export interface InlineToken {
  readonly text: string;
  readonly style: InlineStyle;
}

export type ProseBlock =
  | { readonly kind: "paragraph"; readonly tokens: readonly InlineToken[] }
  | { readonly kind: "heading"; readonly level: number; readonly tokens: readonly InlineToken[] }
  | {
      readonly kind: "list";
      readonly marker: string;
      readonly depth: number;
      readonly tokens: readonly InlineToken[];
    }
  | { readonly kind: "quote"; readonly tokens: readonly InlineToken[] }
  | { readonly kind: "code"; readonly language: string; readonly lines: readonly string[] }
  | { readonly kind: "rule" }
  | { readonly kind: "blank" };

const FENCE = /^\s{0,3}(?:```|~~~)\s*([\w+#.-]*)\s*$/u;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*)$/u;
const BULLET = /^(\s*)([-*+])\s+(.*)$/u;
const ORDERED = /^(\s*)(\d{1,3})[.)]\s+(.*)$/u;
const QUOTE = /^\s{0,3}>\s?(.*)$/u;
const RULE = /^\s{0,3}(?:[-*_]\s*){3,}$/u;

/** Splits a Markdown body into the block structure the transcript lays out. */
export function parseBlocks(body: string): ProseBlock[] {
  const blocks: ProseBlock[] = [];
  const lines = body.replace(/\r\n?/gu, "\n").split("\n");
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    const fence = FENCE.exec(line);
    if (fence) {
      const language = fence[1] ?? "";
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !FENCE.test(lines[index] ?? "")) {
        code.push(lines[index] ?? "");
        index += 1;
      }
      // A closing fence is optional: a streaming reply is regularly read while
      // the block it is writing is still open.
      if (index < lines.length) index += 1;
      blocks.push({ kind: "code", language, lines: code });
      continue;
    }

    index += 1;

    if (line.trim() === "") {
      if (blocks.at(-1)?.kind !== "blank" && blocks.length > 0) {
        blocks.push({ kind: "blank" });
      }
      continue;
    }
    if (RULE.test(line)) {
      blocks.push({ kind: "rule" });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({
        kind: "heading",
        level: (heading[1] ?? "#").length,
        tokens: parseInline(heading[2] ?? ""),
      });
      continue;
    }

    const quote = QUOTE.exec(line);
    if (quote) {
      blocks.push({ kind: "quote", tokens: parseInline(quote[1] ?? "") });
      continue;
    }

    const bullet = BULLET.exec(line);
    if (bullet) {
      blocks.push({
        kind: "list",
        marker: GLYPHS.bullet,
        depth: indentDepth(bullet[1] ?? ""),
        tokens: parseInline(bullet[3] ?? ""),
      });
      continue;
    }

    const ordered = ORDERED.exec(line);
    if (ordered) {
      blocks.push({
        kind: "list",
        marker: `${ordered[2] ?? "1"}.`,
        depth: indentDepth(ordered[1] ?? ""),
        tokens: parseInline(ordered[3] ?? ""),
      });
      continue;
    }

    // Consecutive plain lines are one paragraph. Models hard-wrap prose at
    // their own width, which has nothing to do with this terminal's.
    const paragraph = [line.trim()];
    while (index < lines.length && isParagraphContinuation(lines[index] ?? "")) {
      paragraph.push((lines[index] ?? "").trim());
      index += 1;
    }
    blocks.push({ kind: "paragraph", tokens: parseInline(paragraph.join(" ")) });
  }

  while (blocks.at(-1)?.kind === "blank") blocks.pop();
  return blocks;
}

function isParagraphContinuation(line: string): boolean {
  if (line.trim() === "") return false;
  return !(
    FENCE.test(line) ||
    HEADING.test(line) ||
    BULLET.test(line) ||
    ORDERED.test(line) ||
    QUOTE.test(line) ||
    RULE.test(line)
  );
}

function indentDepth(indent: string): number {
  return Math.min(2, Math.floor(indent.replace(/\t/gu, "  ").length / 2));
}

/**
 * Splits one line into styled runs.
 *
 * Code spans are taken first and are never re-scanned, because a backtick span
 * is the one place a model legitimately writes `**` and means the characters.
 */
export function parseInline(text: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  const pattern = /`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\s][^*]*)\*|\[([^\]]+)\]\(([^)\s]+)\)/gu;
  let cursor = 0;

  for (const match of text.matchAll(pattern)) {
    const start = match.index;
    if (start > cursor) {
      tokens.push({ text: text.slice(cursor, start), style: "plain" });
    }
    if (match[1] !== undefined) {
      tokens.push({ text: match[1], style: "code" });
    } else if (match[2] !== undefined || match[3] !== undefined) {
      tokens.push({ text: match[2] ?? match[3] ?? "", style: "strong" });
    } else if (match[4] !== undefined) {
      tokens.push({ text: match[4], style: "emphasis" });
    } else if (match[5] !== undefined) {
      tokens.push({ text: match[5], style: "link" });
    }
    cursor = start + match[0].length;
  }

  if (cursor < text.length) {
    tokens.push({ text: text.slice(cursor), style: "plain" });
  }
  return tokens.filter((token) => token.text !== "");
}

/**
 * Wraps styled runs to `width`, keeping each run's style across the break.
 *
 * Plain word wrapping cannot be reused here: a line is a sequence of runs, and
 * a bold phrase that straddles the wrap point has to stay bold on both lines.
 */
export function wrapInline(tokens: readonly InlineToken[], width: number): InlineToken[][] {
  if (width <= 0) return [[]];
  const lines: InlineToken[][] = [];
  let line: InlineToken[] = [];
  let used = 0;

  const flush = (): void => {
    lines.push(line);
    line = [];
    used = 0;
  };
  const append = (text: string, style: InlineStyle): void => {
    const last = line.at(-1);
    if (last && last.style === style) {
      line[line.length - 1] = { text: last.text + text, style };
    } else {
      line.push({ text, style });
    }
    used += cellWidth(text);
  };

  // The separator is held back rather than written when it is seen. Appending
  // it eagerly can carry a line one cell past the pane, because a word that
  // exactly fills the line is only followed by a space once the next word
  // arrives — and by then the line has already been measured as fitting.
  let pendingSpace = false;

  for (const token of tokens) {
    // Split on whitespace but keep it, so the gap between two differently
    // styled words survives and a break can be taken at it.
    for (const piece of token.text.split(/(\s+)/u).filter((part) => part !== "")) {
      if (/^\s+$/u.test(piece)) {
        if (used > 0) pendingSpace = true;
        continue;
      }
      let word = piece;
      while (cellWidth(word) > width) {
        // A path or a hash longer than the pane still has to be readable.
        if (used > 0) {
          flush();
          pendingSpace = false;
        }
        const head = sliceCells(word, width);
        append(head, token.style);
        flush();
        word = word.slice(head.length);
      }
      const needed = cellWidth(word) + (pendingSpace && used > 0 ? 1 : 0);
      if (used > 0 && used + needed > width) {
        flush();
        pendingSpace = false;
      }
      if (pendingSpace && used > 0) append(" ", token.style);
      pendingSpace = false;
      append(word, token.style);
    }
  }

  if (line.length > 0 || lines.length === 0) lines.push(line);
  return lines;
}


function sliceCells(value: string, width: number): string {
  let out = "";
  let used = 0;
  for (const character of value) {
    const next = used + cellWidth(character);
    if (next > width) break;
    out += character;
    used = next;
  }
  return out || value.slice(0, 1);
}

export interface ProseLine {
  readonly spans: readonly RowSpan[];
}

export interface ProseOptions {
  /** Colour of ordinary body text. Reasoning passes a dimmer one. */
  readonly bodyColor: string;
  /** Reasoning renders flat: no code tint, no heading weight. */
  readonly muted?: boolean;
}

/**
 * Turns a Markdown body into terminal rows.
 *
 * Everything is laid out to exactly `width` so the caller can prepend a rail
 * without anything overflowing and being silently shrunk by the flex pass.
 */
export function renderProse(
  body: string,
  theme: Theme,
  width: number,
  options: ProseOptions,
): ProseLine[] {
  const lines: ProseLine[] = [];
  const inner = Math.max(8, width);

  for (const block of parseBlocks(body)) {
    switch (block.kind) {
      case "blank":
        lines.push({ spans: [{ text: "", color: theme.faint }] });
        break;

      case "rule":
        lines.push({
          spans: [{ text: GLYPHS.ruleLight.repeat(Math.min(inner, 24)), color: theme.ruleSoft }],
        });
        break;

      case "heading": {
        const color = options.muted ? options.bodyColor : theme.text;
        for (const line of wrapInline(block.tokens, inner)) {
          lines.push({
            spans: line.map((token) => ({
              text: token.text,
              color: token.style === "code" ? theme.info : color,
              bold: !options.muted,
            })),
          });
        }
        break;
      }

      case "quote": {
        const marker = `${GLYPHS.railSoft} `;
        for (const line of wrapInline(block.tokens, Math.max(4, inner - 2))) {
          lines.push({
            spans: [
              { text: marker, color: theme.ruleSoft },
              ...styled(line, theme, { ...options, bodyColor: theme.muted }),
            ],
          });
        }
        break;
      }

      case "list": {
        const indent = "  ".repeat(block.depth);
        const marker = `${indent}${block.marker} `;
        const hanging = " ".repeat(cellWidth(marker));
        const wrapped = wrapInline(block.tokens, Math.max(4, inner - cellWidth(marker)));
        for (const [index, line] of wrapped.entries()) {
          lines.push({
            spans: [
              index === 0
                ? { text: marker, color: options.muted ? options.bodyColor : theme.brand }
                : { text: hanging, color: theme.faint },
              ...styled(line, theme, options),
            ],
          });
        }
        break;
      }

      case "code": {
        if (block.language) {
          lines.push({
            spans: [{ text: `  ${block.language}`, color: theme.faint }],
          });
        }
        // The transcript is inside a scrollbox. Keeping only the first 24
        // lines made a normal provider reply appear to lose content (for
        // example, "… 3 more lines"). Render the complete bounded message
        // and let the pane scroll; copy still uses the original Markdown.
        for (const line of block.lines) {
          lines.push({
            spans: [
              {
                text: `  ${truncate(line.replace(/\t/gu, "  "), Math.max(4, inner - 2))}`,
                color: options.muted ? options.bodyColor : theme.info,
              },
            ],
          });
        }
        break;
      }

      default:
        for (const line of wrapInline(block.tokens, inner)) {
          lines.push({ spans: styled(line, theme, options) });
        }
    }
  }

  return lines.length > 0 ? lines : [{ spans: [{ text: "", color: theme.faint }] }];
}

/** Maps one wrapped line's runs onto themed spans. */
function styled(line: readonly InlineToken[], theme: Theme, options: ProseOptions): RowSpan[] {
  return line.map((token) => {
    if (options.muted) {
      return { text: token.text, color: options.bodyColor, dim: true };
    }
    switch (token.style) {
      case "strong":
        return { text: token.text, color: theme.text, bold: true };
      case "emphasis":
        return { text: token.text, color: options.bodyColor, dim: true };
      case "code":
        return { text: token.text, color: theme.info };
      case "link":
        return { text: token.text, color: theme.info, bold: true };
      default:
        return { text: token.text, color: options.bodyColor };
    }
  });
}

/**
 * The plain text a reader expects on the clipboard.
 *
 * Copying reproduces the source the model wrote rather than the rendered rows:
 * the Markdown is what pastes usefully into an editor or an issue, and the rows
 * carry this terminal's wrap width, which is meaningless anywhere else.
 */
export function proseToPlainText(body: string): string {
  return body.replace(/\r\n?/gu, "\n").replace(/[ \t]+$/gmu, "").trim();
}
