export {};

const decoder = new TextDecoder();
let buffer = "";
const mode = process.env.WATARI_FAKE_MODE ?? "normal";
let turnStarts = 0;

function write(value: unknown): void {
  const line = `${JSON.stringify(value)}\n`;
  if (mode === "partial") {
    const midpoint = Math.floor(line.length / 2);
    process.stdout.write(line.slice(0, midpoint));
    process.stdout.write(line.slice(midpoint));
  } else {
    process.stdout.write(line);
  }
}

function turn(): Record<string, unknown> {
  return {
    id: "turn-fake",
    items: [],
    itemsView: "full",
    status: "completed",
    error: null,
    startedAt: 1,
    completedAt: 2,
    durationMs: 1,
  };
}

function handle(message: Record<string, unknown>): void {
  const method = message.method;
  if (method === "initialize") {
    if (mode === "malformed") {
      process.stdout.write("{not-json}\n");
    }
    if (mode === "invalid-shape") {
      write({ method: "thread/started", params: {} });
    }
    process.stderr.write(
      `fake codex cwd=${process.cwd()} stdin_tty=${Boolean(process.stdin.isTTY)} token=${process.env.WATARI_FAKE_SECRET ?? "none"}\n`,
    );
    write({
      id: message.id,
      result: {
        userAgent: "fake-codex/0.149.0",
        codexHome: "/tmp/fake-codex-home",
        platformFamily: "unix",
        platformOs: "linux",
      },
    });
    if (mode === "crash" || mode === "clean-exit") {
      setTimeout(() => process.exit(mode === "crash" ? 7 : 0), 10);
    }
    return;
  }
  if (method === "thread/start" || method === "thread/resume") {
    if (mode === "mcp-config" && method === "thread/start") {
      const params = message.params as Record<string, unknown>;
      write({
        method: "watari/test/mcp-config",
        params: {
          config: params.config,
          hasDynamicTools: "dynamicTools" in params,
          hasDeveloperInstructions: typeof params.developerInstructions === "string",
        },
      });
    }
    if (mode === "profile") {
      write({ method: "watari/test/thread-profile", params: message.params });
    }
    write({
      id: message.id,
      result: {
        thread: { id: "thread-fake" },
        model: "fake",
        modelProvider: "fake",
        serviceTier: null,
        cwd: process.cwd(),
        instructionSources: [],
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandbox: { type: "readOnly" },
        reasoningEffort: null,
      },
    });
    write({ method: "thread/started", params: { thread: { id: "thread-fake" } } });
    return;
  }
  if (method === "model/list") {
    write({
      id: message.id,
      result: {
        data: [{
          id: "fake-model",
          model: "fake-model",
          displayName: "Fake Model",
          description: "deterministic fixture",
          supportedReasoningEfforts: [
            { reasoningEffort: "low", description: "fast" },
            { reasoningEffort: "high", description: "deep" },
          ],
          defaultReasoningEffort: "low",
          inputModalities: ["text"],
          supportsPersonality: false,
          hidden: false,
          isDefault: true,
          upgrade: null,
          upgradeInfo: null,
          availabilityNux: null,
          modelSpecialty: null,
          multiAgentVersion: null,
          additionalSpeedTiers: [],
          serviceTiers: [],
          defaultServiceTier: null,
        }],
        nextCursor: null,
      },
    });
    return;
  }
  if (method === "turn/steer" && (mode === "subagents" || mode === "stale-turn")) {
    // Only the main thread's real turn may be steered, as in Codex.
    const params = message.params as { threadId?: string; expectedTurnId?: string };
    if (params.threadId === "thread-fake" && params.expectedTurnId === "turn-fake") {
      write({ method: "watari/test/steered", params: { expectedTurnId: params.expectedTurnId } });
      write({ id: message.id, result: { turnId: "turn-fake" } });
    } else {
      write({
        id: message.id,
        error: {
          code: -32600,
          message: `expected active turn id \`${params.expectedTurnId}\` but found \`turn-fake\``,
        },
      });
    }
    return;
  }
  if (method === "turn/start" && mode === "stale-turn") {
    // Watari is told about a turn id that is not the one Codex runs.
    write({ id: message.id, result: { turn: { ...turn(), id: "turn-old" } } });
    write({ method: "turn/started", params: { threadId: "thread-fake", turn: { ...turn(), id: "turn-old" } } });
    return;
  }
  if (method === "turn/start" && mode === "subagents") {
    write({ id: message.id, result: { turn: turn() } });
    write({ method: "turn/started", params: { threadId: "thread-fake", turn: turn() } });
    // A sub-agent Codex spawned reports on the same connection.
    write({ method: "thread/started", params: { thread: { id: "thread-sub" } } });
    write({ method: "turn/started", params: { threadId: "thread-sub", turn: { ...turn(), id: "turn-sub" } } });
    write({
      method: "error",
      params: {
        threadId: "thread-sub",
        turnId: "turn-sub",
        willRetry: false,
        error: { message: "sub-agent hit a snag", codexErrorInfo: "other", additionalDetails: null, misalignment: null },
      },
    });
    write({ method: "turn/completed", params: { threadId: "thread-sub", turn: { ...turn(), id: "turn-sub" } } });
    write({ method: "watari/test/subagent-done", params: {} });
    return;
  }
  if (method === "turn/steer") {
    if (mode === "steer-race") {
      // The turn ends just before the steer is read, which is the race Watari must survive.
      write({ method: "turn/completed", params: { threadId: "thread-fake", turn: turn() } });
    }
    write({
      id: message.id,
      error: {
        code: -32600,
        message: mode === "steer-race" ? "no active turn to steer" : "active turn is not steerable: compact",
      },
    });
    return;
  }
  if (method === "turn/start" && (mode === "steer-race" || mode === "steer-refused")) {
    turnStarts += 1;
    write({ method: "watari/test/turn-start", params: { count: turnStarts } });
    write({ id: message.id, result: { turn: turn() } });
    write({ method: "turn/started", params: { threadId: "thread-fake", turn: turn() } });
    if (mode === "steer-race" && turnStarts > 1) completeTurn();
    return;
  }
  if (method === "turn/start") {
    if (mode === "profile") {
      write({ method: "watari/test/turn-profile", params: message.params });
    }
    write({ id: message.id, result: { turn: turn() } });
    write({ method: "turn/started", params: { threadId: "thread-fake", turn: turn() } });
    write({
      method: "item/reasoning/summaryTextDelta",
      params: {
        threadId: "thread-fake",
        turnId: "turn-fake",
        itemId: "reason-1",
        delta: "checking fixture",
        summaryIndex: 0,
      },
    });
    write({
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-fake",
        turnId: "turn-fake",
        itemId: "message-1",
        delta: "WATARI_PROBE_OK",
      },
    });
    write({
      method: "turn/diff/updated",
      params: { threadId: "thread-fake", turnId: "turn-fake", diff: "+fixture" },
    });
    write({ method: "future/event", params: { supportedLater: true } });
    if (mode === "turn-errors") {
      const error = (message: string, codexErrorInfo: unknown) => ({
        message,
        codexErrorInfo,
        additionalDetails: null,
        misalignment: null,
      });
      write({
        method: "error",
        params: {
          threadId: "thread-fake",
          turnId: "turn-fake",
          willRetry: true,
          error: error("stream disconnected before completion", { responseStreamDisconnected: { httpStatusCode: null } }),
        },
      });
      write({
        method: "error",
        params: {
          threadId: "thread-fake",
          turnId: "turn-fake",
          willRetry: false,
          error: error("You've hit your usage limit.", "usageLimitExceeded"),
        },
      });
    }
    if (mode === "question" || mode === "question-resolved" || mode === "question-secret") {
      write({ id: 0, method: "item/tool/requestUserInput", params: {
        threadId: "thread-fake", turnId: "turn-fake", itemId: "ask-1", isBlocking: true, autoResolutionMs: null,
        questions: [{ id: "scope", header: "Scope", question: "What should be reviewed?", isOther: true,
          isSecret: mode === "question-secret", options: [{ label: "Core", description: "Review core" }, { label: "All", description: "Review everything" }] }],
      } });
      if (mode === "question-resolved") setTimeout(() => write({ method: "serverRequest/resolved", params: { threadId: "thread-fake", requestId: 0 } }), 20);
    } else if (mode === "team-tools") {
      write({
        id: "team-call-1",
        method: "item/tool/call",
        params: {
          threadId: "thread-fake",
          turnId: "turn-fake",
          callId: "call-fake",
          namespace: null,
          tool: "team_send",
          arguments: { to: "claude", message: "Dynamic tool identity roundtrip" },
        },
      });
    } else if (mode === "approval" || mode === "approval-number") {
      write({
        id: mode === "approval-number" ? 0 : "approval-1",
        method: "item/commandExecution/requestApproval",
        params: { threadId: "thread-fake", turnId: "turn-fake", itemId: "cmd-1" },
      });
    } else {
      completeTurn();
    }
    return;
  }
  if (message.id === "approval-1" || (mode === "approval-number" && message.id === 0)) {
    completeTurn();
  }
  if (message.id === "team-call-1") {
    completeTurn();
  }
  if (message.id === 0 && mode.startsWith("question")) {
    write({ method: "watari/test/question-response", params: { nativeId: message.id, result: message.result } });
    completeTurn();
  }
}

function completeTurn(): void {
  if (mode === "huge") {
    write({
      method: "process/outputDelta",
      params: { processId: "p1", delta: "x".repeat(2 * 1024 * 1024) },
    });
  }
  write({ method: "turn/completed", params: { threadId: "thread-fake", turn: turn() } });
}

for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk, { stream: true });
  let newline = buffer.indexOf("\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line.trim()) {
      handle(JSON.parse(line) as Record<string, unknown>);
    }
    newline = buffer.indexOf("\n");
  }
}
