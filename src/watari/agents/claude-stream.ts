import type {
  AgentAdapter,
  AgentCapabilities,
  AgentEvent,
  AgentInput,
  ProjectContext,
} from "../models.ts";
import type { JsonLineResult } from "../process/jsonl.ts";
import { ManagedProcess } from "../process/supervisor.ts";
import { redactSecrets, redactSummary, redactUnknown } from "../security/redaction.ts";
import { createAgentEventQueue } from "../util/event-queue.ts";

export interface ClaudeStreamAdapterOptions {
  readonly executable: string;
  readonly commandPrefix?: readonly [string, ...string[]];
  readonly readOnlyProbe?: boolean;
}

export class ClaudeStreamAdapter implements AgentAdapter {
  readonly #executable: string;
  readonly #readOnlyProbe: boolean;
  readonly #commandPrefix: readonly [string, ...string[]] | null;
  readonly #events = createAgentEventQueue("claude");
  #process: ManagedProcess | null = null;
  #project: ProjectContext | null = null;
  #resumeSessionId: string | null = null;
  #sessionId: string | null = null;
  #stopping = false;

  constructor(options: ClaudeStreamAdapterOptions) {
    this.#executable = options.executable;
    this.#readOnlyProbe = options.readOnlyProbe ?? false;
    this.#commandPrefix = options.commandPrefix ?? null;
  }

  get sessionId(): string | null {
    return this.#sessionId;
  }

  capabilities(): AgentCapabilities {
    return {
      structuredReasoningEvents: true,
      toolEvents: true,
      diffEvents: false,
      approvals: false,
      interrupt: true,
      bidirectionalInput: true,
      safeSteer: false,
      resume: true,
      mcp: true,
      skills: true,
      nativeSession: true,
      usageMetadata: true,
    };
  }

