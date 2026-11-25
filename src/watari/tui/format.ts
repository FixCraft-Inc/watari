import { GLYPHS } from "./theme.ts";

const HAS_STRING_WIDTH = typeof Bun !== "undefined" && typeof Bun.stringWidth === "function";

/** Terminal cell width of a string, counting wide glyphs as two cells. */
export function cellWidth(value: string): number {
  return HAS_STRING_WIDTH ? Bun.stringWidth(value) : [...value].length;
}

/** Cut to `width` cells, marking the cut with Watari's ellipsis glyph. */
export function truncate(value: string, width: number): string {
  if (width <= 0) return "";
  if (cellWidth(value) <= width) return value;
  if (width === 1) return GLYPHS.ellipsis;
  let out = "";
  let used = 0;
  for (const character of value) {
    const next = used + cellWidth(character);
    if (next > width - 1) break;
    out += character;
    used = next;
  }
  return `${out.trimEnd()}${GLYPHS.ellipsis}`;
}

export function padEnd(value: string, width: number): string {
  const missing = width - cellWidth(value);
  return missing > 0 ? value + " ".repeat(missing) : value;
}

export function padStart(value: string, width: number): string {
  const missing = width - cellWidth(value);
  return missing > 0 ? " ".repeat(missing) + value : value;
}

/** Word wrap that keeps author-supplied newlines and hard-breaks long tokens. */
export function wrapText(value: string, width: number): string[] {
  if (width <= 0) return [];
  const lines: string[] = [];
  for (const paragraph of value.replace(/\r\n?/gu, "\n").split("\n")) {
    if (paragraph.trim() === "") {
      lines.push("");
      continue;
    }
    let current = "";
    for (const word of paragraph.split(/\s+/u).filter(Boolean)) {
      if (current === "") {
        current = word;
      } else if (cellWidth(current) + 1 + cellWidth(word) <= width) {
        current = `${current} ${word}`;
      } else {
        lines.push(current);
        current = word;
      }
      while (cellWidth(current) > width) {
        lines.push(sliceCells(current, width));
        current = dropCells(current, width);
      }
    }
    if (current !== "") lines.push(current);
  }
  return lines.length > 0 ? lines : [""];
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
  return out;
}

function dropCells(value: string, width: number): string {
  return value.slice(sliceCells(value, width).length);
}

export function clockTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Compact age used by the goal strip and peer panel: 12s, 4m, 3h, 2d. */
export function relativeAge(timestamp: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 10) return "now";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** `/home/you/src/watari` renders as `~/src/watari`, then tail-trims to fit. */
export function displayPath(path: string, home: string | undefined, width: number): string {
  let value = path;
  if (home && home.length > 1 && (path === home || path.startsWith(`${home}/`))) {
    value = `~${path.slice(home.length)}`;
  }
  if (cellWidth(value) <= width) return value;
  const segments = value.split("/");
  while (segments.length > 2 && cellWidth(segments.join("/")) > width) {
    segments.splice(0, 1);
  }
  const trimmed = `${GLYPHS.ellipsis}/${segments.join("/")}`;
  return cellWidth(trimmed) <= width ? trimmed : truncate(value, width);
}

/** Claim paths collapse to file names once they no longer fit in full. */
export function summarizePaths(paths: readonly string[], width: number): string {
  const full = paths.join("  ");
  if (cellWidth(full) <= width) return full;
  const names = paths.map((path) => path.split("/").at(-1) ?? path);
  const short = names.join("  ");
  return cellWidth(short) <= width ? short : truncate(short, width);
}

/** Joins non-empty parts with Watari's middle dot separator. */
export function joinMeta(parts: readonly (string | null | undefined | false)[]): string {
  return parts.filter((part): part is string => Boolean(part)).join(`  ${GLYPHS.bullet}  `);
}

/** Collapses provider chatter to one transcript line. */
export function singleLine(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}
