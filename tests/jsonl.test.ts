import { describe, expect, test } from "bun:test";

import { JsonLineDecoder } from "../src/watari/process/jsonl.ts";

describe("JsonLineDecoder", () => {
  test("reassembles partial lines", () => {
    const decoder = new JsonLineDecoder();
    expect(decoder.push(new TextEncoder().encode('{"ok":'))).toEqual([]);
    expect(decoder.push(new TextEncoder().encode("true}\n"))).toEqual([
      { ok: true, value: { ok: true } },
    ]);
  });

  test("reports malformed lines and continues", () => {
    const decoder = new JsonLineDecoder();
    const results = decoder.push(
      new TextEncoder().encode("not-json\n{\"next\":1}\n"),
    );
    expect(results[0]?.ok).toBe(false);
    expect(results[1]).toEqual({ ok: true, value: { next: 1 } });
  });

  test("bounds unterminated lines", () => {
    const decoder = new JsonLineDecoder(8);
    expect(() => decoder.push(new TextEncoder().encode("123456789"))).toThrow(
      "exceeded 8 bytes",
    );
  });
});
