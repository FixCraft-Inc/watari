import { describe, expect, test } from "bun:test";

import {
  cellWidth,
  clockTime,
  displayPath,
  joinMeta,
  padEnd,
  relativeAge,
  singleLine,
  summarizePaths,
  truncate,
  wrapText,
} from "../src/watari/tui/format.ts";

describe("tui text measurement", () => {
  test("counts wide glyphs as two cells", () => {
    expect(cellWidth("codex")).toBe(5);
    expect(cellWidth("課題")).toBe(4);
  });

  test("truncate never exceeds the requested width", () => {
    for (const width of [1, 2, 5, 12, 40]) {
      expect(cellWidth(truncate("a fairly long transcript line", width))).toBeLessThanOrEqual(width);
    }
    expect(truncate("short", 40)).toBe("short");
  });

  test("padEnd fills to the column width without overflowing", () => {
    expect(padEnd("codex", 8)).toBe("codex   ");
    expect(padEnd("a-very-long-agent-name", 8)).toBe("a-very-long-agent-name");
  });
});

describe("tui wrapping", () => {
  test("wraps on word boundaries within the given width", () => {
    const lines = wrapText("the delivery queue drops urgent peer messages", 20);
    for (const line of lines) {
      expect(cellWidth(line)).toBeLessThanOrEqual(20);
    }
    expect(lines.join(" ")).toBe("the delivery queue drops urgent peer messages");
  });

  test("hard breaks a token that cannot fit", () => {
    const lines = wrapText("src/watari/service/runtime.ts", 10);
    for (const line of lines) {
      expect(cellWidth(line)).toBeLessThanOrEqual(10);
    }
    expect(lines.join("")).toBe("src/watari/service/runtime.ts");
  });

  test("keeps author newlines and never returns zero lines", () => {
    expect(wrapText("first\nsecond", 20)).toEqual(["first", "second"]);
    expect(wrapText("", 20)).toEqual([""]);
  });
});

describe("tui labels", () => {
  test("collapses the home directory and then trims from the left", () => {
    expect(displayPath("/home/dev/src/watari", "/home/dev", 40)).toBe("~/src/watari");
    expect(cellWidth(displayPath("/home/dev/a/b/c/d/e/f/g", "/home/dev", 12))).toBeLessThanOrEqual(12);
    expect(displayPath("/srv/watari", undefined, 40)).toBe("/srv/watari");
  });

  test("reports compact ages", () => {
    const now = Date.parse("2026-08-23T12:00:00Z");
    expect(relativeAge(now - 2_000, now)).toBe("now");
    expect(relativeAge(now - 45_000, now)).toBe("45s");
    expect(relativeAge(now - 240_000, now)).toBe("4m");
    expect(relativeAge(now - 7_200_000, now)).toBe("2h");
    expect(relativeAge(now - 172_800_000, now)).toBe("2d");
  });

  test("falls back to file names when claim paths do not fit", () => {
    const paths = ["src/watari/service/runtime.ts", "src/watari/util/async-queue.ts"];
    expect(summarizePaths(paths, 80)).toContain("src/watari/service/runtime.ts");
    expect(summarizePaths(paths, 30)).toBe("runtime.ts  async-queue.ts");
  });

  test("joins only the parts that exist", () => {
    expect(joinMeta(["codex ready", null, false, "no goal"])).toBe("codex ready  ·  no goal");
  });

  test("collapses provider chatter onto one line", () => {
    expect(singleLine("read\n  src/watari/models.ts \t")).toBe("read src/watari/models.ts");
  });

  test("formats a 24 hour clock", () => {
    expect(clockTime(Date.parse("2026-08-23T09:07:00"))).toMatch(/^\d{2}:\d{2}$/u);
  });
});
