import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const MAX_ENTRIES = 200;
const MAX_ENTRY_CHARS = 4_000;

/**
 * What the reader has sent, recalled with Up and Down like a shell.
 *
 * Kept per project beside the chat state, so a message retyped after a detach
 * or a restart is one key away. Recall starts from an empty composer only, so
 * Up never throws away text being written. A pasted block is not kept: the
 * composer shows it as a marker that means nothing once the paste is gone.
 */
export class ComposerHistory {
  readonly #path: string | null;
  #entries: string[];
  /** Position while recalling, counted back from the newest. Null when not recalling. */
  #cursor: number | null = null;

  constructor(path: string | null) {
    this.#path = path;
    this.#entries = path ? load(path) : [];
  }

  get entries(): readonly string[] {
    return this.#entries;
  }

  push(text: string): void {
    this.#cursor = null;
    const entry = text.trim();
    if (!entry || entry.length > MAX_ENTRY_CHARS || /\[pasted #\d+/u.test(entry)) return;
    if (this.#entries.at(-1) === entry) return;
    this.#entries = [...this.#entries.filter((existing) => existing !== entry), entry].slice(-MAX_ENTRIES);
    this.#save();
  }

  /** The entry before the one shown, or null when there is nothing older. */
  previous(): string | null {
    if (this.#entries.length === 0) return null;
    const next = this.#cursor === null ? 0 : Math.min(this.#cursor + 1, this.#entries.length - 1);
    this.#cursor = next;
    return this.#entries[this.#entries.length - 1 - next] ?? null;
  }

  /** The entry after the one shown, or the empty composer past the newest. */
  next(): string | null {
    if (this.#cursor === null) return null;
    if (this.#cursor === 0) {
      this.#cursor = null;
      return "";
    }
    this.#cursor -= 1;
    return this.#entries[this.#entries.length - 1 - this.#cursor] ?? "";
  }

  get recalling(): boolean {
    return this.#cursor !== null;
  }

  /** The reader typed, so the next Up starts from the newest again. */
  reset(): void {
    this.#cursor = null;
  }

  #save(): void {
    if (!this.#path) return;
    try {
      mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });
      const staging = `${this.#path}.${process.pid}.tmp`;
      writeFileSync(staging, `${JSON.stringify(this.#entries)}\n`, { mode: 0o600 });
      renameSync(staging, this.#path);
      chmodSync(this.#path, 0o600);
    } catch {
      // History is a convenience. A read-only state directory must not stop a send.
    }
  }
}

function load(path: string): string[] {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string").slice(-MAX_ENTRIES)
      : [];
  } catch {
    return [];
  }
}
