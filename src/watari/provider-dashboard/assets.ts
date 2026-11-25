/**
 * Static assets for the provider dashboard. They carry no data. Everything
 * shown comes from the authenticated status API, fetched by the script.
 *
 * The colours are Watari's own theme tokens (`src/watari/tui/theme.ts`), so the
 * page reads as the same product as the terminal UI: teal for Watari itself,
 * blue for ChatGPT/Codex, orange for Claude, and a status ramp that never
 * borrows a provider colour. Every coloured state also carries a glyph and a
 * word.
 */

import { dashboardRuntime } from "./client.ts";

export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="referrer" content="no-referrer">
<title>Watari providers</title>
<link rel="stylesheet" href="/app.css">
<script src="/app.js" defer></script>
</head>
<body>
<header class="topbar">
  <div class="wrap topbar-row">
    <p class="brand"><span class="brand-name">Watari</span><span class="page-name">Provider accounts</span></p>
    <nav id="jump" class="jump" aria-label="Providers"></nav>
    <div class="controls">
      <p id="status" class="status tone-muted" role="status" aria-live="polite">Loading provider status</p>
      <label class="auto"><span>Auto refresh</span><select id="auto"></select></label>
      <button id="refresh" class="button" type="button">Refresh now</button>
    </div>
  </div>
</header>
<main id="main" class="wrap"></main>
<footer class="wrap footer">
  <p>CodexLB and TeamClaude pick the account for each request. Watari only sets their routing policy and priority, through their own controls, when routing is set to Automatic or you press Apply now. Logins and adding or removing accounts stay in those tools.</p>
</footer>
</body>
</html>
`;

/** The browser script is the runtime's own source, run once on load. */
export function dashboardScript(): string {
  return `"use strict";\n(${dashboardRuntime.toString()})().mount(globalThis);\n`;
}

export const DASHBOARD_CSS = `
:root {
  color-scheme: light;
  --base: #fbfaf7;
  --surface: #ffffff;
  --raised: #f1efe9;
  --rule: #d5d1c6;
  --rule-soft: #e6e3da;
  --text: #23262d;
  --muted: #5b6470;
  --faint: #87909c;
  --brand: #0f7a68;
  --ok: #2c7a31;
  --warn: #87680c;
  --danger: #bb2f47;
  --track: #e6e3da;
  --codex: #16679f;
  --codex-fill: #3f8fcb;
  --codex-tint: #edf5fb;
  --claude: #9c5305;
  --claude-fill: #e07b24;
  --claude-tint: #fbf1e6;
  --focus: #0f7a68;
  --topbar: 64px;
  --font: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
  --mono: ui-monospace, "SF Mono", "Cascadia Mono", "JetBrains Mono", Menlo, Consolas, monospace;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
    --base: #0d1014;
    --surface: #151a21;
    --raised: #1e2630;
    --rule: #28323e;
    --rule-soft: #1a212a;
    --text: #d5dce6;
    --muted: #8d99a8;
    --faint: #5f6a77;
    --brand: #2fc4b2;
    --ok: #5fc46a;
    --warn: #e0bf4d;
    --danger: #f4677f;
    --track: #28323e;
    --codex: #79c6f7;
    --codex-fill: #79c6f7;
    --codex-tint: #142231;
    --claude: #f2913f;
    --claude-fill: #f2913f;
    --claude-tint: #2a1d12;
    --focus: #2fc4b2;
  }
}

:root[data-theme="dark"] {
  color-scheme: dark;
  --base: #0d1014;
  --surface: #151a21;
  --raised: #1e2630;
  --rule: #28323e;
  --rule-soft: #1a212a;
  --text: #d5dce6;
  --muted: #8d99a8;
  --faint: #5f6a77;
  --brand: #2fc4b2;
  --ok: #5fc46a;
  --warn: #e0bf4d;
  --danger: #f4677f;
  --track: #28323e;
  --codex: #79c6f7;
  --codex-fill: #79c6f7;
  --codex-tint: #142231;
  --claude: #f2913f;
  --claude-fill: #f2913f;
  --claude-tint: #2a1d12;
  --focus: #2fc4b2;
}

* { box-sizing: border-box; }

html { -webkit-text-size-adjust: 100%; scroll-padding-top: calc(var(--topbar) + 16px); }

body {
  margin: 0;
  background: var(--base);
  color: var(--text);
  font: 15px/1.5 var(--font);
  font-variant-numeric: tabular-nums;
}

.wrap {
  width: 100%;
  max-width: 1320px;
  margin: 0 auto;
  padding-left: clamp(16px, 4vw, 48px);
  padding-right: clamp(16px, 4vw, 48px);
}

:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }

.visually-hidden {
  position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0;
  overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}

/* Top bar */

.topbar {
  position: sticky;
  top: 0;
  z-index: 10;
  background: var(--surface);
  border-bottom: 1px solid var(--rule);
}

.topbar-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px 28px;
  min-height: var(--topbar);
  padding-top: 10px;
  padding-bottom: 10px;
}

.brand { margin: 0; display: flex; align-items: baseline; gap: 12px; }
.brand-name { color: var(--brand); font-weight: 700; font-size: 17px; }
.page-name { font-weight: 600; font-size: 17px; }

