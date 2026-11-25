import { appendFileSync } from "node:fs";

export {};

const decoder = new TextDecoder();
const mode = process.env.WATARI_FAKE_MODE ?? "normal";
/** `qwen` answers the way Qwen Code's ACP server does where it differs. */
const flavor = process.env.WATARI_FAKE_FLAVOR ?? "opencode";
/** Qwen Code before 0.26 did not advertise `session/resume`. */
const legacyQwen = process.env.WATARI_FAKE_QWEN_LEGACY === "1";
const args = process.argv.slice(2);
const recordPath = process.env.WATARI_FAKE_RECORD;
let buffer = "";
let pendingPromptId: string | number | null = null;
/** Qwen's approval mode: the command line's, until a resume restores the recorded one. */
let qwenMode = args.includes("--approval-mode") ? args[args.indexOf("--approval-mode") + 1] ?? "default" : "default";
/** Requests this fake sent to the client, by id, and what to do with the answer. */
const clientRequests = new Map<string | number, (result: unknown) => void>();
let clientRequestCount = 0;

if (recordPath) {
  appendFileSync(recordPath, `${JSON.stringify(args)}\n`);
  appendFileSync(recordPath, `${JSON.stringify({ configContent: process.env.OPENCODE_CONFIG_CONTENT ?? null })}\n`);
}

if (args[0] === "models") {
  process.stdout.write(`fake-provider/fake-model
{
  "id": "fake-model",
  "name": "Fake Model",
  "description": "deterministic OpenCode fixture",
  "variants": {
    "default": {},
    "low": {},
    "high": {}
  }
}
other/next-model
{
  "id": "next-model",
  "name": "Next Model"
}
`);
  process.exit(0);
}

if (args[0] === "session" && args[1] === "delete") {
  process.exit(0);
}

function write(value: unknown): void {
  const line = `${JSON.stringify(value)}\n`;
  if (mode === "partial") {
    const midpoint = Math.floor(line.length / 2);
    process.stdout.write(line.slice(0, midpoint));
    process.stdout.write(line.slice(midpoint));
    return;
  }
  process.stdout.write(line);
}

function respond(id: unknown, result: unknown): void {
  write({ jsonrpc: "2.0", id, result });
}

function configOptions() {
  return [
    ...(flavor === "qwen" ? [{
      id: "mode",
      name: "Mode",
      category: "mode",
      type: "select",
      currentValue: qwenMode,
      options: ["plan", "default", "auto-edit", "auto", "yolo"].map((value) => ({ value, name: value })),
    }] : []),
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: "fake-provider/fake-model",
      options: [
        { value: "fake-provider/fake-model", name: "Fake Provider/Fake Model" },
        { value: "other/next-model", name: "Other/Next Model" },
      ],
    },
    {
      id: flavor === "qwen" ? "reasoning_effort" : "effort",
      name: "Effort",
      category: "thought_level",
      type: "select",
      currentValue: "low",
      options: [
        ...(flavor === "qwen" ? [{ value: "default", name: "Default" }] : []),
        { value: "low", name: "Low" },
        { value: "high", name: "High" },
      ],
    },
  ];
}

function sessionUpdate(update: Record<string, unknown>): void {
  write({
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId: "session-fake", update },
  });
}

function messageId(id: string): Record<string, string> {
  return flavor === "qwen" ? {} : { messageId: id };
}

function streamTurn(): void {
  sessionUpdate({
    sessionUpdate: "agent_thought_chunk",
    ...messageId("00000000-0000-4000-8000-000000000001"),
    content: { type: "text", text: "checking " },
  });
  sessionUpdate({
    sessionUpdate: "agent_thought_chunk",
    ...messageId("00000000-0000-4000-8000-000000000001"),
    content: { type: "text", text: "fixture" },
  });
  sessionUpdate({
    sessionUpdate: "agent_message_chunk",
    ...messageId("00000000-0000-4000-8000-000000000002"),
    content: { type: "text", text: "WATARI_PROBE_OK" },
  });
  sessionUpdate({ sessionUpdate: "available_commands_update", availableCommands: [] });
  sessionUpdate({
    sessionUpdate: "tool_call",
    toolCallId: "tool-fake",
    title: "Edit fixture",
    kind: "edit",
    status: "pending",
    locations: [{ path: "/work/fixture.ts" }],
  });
  sessionUpdate({
    sessionUpdate: "tool_call_update",
    toolCallId: "tool-fake",
    title: "Edit fixture",
    kind: "edit",
    status: "completed",
    content: [{
      type: "diff",
      path: flavor === "qwen" ? "fixture.ts" : "/work/fixture.ts",
      oldText: "old",
      newText: "new",
    }],
  });
}

/** Asks the client for input queued during the turn, the way Qwen Code does after a tool run. */
function drainMidTurnQueue(then: (result: unknown) => void, userInputOnly = false): void {
  clientRequestCount += 1;
  const id = `drain-${clientRequestCount}`;
  clientRequests.set(id, then);
  write({
    jsonrpc: "2.0",
    id,
    method: "craft/drainMidTurnQueue",
    params: userInputOnly
      ? { sessionId: "session-fake", promptId: "prompt-fake", userInputOnly: true }
      : { sessionId: "session-fake", promptId: "prompt-fake", todoStopGuardWatchQueuedPrompt: true },
  });
}

/** What reached the model mid-turn, echoed so a test can read it. */
function echoDrained(result: unknown): void {
  sessionUpdate({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: `DRAINED ${JSON.stringify(result)}` },
  });
}

function completePrompt(stopReason = "end_turn"): void {
  const id = pendingPromptId;
  pendingPromptId = null;
  if (id !== null) respond(id, { stopReason });
}