  async start(project: ProjectContext): Promise<void> {
    if (this.#process) {
      throw new Error("Claude stream adapter is already started");
    }
    this.#project = project;
    this.#spawn();
    this.#emit("status", "Claude structured CLI fallback started", {
      rawType: "stream_json_start",
    });
  }

  async send(input: AgentInput): Promise<void> {
    if (input.kind === "question_response") throw new Error("Claude CLI fallback cannot answer native questions");
    if (input.kind === "approval_response") {
      throw new Error("Claude structured CLI fallback cannot surface approvals");
    }
    this.#requiredProcess().writeJson({
      type: "user",
      message: { role: "user", content: input.text },
      parent_tool_use_id: null,
      ...(this.#sessionId ? { session_id: this.#sessionId } : {}),
    });
  }

  async resume(sessionId: string): Promise<void> {
    if (!this.#project) {
      throw new Error("Claude stream adapter is not started");
    }
    const existing = this.#process;
    this.#process = null;
    if (existing) {
      await existing.stop();
    }
    this.#resumeSessionId = sessionId;
    this.#sessionId = sessionId;
    this.#spawn();
    this.#emit("session", `Claude CLI resumed session ${sessionId}`, {
      rawType: "resume",
      providerEventId: sessionId,
    });
  }

  async interrupt(): Promise<void> {
    this.#process?.interrupt();
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    const process = this.#process;
    this.#process = null;
    if (process) {
      await process.stop();
    }
    this.#events.close();
  }

  events(): AsyncIterable<AgentEvent> {
    return this.#events;
  }

  #spawn(): void {
    const project = this.#requiredProject();
    const claudeArguments = [
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--replay-user-messages",
      "--permission-mode",
      this.#readOnlyProbe ? "dontAsk" : "default",
      "--setting-sources",
      "user,project,local",
      ...(this.#readOnlyProbe ? ["--tools", ""] : []),
      ...(this.#resumeSessionId ? ["--resume", this.#resumeSessionId] : []),
    ];
    const command = [
      ...(this.#commandPrefix ?? [this.#executable]),
      ...claudeArguments,
    ] as [string, ...string[]];
    const process = ManagedProcess.start({
      command,
      cwd: project.launchDirectory,
      onJsonLine: (line) => this.#handleLine(line),
      onDiagnostic: (message) => {
        if (message) {
          this.#emit("warning", message, { rawType: "stderr" });
        }
      },
      onTransportError: (error) =>
        this.#emit("error", error.message, { rawType: "transport" }),
    });
    this.#process = process;
    void this.#watchExit(process);
  }

  #handleLine(result: JsonLineResult): void {
    if (!result.ok) {
      this.#emit("warning", result.error, {
        rawType: "malformed_jsonl",
        payload: { preview: result.raw.slice(0, 512) },
      });
      return;
    }
    if (!isRecord(result.value) || typeof result.value.type !== "string") {
      this.#emit("warning", "Claude emitted an unrecognized stream value", {
        rawType: "unknown",
        payload: result.value,
      });
      return;
    }
    const message = result.value;
    const sessionId = typeof message.session_id === "string" ? message.session_id : null;
    if (sessionId) {
      this.#sessionId = sessionId;
    }
    switch (message.type) {
      case "assistant":
        this.#handleAssistant(message);
        break;
      case "stream_event":
        this.#handleStreamEvent(message);
        break;
      case "result":
        this.#emit(message.is_error === true ? "error" : "status", `Claude turn completed: ${String(message.subtype ?? "result")}`, {
          rawType: "result",
          ...(sessionId ? { providerEventId: sessionId } : {}),
          payload: message,
        });
        break;
      case "system":
        this.#emit(
          message.subtype === "api_retry" || message.subtype === "permission_denied"
            ? "warning"
            : message.subtype === "init"
              ? "session"
              : "status",
          `Claude system event: ${String(message.subtype ?? "unknown")}`,
          {
            rawType: `system/${String(message.subtype ?? "unknown")}`,
            ...(sessionId ? { providerEventId: sessionId } : {}),
            payload: message,
          },
        );
        break;
      default:
        this.#emit("status", `Claude event: ${message.type}`, {
          rawType: String(message.type),
          ...(sessionId ? { providerEventId: sessionId } : {}),
          payload: message,
        });
    }
  }

  #handleAssistant(message: Record<string, unknown>): void {
    if (!isRecord(message.message) || !Array.isArray(message.message.content)) {
      return;
    }
    for (const block of message.message.content) {
      if (!isRecord(block)) {
        continue;
      }
      if (block.type === "text" && typeof block.text === "string") {
        this.#emit("assistant", block.text, { rawType: "assistant_text" });
      } else if (block.type === "thinking" && typeof block.thinking === "string") {
        this.#emit("reasoning", block.thinking, { rawType: "assistant_thinking" });
      } else if (block.type === "tool_use") {
        this.#emit("tool_start", `Claude started ${String(block.name ?? "tool")}`, {
          rawType: "tool_use",
          ...(typeof block.id === "string" ? { providerEventId: block.id } : {}),
          payload: block.input,
        });
      }
    }
  }

  #handleStreamEvent(message: Record<string, unknown>): void {
    if (!isRecord(message.event) || !isRecord(message.event.delta)) {
      return;
    }
    const delta = message.event.delta;
    if (delta.type === "text_delta" && typeof delta.text === "string") {
      this.#emit("assistant", delta.text, { rawType: "text_delta" });
    } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
      this.#emit("reasoning", delta.thinking, { rawType: "thinking_delta" });
    }
  }

  async #watchExit(process: ManagedProcess): Promise<void> {
    const code = await process.exited;
    if (!this.#stopping && code !== 0) {
      this.#emit("error", `Claude structured CLI exited with code ${code}`, {
        rawType: "process_exit",
      });
    }
  }

  #emit(
    kind: AgentEvent["kind"],
    summary: string,
    extras: Omit<Partial<AgentEvent>, "agent" | "kind" | "timestamp" | "summary"> = {},
  ): void {
    this.#events.push({
      agent: "claude",
      kind,
      timestamp: Date.now(),
      summary: redactSummary(summary),
      ...extras,
      ...("payload" in extras ? { payload: redactUnknown(extras.payload) } : {}),
    });
  }

  #requiredProject(): ProjectContext {
    if (!this.#project) {
      throw new Error("Claude stream adapter is not started");
    }
    return this.#project;
  }

  #requiredProcess(): ManagedProcess {
    if (!this.#process) {
      throw new Error("Claude stream adapter is not started");
    }
    return this.#process;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
