import { redactSecrets, stripTerminalControl } from "../security/redaction.ts";
import type { ContentRetention } from "./types.ts";

export const MAX_ACTIVITY_DETAIL_BYTES = 256 * 1024;
export const MAX_ACTIVITY_COMMAND_BYTES = 64 * 1024;
export const DEFAULT_MCP_DETAIL_BYTES = 16 * 1024;
export const MAX_MCP_DETAIL_BYTES = 64 * 1024;

export interface RetainedText {
  readonly text: string;
  readonly retention: ContentRetention;
}

/** Redacts and strips terminal controls before applying a byte, not code-unit, cap. */
export function retainActivityText(value: string, maximumBytes: number): RetainedText {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
    throw new Error("activity text limit must be a non-negative safe integer");
  }
  const safe = stripTerminalControl(redactSecrets(value));
  const encoded = Buffer.from(safe, "utf8");
  const originalLines = lineCount(safe);
  if (encoded.byteLength <= maximumBytes) {
    return {
      text: safe,
      retention: retention(encoded.byteLength, encoded.byteLength, 0, originalLines, originalLines),
    };
  }

  const largestMarker = omissionMarker(encoded.byteLength, originalLines);
  const contentBudget = Math.max(0, maximumBytes - Buffer.byteLength(largestMarker, "utf8"));
  const headBytes = Math.ceil(contentBudget * 0.6);
  const tailBytes = contentBudget - headBytes;
  const head = boundedSlice(safe, headBytes, true);
  const tail = boundedSlice(safe, tailBytes, false);
  const retainedContentBytes = Buffer.byteLength(head, "utf8") + Buffer.byteLength(tail, "utf8");
  const omittedBytes = Math.max(0, encoded.byteLength - retainedContentBytes);
  const retainedLines = Math.min(originalLines, lineCount(head) + lineCount(tail));
  const omittedLines = Math.max(0, originalLines - retainedLines);
  const marker = omissionMarker(omittedBytes, omittedLines);
  const text = Buffer.byteLength(marker, "utf8") <= maximumBytes
    ? `${head}${marker}${tail}`
    : boundedSlice(marker, maximumBytes, true);
  return {
    text,
    retention: retention(
      encoded.byteLength,
      Buffer.byteLength(text, "utf8"),
      omittedBytes,
      originalLines,
      retainedLines,
    ),
  };
}

export function combineRetention(
  values: readonly ContentRetention[],
  retainedBytes?: number,
): ContentRetention {
  const originalBytes = values.reduce((total, value) => total + value.originalBytes, 0);
  const retained = retainedBytes ?? values.reduce((total, value) => total + value.retainedBytes, 0);
  const originalLines = values.reduce((total, value) => total + value.originalLines, 0);
  const retainedLines = values.reduce((total, value) => total + value.retainedLines, 0);
  return retention(
    originalBytes,
    retained,
    values.reduce((total, value) => total + value.omittedBytes, 0),
    originalLines,
    retainedLines,
  );
}

export function emptyRetention(): ContentRetention {
  return retention(0, 0, 0, 0, 0);
}

function retention(
  originalBytes: number,
  retainedBytes: number,
  omittedBytes: number,
  originalLines: number,
  retainedLines: number,
): ContentRetention {
  return {
    truncated: omittedBytes > 0,
    originalBytes,
    retainedBytes,
    omittedBytes,
    originalLines,
    retainedLines,
    omittedLines: Math.max(0, originalLines - retainedLines),
  };
}

function omissionMarker(bytes: number, lines: number): string {
  return `\n[WATARI OMITTED ${bytes} BYTES / ${lines} LINES]\n`;
}

function lineCount(value: string): number {
  return value === "" ? 0 : value.split("\n").length;
}

function boundedSlice(value: string, maximumBytes: number, fromHead: boolean): string {
  if (maximumBytes <= 0 || value === "") return "";
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = fromHead ? value.slice(0, middle) : value.slice(value.length - middle);
    if (Buffer.byteLength(candidate, "utf8") <= maximumBytes) low = middle;
    else high = middle - 1;
  }
  let result = fromHead ? value.slice(0, low) : value.slice(value.length - low);
  if (fromHead && /[\uD800-\uDBFF]$/u.test(result)) result = result.slice(0, -1);
  if (!fromHead && /^[\uDC00-\uDFFF]/u.test(result)) result = result.slice(1);
  return result;
}