.jump { display: flex; gap: 6px; flex-wrap: wrap; }
.jump-link {
  padding: 4px 10px;
  border-radius: 6px;
  color: var(--text);
  text-decoration: none;
  font-size: 14px;
  border: 1px solid var(--rule-soft);
}
.jump-link:hover { border-color: var(--rule); background: var(--raised); }
.jump-link.theme-codex-light-blue { box-shadow: inset 3px 0 0 var(--codex-fill); }
.jump-link.theme-claude-orange { box-shadow: inset 3px 0 0 var(--claude-fill); }

.controls { margin-left: auto; display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; }
.status { margin: 0; font-size: 13px; color: var(--muted); }
.status.tone-warn { color: var(--warn); }
.status.tone-bad { color: var(--danger); }

.auto { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--muted); }
select, .search {
  font: inherit;
  font-size: 14px;
  color: var(--text);
  background: var(--surface);
  border: 1px solid var(--rule);
  border-radius: 6px;
  padding: 5px 8px;
}

.button {
  font: inherit;
  font-size: 14px;
  font-weight: 600;
  color: var(--surface);
  background: var(--brand);
  border: 1px solid var(--brand);
  border-radius: 6px;
  padding: 6px 14px;
  cursor: pointer;
}
.button:disabled { opacity: 0.6; cursor: progress; }

/* Provider sections */

main { padding-top: 32px; padding-bottom: 16px; }

.provider { margin: 0 0 56px; }
.theme-codex-light-blue { --accent: var(--codex); --accent-fill: var(--codex-fill); --accent-tint: var(--codex-tint); }
.theme-claude-orange { --accent: var(--claude); --accent-fill: var(--claude-fill); --accent-tint: var(--claude-tint); }
.theme-neutral { --accent: var(--text); --accent-fill: var(--muted); --accent-tint: var(--raised); }

.provider-head { padding: 0 0 16px; }
.title-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; }
.provider-title { margin: 0; font-size: 22px; line-height: 1.25; font-weight: 700; color: var(--accent); display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.via { color: var(--muted); font-size: 14px; font-weight: 500; }

.state-chip { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 600; }
.glyph { display: inline-block; min-width: 1em; text-align: center; }

.headline { margin: 14px 0 8px; font-size: 16px; font-weight: 600; }

.strip {
  display: flex;
  gap: 4px;
  max-width: 640px;
  margin: 0 0 14px;
}
.cell {
  position: relative;
  flex: 1 1 0;
  max-width: 72px;
  height: 18px;
  border-radius: 3px;
  background: var(--track);
  overflow: hidden;
}
.cell::after {
  content: "";
  position: absolute;
  inset: 0 auto 0 0;
  width: var(--fill, 0%);
  background: var(--accent-fill);
}
.cell.kind-near::after { background: var(--warn); }
.cell.kind-out, .cell.kind-login, .cell.kind-off {
  background: repeating-linear-gradient(135deg, var(--track) 0 4px, transparent 4px 8px);
  border: 1px solid var(--rule);
}
.cell.kind-unknown { background: transparent; border: 1px dashed var(--rule); }

.facts { margin: 0; }
.summary-facts { display: flex; flex-wrap: wrap; gap: 6px 28px; font-size: 14px; }
.summary-facts .fact { display: flex; gap: 8px; }
.fact dt { color: var(--muted); }
.fact dd { margin: 0; }
dd.tone-muted { color: var(--faint); }
dd.tone-warn { color: var(--warn); font-weight: 600; }
dd.tone-bad { color: var(--danger); font-weight: 600; }
dd.code { font-family: var(--mono); font-size: 12.5px; overflow-wrap: anywhere; }

.banners:empty { display: none; }
.banners { display: grid; gap: 8px; margin: 0 0 16px; }
.banner { margin: 0; padding: 10px 14px; border-radius: 6px; font-size: 14px; max-width: 80ch; }
.banner-advisory { background: var(--surface); border: 1px solid var(--warn); }
.banner-checkpoint { background: var(--surface); border: 1px solid var(--danger); border-left-width: 4px; }
.banner-error { background: var(--raised); color: var(--muted); }
.banner-empty { background: var(--raised); color: var(--muted); }

.tools { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px 16px; margin: 0 0 10px; }
.filters { display: flex; gap: 6px; flex-wrap: wrap; }
.chip {
  font: inherit;
  font-size: 13px;
  color: var(--muted);
  background: transparent;
  border: 1px solid var(--rule);
  border-radius: 999px;
  padding: 3px 12px;
  cursor: pointer;
}
.chip[aria-pressed="true"] { color: var(--text); border-color: var(--accent-fill); background: var(--accent-tint); font-weight: 600; }
.search { width: min(280px, 100%); }

/* Routing */

.routing-slot:empty { display: none; }
.routing { margin: 0 0 16px; padding: 12px 14px; border: 1px solid var(--rule); border-radius: 8px; background: var(--surface); max-width: 100%; }
.routing-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; }
.routing-label { font-weight: 600; font-size: 14px; }
.routing-plan, .routing-last { margin: 8px 0 0; font-size: 13.5px; color: var(--muted); max-width: 100ch; }
.routing-last.tone-bad { color: var(--danger); }
.button-quiet { background: transparent; color: var(--accent); border-color: var(--accent-fill); }
.chip:disabled { opacity: 0.6; cursor: progress; }
.routing { font-variant-numeric: tabular-nums; }
.routing-cell { white-space: nowrap; color: var(--muted); }