function handle(message: Record<string, unknown>): void {
  if (recordPath) appendFileSync(recordPath, `${JSON.stringify({ wire: message })}\n`);
  const method = message.method;
  if (method === undefined && message.id !== undefined && clientRequests.has(message.id as string)) {
    const then = clientRequests.get(message.id as string)!;
    clientRequests.delete(message.id as string);
    then(message.result ?? { error: message.error });
    return;
  }
  if (method === "initialize") {
    if (mode === "malformed") process.stdout.write("{not-json}\n");
    process.stderr.write(
      `fake opencode cwd=${process.cwd()} stdin_tty=${Boolean(process.stdin.isTTY)} token=${process.env.WATARI_FAKE_SECRET ?? "none"}\n`,
    );
    respond(message.id, {
      protocolVersion: 1,
      agentInfo: { name: "Fake OpenCode", version: "1.2.3" },
      agentCapabilities: {
        loadSession: true,
        mcpCapabilities: { stdio: true },
        sessionCapabilities: flavor !== "qwen"
          ? { resume: {}, close: {} }
          : legacyQwen ? { list: {} } : { list: {}, resume: {} },
      },
      authMethods: [],
    });
    if (mode === "crash" || mode === "clean-exit") {
      setTimeout(() => process.exit(mode === "crash" ? 7 : 0), 10);
    }
    return;
  }
  if (method === "session/new") {
    respond(message.id, {
      sessionId: "session-fake",
      configOptions: configOptions(),
      _meta: { received: message.params },
    });
    return;
  }
  if (method === "session/resume") {
    qwenMode = process.env.WATARI_FAKE_RESTORED_MODE ?? qwenMode;
    respond(message.id, { configOptions: configOptions() });
    return;
  }
  if (method === "session/load") {
    qwenMode = process.env.WATARI_FAKE_RESTORED_MODE ?? qwenMode;
    // History is replayed before the answer, as ACP specifies.
    sessionUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "REPLAYED_HISTORY" },
    });
    respond(message.id, { configOptions: configOptions() });
    return;
  }
  if (method === "session/set_config_option") {
    const params = message.params as { readonly configId?: string; readonly value?: string };
    if (flavor === "qwen" && params.configId === "mode" && params.value) qwenMode = params.value;
    if (flavor === "qwen") {
      write({ jsonrpc: "2.0", method: "qwen/notify/session/model-update", params: { v: 1 } });
    }
    respond(message.id, { configOptions: configOptions() });
    return;
  }
  if (method === "session/prompt") {
    pendingPromptId = message.id as string | number;
    streamTurn();
    if (mode === "qwen-question" || mode === "qwen-question-malformed") {
      clientRequests.set("qwen-question-fake", (result) => {
        sessionUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: JSON.stringify({ questionResult: result }) } });
        completePrompt();
      });
      write({ jsonrpc: "2.0", id: "qwen-question-fake", method: "session/request_permission", params: {
        sessionId: "session-fake", toolCall: { toolCallId: "ask-user", title: "Please answer", kind: "other", _meta: {
          toolName: "ask_user_question", qwenInteractionKind: "user_question",
          qwenQuestions: mode === "qwen-question-malformed" ? [] : [{ header: "Scope", question: "Which scope?", multiSelect: true,
            options: [{ label: "Core", description: "Core only" }, { label: "Tests", description: "Tests too" }] }],
        } }, options: [{ optionId: "proceed_always", kind: "allow_always", name: "Always" }, { optionId: "proceed_once", kind: "allow_once", name: "Submit" }],
      } });
      return;
    }
    if (mode === "question") {
      clientRequests.set("question-fake", (result) => {
        sessionUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: JSON.stringify({ questionResult: result }) } });
        completePrompt();
      });
      write({ jsonrpc: "2.0", id: "question-fake", method: "elicitation/create", params: {
        sessionId: "session-fake", mode: "form", message: "Which scope?",
        requestedSchema: { type: "object", properties: { scope: { type: "string", enum: ["Core", "All"] } }, required: ["scope"] },
      } });
      return;
    }
    if (mode === "approval") {
      write({
        jsonrpc: "2.0",
        id: "permission-fake",
        method: "session/request_permission",
        params: {
          sessionId: "session-fake",
          toolCall: { toolCallId: "permission-tool", title: "Run fixture", kind: "execute" },
          options: [
            { optionId: "allow", name: "Allow", kind: "allow_once" },
            { optionId: "reject", name: "Reject", kind: "reject_once" },
          ],
        },
      });
      return;
    }
    if (mode === "drain") {
      drainMidTurnQueue((result) => {
        echoDrained(result);
        completePrompt();
      });
      return;
    }
    // `steer` keeps the prompt open until a send-now pull takes the input.
    if (mode !== "hold" && mode !== "steer") completePrompt();
    return;
  }
  if (method === "craft/midTurnSendNow" && flavor === "qwen") {
    // Qwen cuts into the response and pulls user input only.
    respond(message.id, {});
    if (pendingPromptId !== null) {
      drainMidTurnQueue((result) => {
        echoDrained(result);
        if (mode === "steer") completePrompt();
      }, true);
    }
    return;
  }
  if (method === "session/cancel") {
    completePrompt("cancelled");
    return;
  }
  if (method === "session/close") {
    if (flavor === "qwen") {
      write({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
      return;
    }
    respond(message.id, {});
    return;
  }
  if (message.id === "permission-fake") {
    completePrompt();
    return;
  }
  if (typeof method === "string" && message.id !== undefined) {
    write({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
  }
}

for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk, { stream: true });
  let newline = buffer.indexOf("\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line.trim()) handle(JSON.parse(line) as Record<string, unknown>);
    newline = buffer.indexOf("\n");
  }
}
