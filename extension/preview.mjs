/**
 * Renders the panel to a PNG, outside VSCode.
 *
 * The webview is ordinary HTML, so the only things VSCode really supplies are a
 * theme's worth of CSS variables and the `acquireVsCodeApi` bridge. Both are
 * stubbed here, which makes the design reviewable without launching an
 * Extension Development Host and without a service, a provider, or a model call.
 *
 *   node preview.mjs                       dark, sidebar width
 *   node preview.mjs light 320 900         another theme and size
 *   node preview.mjs dark 900 700 wide     the editor-tab layout
 *   node preview.mjs dark 320 900 rail     the drawer open
 *   node preview.mjs dark 320 900 empty    first run, nothing sent yet
 */
import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const media = join(here, "media");

const [themeArg, widthArg, heightArg, stateArg] = process.argv.slice(2);
const theme = themeArg === "light" ? "light" : "dark";
const width = Number(widthArg ?? 340);
const height = Number(heightArg ?? 900);
const scene = stateArg ?? "default";

/** A plausible slice of VSCode's own token set, per theme. */
const TOKENS = {
  dark: {
    "font-family": "system-ui, -apple-system, 'Segoe UI', sans-serif",
    "font-size": "13px",
    "editor-font-family": "'DejaVu Sans Mono', monospace",
    foreground: "#cccccc",
    descriptionForeground: "#9d9d9d",
    "editor-background": "#1f1f1f",
    "sideBar-background": "#181818",
    "editorWidget-background": "#202020",
    "panel-border": "#2b2b2b",
    "textBlockQuote-background": "#242424",
    "textBlockQuote-border": "#3c3c3c",
    "textCodeBlock-background": "#161616",
    "textLink-foreground": "#4daafc",
    "badge-background": "#4d4d4d",
    "badge-foreground": "#ffffff",
    "button-background": "#0078d4",
    "button-foreground": "#ffffff",
    "button-hoverBackground": "#026ec1",
    "button-secondaryBackground": "#313131",
    "button-secondaryForeground": "#cccccc",
    "input-background": "#2b2b2b",
    "input-foreground": "#cccccc",
    "input-border": "#3c3c3c",
    "input-placeholderForeground": "#8b8b8b",
    focusBorder: "#0078d4",
    errorForeground: "#f85149",
    "list-hoverBackground": "#2a2d2e",
    "inputValidation-warningBackground": "#352a05",
    "inputValidation-warningBorder": "#9e6a03",
    "inputValidation-errorBackground": "#3a1d1d",
    "inputValidation-errorBorder": "#be1100",
    "charts-green": "#4ec94e",
    "charts-red": "#e05252",
    "charts-yellow": "#d7ba7d",
  },
  light: {
    "font-family": "system-ui, -apple-system, 'Segoe UI', sans-serif",
    "font-size": "13px",
    "editor-font-family": "'DejaVu Sans Mono', monospace",
    foreground: "#3b3b3b",
    descriptionForeground: "#646464",
    "editor-background": "#ffffff",
    "sideBar-background": "#f8f8f8",
    "editorWidget-background": "#f3f3f3",
    "panel-border": "#e5e5e5",
    "textBlockQuote-background": "#f0f0f0",
    "textBlockQuote-border": "#d0d0d0",
    "textCodeBlock-background": "#f0f0f0",
    "textLink-foreground": "#005fb8",
    "badge-background": "#cccccc",
    "badge-foreground": "#3b3b3b",
    "button-background": "#005fb8",
    "button-foreground": "#ffffff",
    "button-hoverBackground": "#0258a8",
    "button-secondaryBackground": "#e5e5e5",
    "button-secondaryForeground": "#3b3b3b",
    "input-background": "#ffffff",
    "input-foreground": "#3b3b3b",
    "input-border": "#cecece",
    "input-placeholderForeground": "#767676",
    focusBorder: "#005fb8",
    errorForeground: "#e51400",
    "list-hoverBackground": "#f0f0f0",
    "inputValidation-warningBackground": "#fdf6d3",
    "inputValidation-warningBorder": "#d9b400",
    "inputValidation-errorBackground": "#fceaea",
    "inputValidation-errorBorder": "#e51400",
    "charts-green": "#2c8a2c",
    "charts-red": "#c72e2e",
    "charts-yellow": "#b5920a",
  },
};

const now = Date.now();
const at = (secondsAgo) => now - secondsAgo * 1000;

