/**
 * Renders the Watari UI into the current terminal from a fixed demo snapshot.
 *
 * This is a design tool, not a test: it starts no service, spawns no native
 * harness, and makes no model call. Use it to review layout, spacing, and the
 * colour tokens without spending provider quota.
 *
 *   bun run preview                          dark theme, 110x34
 *   bun run preview -- light 100 30           light theme at another size
 *   bun run preview -- dark 110 34 empty      first-run state, no goal yet
 *   bun run preview -- dark 110 34 models     the guided harness picker
 *   bun run preview -- dark 110 34 catalog    OpenCode's model providers
 *   bun run preview -- dark 110 34 search     searching OpenCode's whole catalog
 *   bun run preview -- dark 110 34 help       the help panel
 *   bun run preview -- dark 110 34 agents     the agent profiles panel
 *   bun run preview -- dark 110 34 chats      the archived chat picker
 *   bun run preview -- dark 110 34 palette    the command palette after /
 *   bun run preview -- dark 110 34 . plain    character grid without colour
 */
import { testRender } from "@opentui/solid";

import type { ActivityDetail } from "../src/watari/activity/types.ts";
import { WatariApp } from "../src/watari/tui/app.tsx";
import type { RuntimeEvent, TeamSnapshot } from "../src/watari/state/types.ts";
import { chatClientDefaults } from "../tests/fakes/ui-client.ts";

const ESC = String.fromCharCode(27);
const [modeArgument, widthArgument, heightArgument, stateArgument] = process.argv.slice(2);
const mode = modeArgument === "light" ? "light" : "dark";
const width = Number(widthArgument ?? 110);
const height = Number(heightArgument ?? 34);
const empty = stateArgument === "empty";
/** Overlays are opened the way a reader opens them, through the composer. */
const OVERLAYS = ["models", "catalog", "search", "help", "agents", "chats"] as const;
const overlay = (OVERLAYS as readonly string[]).includes(stateArgument ?? "")
  ? (stateArgument as (typeof OVERLAYS)[number])
  : null;
/** The palette is not an overlay a command opens: it is what typing `/` shows. */
const palette = stateArgument === "palette";
/** `plain` prints the character grid only, which is what a diff or a log wants. */
const plain = process.argv.includes("plain");

process.env["WATARI_THEME"] = mode;
if (process.env["WATARI_DEBUG_UI"] !== "1") delete process.env.DEBUG;

const start = Date.now() - 8 * 60_000;
const at = (offset: number): number => start + offset * 1000;

