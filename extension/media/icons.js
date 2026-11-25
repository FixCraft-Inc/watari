/**
 * Watari's icon set.
 *
 * The terminal UI spends single characters on state because a cell is all it
 * has. A webview has no such excuse, and a screen of `✓ ⋯ ✕ ·` reads as a
 * console log rather than an interface, so every glyph the panel used to draw
 * as text is drawn here as geometry instead.
 *
 * Two rules hold throughout. Icons are built with `createElementNS` rather than
 * markup strings, so nothing here can become an injection path the way an
 * `innerHTML` helper would. And every icon strokes `currentColor` at a fixed
 * 24-unit grid, so a caller sets size and colour with ordinary CSS and the
 * whole set stays consistent with whatever theme the reader chose.
 *
 * State icons deliberately differ in shape as well as colour — a circle, a
 * clock, a crossed circle — because colour alone is not something a reader can
 * always rely on.
 */
(function (global) {
  "use strict";

  const NS = "http://www.w3.org/2000/svg";

  /** Each icon is a list of [tag, attributes] on a 24x24 grid. */
  const ICONS = {
    // — actions —
    send: [["path", { d: "M4.5 12 20 4.5 15.5 20l-4-6.5z" }], ["path", { d: "m11.5 13.5 8.5-9" }]],
    stop: [["rect", { x: "6", y: "6", width: "12", height: "12", rx: "2" }]],
    refresh: [
      ["path", { d: "M20.5 12a8.5 8.5 0 1 1-2.6-6.1" }],
      ["path", { d: "M20.5 4v5h-5" }],
    ],
    close: [["path", { d: "M17 7 7 17M7 7l10 10" }]],
    plus: [["path", { d: "M12 6v12M6 12h12" }]],
    external: [
      ["path", { d: "M14 4h6v6" }],
      ["path", { d: "m20 4-8 8" }],
      ["path", { d: "M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" }],
    ],

    // — disclosure and navigation —
    chevronRight: [["path", { d: "m9.5 5.5 6.5 6.5-6.5 6.5" }]],
    chevronDown: [["path", { d: "m5.5 9.5 6.5 6.5 6.5-6.5" }]],
    chevronLeft: [["path", { d: "m14.5 5.5-6.5 6.5 6.5 6.5" }]],

    // — outcomes —
    check: [["path", { d: "m5 12.5 4.5 4.5L19 7" }]],
    cross: [["path", { d: "M17 7 7 17M7 7l10 10" }]],
    warning: [
      ["path", { d: "M12 3.5 21.5 20H2.5z" }],
      ["path", { d: "M12 10v4" }],
      ["path", { d: "M12 17.2v.1" }],
    ],
    error: [
      ["circle", { cx: "12", cy: "12", r: "9" }],
      ["path", { d: "M12 7.5v5" }],
      ["path", { d: "M12 16.2v.1" }],
    ],
    info: [
      ["circle", { cx: "12", cy: "12", r: "9" }],
      ["path", { d: "M12 11v5.5" }],
      ["path", { d: "M12 7.8v.1" }],
    ],

    // — peer state, each a different shape as well as a different colour —
    ready: [["circle", { cx: "12", cy: "12", r: "7" }]],
    waiting: [
      ["circle", { cx: "12", cy: "12", r: "8" }],
      ["path", { d: "M12 7.5V12l3 2" }],
    ],
    failed: [
      ["circle", { cx: "12", cy: "12", r: "8" }],
      ["path", { d: "m15 9-6 6M9 9l6 6" }],
    ],
    stopped: [
      ["circle", { cx: "12", cy: "12", r: "8" }],
      ["path", { d: "M8.5 12h7" }],
    ],
    starting: [
      ["circle", { cx: "12", cy: "12", r: "8", "stroke-dasharray": "3 3" }],
    ],

    // — activity kinds —
    terminal: [
      ["path", { d: "m5 8 4 4-4 4" }],
      ["path", { d: "M12.5 16h6" }],
    ],
    fileEdit: [
      ["path", { d: "M13 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-8" }],
      ["path", { d: "M13 3v6h6" }],
      ["path", { d: "M8.5 15.5h4" }],
    ],
    read: [
      ["path", { d: "M4 5.5A2.5 2.5 0 0 1 6.5 3H11v16H6.5A2.5 2.5 0 0 0 4 21.5z" }],
      ["path", { d: "M20 5.5A2.5 2.5 0 0 0 17.5 3H13v16h4.5a2.5 2.5 0 0 1 2.5 2.5z" }],
    ],

    // — team concepts —
    goal: [
      ["circle", { cx: "12", cy: "12", r: "8.5" }],
      ["circle", { cx: "12", cy: "12", r: "4.5" }],
      ["circle", { cx: "12", cy: "12", r: "1", fill: "currentColor" }],
    ],
    peers: [
      ["circle", { cx: "9", cy: "8", r: "3.5" }],
      ["path", { d: "M3 20v-1.5A4.5 4.5 0 0 1 7.5 14h3A4.5 4.5 0 0 1 15 18.5V20" }],
      ["path", { d: "M16 5.2a3.5 3.5 0 0 1 0 5.6" }],
      ["path", { d: "M17.5 14.2A4.5 4.5 0 0 1 21 18.5V20" }],
    ],
    claim: [["path", { d: "M18 20.5 12 17l-6 3.5V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z" }]],
    contested: [
      ["path", { d: "M5 9h14M5 15h14" }],
      ["path", { d: "m17 5-10 14" }],
    ],
    finding: [
      ["path", { d: "M5 21V4" }],
      ["path", { d: "M5 4.5s1.5-1 4.5-1 5 2 8 2 1.5 0 1.5 0V14s-1 .5-3 .5-5-2-8-2-3 1-3 1z" }],
    ],
    bridge: [
      ["path", { d: "M12 21v-4.5" }],
      ["path", { d: "M9 7V3M15 7V3" }],
      ["path", { d: "M6.5 7h11v3.5a5.5 5.5 0 0 1-11 0z" }],
    ],
  };

  /** Icons whose meaning is "this is moving", drawn as an arc that spins. */
  const SPINNER = [
    ["circle", { cx: "12", cy: "12", r: "8.5", opacity: "0.25" }],
    ["path", { d: "M20.5 12a8.5 8.5 0 0 0-8.5-8.5" }],
  ];

  /**
   * Builds one icon element.
   *
   * `size` is in CSS pixels and `className` is applied to the root `<svg>`, so
   * colour, opacity and animation all stay in the stylesheet where they belong.
   */
  function icon(name, options) {
    const settings = options || {};
    const spinning = name === "busy" || name === "spinner" || name === "checking";
    const shapes = spinning ? SPINNER : ICONS[name];
    if (!shapes) throw new Error("unknown Watari icon: " + String(name));

    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", String(settings.size || 16));
    svg.setAttribute("height", String(settings.size || 16));
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", String(settings.weight || 1.8));
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("class", "icon" + (spinning ? " is-spinning" : "") + (settings.className ? " " + settings.className : ""));
    // Decorative by default: the surrounding row already names the thing in
    // words, and a screen reader repeating "check icon" after "completed" is
    // noise. A caller that has no adjacent text passes a label instead.
    if (settings.label) {
      svg.setAttribute("role", "img");
      svg.setAttribute("aria-label", settings.label);
    } else {
      svg.setAttribute("aria-hidden", "true");
    }

    for (const [tag, attributes] of shapes) {
      const node = document.createElementNS(NS, tag);
      for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
      svg.appendChild(node);
    }
    return svg;
  }

  /** The icon for one peer's runtime state. */
  function stateIcon(state, options) {
    const named = state === "busy" ? "busy" : ICONS[state] ? state : "ready";
    return icon(named, options);
  }

  /** The icon for one team bridge's health. */
  function bridgeIcon(state, options) {
    if (state === "ready") return icon("check", options);
    if (state === "failed") return icon("cross", options);
    if (state === "checking") return icon("checking", options);
    return icon("stopped", options);
  }

  /** The icon for one unit of provider work. */
  function activityIcon(kind, state, options) {
    if (state === "running") return icon("busy", options);
    if (state === "failed" || state === "interrupted") return icon("error", options);
    return icon(kind === "file_change" ? "fileEdit" : "terminal", options);
  }

  const api = { icon, stateIcon, bridgeIcon, activityIcon, names: Object.keys(ICONS) };
  if (typeof module === "object" && module.exports) module.exports = api;
  else global.watariIcons = api;
})(typeof globalThis === "undefined" ? this : globalThis);
