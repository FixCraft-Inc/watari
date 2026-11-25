/**
 * The most the composer holds, matching the most one message may carry.
 * OpenTUI's single-line input otherwise stops at 1,000 characters without
 * saying so, which cut a long task prompt to its first paragraph.
 */
export const COMPOSER_MAX_CHARS = 32_000;

/** A single-line paste longer than this is held as a marker too. */
const INLINE_PASTE_CHARS = 500;

const ANSI_SEQUENCE = /\u001b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/gu;

/** A terminal paste as text, with line endings normalised and escape sequences removed. */
export function decodePaste(bytes: Uint8Array): string {
  return new TextDecoder("utf-8")
    .decode(bytes)
    .replace(/\r\n?/gu, "\n")
    .replace(ANSI_SEQUENCE, "");
}

/**
 * Pasted text the single-line composer cannot show.
 *
 * The composer is one line, so a pasted prompt used to lose every line break,
 * gluing the last word of each line to the first of the next, and anything
 * past 1,000 characters. A multi-line or long paste is now kept whole here and
 * shown in the composer as a short marker, which is expanded back into the
 * exact text when the message is sent.
 */
export class PasteStore {
  readonly #held = new Map<string, string>();
  #next = 1;

  /** Whether a paste should be held rather than typed into the line. */
  static holds(text: string): boolean {
    return text.includes("\n") || text.length > INLINE_PASTE_CHARS;
  }

  /** Keeps `text` and returns the marker that stands for it. */
  hold(text: string): string {
    const lines = text.split("\n").length;
    const size = lines > 1 ? `${lines} lines` : `${text.length} chars`;
    const marker = `[pasted #${this.#next}: ${size}]`;
    this.#next += 1;
    this.#held.set(marker, text);
    return marker;
  }

  /** Replaces every marker still present in `value` with the text it holds. */
  expand(value: string): string {
    let expanded = value;
    for (const [marker, text] of this.#held) {
      expanded = expanded.split(marker).join(text);
    }
    return expanded;
  }

  get size(): number {
    return this.#held.size;
  }

  clear(): void {
    this.#held.clear();
    this.#next = 1;
  }
}