.page-message { margin: 48px 0; max-width: 64ch; }
.page-message h2 { margin: 0 0 8px; font-size: 20px; }
.page-message p { margin: 0; color: var(--muted); }
.page-message.tone-warn h2 { color: var(--warn); }
.page-message.tone-bad h2 { color: var(--danger); }

/* Account table */

.table-wrap { border: 1px solid var(--rule); border-radius: 8px; background: var(--surface); overflow: clip; }
table { width: 100%; border-collapse: collapse; }
.accounts th {
  position: sticky;
  top: var(--topbar);
  z-index: 1;
  background: var(--accent-tint);
  text-align: left;
  font-size: 13px;
  font-weight: 600;
  color: var(--muted);
  padding: 0;
  border-bottom: 1px solid var(--rule);
}
.accounts th:not(:has(.sort)) { padding: 10px 14px; white-space: nowrap; }
.sort {
  font: inherit;
  color: inherit;
  background: transparent;
  border: 0;
  padding: 10px 14px;
  width: 100%;
  text-align: left;
  white-space: nowrap;
  cursor: pointer;
}
.sort.active { color: var(--text); }
th[aria-sort="ascending"] .sort::after { content: " ↑"; }
th[aria-sort="descending"] .sort::after { content: " ↓"; }

.accounts td { padding: 12px 14px; border-bottom: 1px solid var(--rule-soft); vertical-align: top; font-size: 14px; }
.accounts tr.account:hover td { background: var(--raised); }
.accounts tr.expanded td { background: var(--raised); border-bottom-color: transparent; }
.accounts tr:last-child td { border-bottom: 0; }

.use { width: 3.5em; font-weight: 700; color: var(--accent); }
.use.missing { color: var(--faint); font-weight: 500; }
.name { min-width: 220px; }
.expand {
  font: inherit;
  color: var(--text);
  background: transparent;
  border: 0;
  padding: 0;
  display: inline-flex;
  gap: 8px;
  align-items: baseline;
  text-align: left;
  cursor: pointer;
}
.chevron { color: var(--muted); width: 1em; }
.account-name { font-weight: 600; overflow-wrap: anywhere; }
.route-mark { display: block; margin: 4px 0 0 1.5em; font-size: 12px; color: var(--accent); font-weight: 600; }

.state { white-space: nowrap; font-weight: 600; }
.state .glyph { margin-right: 6px; }
.tone-good { color: var(--ok); }
.tone-warn { color: var(--warn); }
.tone-bad { color: var(--danger); }
.tone-muted { color: var(--faint); }

.meter { min-width: 140px; }
.meter-value { display: block; font-weight: 600; color: var(--text); }
.meter.tone-warn .meter-value { color: var(--warn); }
.meter.tone-bad .meter-value { color: var(--danger); }
.meter.tone-muted .meter-value, .meter.absent .meter-value { color: var(--faint); font-weight: 500; }
.bar { display: block; height: 4px; margin: 6px 0 4px; max-width: 160px; border-radius: 2px; background: var(--track); overflow: hidden; }
.bar-fill { display: block; height: 100%; width: var(--fill, 0%); background: var(--accent-fill); }
.meter.tone-warn .bar-fill { background: var(--warn); }
.meter.tone-bad .bar-fill { background: var(--danger); }
.meter-detail { display: block; font-size: 12.5px; color: var(--muted); }
.missing { color: var(--faint); }
.ends { white-space: nowrap; }
.ends.tone-warn > span:first-child { font-weight: 600; }

.details td { padding: 4px 14px 18px 44px; }
.detail-facts { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 8px 32px; font-size: 13.5px; }
.detail-facts .fact { display: grid; gap: 2px; }
.none td { color: var(--muted); padding: 18px 14px; }

.pins-title { margin: 24px 0 8px; font-size: 15px; }
.pins { max-width: 760px; font-size: 14px; border: 1px solid var(--rule); background: var(--surface); }
.pins th, .pins td { padding: 8px 12px; text-align: left; border-bottom: 1px solid var(--rule-soft); }
.pins th { color: var(--muted); font-weight: 600; font-size: 13px; background: var(--raised); }

.footer { padding-top: 8px; padding-bottom: 40px; color: var(--muted); font-size: 13px; }
.footer p { max-width: 80ch; margin: 0; }

@media (max-width: 900px) {
  .topbar { position: static; }
  html { scroll-padding-top: 16px; }
  .controls { margin-left: 0; width: 100%; }
  .table-wrap { overflow-x: auto; }
  .accounts { min-width: 1000px; }
  .accounts th { position: static; }
}

@media (prefers-reduced-motion: reduce) {
  * { scroll-behavior: auto; }
}
`;