const populated: TeamSnapshot = {
  schemaVersion: 2,
  agents: [
    {
      id: "codex",
      backend: "codex-app-server",
      displayName: "Codex",
      provider: "codex",
      model: "gpt-5-codex",
      effort: "medium",
      mode: "managed",
      sessionId: "thr_91af",
      state: "busy",
      currentGoalId: "goal-demo",
      updatedAt: at(430),
      detail: "editing src/watari/service/runtime.ts",
    },
    {
      id: "claude",
      backend: "claude-agent-sdk",
      displayName: "Claude",
      provider: "claude",
      model: "claude-opus-4-6",
      mode: "managed",
      sessionId: "ses_2c11",
      state: "waiting",
      currentGoalId: "goal-demo",
      updatedAt: at(424),
      detail: "awaiting approval for bash",
    },
    // An alias that is not its provider's name: the accent has to follow the
    // harness, not the word on the tab.
    {
      id: "reviewer",
      backend: "claude-agent-sdk",
      displayName: "Reviewer",
      provider: "claude",
      model: "claude-sonnet-4-6",
      mode: "managed",
      sessionId: "ses_88d0",
      state: "ready",
      currentGoalId: "goal-demo",
      updatedAt: at(420),
      detail: "read-only until it claims a scope",
    },
    {
      id: "opencode",
      backend: "opencode-acp",
      displayName: "OpenCode",
      provider: "opencode",
      model: "qwen/qwen3-coder",
      mode: "managed",
      sessionId: "ses_ac31",
      state: "busy",
      currentGoalId: "goal-demo",
      updatedAt: at(428),
      detail: "reading tests/async-queue.test.ts",
    },
  ],
  activeGoal: {
    id: "goal-demo6f2c19aa",
    instruction:
      "Harden the delivery queue so urgent peer messages are scheduled at safe native boundaries without dropping normal traffic.",
    origin: "user",
    initialAddressee: null,
    state: "active",
    createdAt: at(0),
    updatedAt: at(430),
  },
  messages: [
    {
      id: 1,
      goalId: "goal-demo",
      sender: "user",
      recipients: ["codex", "claude"],
      kind: "goal",
      priority: "normal",
      priorityReason: null,
      body: "Harden the delivery queue so urgent peer messages are scheduled at safe native boundaries without dropping normal traffic.",
      createdAt: at(0),
    },
    {
      id: 2,
      goalId: "goal-demo",
      sender: "codex",
      recipients: ["claude"],
      kind: "peer",
      priority: "normal",
      priorityReason: null,
      body: "I'll take src/watari/service/runtime.ts and the queue module. Can you cover the store schema and the acknowledgement path so we don't collide?",
      createdAt: at(42),
    },
    {
      id: 3,
      goalId: "goal-demo",
      sender: "claude",
      recipients: ["codex"],
      kind: "peer",
      priority: "normal",
      priorityReason: null,
      body: "Agreed. Claiming src/watari/state/store.ts plus tests/store.test.ts. I'll leave runtime.ts untouched.",
      createdAt: at(71),
    },
    {
      id: 4,
      goalId: "goal-demo",
      sender: "claude",
      recipients: ["codex"],
      kind: "peer",
      priority: "urgent",
      priorityReason: "A delivery bug can lose pending acknowledgements.",
      body: "Heads up: your last patch drops the acknowledgement row when a peer disconnects mid-turn. That loses messages.",
      createdAt: at(398),
    },
    {
      id: 5,
      goalId: "goal-demo",
      sender: "user",
      recipients: ["codex"],
      kind: "user",
      priority: "normal",
      priorityReason: null,
      body: "Please confirm the bounded queue still applies backpressure instead of dropping.",
      createdAt: at(416),
    },
  ],
  claims: [
    {
      id: "clm-1",
      goalId: "goal-demo",
      claimant: "codex",
      summary: "delivery queue scheduling",
      paths: ["src/watari/service/runtime.ts", "src/watari/util/async-queue.ts"],
      state: "active",
      note: null,
      createdAt: at(45),
      updatedAt: at(45),
    },
    {
      id: "clm-2",
      goalId: "goal-demo",
      claimant: "claude",
      summary: "durable acknowledgement rows",
      paths: ["src/watari/state/store.ts"],
      state: "active",
      note: null,
      createdAt: at(74),
      updatedAt: at(74),
    },
    {
      id: "clm-3",
      goalId: "goal-demo",
      claimant: "codex",
      summary: "queue tests",
      paths: ["tests/async-queue.test.ts"],
      state: "contested",
      note: "overlaps a claude claim",
      createdAt: at(120),
      updatedAt: at(360),
    },
  ],
  findings: [
    {
      id: "fnd-1",
      author: "claude",
      target: "codex",
      scope: "src/watari/service/runtime.ts",
      severity: "high",
      summary: "Acknowledgement row is dropped when a peer disconnects mid-turn",
      evidence: "runtime.ts:214",
      disposition: "open",
      createdAt: at(400),
      updatedAt: at(400),
    },
    {
      id: "fnd-2",
      author: "codex",
      target: "claude",
      scope: "src/watari/state/store.ts",
      severity: "low",
      summary: "Missing index on messages(goal_id, created_at)",
      evidence: null,
      disposition: "open",
      createdAt: at(408),
      updatedAt: at(408),
    },
  ],
  events: [
    { id: 1, agent: "codex", type: "session", summary: "native session started", providerEventId: null, createdAt: at(3) },
    { id: 2, agent: "claude", type: "session", summary: "native session started", providerEventId: null, createdAt: at(4) },
    { id: 3, agent: "codex", type: "reasoning", summary: "The queue already drops the oldest entry under pressure, so the change is really about which boundary a steer is allowed to land on. Codex exposes turn/steer only while a turn is open, which means an urgent message that arrives between turns has to wait for the next one.", providerEventId: null, createdAt: at(25) },
    { id: 4, agent: "codex", type: "tool_end", summary: "read  src/watari/service/runtime.ts", providerEventId: null, createdAt: at(30) },
    { id: 5, agent: "claude", type: "tool_end", summary: "search  acknowledgement", providerEventId: null, createdAt: at(58) },
    { id: 6, agent: "codex", type: "assistant", summary: "The delivery queue is bounded and applies backpressure, so nothing is dropped on the happy path. What is missing is the acknowledgement write when a peer disconnects during a turn, which is the case Claude found.", providerEventId: null, createdAt: at(300) },
    { id: 7, agent: "codex", type: "tool_end", summary: "edit  src/watari/util/async-queue.ts", providerEventId: "preview-edit", createdAt: at(333) },
    { id: 8, agent: "codex", type: "tool_start", summary: "bash  bun test tests/async-queue.test.ts", providerEventId: "preview-command", createdAt: at(352) },
    { id: 9, agent: "codex", type: "warning", summary: "path overlap contested with claude on tests/async-queue.test.ts", providerEventId: null, createdAt: at(360) },
    { id: 10, agent: "claude", type: "approval", summary: "bash: bun test tests/store.test.ts", providerEventId: "req_7731", createdAt: at(424) },
    { id: 15, agent: "codex", type: "approval", summary: "write src/watari/util/async-queue.ts", providerEventId: "req_7742", createdAt: at(426) },
    { id: 16, agent: "opencode", type: "tool_end", summary: "read  tests/async-queue.test.ts", providerEventId: null, createdAt: at(427) },
    {
      id: 11,
      agent: "claude",
      type: "assistant",
      summary: [
        "## What I changed",
        "",
        "Delivery now lands on a **safe native boundary** instead of waiting for idle:",
        "",
        "1. `tool_end` and `edit` both count as boundaries",
        "2. a whole turn completing counts too",
        "3. everything waiting is coalesced into one handover",
        "",
        "```ts",
        "if (isSafeBoundary(event)) {",
        "  this.#deliveryPending.add(id);",
        "}",
        "```",
        "",
        "> Nothing interrupts a running command.",
      ].join("\n"),
      providerEventId: null,
      createdAt: at(430),
    },
  ],
  activities: [
    {
      id: "act_111111111111111111111111",
      agent: "codex",
      kind: "file_change",
      state: "completed",
      title: "edit",
      preview: "src/watari/util/async-queue.ts",
      providerEventId: "preview-edit",
      revision: 2,
      startedAt: at(333),
      updatedAt: at(334),
      hasDetail: true,
    },
    {
      id: "act_222222222222222222222222",
      agent: "codex",
      kind: "command",
      state: "running",
      title: "bash",
      preview: "bun test tests/async-queue.test.ts",
      providerEventId: "preview-command",
      revision: 3,
      startedAt: at(352),
      updatedAt: at(358),
      hasDetail: true,
    },
  ],
  bridges: [
    {
      agent: "codex",
      state: "ready",
      detail: "8 team tools, roster answered in 41ms",
      tools: [],
      missing: [],
      elapsedMs: 41,
      checkedAt: at(60),
      providerReported: "connected",
    },
    {
      agent: "claude",
      state: "failed",
      detail: "the bridge did not answer team_roster within 10000ms",
      tools: [],
      missing: [],
      elapsedMs: 10_000,
      checkedAt: at(60),
    },
    {
      agent: "reviewer",
      state: "ready",
      detail: "8 team tools, roster answered in 55ms",
      tools: [],
      missing: [],
      elapsedMs: 55,
      checkedAt: at(60),
    },
    {
      agent: "opencode",
      state: "checking",
      detail: "handshaking",
      tools: [],
      missing: [],
      elapsedMs: 0,
      checkedAt: at(60),
    },
  ],
};

