const DEFAULT_MAX_LINE_BYTES = 8 * 1024 * 1024;

export type JsonLineResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: string; readonly raw: string };

export class JsonLineDecoder {
  readonly #decoder = new TextDecoder("utf-8", { fatal: false });
  readonly #maxLineBytes: number;
  #buffer = "";

  constructor(maxLineBytes = DEFAULT_MAX_LINE_BYTES) {
    this.#maxLineBytes = maxLineBytes;
  }

  push(chunk: Uint8Array): JsonLineResult[] {
    this.#buffer += this.#decoder.decode(chunk, { stream: true });
    this.#assertBounded();
    return this.#drain(false);
  }

  finish(): JsonLineResult[] {
    this.#buffer += this.#decoder.decode();
    this.#assertBounded();
    return this.#drain(true);
  }

  #assertBounded(): void {
    if (Buffer.byteLength(this.#buffer, "utf8") > this.#maxLineBytes) {
      this.#buffer = "";
      throw new Error(`JSONL line exceeded ${this.#maxLineBytes} bytes`);
    }
  }

  #drain(includeRemainder: boolean): JsonLineResult[] {
    const lines = this.#buffer.split("\n");
    this.#buffer = includeRemainder ? "" : (lines.pop() ?? "");
    return lines
      .map((line) => line.trimEnd())
      .filter(Boolean)
      .map(parseJsonLine);
  }
}

function parseJsonLine(raw: string): JsonLineResult {
  try {
    return { ok: true, value: JSON.parse(raw) as unknown };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `malformed JSONL: ${reason}`, raw };
  }
}
