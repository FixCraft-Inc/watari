/**
 * Runs the panel script against a minimal DOM.
 *
 * `node --check` proves main.js parses, which is not the same as proving it
 * runs: a typo in a render path only shows up when that path is walked. This
 * stubs just enough DOM for the real script to build a real tree, then drives
 * it through every branch — messages, speech, work lines, notes, activity cards
 * in both kinds, approvals, the rail, and the empty state.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const mediaDir = join(here, "..", "media");

/** The smallest element that main.js can build a tree out of. */
class StubElement {
  constructor(tag, namespace) {
    this.tagName = String(tag).toUpperCase();
    this.namespaceURI = namespace ?? null;
    this.children = [];
    this.attributes = {};
    this.listeners = {};
    this.style = { setProperty: (name, value) => (this.style[name] = value) };
    this.className = "";
    this.textContent = "";
    this.innerHTML = "";
    this.value = "";
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.clientHeight = 0;
  }
  appendChild(child) {
    this.children.push(child);
    return child;
  }
  replaceChildren(...next) {
    this.children = next;
  }
  setAttribute(name, value) {
    this.attributes[name] = value;
  }
  addEventListener(name, handler) {
    (this.listeners[name] ||= []).push(handler);
  }
  focus() {}
  setSelectionRange() {}
  /** Flattened text, for asserting what actually reached the screen. */
  get allText() {
    return [this.textContent, this.innerHTML]
      .concat(this.children.map((child) => child.allText))
      .join(" ");
  }
  get allClasses() {
    return [this.className, this.attributes.class ?? ""]
      .concat(this.children.map((child) => child.allClasses))
      .join(" ");
  }
  /** Every icon in the subtree, by the shape data it was built from. Icons are
   * geometry rather than text, so this is how a test sees one at all. */
  get allShapes() {
    const own = this.namespaceURI ? [this.tagName.toLowerCase() + ":" + (this.attributes.d ?? "")] : [];
    return own.concat(...this.children.map((child) => child.allShapes));
  }
}

function loadPanel() {
  const root = new StubElement("div");
  root.id = "root";
  const posted = [];

  const documentStub = {
    createElement: (tag) => new StubElement(tag),
    createElementNS: (namespace, tag) => new StubElement(tag, namespace),
    getElementById: (id) => (id === "root" ? root : findById(root, id)),
    createDocumentFragment: () => new StubElement("fragment"),
    activeElement: null,
  };

  const listeners = [];
  const context = {
    console,
    Date,
    Math,
    Set,
    Map,
    Object,
    Array,
    String,
    Number,
    JSON,
    RegExp,
    Error,
    document: documentStub,
    window: { addEventListener: (name, handler) => listeners.push([name, handler]) },
    acquireVsCodeApi: () => ({
      postMessage: (message) => posted.push(message),
      getState: () => null,
      setState: () => undefined,
    }),
  };
  context.globalThis = context;
  vm.createContext(context);

  vm.runInContext(readFileSync(join(mediaDir, "icons.js"), "utf8"), context);
  vm.runInContext(readFileSync(join(mediaDir, "markdown.js"), "utf8"), context);
  vm.runInContext(readFileSync(join(mediaDir, "main.js"), "utf8"), context);

  const deliver = (message) => {
    for (const [name, handler] of listeners) {
      if (name === "message") handler({ data: message });
    }
  };
  return { root, posted, deliver };
}

function findById(node, id) {
  if (node.id === id || node.attributes.id === id) return node;
  for (const child of node.children) {
    const found = findById(child, id);
    if (found) return found;
  }
  return null;
}