const snapshot = {
  schemaVersion: 2,
  agents: [
    { id: "codex", backend: "codex-app-server", displayName: "codex", provider: "codex", model: "gpt-5-codex", effort: "medium", mode: "managed", sessionId: "thr_91af", state: "busy", currentGoalId: "g1", updatedAt: at(4), detail: "editing src/watari/service/runtime.ts" },
    { id: "claude", backend: "claude-agent-sdk", displayName: "claude", provider: "claude", model: "claude-opus-4-6", mode: "managed", sessionId: "ses_2c11", state: "waiting", currentGoalId: "g1", updatedAt: at(9), detail: "awaiting approval for bash" },
    { id: "reviewer", backend: "claude-agent-sdk", displayName: "reviewer", provider: "claude", model: "claude-sonnet-4-6", mode: "managed", sessionId: "ses_44", state: "ready", currentGoalId: "g1", updatedAt: at(30), detail: "read-only until it claims a scope" },
    { id: "opencode", backend: "opencode-acp", displayName: "opencode", provider: "opencode", model: "qwen/qwen3-coder", mode: "managed", sessionId: null, state: "ready", currentGoalId: null, updatedAt: at(60), detail: null },
  ],
  activeGoal: {
    id: "g1",
    instruction: "Harden the delivery queue so urgent peer messages are scheduled at safe native boundaries without dropping normal mail.",
    origin: "user",
    initialAddressee: "codex",
    state: "active",
    createdAt: at(490),
    updatedAt: at(50),
  },
  messages: [
    { id: 1, goalId: "g1", sender: "user", recipients: ["codex"], kind: "goal", priority: "normal", priorityReason: null, body: "Harden the delivery queue so urgent peer messages are scheduled at safe native boundaries.", createdAt: at(490) },
    { id: 2, goalId: "g1", sender: "codex", recipients: ["claude"], kind: "peer", priority: "normal", priorityReason: null, body: "I'll take `src/watari/service/runtime.ts` and the queue module.\n\nCan you cover:\n- the store schema\n- the acknowledgement path\n\nso we don't collide?", createdAt: at(420) },
    { id: 3, goalId: "g1", sender: "claude", recipients: ["codex"], kind: "peer", priority: "normal", priorityReason: null, body: "Agreed. Claiming `state/store.ts` plus its tests. Leaving runtime.ts untouched.", createdAt: at(360) },
    { id: 4, goalId: "g1", sender: "claude", recipients: ["codex"], kind: "peer", priority: "urgent", priorityReason: "delivery correctness", body: "Heads up: your last patch drops the acknowledgement row when a peer disconnects mid-turn. **That loses messages.**", createdAt: at(90) },
    { id: 5, goalId: "g1", sender: "user", recipients: ["codex"], kind: "user", priority: "normal", priorityReason: null, body: "Please confirm the bounded queue still applies backpressure instead of dropping.", createdAt: at(60) },
  ],
  claims: [
    { id: "c1", goalId: "g1", claimant: "codex", summary: "delivery queue scheduling", paths: ["src/watari/service/runtime.ts", "src/watari/util/async-queue.ts"], state: "active", note: null, createdAt: at(400), updatedAt: at(400) },
    { id: "c2", goalId: "g1", claimant: "claude", summary: "durable acknowledgements", paths: ["src/watari/state/store.ts"], state: "active", note: null, createdAt: at(350), updatedAt: at(350) },
    { id: "c3", goalId: "g1", claimant: "codex", summary: "queue tests", paths: ["tests/async-queue.test.ts"], state: "contested", note: null, createdAt: at(120), updatedAt: at(120) },
  ],
  findings: [
    { id: "f1", author: "claude", target: "codex", scope: null, severity: "high", summary: "Acknowledgement row is dropped on mid-turn disconnect", evidence: null, disposition: "open", createdAt: at(90), updatedAt: at(90) },
    { id: "f2", author: "codex", target: null, scope: null, severity: "low", summary: "Missing index on messages(goal_id, created_at)", evidence: null, disposition: "open", createdAt: at(80), updatedAt: at(80) },
  ],
  events: [
    { id: 10, agent: "codex", type: "assistant", summary: "The delivery queue is bounded and applies backpressure, so nothing is dropped on the happy path. What is missing is the acknowledgement write when a peer disconnects during a turn.", providerEventId: "msg_1", createdAt: at(300) },
    { id: 11, agent: "codex", type: "reasoning", summary: "checking whether the bounded queue drops or blocks under pressure", providerEventId: "rs_1", createdAt: at(280) },
    { id: 12, agent: "codex", type: "tool_end", summary: "read  src/watari/service/runtime.ts", providerEventId: "t_1", createdAt: at(260) },
    { id: 13, agent: "codex", type: "warning", summary: "path overlap contested with claude on tests/async-queue.test.ts", providerEventId: null, createdAt: at(110) },
    { id: 14, agent: "codex", type: "approval", summary: "write src/watari/util/async-queue.ts", providerEventId: "req_7742", createdAt: at(30) },
  ],
  activities: [
    { id: "act_" + "a".repeat(24), agent: "codex", kind: "file_change", state: "completed", title: "edit", preview: "src/watari/util/async-queue.ts", providerEventId: "cmd_1", revision: 3, startedAt: at(240), updatedAt: at(230), hasDetail: true },
    { id: "act_" + "b".repeat(24), agent: "codex", kind: "command", state: "running", title: "bash", preview: "bun test tests/async-queue.test.ts", providerEventId: "cmd_2", revision: 1, startedAt: at(200), updatedAt: at(200), hasDetail: true },
  ],
  bridges: [
    { agent: "codex", state: "ready", detail: "team bridge ok" },
    { agent: "claude", state: "failed", detail: "team bridge unreachable: relay exited" },
    { agent: "reviewer", state: "ready", detail: "team bridge ok" },
    { agent: "opencode", state: "checking", detail: "checking team bridge" },
  ],
};

