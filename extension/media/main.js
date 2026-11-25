/**
 * The Watari team panel.
 *
 * Plain DOM on purpose: the panel has one screen and a handful of widgets, and
 * a framework would cost more in bundle and build than it saves in this file.
 * The transcript keeps the reader's scroll position across re-renders, because
 * a streaming turn rewrites rows many times a second and yanking the view to
 * the bottom mid-read is the fastest way to make a live panel unusable.
 */
(function () {
  "use strict";

  const vscode = acquireVsCodeApi();
  const root = document.getElementById("root");

  const state = {
    snapshot: null,
    connection: { state: "connecting", detail: "Connecting...", project: "" },
    tab: "global",
    expanded: new Set(),
    details: new Map(),
    files: new Map(),
    draft: "",
    railOpen: false,
  };

  const restored = vscode.getState();
  if (restored && typeof restored.tab === "string") state.tab = restored.tab;
  if (restored && typeof restored.draft === "string") state.draft = restored.draft;
  if (restored && typeof restored.railOpen === "boolean") state.railOpen = restored.railOpen;

  // -- identity ---------------------------------------------------------

  const HARNESS_VAR = {
    codex: "--wat-codex",
    claude: "--wat-claude",
    opencode: "--wat-opencode",
    qwen: "--wat-qwen",
  };
  const MODEL_VENDOR = {
    anthropic: "claude",
    claude: "claude",
    openai: "codex",
    codex: "codex",
    qwen: "qwen",
    alibaba: "qwen",
    dashscope: "qwen",
  };
  const VIA_VAR = { claude: "--wat-via-claude", codex: "--wat-via-codex", qwen: "--wat-via-qwen" };

  /** The harness behind an alias. The stored provider wins; the backend name is
   * the fallback for a snapshot written before providers were recorded. */
  function harnessOf(agent) {
    if (!agent) return null;
    const named = (agent.provider || "").trim().toLowerCase();
    if (named) return named;
    const backend = (agent.backend || "").trim().toLowerCase();
    return backend ? backend.split("-")[0] : null;
  }

  /** The model provider inside an OpenCode-style vendor/model identifier. A
   * router prefix is stepped over, so openrouter/anthropic/... is Anthropic. */
  function modelVendorOf(model) {
    const segments = String(model || "").toLowerCase().split("/").filter(Boolean);
    if (segments.length < 2) return null;
    return segments.slice(0, -1).find((segment) => segment in MODEL_VENDOR) || segments[0] || null;
  }

  /**
   * The colour one agent is drawn in.
   *
   * A function of the harness, never of the alias, so renaming a peer changes
   * nothing and two agents on one harness share a colour while their names and
   * tabs keep them apart. OpenCode is a harness over other people's models
   * rather than a vendor, so it keeps its own identity and only leans towards
   * the model it happens to be running.
   */
  function accentOf(who) {
    if (!who) return "var(--vscode-descriptionForeground)";
    const key = String(who).toLowerCase();
    if (key === "you" || key === "user") return "var(--vscode-foreground)";
    if (key === "watari" || key === "system") return "var(--wat-brand)";

    const agents = (state.snapshot && state.snapshot.agents) || [];
    const agent = agents.find((candidate) => candidate.id.toLowerCase() === key);
    const harness = harnessOf(agent);
    if (!harness) return "var(--vscode-descriptionForeground)";
    if (harness !== "opencode") {
      return "var(" + (HARNESS_VAR[harness] || "--wat-opencode") + ")";
    }
    const vendor = MODEL_VENDOR[modelVendorOf(agent && agent.model) || ""];
    return vendor ? "var(" + VIA_VAR[vendor] + ")" : "var(--wat-opencode)";
  }


  // -- helpers ----------------------------------------------------------

  function el(tag, props, children) {
    const node = document.createElement(tag);
    const entries = Object.entries(props || {});
    for (let index = 0; index < entries.length; index += 1) {
      const key = entries[index][0];
      const value = entries[index][1];
      if (value === null || value === undefined || value === false) continue;
      if (key === "class") node.className = value;
      else if (key === "text") node.textContent = value;
      else if (key === "html") node.innerHTML = value;
      else if (key.indexOf("on") === 0) node.addEventListener(key.slice(2).toLowerCase(), value);
      else if (key === "style") {
        for (const [name, setting] of Object.entries(value)) {
          if (name.indexOf("--") === 0) node.style.setProperty(name, setting);
          else node.style[name] = setting;
        }
      } else node.setAttribute(key, value === true ? "" : String(value));
    }
    for (const child of children || []) {
      if (child) node.appendChild(child);
    }
    return node;
  }

  function clockTime(ms) {
    const date = new Date(ms);
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");
    return hours + ":" + minutes;
  }

  function relativeAge(ms) {
    const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (seconds < 60) return seconds + "s";
    if (seconds < 3600) return Math.round(seconds / 60) + "m";
    if (seconds < 86400) return Math.round(seconds / 3600) + "h";
    return Math.round(seconds / 86400) + "d";
  }

  /** Markdown rendering lives in markdown.js so its escaping can be tested
   * outside a browser; it is loaded before this file. */
  const renderMarkdown = globalThis.watariMarkdown.render;

  /** Icons are geometry, not glyphs — see icons.js. */
  const icon = globalThis.watariIcons.icon;
  const stateIcon = globalThis.watariIcons.stateIcon;
  const bridgeIcon = globalThis.watariIcons.bridgeIcon;
  const activityIcon = globalThis.watariIcons.activityIcon;

  // -- transcript model -------------------------------------------------

  const SPEECH_TYPES = new Set(["assistant", "reasoning"]);
  const WORK_TYPES = new Set(["tool_start", "tool_end", "edit", "diff"]);
  const LOUD_TYPES = new Set(["error", "warning", "approval"]);
  const MAX_ENTRIES = 400;

  /**
   * Merges messages, provider events, and structured activity into one ordered
   * transcript.
   *
   * An event that an activity card already covers is dropped rather than drawn
   * twice: the card is the richer view of exactly the same unit of work.
   */
  function buildEntries(snapshot, filter) {
    if (!snapshot) return [];
    const entries = [];
    const covered = new Set(
      (snapshot.activities || []).map((activity) => activity.agent + " " + activity.providerEventId),
    );

    for (const message of snapshot.messages || []) {
      if (filter && message.sender !== filter && message.recipients.indexOf(filter) < 0) continue;
      entries.push({ kind: "message", key: "m" + message.id, timestamp: message.createdAt, message });
    }

    const awaiting = new Set(pendingApprovals(snapshot).map((event) => event.id));
    for (const event of snapshot.events || []) {
      if (filter && event.agent !== filter) continue;
      if (
        event.agent &&
        event.providerEventId &&
        WORK_TYPES.has(event.type) &&
        covered.has(event.agent + " " + event.providerEventId)
      ) {
        continue;
      }
      // An approval still waiting has a card of its own, with the buttons on
      // it. A line saying the same thing directly above it is noise.
      if (awaiting.has(event.id)) continue;
      entries.push({ kind: "event", key: "e" + event.id, timestamp: event.createdAt, event });
    }

    for (const activity of snapshot.activities || []) {
      if (filter && activity.agent !== filter) continue;
      entries.push({ kind: "activity", key: activity.id, timestamp: activity.startedAt, activity });
    }

    entries.sort((a, b) => a.timestamp - b.timestamp || a.key.localeCompare(b.key));
    return entries.slice(-MAX_ENTRIES);
  }

  /** Approvals still waiting for an answer, newest last. */
  function pendingApprovals(snapshot) {
    if (!snapshot) return [];
    const answered = new Set();
    const open = [];
    for (const event of snapshot.events || []) {
      if (event.type === "approval" && event.providerEventId) open.push(event);
      else if (event.providerEventId && event.type.indexOf("approval_") === 0) {
        answered.add(event.providerEventId);
      }
    }
    return open.filter((event) => !answered.has(event.providerEventId));
  }

  // -- rendering --------------------------------------------------------

  function render() {
    const snapshot = state.snapshot;
    const connection = state.connection;
    const shell = el("div", { class: "shell" });
    // Rows: [banner?] goal, tabs, body, rail strip, composer.
    shell.style.gridTemplateRows =
      (connection.state !== "ready" ? "auto " : "") + "auto auto minmax(0, 1fr) auto auto";

    if (connection.state !== "ready") shell.appendChild(renderBanner(connection));
    shell.appendChild(renderGoal(snapshot));
    shell.appendChild(renderTabs(snapshot));

    const body = el("div", { class: "body" });
    const transcript = el("div", { class: "transcript", id: "transcript" });
    const filter = state.tab === "global" ? null : state.tab;
    const entries = buildEntries(snapshot, filter);

    if (entries.length === 0) transcript.appendChild(renderEmpty(snapshot));
    else for (const entry of entries) transcript.appendChild(renderEntry(entry));

    for (const approval of pendingApprovals(snapshot)) {
      transcript.appendChild(renderApproval(approval));
    }
    body.appendChild(transcript);
    body.appendChild(renderRail(snapshot));
    shell.appendChild(body);
    // The strip is the only always-visible summary of team state at sidebar
    // width, so it carries the counts rather than just opening the drawer.
    shell.appendChild(renderRailToggle(snapshot));
    shell.appendChild(renderComposer(snapshot));

    // Follow the tail only when the reader was already at it. Scrolling back
    // through a long turn is exactly when new rows keep arriving, and yanking
    // the view down would make that impossible.
    const previous = document.getElementById("transcript");
    const pinned =
      !previous || previous.scrollHeight - previous.scrollTop - previous.clientHeight < 80;
    const previousTop = previous ? previous.scrollTop : 0;
    const focusWasComposer =
      document.activeElement && document.activeElement.id === "composer-input";
    const caret = focusWasComposer ? document.activeElement.selectionStart : null;

    root.replaceChildren(shell);

    const next = document.getElementById("transcript");
    if (next) next.scrollTop = pinned ? next.scrollHeight : previousTop;

    if (focusWasComposer) {
      const composer = document.getElementById("composer-input");
      if (composer) {
        composer.focus();
        if (caret !== null) composer.setSelectionRange(caret, caret);
        autosize(composer);
      }
    }
  }

  function renderBanner(connection) {
    const connecting = connection.state === "connecting";
    return el("div", { class: "banner" + (connecting ? " is-connecting" : "") }, [
      el("span", { class: "banner-icon" }, [
        connecting ? icon("busy", { size: 14 }) : icon("error", { size: 14 }),
      ]),
      el("span", { class: "detail", text: connection.detail }),
      connecting
        ? null
        : el("button", { onclick: () => vscode.postMessage({ type: "reconnect" }) }, [
            icon("refresh", { size: 13 }),
            el("span", { text: "Reconnect" }),
          ]),
    ]);
  }

  function renderGoal(snapshot) {
    const goal = snapshot && snapshot.activeGoal;
    if (!goal) {
      return el("div", { class: "goal is-empty" }, [
        icon("goal", { size: 13 }),
        el("span", { class: "goal-text", text: "No goal yet" }),
      ]);
    }
    // The age used a row of its own and answered a question nobody had asked.
    // It is worth keeping, so it moves to the tooltip and costs nothing.
    return el(
      "div",
      {
        class: "goal",
        title: goal.instruction + "\n\nopen " + relativeAge(goal.createdAt) + ", last moved " + relativeAge(goal.updatedAt) + " ago",
      },
      [icon("goal", { size: 13 }), el("span", { class: "goal-text", text: goal.instruction })],
    );
  }

  function renderTabs(snapshot) {
    const agents = (snapshot && snapshot.agents) || [];
    const tabs = el("div", { class: "tabs", role: "tablist" });

    tabs.appendChild(
      el(
        "button",
        {
          class: "tab",
          role: "tab",
          "aria-selected": state.tab === "global" ? "true" : "false",
          onclick: () => selectTab("global"),
        },
        [el("span", { text: "Global" })],
      ),
    );

    for (const agent of agents) {
      const accent = accentOf(agent.id);
      const model = agent.model ? " · " + agent.model : "";
      tabs.appendChild(
        el(
          "button",
          {
            class: "tab",
            role: "tab",
            "aria-selected": state.tab === agent.id ? "true" : "false",
            style: { "--tab-accent": accent },
            title: agent.id + " · " + (harnessOf(agent) || "unknown") + model,
            onclick: () => selectTab(agent.id),
          },
          [
            el(
              "span",
              {
                class: "tab-state" + (agent.state === "failed" ? " is-failed" : ""),
                style: { color: agent.state === "failed" ? "" : accent },
                title: agent.state,
              },
              [stateIcon(agent.state, { size: 12 })],
            ),
            el("span", { text: agent.displayName || agent.id }),
          ],
        ),
      );
    }
    return tabs;
  }

  function renderEmpty(snapshot) {
    const peers = ((snapshot && snapshot.agents) || []).map(
      (agent) => agent.displayName || agent.id,
    );
    const roster =
      peers.length === 0
        ? "No agent is configured yet."
        : peers.length === 1
          ? peers[0] + " shares this checkout with you."
          : peers.slice(0, -1).join(", ") +
            " and " +
            peers[peers.length - 1] +
            " share this checkout as equal peers.";
    return el("div", { class: "empty" }, [
      el("h1", {}, [el("span", { class: "mark" }), el("span", { text: "Watari" })]),
      el("p", { text: roster }),
      el("ul", {}, [
        el("li", { text: "Your first message opens the shared goal." }),
        el("li", {
          text: "Global reaches every ready peer; a peer's own tab reaches only them.",
        }),
      ]),
    ]);
  }

  function renderEntry(entry) {
    if (entry.kind === "message") return renderMessage(entry.message);
    if (entry.kind === "activity") return renderCard(entry.activity);
    const event = entry.event;
    if (SPEECH_TYPES.has(event.type)) return renderSpeech(event);
    if (WORK_TYPES.has(event.type)) return renderWork(event);
    return renderNote(event);
  }

  function renderMessage(message) {
    const isUser = message.sender === "user";
    const audience = audienceLabel(message.recipients);
    return el(
      "div",
      { class: "message" + (isUser ? " is-user" : ""), style: { "--accent": accentOf(message.sender) } },
      [
        el("div", { class: "message-head" }, [
          el("span", { class: "message-from", text: isUser ? "you" : message.sender }),
          audience ? el("span", { class: "message-to", text: "→ " + audience }) : null,
          message.priority !== "normal"
            ? el("span", {
                class: "message-priority" + (message.priority === "stop" ? " is-stop" : ""),
                text: message.priority,
                title: message.priorityReason || "",
              })
            : null,
          el("span", { class: "message-time", text: clockTime(message.createdAt) }),
        ]),
        el("div", { class: "message-body", html: renderMarkdown(message.body) }),
      ],
    );
  }

  function audienceLabel(recipients) {
    const agents = (state.snapshot && state.snapshot.agents) || [];
    if (!recipients || recipients.length === 0) return "";
    if (agents.length > 0 && recipients.length >= agents.length) return "everyone";
    return recipients.join(", ");
  }

  function renderSpeech(event) {
    const thinking = event.type === "reasoning";
    return el(
      "div",
      {
        class: "message speech" + (thinking ? " is-thinking" : ""),
        style: { "--accent": accentOf(event.agent) },
      },
      [
        el("div", { class: "message-head" }, [
          el("span", { class: "message-from", text: event.agent || "watari" }),
          thinking ? el("span", { class: "message-to", text: "thinking" }) : null,
          el("span", { class: "message-time", text: clockTime(event.createdAt) }),
        ]),
        el("div", { class: "message-body", html: renderMarkdown(event.summary) }),
      ],
    );
  }

  function renderWork(event) {
    const summary = String(event.summary || "").replace(/[\r\n]+/g, " ");
    const failed = /\s+failed$/.test(summary);
    const parts = summary.replace(/\s+failed$/, "").split(/\s{2,}/);
    const verb = parts.shift() || "work";
    const running = event.type === "tool_start";
    const detail = parts.join(" ");
    return el(
      "div",
      {
        class: "work entry " + (failed ? "is-failed" : running ? "is-running" : ""),
        style: { "--accent": accentOf(event.agent) },
      },
      [
        el("span", { class: "glyph" }, [
          failed ? icon("error", { size: 13 }) : running ? icon("busy", { size: 13 }) : icon("check", { size: 13 }),
        ]),
        el("span", { class: "who", text: event.agent || "" }),
        el("span", { class: "verb", text: verb }),
        el("span", { class: "detail", text: detail, title: detail }),
      ],
    );
  }

  /** A note's icon says what kind of notice it is; routine steps get a dot. */
  function noteIcon(type) {
    if (type === "error") return icon("error", { size: 13 });
    if (type === "warning") return icon("warning", { size: 13 });
    if (type === "approval") return icon("warning", { size: 13 });
    return icon("info", { size: 13 });
  }

  function renderNote(event) {
    const loud = LOUD_TYPES.has(event.type);
    return el(
      "div",
      {
        class:
          "note entry" + (loud ? " is-loud" : "") + (event.type === "error" ? " is-failed" : ""),
        style: { "--accent": accentOf(event.agent) },
      },
      [
        el("span", { class: "glyph" }, [noteIcon(event.type)]),
        el("span", { class: "who", text: event.agent || "watari" }),
        loud ? el("span", { class: "kind", text: event.type.replace(/_/g, " ") }) : null,
        el("span", { class: "detail", text: event.summary, title: event.summary }),
      ],
    );
  }

  function renderCard(activity) {
    const expanded = state.expanded.has(activity.id);
    const detail = state.details.get(activity.id);
    const tone =
      activity.state === "failed" || activity.state === "interrupted"
        ? "is-failed"
        : activity.state === "running"
          ? "is-running"
          : "";

    const card = el("div", { class: "card", style: { "--accent": accentOf(activity.agent) } }, [
      el(
        "button",
        {
          class: "card-head",
          "aria-expanded": expanded ? "true" : "false",
          onclick: () => toggleCard(activity),
        },
        [
          el("span", { class: "chevron" }, [
            icon(expanded ? "chevronDown" : "chevronRight", { size: 12 }),
          ]),
          el("span", { class: "glyph " + tone }, [
            activityIcon(activity.kind, activity.state, { size: 13 }),
          ]),
          el("span", { class: "who", text: activity.agent }),
          el("span", { class: "title", text: activity.title }),
          el("span", { class: "preview", text: activity.preview, title: activity.preview }),
          el("span", { class: "state " + tone, text: activity.state }),
        ],
      ),
    ]);

    if (!expanded) return card;
    if (!activity.hasDetail || (state.details.has(activity.id) && !detail)) {
      card.appendChild(el("pre", { class: "card-pane", text: "Detail unavailable." }));
      return card;
    }
    if (!state.details.has(activity.id)) {
      card.appendChild(el("pre", { class: "card-pane", text: "Loading detail..." }));
      return card;
    }
    if (detail.kind === "command") renderCommandPane(card, detail);
    else renderFilePane(card, activity, detail);
    return card;
  }

  function renderCommandPane(card, detail) {
    const meta = [
      detail.cwd ? "cwd " + detail.cwd : null,
      detail.exitCode === null || detail.exitCode === undefined ? null : "exit " + detail.exitCode,
      detail.durationMs === null || detail.durationMs === undefined
        ? null
        : Math.round(detail.durationMs) + "ms",
    ]
      .filter(Boolean)
      .join("  ·  ");

    const body = ["$ " + detail.command];
    if (meta) body.push("  " + meta);
    body.push("");
    if (detail.stdout) body.push(detail.stdout);
    if (detail.stderr) body.push("", detail.stderr);

    card.appendChild(el("pre", { class: "card-pane", text: body.join("\n") }));
    appendRetention(card, detail.retention);
  }

  function renderFilePane(card, activity, detail) {
    const files = detail.files || [];
    const index = Math.min(state.files.get(activity.id) || 0, Math.max(0, files.length - 1));
    const file = files[index];

    card.appendChild(
      el("div", { class: "card-files" }, [
        el(
          "button",
          {
            disabled: files.length < 2,
            title: "Previous file",
            "aria-label": "Previous file",
            onclick: () => selectFile(activity.id, index - 1, files.length),
          },
          [icon("chevronLeft", { size: 13 })],
        ),
        el("span", {
          class: "path",
          text: file ? file.path : "no file detail",
          title: file ? file.path : "",
        }),
        file
          ? el("span", { class: "churn" }, [
              el("span", { class: "add", text: "+" + file.additions }),
              el("span", { text: " " }),
              el("span", { class: "del", text: "-" + file.deletions }),
            ])
          : null,
        files.length > 1
          ? el("span", { class: "churn", text: index + 1 + "/" + files.length })
          : null,
        el(
          "button",
          {
            disabled: files.length < 2,
            title: "Next file",
            "aria-label": "Next file",
            onclick: () => selectFile(activity.id, index + 1, files.length),
          },
          [icon("chevronRight", { size: 13 })],
        ),
      ]),
    );

    const pane = el("pre", { class: "card-pane" });
    const lines = String((file && file.diff) || "").split("\n");
    for (const line of lines) {
      const kind = line.charAt(0) === "+"
        ? "diff-add"
        : line.charAt(0) === "-"
          ? "diff-del"
          : line.indexOf("@@") === 0 || line.indexOf("diff ") === 0
            ? "diff-meta"
            : "";
      pane.appendChild(el("div", { class: kind, text: line || " " }));
    }
    card.appendChild(pane);
    appendRetention(card, file && file.retention);
  }

  function appendRetention(card, retention) {
    if (!retention || !retention.truncated) return;
    card.appendChild(
      el("div", {
        class: "truncated",
        text:
          retention.omittedBytes +
          " bytes / " +
          retention.omittedLines +
          " lines omitted by Watari's detail cap",
      }),
    );
  }

  function renderApproval(event) {
    return el("div", { class: "approval", style: { "--accent": accentOf(event.agent) } }, [
      el("div", { class: "approval-head" }, [
        el("span", { class: "approval-icon" }, [icon("warning", { size: 14 })]),
        el("span", { class: "who", text: event.agent }),
        el("span", { text: "wants to run" }),
      ]),
      el("div", { class: "what", text: event.summary, title: event.summary }),
      el("div", { class: "approval-actions" }, [
        el("button", { class: "primary", text: "Allow", onclick: () => answer(event, "accept") }),
        el("button", { text: "Decline", onclick: () => answer(event, "decline") }),
        el("button", { text: "Cancel", onclick: () => answer(event, "cancel") }),
      ]),
    ]);
  }

  /**
   * The strip below the transcript.
   *
   * At sidebar width the rail is a drawer, so this is the only thing always on
   * screen that says how the team is doing. Trouble is named in words and
   * everything else is an icon and a number, which is what keeps it a status
   * line rather than a sentence the reader has to parse on every render.
   */
  function renderRailToggle(snapshot) {
    const agents = (snapshot && snapshot.agents) || [];
    const bridges = (snapshot && snapshot.bridges) || [];
    const claims = ((snapshot && snapshot.claims) || []).filter(
      (claim) => claim.state !== "released" && claim.state !== "superseded",
    );
    const findings = ((snapshot && snapshot.findings) || []).filter(
      (finding) => finding.disposition === "open",
    );
    const broken = bridges.filter((bridge) => bridge.state === "failed").length;
    const contested = claims.filter((claim) => claim.state === "contested").length;

    const children = [];
    // Only trouble gets words. Everything else is an icon and a number, which
    // is the difference between a status line and a sentence to read.
    if (broken > 0) {
      children.push(
        el("span", { class: "strip-warn" }, [
          icon("bridge", { size: 12 }),
          el("span", { text: broken + " down" }),
        ]),
      );
    }
    if (contested > 0) {
      children.push(
        el("span", { class: "strip-warn" }, [
          icon("contested", { size: 12 }),
          el("span", { text: String(contested) }),
        ]),
      );
    }
    children.push(
      el("span", { class: "strip-count" }, [
        icon("peers", { size: 12 }),
        el("span", { text: String(agents.length) }),
      ]),
    );
    if (claims.length > 0) {
      children.push(
        el("span", { class: "strip-count" }, [
          icon("claim", { size: 12 }),
          el("span", { text: String(claims.length) }),
        ]),
      );
    }
    if (findings.length > 0) {
      children.push(
        el("span", { class: "strip-count" }, [
          icon("finding", { size: 12 }),
          el("span", { text: String(findings.length) }),
        ]),
      );
    }

    return el(
      "button",
      {
        class: "rail-toggle",
        "aria-expanded": state.railOpen ? "true" : "false",
        title: "Peers, claims, and findings",
        onclick: toggleRail,
      },
      children,
    );
  }

  /** Severity reads as shape first: a triangle for the loud end, a dot for
   * the quiet one, so it survives a colour-blind reader and a grayscale shot. */
  function severityIcon(severity) {
    if (severity === "critical" || severity === "high") return "warning";
    if (severity === "medium") return "error";
    return "info";
  }

  function bridgeTone(state) {
    if (state === "failed") return "is-failed";
    if (state === "ready") return "is-ok";
    return "is-idle";
  }

  function renderRail(snapshot) {
    const rail = el("aside", {
      class: "rail" + (state.railOpen ? " is-open" : ""),
      "aria-label": "Peers, claims, and findings",
    });
    // Only reachable when the rail is a drawer; the wide layout hides it,
    // because there the rail is a column that never covers anything.
    rail.appendChild(
      el("div", { class: "rail-close" }, [
        el("button", { title: "Close", "aria-label": "Close", onclick: toggleRail }, [
          icon("close", { size: 14 }),
        ]),
      ]),
    );
    const agents = (snapshot && snapshot.agents) || [];
    const bridges = new Map(
      ((snapshot && snapshot.bridges) || []).map((bridge) => [bridge.agent, bridge]),
    );

    rail.appendChild(
      el("h2", {}, [
        icon("peers", { size: 12 }),
        el("span", { text: "Peers" }),
        agents.length ? el("span", { class: "count", text: String(agents.length) }) : null,
      ]),
    );
    if (agents.length === 0) {
      rail.appendChild(el("div", { class: "rail-empty", text: "None configured" }));
    }
    for (const agent of agents) {
      const bridge = bridges.get(agent.id);
      // The second line is the bridge's problem when there is one and the
      // harness's own status otherwise. Repeating the state word from the row
      // above would spend a line saying nothing.
      const second = bridge && bridge.state === "failed" ? bridge.detail : agent.detail;
      rail.appendChild(
        el("div", { class: "peer", style: { "--accent": accentOf(agent.id) } }, [
          el("div", { class: "peer-head" }, [
            el("span", { class: "peer-name", text: agent.displayName || agent.id }),
            el("span", { class: "peer-state", text: agent.state }),
            el(
              "span",
              {
                class: "peer-bridge " + bridgeTone(bridge && bridge.state),
                title: bridge ? bridge.detail : "team bridge not measured yet",
              },
              [bridgeIcon((bridge && bridge.state) || "unknown", { size: 13 })],
            ),
          ]),
          second ? el("div", { class: "peer-detail", text: second, title: second }) : null,
        ]),
      );
    }

    const claims = ((snapshot && snapshot.claims) || []).filter(
      (claim) => claim.state !== "released" && claim.state !== "superseded",
    );
    rail.appendChild(
      el("h2", {}, [
        icon("claim", { size: 12 }),
        el("span", { text: "Claims" }),
        claims.length ? el("span", { class: "count", text: String(claims.length) }) : null,
      ]),
    );
    if (claims.length === 0) rail.appendChild(el("div", { class: "rail-empty", text: "None" }));
    for (const claim of claims) {
      rail.appendChild(
        el("div", { class: "rail-item", style: { "--accent": accentOf(claim.claimant) } }, [
          el("div", { class: "rail-line" }, [
            el(
              "span",
              { class: "rail-mark" + (claim.state === "contested" ? " is-contested" : "") },
              [icon(claim.state === "contested" ? "contested" : "claim", { size: 12 })],
            ),
            el("span", { class: "lead", text: claim.claimant }),
            el("span", { text: claim.summary }),
          ]),
          claim.paths && claim.paths.length
            ? el("div", { class: "paths", text: claim.paths.join("  ") })
            : null,
        ]),
      );
    }

    const findings = ((snapshot && snapshot.findings) || []).filter(
      (finding) => finding.disposition === "open",
    );
    rail.appendChild(
      el("h2", {}, [
        icon("finding", { size: 12 }),
        el("span", { text: "Findings" }),
        findings.length ? el("span", { class: "count", text: String(findings.length) }) : null,
      ]),
    );
    if (findings.length === 0) {
      rail.appendChild(el("div", { class: "rail-empty", text: "None open" }));
    }
    for (const finding of findings) {
      rail.appendChild(
        el("div", { class: "rail-item", style: { "--accent": accentOf(finding.author) } }, [
          el("div", { class: "rail-line" }, [
            el("span", { class: "rail-mark sev-" + finding.severity }, [
              icon(severityIcon(finding.severity), { size: 12 }),
            ]),
            el("span", { class: "sev-" + finding.severity, text: finding.severity }),
            el("span", { class: "lead", text: finding.author }),
          ]),
          el("div", { text: finding.summary }),
        ]),
      );
    }
    return rail;
  }

  function renderComposer(snapshot) {
    const target = state.tab === "global" ? "all" : state.tab;
    const connected = state.connection.state === "ready";
    const label = target === "all" ? "to everyone" : "to " + target;
    // Global can stop anyone; a peer's own tab stops only that peer.
    const busy = ((snapshot && snapshot.agents) || []).filter(
      (agent) => agent.state === "busy" && (target === "all" || agent.id === target),
    );

    const input = el("textarea", {
      id: "composer-input",
      rows: 1,
      "aria-label": "Message " + (target === "all" ? "every peer" : target),
      placeholder: connected
        ? target === "all"
          ? "Message every ready peer..."
          : "Message " + target + "..."
        : "Not connected",
      disabled: !connected,
      oninput: (event) => {
        state.draft = event.target.value;
        persist();
        autosize(event.target);
      },
      onkeydown: (event) => {
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          submit();
        }
      },
    });
    input.value = state.draft;

    const goal = snapshot && snapshot.activeGoal;
    return el("div", { class: "composer" }, [
      el("span", { class: "composer-target", text: label }),
      el("div", { class: "composer-row" }, [
        input,
        // Stop is a separate control rather than a mode of Send. Watari accepts
        // a message during a turn and delivers it at a safe boundary, so taking
        // Send away while a peer works would remove something that still works.
        busy.length > 0
          ? el(
              "button",
              {
                class: "stop",
                title: "Interrupt " + busy.map((agent) => agent.id).join(", "),
                "aria-label": "Interrupt",
                onclick: () => requestStop(busy),
              },
              [icon("stop", { size: 13 })],
            )
          : null,
        el(
          "button",
          {
            class: "send",
            title: "Send  (Enter)",
            "aria-label": "Send",
            disabled: !connected,
            onclick: submit,
          },
          [icon("send", { size: 14 })],
        ),
      ]),
    ]);
  }

  function autosize(textarea) {
    textarea.style.height = "auto";
    textarea.style.height = Math.min(180, textarea.scrollHeight) + "px";
  }

  // -- actions ----------------------------------------------------------

  function toggleRail() {
    state.railOpen = !state.railOpen;
    persist();
    render();
  }

  function selectTab(tab) {
    state.tab = tab;
    persist();
    render();
  }

  function selectFile(activityId, next, count) {
    if (count < 1) return;
    state.files.set(activityId, ((next % count) + count) % count);
    render();
  }

  function toggleCard(activity) {
    if (state.expanded.has(activity.id)) {
      state.expanded.delete(activity.id);
    } else {
      state.expanded.add(activity.id);
      if (activity.hasDetail && !state.details.has(activity.id)) {
        vscode.postMessage({ type: "activityDetail", id: activity.id });
      }
    }
    render();
  }

  /**
   * Asks the extension host to interrupt.
   *
   * Stopping a peer mid-turn throws away work that cannot be resumed, so the
   * confirmation is a real modal from VSCode rather than something drawn here:
   * a dialog the reader already trusts, and one a stray click cannot dismiss
   * into an accidental yes.
   */
  function requestStop(agents) {
    vscode.postMessage({ type: "interrupt", agents: agents.map((agent) => agent.id) });
  }

  function answer(event, decision) {
    vscode.postMessage({
      type: "approve",
      agent: event.agent,
      requestId: event.providerEventId,
      decision,
    });
  }

  function submit() {
    const text = state.draft.trim();
    if (text === "" || state.connection.state !== "ready") return;
    vscode.postMessage({
      type: "send",
      target: state.tab === "global" ? "all" : state.tab,
      text,
    });
    state.draft = "";
    persist();
    render();
  }

  function persist() {
    vscode.setState({ tab: state.tab, draft: state.draft, railOpen: state.railOpen });
  }

  // -- inbound ----------------------------------------------------------

  window.addEventListener("message", (incoming) => {
    const message = incoming.data;
    if (!message || typeof message.type !== "string") return;

    if (message.type === "state") {
      state.snapshot = message.snapshot;
      state.connection = message.connection;
      render();
    } else if (message.type === "connection") {
      state.connection = message.connection;
      render();
    } else if (message.type === "activityDetail") {
      state.details.set(message.id, message.detail);
      render();
    } else if (message.type === "notice") {
      state.connection = {
        state: state.connection.state,
        detail: message.message,
        project: state.connection.project,
      };
      render();
    } else if (message.type === "event") {
      applyEvent(message.event);
      render();
    }
  });

  /**
   * Applies one incremental event to the local snapshot, the way the terminal
   * client does, so a streaming turn never needs a full refetch.
   */
  function applyEvent(event) {
    if (event.type === "snapshot" || event.type === "state_changed") {
      state.snapshot = event.snapshot;
      return;
    }
    if (!state.snapshot) return;

    if (event.type === "transcript_upsert") {
      state.snapshot = {
        ...state.snapshot,
        events: upsert(state.snapshot.events, event.event),
      };
    } else if (event.type === "activity_upsert") {
      state.snapshot = {
        ...state.snapshot,
        activities: upsert(state.snapshot.activities, event.activity),
      };
    } else if (event.type === "activity_detail_changed") {
      // The cached body is a revision behind now. Refetch only what is open; a
      // collapsed card has nothing on screen that could be wrong.
      if (state.expanded.has(event.activityId)) {
        vscode.postMessage({ type: "activityDetail", id: event.activityId });
      } else {
        state.details.delete(event.activityId);
      }
    }
  }

  function upsert(values, value) {
    const list = values || [];
    const index = list.findIndex((existing) => existing.id === value.id);
    if (index < 0) return list.concat([value]);
    const next = list.slice();
    next[index] = value;
    return next;
  }

  render();
  vscode.postMessage({ type: "ready" });
})();