const blank: TeamSnapshot = {
  schemaVersion: 2,
  agents: [
    { id: "codex", backend: "codex-app-server", displayName: "Codex", sessionId: null, state: "ready", currentGoalId: null, updatedAt: at(0), detail: "native harness ready" },
    { id: "claude", backend: "claude-agent-sdk", displayName: "Claude", sessionId: null, state: "starting", currentGoalId: null, updatedAt: at(0), detail: null },
  ],
  activeGoal: null,
  messages: [],
  claims: [],
  findings: [],
  events: [],
  activities: [],
};

const previewDetails = new Map<string, ActivityDetail>([
  [
    "act_111111111111111111111111",
    {
      kind: "file_change",
      files: [{
        path: "src/watari/util/async-queue.ts",
        kind: "update",
        diff: "@@ -42,2 +42,3 @@\n-queue.shift();\n+const next = queue.shift();\n+if (next) deliver(next);",
        additions: 2,
        deletions: 1,
        retention: { truncated: false, originalBytes: 89, retainedBytes: 89, omittedBytes: 0, originalLines: 4, retainedLines: 4, omittedLines: 0 },
      }],
      retention: { truncated: false, originalBytes: 89, retainedBytes: 89, omittedBytes: 0, originalLines: 4, retainedLines: 4, omittedLines: 0 },
    },
  ],
  [
    "act_222222222222222222222222",
    {
      kind: "command",
      command: "bun test tests/async-queue.test.ts",
      cwd: "/home/you/project",
      outputMode: "combined",
      stdout: "bun test v1.4.0\n4 pass\n0 fail",
      stderr: "",
      exitCode: null,
      durationMs: null,
      interrupted: false,
      retention: { truncated: false, originalBytes: 31, retainedBytes: 31, omittedBytes: 0, originalLines: 3, retainedLines: 3, omittedLines: 0 },
    },
  ],
]);

