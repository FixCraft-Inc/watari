/**
 * Tests for the panel's Markdown renderer.
 *
 * Its output goes to `innerHTML`, and its input is whatever a model wrote, so
 * the escaping is the part that matters. Run with `node --test test/*.test.mjs`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const markdown = createRequire(import.meta.url)("../media/markdown.js");
const render = markdown.render;

test("renders the shapes an agent actually writes back", () => {
  assert.equal(render("plain text"), "<p>plain text</p>");
  assert.equal(render("# Heading"), "<h1>Heading</h1>");
  assert.equal(render("#### deep"), "<h3>deep</h3>", "headings clamp at h3");
  assert.equal(render("- one\n- two"), "<ul><li>one</li><li>two</li></ul>");
  assert.equal(render("1. one\n2. two"), "<ol><li>one</li><li>two</li></ol>");
  assert.equal(render("> quoted"), "<blockquote>quoted</blockquote>");
  assert.equal(
    render("```ts\nconst x = 1;\n```"),
    '<pre><code class="language-ts">const x = 1;</code></pre>',
  );
  assert.equal(render("use `code` here"), "<p>use <code>code</code> here</p>");
  assert.equal(render("**bold** and *italic*"), "<p><strong>bold</strong> and <em>italic</em></p>");
});

test("a wrapped paragraph stays one paragraph", () => {
  assert.equal(render("one\ntwo"), "<p>one<br>two</p>");
  assert.equal(render("one\n\ntwo"), "<p>one</p><p>two</p>");
});

/** Every tag the renderer is allowed to produce. Anything else in its output
 * came from the input, which is the failure this file exists to catch. */
const ALLOWED = new Set([
  "p", "br", "h1", "h2", "h3", "ul", "ol", "li",
  "blockquote", "pre", "code", "strong", "em", "a",
]);

/** Tag names actually present in rendered output. */
function tagsIn(html) {
  return [...String(html).matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)/g)].map((match) =>
    match[1].toLowerCase(),
  );
}

// Everything below is the reason this file exists. Peer replies are model
// output rendered as HTML; a reply must never be able to put an element into
// the panel, no matter which branch of the renderer it takes. Note that an
// escaped `onerror=` inside a text node is harmless — what must never happen
// is a tag or an attribute the renderer did not write itself.
test("markup in model output never becomes an element", () => {
  const payload = '<img src=x onerror="alert(1)">';
  for (const source of [
    payload,
    `# ${payload}`,
    `- ${payload}`,
    `> ${payload}`,
    "```\n" + payload + "\n```",
    "```bad lang\n" + payload + "\n```",
    `**${payload}**`,
    `\`${payload}\``,
    `[link](https://example.com) ${payload}`,
  ]) {
    const html = render(source);
    for (const tag of tagsIn(html)) {
      assert.ok(ALLOWED.has(tag), `emitted <${tag}> for: ${source}`);
    }
    assert.ok(html.includes("&lt;img"), `did not escape the tag for: ${source}`);
  }
});

// A fence whose info string the fence pattern rejects used to consume no line
// at all, so the outer loop appended empty paragraphs until the array blew up
// and took the panel with it. Models write these constantly.
test("a malformed fence terminates instead of hanging", () => {
  for (const source of [
    '```a"b\ncode\n```',
    "```js extra\ncode\n```",
    "``` js\ncode\n```",
    "```unterminated\ncode",
    "```",
  ]) {
    const started = Date.now();
    const html = render(source);
    assert.ok(Date.now() - started < 1000, `took too long for: ${source}`);
    assert.equal(typeof html, "string");
  }
});

test("a fence language cannot break out of the class attribute", () => {
  // The language is interpolated into an attribute, so it is the one place a
  // quote would be structural rather than textual. A rejected info string is
  // rendered as the literal text it is.
  // The rejected info string becomes text; the bare fence that follows it does
  // open a block, and an unterminated one at the end is an empty block.
  assert.equal(
    render('```a"b\ncode\n```'),
    "<p>```a&quot;b</p><p>code</p><pre><code></code></pre>",
  );
  assert.equal(render("```ts\nx\n```"), '<pre><code class="language-ts">x</code></pre>');
});

test("only http and https become links", () => {
  assert.equal(
    render("[docs](https://example.com/a)"),
    '<p><a href="https://example.com/a" rel="noreferrer">docs</a></p>',
  );
  for (const hostile of [
    "[x](javascript:alert(1))",
    "[x](data:text/html,<script>alert(1)</script>)",
    "[x](vbscript:msgbox)",
    "[x](file:///etc/passwd)",
  ]) {
    const html = render(hostile);
    assert.ok(!html.includes("<a "), `made a link for: ${hostile}`);
    assert.ok(!html.includes("<script"), `emitted a script for: ${hostile}`);
  }
});

test("a link target cannot smuggle an attribute", () => {
  // The quote is rejected by the href pattern, so no anchor is built at all and
  // the whole thing stays text.
  const html = render('[x](https://example.com/" onmouseover="alert(1))');
  assert.ok(!html.includes("<a "), html);
  assert.ok(html.includes("&quot;"), html);
});

test("empty and absent input render to nothing", () => {
  assert.equal(render(""), "");
  assert.equal(render(null), "");
  assert.equal(render(undefined), "");
});
