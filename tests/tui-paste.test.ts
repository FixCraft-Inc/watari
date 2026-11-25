import { describe, expect, test } from "bun:test";

import { PasteStore, decodePaste } from "../src/watari/tui/paste.ts";

describe("pasted text", () => {
  test("multi-line and long pastes are held, short ones are typed", () => {
    expect(PasteStore.holds("one line")).toBe(false);
    expect(PasteStore.holds("two\nlines")).toBe(true);
    expect(PasteStore.holds("x".repeat(501))).toBe(true);
  });

  test("markers expand back to the exact text, and clearing forgets them", () => {
    const store = new PasteStore();
    const first = store.hold("## Load first\n\nSkills: /cpp");
    const second = store.hold("y".repeat(800));
    expect(first).toBe("[pasted #1: 3 lines]");
    expect(second).toBe("[pasted #2: 800 chars]");
    expect(store.expand(`/all ${first} and ${second}`)).toBe(`/all ## Load first\n\nSkills: /cpp and ${"y".repeat(800)}`);
    store.clear();
    expect(store.expand(first)).toBe(first);
    expect(store.hold("a\nb")).toBe("[pasted #1: 2 lines]");
  });

  test("decoding normalises line endings and drops terminal escapes", () => {
    const bytes = new TextEncoder().encode("a\r\nb\rc\u001b[31m red\u001b[0m");
    expect(decodePaste(bytes)).toBe("a\nb\nc red");
  });
});