/** Catalogs shaped like the real ones, so the picker can be reviewed offline.
 * Codex and Claude serve their own few models; OpenCode answers with other
 * people's, `vendor/model`, which is what the vendor step and search exist for. */
const OWN_MODELS = [
  { id: "gpt-5-codex", displayName: "GPT-5 Codex", description: "Codex-tuned reasoning model.", efforts: ["low", "medium", "high"], isDefault: true },
  { id: "gpt-5", displayName: "GPT-5", description: "General reasoning model.", efforts: ["low", "medium", "high"] },
  { id: "o4-mini", displayName: "o4-mini", description: "Faster, cheaper reasoning.", efforts: ["low", "medium"] },
];

const OPENCODE_MODELS = [
  ["anthropic/claude-sonnet-4-5", "Claude Sonnet 4.5"],
  ["anthropic/claude-opus-4-1", "Claude Opus 4.1"],
  ["anthropic/claude-haiku-4-5", "Claude Haiku 4.5"],
  ["openai/gpt-5", "GPT-5"],
  ["openai/gpt-5-mini", "GPT-5 mini"],
  ["google/gemini-2.5-pro", "Gemini 2.5 Pro"],
  ["google/gemini-2.5-flash", "Gemini 2.5 Flash"],
  ["qwen/qwen3-coder", "Qwen3 Coder"],
  ["qwen/qwen3-max", "Qwen3 Max"],
  ["deepseek/deepseek-v3", "DeepSeek V3"],
  ["openrouter/anthropic/claude-sonnet-4-5", "Claude Sonnet 4.5 (OpenRouter)"],
  ["openrouter/meta-llama/llama-4-maverick", "Llama 4 Maverick"],
  ["zai/glm-4.6", "GLM 4.6"],
].map(([id, displayName]) => ({
  id: id!,
  displayName: displayName!,
  description: `${displayName} served through OpenCode by ${id!.split("/")[0]}.`,
  efforts: id!.startsWith("anthropic/") ? ["low", "medium", "high"] : [],
}));

const modelsFor = (provider: string) => (provider === "opencode" ? OPENCODE_MODELS : OWN_MODELS);