const snapshot = {
  schemaVersion: 2,
  agents: [
    {
      id: "codex",
      backend: "codex-app-server",
      displayName: "Codex",
      provider: "codex",
      model: "gpt-5-codex",
      mode: "managed",
      sessionId: "thr_1",
      state: "busy",
      currentGoalId: "g1",
      updatedAt: Date.now(),
      detail: "editing runtime.ts",
    },
    {
      id: "reviewer",
      backend: "claude-agent-sdk",
      displayName: "Reviewer",
      provider: "claude",
      model: "claude-opus-4-6",
      mode: "managed",
      sessionId: "ses_1",
      state: "waiting",
      currentGoalId: "g1",
      updatedAt: Date.now(),
      detail: "awaiting approval",
    },
    {
      id: "oc",
      backend: "opencode-acp",
      displayName: "OC",
      provider: "opencode",
      model: "anthropic/claude-sonnet-4-5",
      mode: "managed",
      sessionId: null,
      state: "ready",
      currentGoalId: null,
      updatedAt: Date.now(),
      detail: null,
    },
  ],
  activeGoal: {
    id: "g1",
    instruction: "harden the delivery queue",
    origin: "user",
    initialAddressee: "codex",
    state: "active",
    createdAt: Date.now() - 60_000,
    updatedAt: Date.now() - 5_000,
  },
  messages: [
    {
      id: 1,
      goalId: "g1",
      sender: "user",
      recipients: ["codex"],
      kind: "goal",
      priority: "normal",
      priorityReason: null,
      body: "harden the delivery queue",
      createdAt: Date.now() - 60_000,
    },
    {
      id: 2,
      goalId: "g1",
      sender: "codex",
      recipients: ["reviewer"],
      kind: "peer",
      priority: "urgent",
      priorityReason: "delivery correctness",
      body: "Taking `runtime.ts`.\n\n- please cover the store\n- **do not** touch the queue",
      createdAt: Date.now() - 30_000,
    },
  ],
  claims: [
    {
      id: "c1",
      goalId: "g1",
      claimant: "codex",
      summary: "delivery queue",
      paths: ["src/runtime.ts"],
      state: "contested",
      note: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
  ],
  findings: [
    {
      id: "f1",
      author: "reviewer",
      target: "codex",
      scope: null,
      severity: "high",
      summary: "acknowledgement row dropped",
      evidence: null,
      disposition: "open",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
  ],
  events: [
    { id: 10, agent: "codex", type: "assistant", summary: "The queue is bounded.", providerEventId: "msg_1", createdAt: Date.now() - 25_000 },
    { id: 11, agent: "codex", type: "reasoning", summary: "considering the shutdown path", providerEventId: "rs_1", createdAt: Date.now() - 24_000 },
    { id: 12, agent: "reviewer", type: "tool_start", summary: "bash  bun test", providerEventId: "t_1", createdAt: Date.now() - 20_000 },
    { id: 13, agent: "reviewer", type: "warning", summary: "path overlap contested", providerEventId: null, createdAt: Date.now() - 15_000 },
    { id: 14, agent: "codex", type: "approval", summary: "write src/runtime.ts", providerEventId: "req_7742", createdAt: Date.now() - 10_000 },
  ],
  activities: [
    {
      id: "act_" + "a".repeat(24),
      agent: "codex",
      kind: "command",
      state: "completed",
      title: "bash",
      preview: "bun test tests/store.test.ts",
      providerEventId: "cmd_1",
      revision: 2,
      startedAt: Date.now() - 18_000,
      updatedAt: Date.now() - 17_000,
      hasDetail: true,
    },
    {
      id: "act_" + "b".repeat(24),
      agent: "reviewer",
      kind: "file_change",
      state: "running",
      title: "edit",
      preview: "src/store.ts",
      providerEventId: "edit_1",
      revision: 1,
      startedAt: Date.now() - 16_000,
      updatedAt: Date.now() - 16_000,
      hasDetail: true,
    },
  ],
  bridges: [
    { agent: "codex", state: "ready", detail: "team bridge ok" },
    { agent: "reviewer", state: "failed", detail: "team bridge unreachable" },
    { agent: "oc", state: "checking", detail: "checking team bridge" },
  ],
};

const ready = { state: "ready", detail: "api v2", project: "/work" };

test("the panel asks for state as soon as it loads", () => {
  const { posted } = loadPanel();
  assert.ok(
    posted.some((message) => message.type === "ready"),
    JSON.stringify(posted),
  );
});

test("a full snapshot renders every kind of row without throwing", () => {
  const { root, deliver } = loadPanel();
  deliver({ type: "state", connection: ready, snapshot });

  const text = root.allText;
  const classes = root.allClasses;

  assert.match(text, /harden the delivery queue/, "goal is missing");
  assert.match(text, /Codex/, "roster tab is missing");
  assert.match(text, /urgent/, "priority label is missing");
  assert.match(text, /The queue is bounded/, "assistant text is missing");
  assert.match(text, /considering the shutdown path/, "reasoning is missing");
  assert.match(text, /bun test/, "work line is missing");
  assert.match(text, /path overlap contested/, "warning is missing");
  assert.match(text, /acknowledgement row dropped/, "finding is missing");
  assert.match(text, /team bridge unreachable/, "failed bridge is missing");

  assert.match(classes, /\bmessage\b/);
  assert.match(classes, /\bspeech\b/);
  assert.match(classes, /\bcard\b/);
  assert.match(classes, /\bapproval\b/);
  assert.match(classes, /\brail\b/);
  assert.match(classes, /\bcomposer\b/);
});

test("message bodies arrive as rendered Markdown, not source", () => {
  const { root, deliver } = loadPanel();
  deliver({ type: "state", connection: ready, snapshot });
  const text = root.allText;
  assert.match(text, /<code>runtime\.ts<\/code>/, "inline code was not rendered");
  assert.match(text, /<strong>do not<\/strong>/, "bold was not rendered");
  assert.match(text, /<li>please cover the store<\/li>/, "list was not rendered");
});

test("an unconnected panel shows a banner and disables the composer", () => {
  const { root, deliver } = loadPanel();
  deliver({
    type: "connection",
    connection: { state: "closed", detail: "service went away", project: "/work" },
  });
  assert.match(root.allClasses, /\bbanner\b/);
  assert.match(root.allText, /service went away/);

  const composer = collect(root, (node) => node.attributes.id === "composer-input");
  assert.equal(composer.length, 1);
  assert.equal(composer[0].attributes.disabled, "", "the composer should refuse input");
  const send = collect(root, (node) => node.className === "send");
  assert.equal(send[0].attributes.disabled, "", "send should be disabled");
});

test("an empty team explains what the first message will do", () => {
  const { root, deliver } = loadPanel();
  deliver({
    type: "state",
    connection: ready,
    snapshot: { ...snapshot, messages: [], events: [], activities: [], activeGoal: null },
  });
  assert.match(root.allText, /opens the shared goal/);
  assert.match(root.allText, /No goal yet/);
});

test("expanding a card asks for its detail exactly once", () => {
  const { root, posted, deliver } = loadPanel();
  deliver({ type: "state", connection: ready, snapshot });

  const heads = collect(root, (node) => node.className === "card-head");
  assert.ok(heads.length >= 2, `expected activity cards, found ${heads.length}`);
  heads[0].listeners.click[0]();

  const asked = posted.filter((message) => message.type === "activityDetail");
  assert.equal(asked.length, 1, JSON.stringify(posted));
  assert.match(asked[0].id, /^act_/);
});

test("a detail-less card explains itself without making a request", () => {
  const activity = {
    ...snapshot.activities[0],
    id: "act_" + "c".repeat(24),
    hasDetail: false,
  };
  const { root, posted, deliver } = loadPanel();
  deliver({ type: "state", connection: ready, snapshot: { ...snapshot, activities: [activity] } });
  collect(root, (node) => node.className === "card-head")[0].listeners.click[0]();

  assert.match(root.allText, /Detail unavailable/);
  assert.equal(posted.filter((message) => message.type === "activityDetail").length, 0);
});

test("a command detail renders its command, exit code, and output", () => {
  const { root, deliver } = loadPanel();
  deliver({ type: "state", connection: ready, snapshot });
  collect(root, (node) => node.className === "card-head")[0].listeners.click[0]();
  deliver({
    type: "activityDetail",
    id: "act_" + "a".repeat(24),
    detail: {
      kind: "command",
      command: "bun test tests/store.test.ts",
      cwd: "/work",
      outputMode: "split",
      stdout: "12 pass",
      stderr: "",
      exitCode: 0,
      durationMs: 1234,
      interrupted: false,
      retention: { truncated: true, omittedBytes: 4096, omittedLines: 40 },
    },
  });
  const text = root.allText;
  assert.match(text, /bun test tests\/store\.test\.ts/);
  assert.match(text, /exit 0/);
  assert.match(text, /12 pass/);
  assert.match(text, /4096 bytes/, "the retention notice is missing");
});

test("a file-change detail renders a diff with per-file navigation", () => {
  const { root, deliver } = loadPanel();
  deliver({ type: "state", connection: ready, snapshot });
  const heads = collect(root, (node) => node.className === "card-head");
  heads[1].listeners.click[0]();
  deliver({
    type: "activityDetail",
    id: "act_" + "b".repeat(24),
    detail: {
      kind: "file_change",
      files: [
        {
          path: "src/store.ts",
          kind: "update",
          diff: "@@ -1 +1 @@\n-old line\n+new line",
          additions: 1,
          deletions: 1,
          retention: { truncated: false, omittedBytes: 0, omittedLines: 0 },
        },
        {
          path: "src/queue.ts",
          kind: "add",
          diff: "+created",
          additions: 1,
          deletions: 0,
          retention: { truncated: false, omittedBytes: 0, omittedLines: 0 },
        },
      ],
      retention: { truncated: false, omittedBytes: 0, omittedLines: 0 },
    },
  });
  assert.match(root.allText, /src\/store\.ts/);
  assert.match(root.allText, /new line/);
  assert.match(root.allText, /1\/2/, "file counter is missing");
  assert.match(root.allClasses, /diff-add/);
  assert.match(root.allClasses, /diff-del/);
});

test("answering an approval sends the peer and the exact request id", () => {
  const { root, posted, deliver } = loadPanel();
  deliver({ type: "state", connection: ready, snapshot });
  const buttons = collect(
    root,
    (node) => node.className === "primary" && node.textContent === "Allow",
  );
  assert.equal(buttons.length, 1);
  buttons[0].listeners.click[0]();
  // Spread into this realm first: the message was built inside the vm context,
  // so a deep-equal against a literal here compares prototypes, not contents.
  const answer = { ...posted.find((message) => message.type === "approve") };
  assert.deepEqual(answer, {
    type: "approve",
    agent: "codex",
    requestId: "req_7742",
    decision: "accept",
  });
});

test("an incremental event updates the transcript without a refetch", () => {
  const { root, posted, deliver } = loadPanel();
  deliver({ type: "state", connection: ready, snapshot });
  const before = posted.length;
  deliver({
    type: "event",
    event: {
      type: "transcript_upsert",
      event: {
        id: 99,
        agent: "codex",
        type: "assistant",
        summary: "a brand new sentence",
        providerEventId: "msg_9",
        createdAt: Date.now(),
      },
    },
  });
  assert.match(root.allText, /a brand new sentence/);
  assert.equal(posted.length, before, "an incremental event should not trigger a request");
});

test("a work event an activity card already covers is not drawn twice", () => {
  const { root, deliver } = loadPanel();
  const duplicated = {
    ...snapshot,
    events: [
      ...snapshot.events,
      { id: 20, agent: "codex", type: "tool_end", summary: "bash  covered", providerEventId: "cmd_1", createdAt: Date.now() },
    ],
  };
  deliver({ type: "state", connection: ready, snapshot: duplicated });
  assert.doesNotMatch(root.allText, /covered/, "the event duplicated its activity card");
});

// The panel used to draw state as characters. Everything below asserts that
// what reaches the screen is geometry: a test that only looked at text would
// pass on an empty box where an icon should be.
test("state, outcome and severity are drawn as icons, not characters", () => {
  const { root, deliver } = loadPanel();
  deliver({ type: "state", connection: ready, snapshot });

  const shapes = root.allShapes;
  const roots = shapes.filter((shape) => shape.startsWith("svg:"));
  const drawn = shapes.filter((shape) => !shape.startsWith("svg:"));
  assert.ok(roots.length > 12, `expected icons, found ${roots.length}`);
  assert.ok(drawn.length >= roots.length, "every icon should draw something");
  for (const shape of drawn) {
    assert.match(shape, /^(path|circle|rect|line):/, `unexpected icon shape: ${shape}`);
  }

  // No ASCII stand-in survives anywhere on screen.
  const text = root.allText;
  for (const glyph of ["✓", "✕", "⋯", "▸", "▾", "△", "≠", "‹", "›", "◌", "◍", "◑"]) {
    assert.ok(!text.includes(glyph), `still drawing "${glyph}" as text`);
  }
});

test("a busy peer gets a spinning icon and an idle one does not", () => {
  const { root, deliver } = loadPanel();
  deliver({ type: "state", connection: ready, snapshot });
  const spinning = collect(root, (node) => String(node.attributes.class ?? "").includes("is-spinning"));
  assert.ok(spinning.length > 0, "nothing is animated while a peer is busy");

  const { root: calm, deliver: deliverCalm } = loadPanel();
  deliverCalm({
    type: "state",
    connection: ready,
    snapshot: {
      ...snapshot,
      agents: snapshot.agents.map((agent) => ({ ...agent, state: "ready" })),
      activities: snapshot.activities.map((activity) => ({ ...activity, state: "completed" })),
      events: [],
      bridges: snapshot.bridges.map((bridge) => ({ ...bridge, state: "ready" })),
    },
  });
  const stillSpinning = collect(calm, (node) =>
    String(node.attributes.class ?? "").includes("is-spinning"),
  );
  assert.equal(stillSpinning.length, 0, "an idle team should have nothing spinning");
});

// Stop cuts a native turn that cannot be resumed, so the webview only ever
// asks; the extension host raises the modal and decides.
test("stop appears only while a peer works and asks rather than acts", () => {
  const { root, posted, deliver } = loadPanel();
  deliver({ type: "state", connection: ready, snapshot });

  const stop = collect(root, (node) => node.className === "stop");
  assert.equal(stop.length, 1, "codex is busy, so exactly one stop control belongs here");
  stop[0].listeners.click[0]();

  const asked = { ...posted.find((message) => message.type === "interrupt") };
  assert.equal(asked.type, "interrupt");
  assert.deepEqual([...(asked.agents ?? [])], ["codex"]);
});

test("no stop control is offered when nothing is running", () => {
  const { root, deliver } = loadPanel();
  deliver({
    type: "state",
    connection: ready,
    snapshot: { ...snapshot, agents: snapshot.agents.map((agent) => ({ ...agent, state: "ready" })) },
  });
  assert.equal(collect(root, (node) => node.className === "stop").length, 0);
});

function collect(node, predicate, found = []) {
  if (predicate(node)) found.push(node);
  for (const child of node.children) collect(child, predicate, found);
  return found;
}
