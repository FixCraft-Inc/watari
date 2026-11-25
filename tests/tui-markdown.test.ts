import { describe, expect, test } from "bun:test";

import { cellWidth } from "../src/watari/tui/format.ts";
import {
  parseBlocks,
  parseInline,
  proseToPlainText,
  renderProse,
  wrapInline,
} from "../src/watari/tui/markdown.ts";
import { selectTheme } from "../src/watari/tui/theme.ts";

const theme = selectTheme("dark", true);

function textOf(lines: ReturnType<typeof renderProse>): string {
  return lines.map((line) => line.spans.map((span) => span.text).join("")).join("\n");
}

describe("inline markup", () => {
  test("emphasis and code become styled runs, not literal punctuation", () => {
    expect(parseInline("run **bun test** then `bun run build`")).toEqual([
      { text: "run ", style: "plain" },
      { text: "bun test", style: "strong" },
      { text: " then ", style: "plain" },
      { text: "bun run build", style: "code" },
    ]);
  });

  test("a code span is taken whole, so markup inside it stays literal", () => {
    expect(parseInline("use `a ** b` here")).toEqual([
      { text: "use ", style: "plain" },
      { text: "a ** b", style: "code" },
      { text: " here", style: "plain" },
    ]);
  });

  test("a link keeps its text and drops the target", () => {
    expect(parseInline("see [the docs](https://example.com/x)")).toEqual([
      { text: "see ", style: "plain" },
      { text: "the docs", style: "link" },
    ]);
  });

  test("underscores in identifiers are not emphasis", () => {
    expect(parseInline("call team_send now")).toEqual([
      { text: "call team_send now", style: "plain" },
    ]);
  });

  test("plain prose is one run", () => {
    expect(parseInline("nothing special here")).toEqual([
      { text: "nothing special here", style: "plain" },
    ]);
  });
});

describe("wrapping styled runs", () => {
  test("a phrase that straddles the wrap point keeps its style on both lines", () => {
    const lines = wrapInline(parseInline("**one two three four**"), 9);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      for (const token of line) expect(token.style).toBe("strong");
    }
  });

  test("no wrapped line is wider than the budget", () => {
    const tokens = parseInline("the **delivery queue** is bounded by `SNAPSHOT_INTERVAL_MS` today");
    for (const width of [12, 20, 33]) {
      for (const line of wrapInline(tokens, width)) {
        const used = line.reduce((total, token) => total + cellWidth(token.text), 0);
        expect(used).toBeLessThanOrEqual(width);
      }
    }
  });

  test("a token longer than the pane is broken rather than overflowing", () => {
    const lines = wrapInline(parseInline("src/watari/service/transcript-writer.ts"), 10);
    for (const line of lines) {
      const used = line.reduce((total, token) => total + cellWidth(token.text), 0);
      expect(used).toBeLessThanOrEqual(10);
    }
    expect(lines.map((line) => line.map((token) => token.text).join("")).join("")).toBe(
      "src/watari/service/transcript-writer.ts",
    );
  });
});

describe("block structure", () => {
  test("hard-wrapped prose rejoins into one paragraph", () => {
    const blocks = parseBlocks("a model wraps its own\nprose at its own width");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.kind).toBe("paragraph");
  });

  test("a fenced block keeps its lines verbatim and names its language", () => {
    const blocks = parseBlocks("before\n\n```ts\nconst x = 1;\n  indented();\n```\n\nafter");
    const code = blocks.find((block) => block.kind === "code");
    expect(code).toMatchObject({ kind: "code", language: "ts", lines: ["const x = 1;", "  indented();"] });
  });

  test("a fence still streaming is readable before it closes", () => {
    const blocks = parseBlocks("```sh\nbun test");
    expect(blocks).toEqual([{ kind: "code", language: "sh", lines: ["bun test"] }]);
  });

  test("bullets and numbers are lists, headings are headings", () => {
    const kinds = parseBlocks("## Plan\n\n- first\n- second\n\n1. step one\n2. step two").map(
      (block) => block.kind,
    );
    expect(kinds).toEqual(["heading", "blank", "list", "list", "blank", "list", "list"]);
  });

  test("a nested bullet keeps its depth", () => {
    const blocks = parseBlocks("- top\n    - nested");
    expect(blocks[0]).toMatchObject({ kind: "list", depth: 0 });
    expect(blocks[1]).toMatchObject({ kind: "list", depth: 2 });
  });
});

describe("rendered prose", () => {
  test("markup characters never reach the screen", () => {
    const rendered = textOf(
      renderProse("**bold** and `code` and [link](https://x)", theme, 60, { bodyColor: theme.text }),
    );
    expect(rendered).toBe("bold and code and link");
  });

  test("a bullet gets a marker and a hanging indent, not a stray dash", () => {
    const lines = renderProse("- a reasonably long bullet that has to wrap somewhere", theme, 24, {
      bodyColor: theme.text,
    });
    expect(lines[0]?.spans[0]?.text).toBe("· ");
    expect(lines[1]?.spans[0]?.text).toBe("  ");
  });

  test("every rendered row fits the pane", () => {
    const body = [
      "# Heading",
      "",
      "A paragraph with **emphasis**, `inline_code`, and a very long path",
      "src/watari/service/transcript-writer.ts in it.",
      "",
      "- a bullet",
      "  - nested bullet with more words than fit",
      "",
      "```ts",
      "const wide = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';",
      "```",
      "",
      "> a quotation that also needs to wrap at narrow widths",
    ].join("\n");

    for (const width of [16, 28, 40, 72]) {
      for (const line of renderProse(body, theme, width, { bodyColor: theme.text })) {
        const used = line.spans.reduce((total, span) => total + cellWidth(span.text), 0);
        expect(used).toBeLessThanOrEqual(width);
      }
    }
  });

  test("a long fenced block stays complete inside the scrollable transcript", () => {
    const body = ["```", ...Array.from({ length: 40 }, (_value, index) => `line ${index}`), "```"].join("\n");
    const rendered = textOf(renderProse(body, theme, 40, { bodyColor: theme.text }));
    expect(rendered).toContain("line 39");
    expect(rendered).not.toContain("more lines");
  });

  test("reasoning renders flat, with no code tint competing with the answer", () => {
    const lines = renderProse("a `tinted` word", theme, 40, { bodyColor: theme.muted, muted: true });
    for (const span of lines[0]?.spans ?? []) {
      expect(span.color).toBe(theme.muted);
      expect(span.bold).toBeUndefined();
    }
  });

  test("an empty body still produces a row rather than nothing", () => {
    expect(renderProse("", theme, 40, { bodyColor: theme.text })).toHaveLength(1);
  });
});

describe("copyable text", () => {
  test("the markdown source is preserved, since that is what pastes usefully", () => {
    const body = "Run **bun test**.\n\n```sh\nbun test\n```";
    expect(proseToPlainText(body)).toBe(body);
  });

  test("trailing whitespace and blank edges are trimmed", () => {
    expect(proseToPlainText("\n\n  text here   \n\n")).toBe("text here");
  });
});