const client = {
  ...chatClientDefaults,
  async listChats() {
    const hour = 60 * 60_000;
    return [
      { id: "2026-09-25T14-02-11.000Z-3f9a0c1d", path: "", startedAt: start, updatedAt: Date.now() - 50_000, title: "Harden the delivery queue so urgent peer messages are scheduled at safe native boundaries", goal: null, messages: 42, agents: ["codex", "claude"], current: true },
      { id: "2026-09-24T09-40-00.000Z-9b21e4aa", path: "", startedAt: start, updatedAt: Date.now() - 20 * hour, title: "Review parser error handling", goal: null, messages: 128, agents: ["codex", "claude"], current: false },
      { id: "2026-09-22T17-12-45.000Z-01cc7d52", path: "", startedAt: start, updatedAt: Date.now() - 70 * hour, title: "Port the settings screen to the new theme tokens", goal: null, messages: 17, agents: ["claude"], current: false },
    ];
  },
  snapshot: empty ? blank : populated,
  subscribe(_listener: (event: RuntimeEvent) => void) {
    return () => undefined;
  },
  async send() {},
  async interrupt() {},
  async approve() {},
    async checkBridges() {
      return [];
    },
    async configureAgent() {},
    async removeAgent() {},
    async availableModels(agent: string) {
      return modelsFor(agent === "opencode" ? "opencode" : "codex");
    },
    async availableProviderModels(provider: string) {
      return modelsFor(provider);
    },
    async getActivityDetail(activityId: string) {
      return previewDetails.get(activityId) ?? null;
    },
  async completeGoal() {},
  async restartAgent() {},
  async newChat() {},
  async shutdown() {},
};

const setup = await testRender(
  () => (
    <WatariApp
      client={client}
      project={{ launchDirectory: process.cwd(), repositoryRoot: process.cwd() }}
      stateDirectory={`${process.env["HOME"] ?? "~"}/.local/state/watari/preview`}
    />
  ),
  { width, height },
);

await setup.renderOnce();
await setup.renderOnce();

if (overlay) {
  const command = overlay === "help" || overlay === "agents" || overlay === "chats" ? `/${overlay}` : "/models";
  await setup.mockInput.typeText(command);
  setup.mockInput.pressEnter();
  await setup.waitForFrame((frame: string) =>
    frame.includes(overlay === "help" || overlay === "agents" || overlay === "chats" ? overlay : "provider"),
  );
  if (overlay === "catalog" || overlay === "search") {
    // Harness step → OpenCode → its model providers.
    setup.mockInput.pressArrow("down");
    setup.mockInput.pressArrow("down");
    setup.mockInput.pressEnter();
    await setup.waitForFrame((frame: string) => frame.includes("model provider"));
  }
  if (overlay === "search") {
    // "All providers", then a half-remembered name typed into the search.
    setup.mockInput.pressEnter();
    await setup.waitForFrame((frame: string) => frame.includes("search"));
    await setup.mockInput.typeText("sonnet");
    await setup.waitForFrame((frame: string) => frame.includes("Sonnet"));
  }
  await setup.renderOnce();
}

if (palette) {
  await setup.mockInput.typeText("/");
  await setup.waitForFrame((frame: string) => frame.includes("commands"));
  await setup.renderOnce();
}

if (plain) {
  process.stdout.write(`${setup.captureCharFrame()}\n`);
  setup.renderer.destroy();
  process.exit(0);
}

const frame = setup.captureSpans();
const rows: string[] = [];
for (const line of frame.lines) {
  let row = "";
  for (const span of line.spans) {
    const foreground = `38;2;${channel(span.fg.r)};${channel(span.fg.g)};${channel(span.fg.b)}`;
    const background = `48;2;${channel(span.bg.r)};${channel(span.bg.g)};${channel(span.bg.b)}`;
    const attributes: string[] = [];
    if (span.attributes & 1) attributes.push("1");
    if (span.attributes & 2) attributes.push("2");
    if (span.attributes & 4) attributes.push("3");
    if (span.attributes & 8) attributes.push("4");
    const suffix = attributes.length > 0 ? `;${attributes.join(";")}` : "";
    row += `${ESC}[0;${foreground};${background}${suffix}m${span.text}`;
  }
  rows.push(`${row}${ESC}[0m`);
}

process.stdout.write(`${rows.join("\n")}\n`);
setup.renderer.destroy();
process.exit(0);

function channel(value: number): number {
  return Math.round(value * 255);
}