const empty = {
  ...snapshot,
  activeGoal: null,
  messages: [],
  events: [],
  activities: [],
  claims: [],
  findings: [],
};

const variables = Object.entries(TOKENS[theme])
  .map(([name, value]) => `  --vscode-${name}: ${value};`)
  .join("\n");

const payload = JSON.stringify({
  snapshot: scene === "empty" ? empty : snapshot,
  connection: { state: "ready", detail: "api v2", project: "/home/you/project" },
  railOpen: scene === "rail",
});

const harness = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<link href="main.css" rel="stylesheet">
<style>
:root {
${variables}
}
html, body { width: ${width}px; }
body { background: var(--vscode-${scene === "wide" ? "editor" : "sideBar"}-background); }
</style>
</head>
<body class="vscode-${theme}" data-surface="${scene === "wide" ? "panel" : "view"}">
<div id="root"></div>
<script>
const PAYLOAD = ${payload};
window.acquireVsCodeApi = () => ({
  postMessage: () => {},
  getState: () => ({ tab: "global", draft: "", railOpen: PAYLOAD.railOpen }),
  setState: () => {},
});
</script>
<script src="icons.js"></script>
<script src="markdown.js"></script>
<script src="main.js"></script>
<script>
window.dispatchEvent(new MessageEvent("message", {
  data: { type: "state", connection: PAYLOAD.connection, snapshot: PAYLOAD.snapshot },
}));
</script>
</body></html>`;

// Written beside the assets so the stylesheet's own relative url() for the
// Watari mark resolves the way it does inside a webview.
// A design review commonly launches narrow/wide/theme variants together.
// Process-local harness names prevent one preview from deleting another one's
// page before Chromium has loaded it.
const harnessPath = join(media, `_preview-${process.pid}.html`);
const out = join(here, `preview-${theme}-${scene}-${width}x${height}.png`);
writeFileSync(harnessPath, harness);

const chromium = ["chromium", "google-chrome", "chromium-browser"].find((candidate) => {
  try {
    execFileSync("command", ["-v", candidate], { shell: "/bin/sh", stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
});

try {
  if (!chromium) throw new Error("no chromium on PATH");
  execFileSync(
    chromium,
    [
      "--headless",
      "--disable-gpu",
      "--no-sandbox",
      "--hide-scrollbars",
      // Each file:// document is its own opaque origin, so a mask or icon that
      // main.css pulls in is cross-origin here and silently drops. A real
      // webview serves every asset from one origin and needs no equivalent.
      "--allow-file-access-from-files",
      `--window-size=${width},${height}`,
      `--screenshot=${out}`,
      harnessPath,
    ],
    { stdio: ["ignore", "ignore", "pipe"], timeout: 60_000 },
  );
  console.log(existsSync(out) ? `wrote ${out}` : "chromium produced no screenshot");
} finally {
  if (existsSync(harnessPath)) unlinkSync(harnessPath);
}
