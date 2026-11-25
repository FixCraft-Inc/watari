/**
 * Enough Markdown for what a coding agent actually writes back.
 *
 * Fenced code, headings, lists, quotes, and inline emphasis, code, and links —
 * deliberately not a full parser. Its real job is safety, which is why it lives
 * in its own file with its own tests: this text arrives from a model and is
 * handed to `innerHTML`, so every branch escapes its input before it builds any
 * markup, and the only tag attributes that ever appear are ones written here.
 * A reply must never be able to put an element into the panel.
 */
(function (global) {
  "use strict";

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function inline(text) {
    let value = escapeHtml(text);
    value = value.replace(/`([^`]+)`/g, "<code>$1</code>");
    value = value.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    value = value.replace(/(^|\W)\*([^*\n]+)\*(?=\W|$)/g, "$1<em>$2</em>");
    // Only http(s) targets become links. A `javascript:` or `data:` href is left
    // as the literal text it was, which is the whole point of an allowlist here.
    value = value.replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)"']+)\)/g,
      '<a href="$2" rel="noreferrer">$1</a>',
    );
    return value;
  }

  function render(source) {
    const lines = String(source === null || source === undefined ? "" : source).split("\n");
    const out = [];
    let index = 0;

    while (index < lines.length) {
      const line = lines[index];

      const fence = /^\s*```(\w*)\s*$/.exec(line);
      if (fence) {
        const language = fence[1];
        const body = [];
        index += 1;
        while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
          body.push(lines[index]);
          index += 1;
        }
        index += 1;
        const attribute = language ? ' class="language-' + escapeHtml(language) + '"' : "";
        out.push("<pre><code" + attribute + ">" + escapeHtml(body.join("\n")) + "</code></pre>");
        continue;
      }

      const heading = /^(#{1,6})\s+(.*)$/.exec(line);
      if (heading) {
        const level = Math.min(3, heading[1].length);
        out.push("<h" + level + ">" + inline(heading[2]) + "</h" + level + ">");
        index += 1;
        continue;
      }

      if (/^\s*[-*+]\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line)) {
        const ordered = /^\s*\d+[.)]\s+/.test(line);
        const items = [];
        while (
          index < lines.length &&
          (ordered ? /^\s*\d+[.)]\s+/.test(lines[index]) : /^\s*[-*+]\s+/.test(lines[index]))
        ) {
          items.push("<li>" + inline(lines[index].replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")) + "</li>");
          index += 1;
        }
        out.push(ordered ? "<ol>" + items.join("") + "</ol>" : "<ul>" + items.join("") + "</ul>");
        continue;
      }

      if (/^\s*>\s?/.test(line)) {
        const quoted = [];
        while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
          quoted.push(inline(lines[index].replace(/^\s*>\s?/, "")));
          index += 1;
        }
        out.push("<blockquote>" + quoted.join("<br>") + "</blockquote>");
        continue;
      }

      if (line.trim() === "") {
        index += 1;
        continue;
      }

      const paragraph = [];
      while (index < lines.length && lines[index].trim() !== "" && !opensBlock(lines[index])) {
        paragraph.push(inline(lines[index]));
        index += 1;
      }
      // A line that opens a block but did not parse as one — a fence with a
      // language the fence pattern rejects, say — reaches here having consumed
      // nothing. Without this the outer loop cannot advance: it would append an
      // empty paragraph forever and take the panel down with it. Such a line is
      // rendered as the literal text it is.
      if (paragraph.length === 0) {
        paragraph.push(inline(lines[index]));
        index += 1;
      }
      out.push("<p>" + paragraph.join("<br>") + "</p>");
    }
    return out.join("");
  }

  /** Whether a line starts a block construct, and so ends a paragraph. */
  function opensBlock(line) {
    return (
      /^\s*```/.test(line) ||
      /^#{1,6}\s/.test(line) ||
      /^\s*[-*+]\s+/.test(line) ||
      /^\s*\d+[.)]\s+/.test(line) ||
      /^\s*>\s?/.test(line)
    );
  }

  const api = { render: render, escapeHtml: escapeHtml, inline: inline };
  if (typeof module === "object" && module.exports) module.exports = api;
  else global.watariMarkdown = api;
})(typeof globalThis === "undefined" ? this : globalThis);
