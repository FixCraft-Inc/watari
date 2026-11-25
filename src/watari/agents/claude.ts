import { spawn } from "node:child_process";
import { z } from "zod";
import { QuestionQueue } from "../questions.ts";
import { compileQuestionForm } from "../question-form.ts";
import type { Readable, Writable } from "node:stream";

import {
  getSessionInfo,
  startup,
  type CanUseTool,
  type HookCallback,
  type Options,
  type PermissionResult,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
  type SpawnedProcess,
  type SpawnOptions,
  type WarmQuery,
} from "@anthropic-ai/claude-agent-sdk";

import type {
  AgentAdapter,
  AgentCapabilities,
  AgentEvent,
  AgentId,
  AgentModelOption,
  AgentInput,
  ApprovalDecision,
  BoundaryInbox,
  ProjectContext,
} from "../models.ts";
import { trackProcess, untrackProcess } from "../process/ledger.ts";
import { registerProcessCleanup } from "../process/shutdown.ts";
import { describeClaudeTool, formatToolLabel } from "./tool-summary.ts";
import { redactSecrets, redactSummary, redactUnknown } from "../security/redaction.ts";
import { createClaudeTeamMcp } from "../team/claude-mcp.ts";
import { TEAM_INSTRUCTIONS } from "../team/instructions.ts";
import {
  claudePermissionOptions,
  claudeTeamMcpConfig,
  type TeamMcpCommand,
  type TeamMcpEnvironment,
} from "../team/provider-config.ts";
import type { IdentityBoundTeamTools } from "../team/tools.ts";
import type { ReasoningEffort } from "../team/roster.ts";
import { AsyncQueue } from "../util/async-queue.ts";
import { createAgentEventQueue } from "../util/event-queue.ts";

const INITIALIZE_TIMEOUT_MS = 15_000;

const ClaudeQuestionsSchema = z.object({
  questions: z.array(z.object({
    question: z.string().min(1).max(8_000),
    header: z.string().max(256),
    options: z.array(z.object({ label: z.string().min(1).max(512), description: z.string().max(2_000) })).max(16),
    multiSelect: z.boolean().default(false),
  })).min(1).max(8),
}).refine(({ questions }) => new Set(questions.map((question) => question.question)).size === questions.length);

interface PendingPermission {
  readonly input: Record<string, unknown>;
  readonly resolve: (result: PermissionResult) => void;
  readonly reject: (error: Error) => void;
  readonly removeAbortListener: () => void;
}

export interface ClaudeAdapterOptions {
  /** SDK boundary, injectable for simulated native callback tests. */
  readonly sdkStartup?: typeof startup;
  readonly executable: string;
  readonly agent?: AgentId;
  readonly model?: string;
  readonly effort?: ReasoningEffort;
  readonly readOnlyProbe?: boolean;
  readonly unrestricted?: boolean;
  readonly initializeTimeoutMs?: number;
  readonly teamTools?: IdentityBoundTeamTools;
  readonly teamMcpCommand?: TeamMcpCommand;
  readonly teamMcpEnv?: TeamMcpEnvironment;
  /** Where team mail comes from inside a turn. Without it mail waits for the turn to end. */
  readonly boundaryInbox?: BoundaryInbox;
}

export class ClaudeAdapter implements AgentAdapter {
  readonly #sdkStartup: typeof startup;
  readonly #questions: QuestionQueue;
  readonly #agent: AgentId;
  readonly #executable: string;
  readonly #model: string | null;
  readonly #effort: ReasoningEffort | null;
  readonly #readOnlyProbe: boolean;
  readonly #unrestricted: boolean;
  readonly #initializeTimeoutMs: number;
  readonly #teamTools: IdentityBoundTeamTools | null;
  readonly #teamMcpCommand: TeamMcpCommand | null;
  readonly #teamMcpEnv: TeamMcpEnvironment | undefined;
  readonly #boundaryInbox: BoundaryInbox | null;
  readonly #events;
  #input = new AsyncQueue<SDKUserMessage>();
  readonly #permissions = new Map<string, PendingPermission>();
  /** tool_use id to the label its start row already shows, so the matching
   * result can close that row without replacing what it says. */
  readonly #toolLabels = new Map<string, string>();
  #project: ProjectContext | null = null;
  #warmQuery: WarmQuery | null = null;
  #query: Query | null = null;
  #consumer: Promise<void> | null = null;
  #abortController: AbortController | null = null;
  /** Anthropic message id of the block currently streaming, so every delta of
   * one message lands on one transcript row. Each `stream_event` carries its
   * own uuid, which would otherwise split a sentence across many rows. */
  #streamingMessageId: string | null = null;
  #lastTurnError: string | null = null;
  #sessionId: string | null = null;
  #resumeSessionId: string | null = null;
  #stopping = false;
  #resetting = false;
  #unregisterCleanup: (() => void) | null = null;
  #stopPromise: Promise<void> | null = null;

  constructor(options: ClaudeAdapterOptions) {
    this.#agent = options.agent ?? "claude";
    this.#sdkStartup = options.sdkStartup ?? startup;
    this.#questions = new QuestionQueue(this.#agent, (event) => this.#events.push(event));
    this.#executable = options.executable;
    this.#model = options.model ?? null;
    this.#effort = options.effort ?? null;
    this.#events = createAgentEventQueue(this.#agent);
    this.#readOnlyProbe = options.readOnlyProbe ?? false;
    this.#unrestricted = options.unrestricted ?? false;
    this.#initializeTimeoutMs =
      options.initializeTimeoutMs ?? INITIALIZE_TIMEOUT_MS;
    this.#teamTools = options.teamTools ?? null;
    this.#teamMcpCommand = options.teamMcpCommand ?? null;
    this.#teamMcpEnv = options.teamMcpEnv;
    this.#boundaryInbox = options.boundaryInbox ?? null;
    if (this.#teamTools && this.#teamMcpCommand) {
      throw new Error("Claude team tools must use exactly one transport");
    }
  }

  get sessionId(): string | null {
    return this.#sessionId;
  }

  capabilities(): AgentCapabilities {
    return {
      structuredReasoningEvents: true,
      toolEvents: true,
      diffEvents: false,
      approvals: true,
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
    if (this.#project) {
      throw new Error("Claude adapter is already started");
    }
    this.#project = project;
    this.#unregisterCleanup = registerProcessCleanup(async () => {
      await this.stop();
    });
    try {
      await this.#prepareWarmQuery();
    } catch (error) {
      this.#unregisterCleanup();
      this.#unregisterCleanup = null;
      throw error;
    }
    this.#emit("status", "Claude Agent SDK initialized native Claude Code", {
      rawType: "sdk_initialize",
    });
  }

  async send(input: AgentInput): Promise<void> {
    if (input.kind === "question_response") {
      this.#questions.respond(input.requestId, input.response);
      return;
    }
    if (input.kind === "approval_response") {
      this.#resolvePermission(String(input.requestId), input.decision);
      return;
    }
    this.#lastTurnError = null;
    await this.prepare();
    this.#input.push({
      type: "user",
      message: { role: "user", content: input.text },
      parent_tool_use_id: null,
      ...(this.#sessionId ? { session_id: this.#sessionId } : {}),
    });
  }

  async prepare(): Promise<void> {
    if (this.#query) return;
    const warmQuery = this.#requiredWarmQuery();
    this.#warmQuery = null;
    this.#query = warmQuery.query(this.#input);
    this.#consumer = this.#consume(this.#query);
  }

  async availableModels(): Promise<readonly AgentModelOption[]> {
    await this.prepare();
    const models = await this.#query!.supportedModels();
    return models.map((model) => ({
      id: model.value,
      displayName: model.displayName,
      description: model.description,
      efforts: model.supportedEffortLevels ?? [],
    }));
  }

  async resume(sessionId: string): Promise<void> {
    if (this.#query) {
      throw new Error("cannot resume Claude after streaming input has started");
    }
    // Resuming a session Claude Code never saved only fails at the first
    // message, as a dead turn. Checking here lets Watari start fresh instead.
    const saved = await getSessionInfo(sessionId, { dir: this.#requiredProject().launchDirectory });
    if (!saved) throw new Error(`Claude has no saved conversation ${sessionId}`);
    this.#resumeSessionId = sessionId;
    this.#sessionId = sessionId;
    this.#warmQuery?.close();
    this.#warmQuery = null;
    this.#abortController?.abort();
    await this.#prepareWarmQuery();
    this.#emit("session", `Prepared Claude session ${sessionId} for resume`, {
      rawType: "resume",
      providerEventId: sessionId,
    });
  }

  async interrupt(): Promise<void> {
    this.#questions.cancelAll();
    await this.#query?.interrupt();
  }

  async resetSession(): Promise<void> {
    this.#questions.cancelAll();
    this.#resetting = true;
    await this.#query?.interrupt().catch(() => undefined);
    this.#input.close();
    this.#query?.close();
    if (this.#consumer) {
      await Promise.race([
        this.#consumer.catch(() => undefined),
        new Promise<void>((resolve) => setTimeout(resolve, 2_500)),
      ]);
    }
    this.#rejectPermissions(new Error("Claude conversation reset"));
    this.#toolLabels.clear();
    this.#streamingMessageId = null;
    this.#lastTurnError = null;
    this.#sessionId = null;
    this.#resumeSessionId = null;
    this.#query = null;
    this.#consumer = null;
    this.#input = new AsyncQueue<SDKUserMessage>();
    this.#warmQuery?.close();
    this.#warmQuery = null;
    this.#abortController?.abort();
    try {
      await this.#prepareWarmQuery();
    } finally {
      this.#resetting = false;
    }
  }

  async stop(): Promise<void> {
    this.#stopPromise ??= this.#stopInternal();
    await this.#stopPromise;
  }

  async #stopInternal(): Promise<void> {
    this.#questions.cancelAll();
    this.#stopping = true;
    this.#input.close();
    this.#rejectPermissions(new Error("Claude adapter stopped"));
    this.#toolLabels.clear();
    this.#streamingMessageId = null;
    this.#query?.close();
    this.#warmQuery?.close();
    this.#abortController?.abort();
    if (this.#consumer) {
      await Promise.race([
        this.#consumer,
        new Promise<void>((resolve) => setTimeout(resolve, 2_500)),
      ]);
    }
    this.#unregisterCleanup?.();
    this.#unregisterCleanup = null;
    this.#events.close();
  }

  events(): AsyncIterable<AgentEvent> {
    return this.#events;
  }

  async #prepareWarmQuery(): Promise<void> {
    const project = this.#requiredProject();
    const abortController = new AbortController();
    this.#abortController = abortController;
    const permissions = claudePermissionOptions({
      readOnlyProbe: this.#readOnlyProbe,
      unrestricted: this.#unrestricted,
    });
    const options: Options = {
      cwd: project.launchDirectory,
      pathToClaudeCodeExecutable: this.#executable,
      abortController,
      includePartialMessages: true,
      // A managed conversation is saved so a restarted harness or service can
      // resume it instead of starting over with no memory. Only the read-only
      // catalog probe stays ephemeral.
      persistSession: !this.#readOnlyProbe,
      ...(this.#model ? { model: this.#model } : {}),
      ...(this.#effort ? { effort: this.#effort as NonNullable<Options["effort"]> } : {}),
      settingSources: ["user", "project", "local"],
      // Full access skips canUseTool. Questions use PreToolUse in that mode.
      ...(!this.#unrestricted || this.#readOnlyProbe ? { canUseTool: this.#canUseTool } : {}),
      onElicitation: async (request, context) => {
        try {
          if (request.mode === "url" || this.#readOnlyProbe) throw new Error("unsupported form");
          const form = compileQuestionForm(request.requestedSchema, request.message);
          const response = await this.#questions.ask(form.fields, context.signal, form.decode);
          return response.action === "answer" ? { action: "accept", content: form.decode(response.answers) } : { action: "cancel" };
        } catch {
          this.#emit("warning", "Claude MCP input form declined: unsupported or secure form", { rawType: "question_unsupported" });
          return { action: "decline" };
        }
      },
      stderr: (data) => {
        const message = redactSecrets(data).trimEnd();
        if (message) {
          this.#emit("warning", message, { rawType: "stderr" });
        }
      },
      spawnClaudeCodeProcess: (spawnOptions) =>
        this.#spawnClaudeCodeProcess(spawnOptions),
      ...(!this.#readOnlyProbe ? { hooks: {
        ...(this.#boundaryInbox ? claudeTeamHooks(this.#boundaryInbox) : {}),
        PreToolUse: [{
          matcher: "AskUserQuestion",
          // Human answers may take longer than a tool hook's default timeout.
          timeout: 86_400,
          onFailure: "block" as const,
          hooks: [this.#questionHook],
        }],
      } } : {}),
      ...(this.#teamMcpCommand
        ? {
            mcpServers: { watari: claudeTeamMcpConfig(this.#teamMcpCommand, this.#teamMcpEnv) },
            systemPrompt: {
              type: "preset" as const,
              preset: "claude_code" as const,
              append: TEAM_INSTRUCTIONS,
            },
          }
        : this.#teamTools
        ? {
            mcpServers: { watari: createClaudeTeamMcp(this.#teamTools) },
            systemPrompt: {
              type: "preset" as const,
              preset: "claude_code" as const,
              append: TEAM_INSTRUCTIONS,
            },
          }
        : {}),
      ...(this.#resumeSessionId ? { resume: this.#resumeSessionId } : {}),
      permissionMode: permissions.permissionMode,
      ...(permissions.allowDangerouslySkipPermissions
        ? { allowDangerouslySkipPermissions: true as const }
        : {}),
      ...(permissions.tools ? { tools: [...permissions.tools] } : {}),
    };
    this.#warmQuery = await this.#sdkStartup({
      options,
      initializeTimeoutMs: this.#initializeTimeoutMs,
    });
  }

  readonly #questionHook: HookCallback = async (input, _toolUseId, context) => {
    if (input.hook_event_name !== "PreToolUse" || input.tool_name !== "AskUserQuestion") return {};
    const result = (isRecord(input.tool_input)
      ? await this.#canUseTool("AskUserQuestion", input.tool_input, {
          signal: context.signal, toolUseID: input.tool_use_id, requestId: input.tool_use_id,
        })
      : null) ?? { behavior: "deny", message: "Watari cannot render this question form" };
    return { hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: result.behavior,
      ...(result.behavior === "allow"
        ? (result.updatedInput ? { updatedInput: result.updatedInput } : {})
        : { permissionDecisionReason: result.message }),
    } };
  };

  readonly #canUseTool: CanUseTool = async (toolName, input, options) => {
    if (toolName === "AskUserQuestion" && !this.#readOnlyProbe) {
      const parsed = ClaudeQuestionsSchema.safeParse(input);
      if (!parsed.success) {
        this.#emit("warning", "Claude question cancelled: invalid input form", { rawType: "question_unsupported" });
        return { behavior: "deny", message: "Watari cannot render this question form" };
      }
      try {
        const questions = parsed.data.questions;
        const response = await this.#questions.ask(questions.map((question, index) => ({
          id: `q${index}`, header: question.header, question: question.question,
          options: question.options, multiSelect: question.multiSelect, allowOther: true,
        })), options.signal);
        if (response.action === "cancel") return { behavior: "deny", message: "The user cancelled the question" };
        const answers = Object.fromEntries(questions.map((question, index) => [question.question, response.answers[`q${index}`]!.join(", ")]));
        return { behavior: "allow", updatedInput: { ...input, answers } };
      } catch {
        this.#emit("warning", "Claude question cancelled: input form exceeds supported limits", { rawType: "question_unsupported" });
        return { behavior: "deny", message: "Watari cannot render this question form" };
      }
    }
    if (this.#unrestricted && !this.#readOnlyProbe) return { behavior: "allow", updatedInput: input };
    if (this.#readOnlyProbe) return { behavior: "deny", message: "Read-only metadata probe" };
    this.#emit("approval", options.title ?? `Claude requests ${toolName}`, {
      rawType: "can_use_tool",
      providerEventId: options.toolUseID,
      payload: {
        toolName,
        input,
        displayName: options.displayName,
        description: options.description,
        decisionReason: options.decisionReason,
      },
    });
    return await new Promise<PermissionResult>((resolve, reject) => {
      const abort = () => {
        this.#permissions.delete(options.toolUseID);
        reject(new Error(`Claude permission request aborted: ${toolName}`));
      };
      options.signal.addEventListener("abort", abort, { once: true });
      this.#permissions.set(options.toolUseID, {
        input,
        resolve,
        reject,
        removeAbortListener: () =>
          options.signal.removeEventListener("abort", abort),
      });
    });
  };

  #resolvePermission(requestId: string, decision: ApprovalDecision): void {
    const pending = this.#permissions.get(requestId);
    if (!pending) {
      throw new Error(`unknown Claude approval request: ${requestId}`);
    }
    this.#permissions.delete(requestId);
    pending.removeAbortListener();
    if (decision === "accept") {
      pending.resolve({ behavior: "allow", updatedInput: pending.input });
      return;
    }
    pending.resolve({
      behavior: "deny",
      message: decision === "cancel" ? "Cancelled by the user" : "Declined by the user",
      interrupt: decision === "cancel",
    });
  }

  async #consume(query: Query): Promise<void> {
    try {
      for await (const message of query) {
        this.#handleMessage(message);
      }
      if (!this.#stopping && !this.#resetting) {
        this.#emit("error", "Claude Agent SDK stream ended unexpectedly", {
          rawType: "stream_end",
        });
      }
    } catch (error) {
      if (!this.#stopping && !this.#resetting) {
        this.#emit("error", redactSecrets(asError(error).message), {
          rawType: "sdk_error",
        });
      }
    } finally {
      this.#questions.cancelAll();
    }
  }

  #handleMessage(message: SDKMessage): void {
    this.#sessionId = message.session_id ?? this.#sessionId;
    switch (message.type) {
      case "assistant":
        const seenSpeech = new Set<string>();
        for (const [index, block] of message.message.content.entries()) {
          const signature = readableBlockSignature(block);
          if (signature && seenSpeech.has(signature)) continue;
          if (signature) seenSpeech.add(signature);
          this.#handleContentBlock(block, blockId(message.message.id ?? message.uuid, index), message.uuid);
        }
        if (message.error) {
          this.#lastTurnError = String(message.error);
          this.#emit("error", `Claude assistant error: ${this.#lastTurnError}`, {
            rawType: "assistant",
            providerEventId: message.uuid,
          });
        }
        break;
      case "stream_event":
        this.#handleStreamEvent(message.event, message.uuid);
        break;
      case "result":
        if (message.is_error && this.#lastTurnError) {
          this.#emit("status", `Claude turn ended after error: ${this.#lastTurnError}`, {
            rawType: "result_after_error",
            providerEventId: message.uuid,
          });
        } else {
          this.#emit(
            message.is_error ? "error" : "status",
            message.is_error
              ? `Claude turn failed: ${message.subtype}`
              : `Claude turn completed: ${message.subtype}`,
            {
            rawType: "result",
            providerEventId: message.uuid,
            payload: {
              durationMs: message.duration_ms,
              turns: message.num_turns,
              costUsd: message.total_cost_usd,
              stopReason: message.stop_reason,
              permissionDenials: message.permission_denials,
            },
            },
          );
        }
        this.#lastTurnError = null;
        break;
      case "tool_progress":
        this.#emit("tool_output", `${message.tool_name} is running`, {
          rawType: "tool_progress",
          providerEventId: message.tool_use_id,
          payload: { elapsedSeconds: message.elapsed_time_seconds },
        });
        break;
      case "tool_use_summary":
        this.#emit("tool_end", message.summary, {
          rawType: "tool_use_summary",
          providerEventId: message.uuid,
        });
        break;
      case "system":
        this.#handleSystemMessage(message);
        break;
      case "user":
        // A tool result names the tool_use it answers, which is what lets the
        // transcript close the row that the tool call opened instead of adding
        // a second, unattached one.
        for (const result of toolResults(message.message?.content)) {
          const label = this.#toolLabels.get(result.toolUseId) ?? "tool";
          this.#toolLabels.delete(result.toolUseId);
          this.#emit("tool_end", result.failed ? `${label}  failed` : label, {
            rawType: "tool_result",
            providerEventId: result.toolUseId,
            payload: completionPayload(message.tool_use_result, result.failed),
          });
        }
        break;
      default:
        this.#emit("status", `Claude event: ${message.type}`, {
          rawType: message.type,
          ...("uuid" in message && typeof message.uuid === "string"
            ? { providerEventId: message.uuid }
            : {}),
          payload: message,
        });
    }
  }

  #handleContentBlock(block: unknown, blockKey: string, messageUuid: string): void {
    if (!isRecord(block) || typeof block.type !== "string") {
      return;
    }
    // A redacted thinking block arrives with no readable text. Emitting it
    // would say nothing and would close a row that streamed real content.
    if (block.type === "text" && typeof block.text === "string") {
      if (block.text.trim() !== "") {
        this.#emit("assistant", block.text, {
          rawType: "assistant_text",
          providerEventId: blockKey,
        });
      }
      return;
    }
    if (block.type === "thinking" && typeof block.thinking === "string") {
      if (block.thinking.trim() !== "") {
        this.#emit("reasoning", block.thinking, {
          rawType: "assistant_thinking",
          providerEventId: blockKey,
        });
      }
      return;
    }
    if (block.type === "tool_use") {
      const label = formatToolLabel(describeClaudeTool(String(block.name ?? "tool"), block.input));
      const toolUseId = typeof block.id === "string" ? block.id : messageUuid;
      this.#toolLabels.set(toolUseId, label);
      this.#emit("tool_start", label, {
        rawType: "tool_use",
        providerEventId: toolUseId,
        payload: block.input,
      });
    }
  }

  #handleStreamEvent(event: unknown, messageUuid: string): void {
    if (!isRecord(event)) {
      return;
    }
    if (event.type === "message_start") {
      const started = isRecord(event.message) && typeof event.message.id === "string" ? event.message.id : null;
      this.#streamingMessageId = started;
      return;
    }
    if (event.type === "message_stop") {
      this.#streamingMessageId = null;
      return;
    }
    if (!isRecord(event.delta)) {
      return;
    }
    const index = typeof event.index === "number" ? event.index : 0;
    const blockKey = blockId(this.#streamingMessageId ?? messageUuid, index);
    const delta = event.delta;
    if (delta.type === "text_delta" && typeof delta.text === "string") {
      this.#emit("assistant", delta.text, {
        rawType: "text_delta",
        providerEventId: blockKey,
      });
    } else if (
      delta.type === "thinking_delta" &&
      typeof delta.thinking === "string"
    ) {
      this.#emit("reasoning", delta.thinking, {
        rawType: "thinking_delta",
        providerEventId: blockKey,
      });
    }
  }

  #handleSystemMessage(message: Extract<SDKMessage, { type: "system" }>): void {
    switch (message.subtype) {
      case "init":
        this.#emit("session", `Claude session ${message.session_id} initialized${message.model ? ` (${message.model})` : ""}`, {
          rawType: "system/init",
          providerEventId: message.session_id,
          payload: {
            version: message.claude_code_version,
            cwd: message.cwd,
            model: message.model,
            permissionMode: message.permissionMode,
            mcpServers: message.mcp_servers,
            skills: message.skills,
          },
        });
        break;
      case "api_retry":
        this.#emit("warning", `Claude API retry ${message.attempt}/${message.max_retries}`, {
          rawType: "system/api_retry",
          providerEventId: message.uuid,
          payload: { delayMs: message.retry_delay_ms, error: message.error },
        });
        break;
      case "permission_denied":
        this.#emit("warning", message.message, {
          rawType: "system/permission_denied",
          providerEventId: message.tool_use_id,
          payload: { toolName: message.tool_name },
        });
        break;
      case "thinking_tokens":
        this.#emit("usage", "Claude reasoning token estimate updated", {
          rawType: "system/thinking_tokens",
          providerEventId: message.uuid,
          payload: { estimatedTokens: message.estimated_tokens },
        });
        break;
      case "task_started":
        // A background Bash/subagent outlives the foreground turn. Represent
        // it as a command activity so team_status and team_activity do not
        // incorrectly imply that the provider is idle after the turn ends.
        if (message.is_backgrounded) {
          this.#emit("tool_start", `background ${message.description}`, {
            rawType: "system/task_started",
            providerEventId: message.task_id,
            payload: {
              type: "commandExecution",
              command: message.description,
              status: "running",
              background: true,
            },
          });
        }
        break;
      case "task_progress":
        this.#emit("tool_output", `background ${message.description} is running`, {
          rawType: "system/task_progress",
          providerEventId: message.task_id,
          payload: {
            type: "commandExecution",
            command: message.description,
            status: "running",
            background: true,
          },
        });
        break;
      case "task_notification":
        this.#emit("tool_end", `background ${message.summary}`, {
          rawType: "system/task_notification",
          providerEventId: message.task_id,
          payload: {
            type: "commandExecution",
            command: message.summary,
            status: message.status === "completed" ? "completed" : "failed",
            background: true,
            output_file: message.output_file,
          },
        });
        break;
      case "background_tasks_changed":
        this.#emit("status", `Claude has ${message.tasks.length} background task${message.tasks.length === 1 ? "" : "s"}`, {
          rawType: "system/background_tasks_changed",
          providerEventId: message.uuid,
          payload: { tasks: message.tasks.map((task) => ({ task_id: task.task_id, task_type: task.task_type, description: task.description })) },
        });
        break;
      default:
        this.#emit("status", `Claude system event: ${message.subtype}`, {
          rawType: `system/${message.subtype}`,
          ...(message.uuid ? { providerEventId: message.uuid } : {}),
          payload: message,
        });
    }
  }

  #spawnClaudeCodeProcess(options: SpawnOptions): SpawnedProcess {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      detached: process.platform !== "win32",
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      const message = redactSecrets(String(chunk)).trimEnd();
      if (message) {
        this.#emit("warning", message, { rawType: "stderr" });
      }
    });
    trackProcess(child.pid);
    child.once("exit", () => untrackProcess(child.pid));
    const wrapped = new GroupedChildProcess(child);
    options.signal.addEventListener("abort", () => wrapped.kill("SIGTERM"), {
      once: true,
    });
    return wrapped;
  }

  #rejectPermissions(error: Error): void {
    for (const permission of this.#permissions.values()) {
      permission.removeAbortListener();
      permission.reject(error);
    }
    this.#permissions.clear();
  }

  #emit(
    kind: AgentEvent["kind"],
    summary: string,
    extras: Omit<Partial<AgentEvent>, "agent" | "kind" | "timestamp" | "summary"> = {},
  ): void {
    this.#events.push({
      agent: this.#agent,
      kind,
      timestamp: Date.now(),
      summary: redactSummary(summary),
      ...extras,
      ...("payload" in extras ? { payload: redactUnknown(extras.payload) } : {}),
    });
  }

  #requiredProject(): ProjectContext {
    if (!this.#project) {
      throw new Error("Claude adapter is not started");
    }
    return this.#project;
  }

  #requiredWarmQuery(): WarmQuery {
    if (!this.#warmQuery) {
      throw new Error("Claude Agent SDK is not initialized");
    }
    return this.#warmQuery;
  }
}

class GroupedChildProcess implements SpawnedProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly #child: ReturnType<typeof spawn>;

  constructor(child: ReturnType<typeof spawn>) {
    if (!child.stdin || !child.stdout) {
      throw new Error("Claude subprocess did not expose piped stdio");
    }
    this.#child = child;
    this.stdin = child.stdin;
    this.stdout = child.stdout;
  }

  get killed(): boolean {
    return this.#child.killed;
  }

  get exitCode(): number | null {
    return this.#child.exitCode;
  }

  get signalCode(): NodeJS.Signals | null {
    return this.#child.signalCode;
  }

  kill(signal: NodeJS.Signals): boolean {
    const pid = this.#child.pid;
    if (pid && pid > 1 && this.#child.exitCode === null) {
      try {
        if (process.platform !== "win32") {
          process.kill(-pid, signal);
          return true;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
          throw error;
        }
      }
    }
    return this.#child.kill(signal);
  }

  on(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): void;
  on(event: "error", listener: (error: Error) => void): void;
  on(
    event: "exit" | "error",
    listener:
      | ((code: number | null, signal: NodeJS.Signals | null) => void)
      | ((error: Error) => void),
  ): void {
    this.#child.on(event, listener as never);
  }

  once(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): void;
  once(event: "error", listener: (error: Error) => void): void;
  once(
    event: "exit" | "error",
    listener:
      | ((code: number | null, signal: NodeJS.Signals | null) => void)
      | ((error: Error) => void),
  ): void {
    this.#child.once(event, listener as never);
  }

  off(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): void;
  off(event: "error", listener: (error: Error) => void): void;
  off(
    event: "exit" | "error",
    listener:
      | ((code: number | null, signal: NodeJS.Signals | null) => void)
      | ((error: Error) => void),
  ): void {
    this.#child.off(event, listener as never);
  }
}

/**
 * In-process SDK hooks that let a working Claude take team mail inside its turn.
 *
 * Claude's streaming input is only read between turns, so a peer's question
 * used to wait for a turn that could run twenty minutes. PostToolBatch fires
 * once every tool call in a batch has finished and before the next model
 * request, which is the same safe boundary Codex is steered at. Stop fires when
 * Claude is about to end its turn. Blocking it with waiting mail or an
 * unanswered question keeps the work in the same turn instead of paying for a
 * new one. These are SDK callbacks answered inside the Watari service. Nothing
 * is written to provider settings and no shell hook runs.
 */
export function claudeTeamHooks(inbox: BoundaryInbox): NonNullable<Options["hooks"]> {
  return {
    PostToolBatch: [{
      hooks: [async (input) => {
        // A subagent's batch belongs to the subagent, which cannot answer for the team.
        if (input.hook_event_name !== "PostToolBatch" || input.agent_id) return {};
        const text = await inbox.atToolBoundary();
        return text
          ? { hookSpecificOutput: { hookEventName: "PostToolBatch" as const, additionalContext: text } }
          : {};
      }],
    }],
    Stop: [{
      hooks: [async (input) => {
        if (input.hook_event_name !== "Stop") return {};
        const text = await inbox.beforeTurnEnd();
        return text ? { decision: "block" as const, reason: text } : {};
      }],
    }],
  };
}

/** One content block of one message. Text and thinking in the same message
 * are separate blocks and stay separate rows, while every delta of one block
 * shares this key so the transcript keeps them on one row. */
export function blockId(messageId: string, index: number): string {
  return `${messageId}#${index}`;
}

interface ToolResult {
  readonly toolUseId: string;
  readonly failed: boolean;
}

/** Reads `tool_result` blocks out of a user message turn. */
function toolResults(content: unknown): ToolResult[] {
  if (!Array.isArray(content)) return [];
  const results: ToolResult[] = [];
  for (const block of content) {
    if (!isRecord(block) || block.type !== "tool_result") continue;
    const toolUseId = block.tool_use_id;
    if (typeof toolUseId !== "string") continue;
    results.push({ toolUseId, failed: block.is_error === true });
  }
  return results;
}

function completionPayload(value: unknown, failed: boolean): Record<string, unknown> {
  const detail = isRecord(value) ? value : {};
  return { ...detail, status: failed ? "failed" : (detail.status ?? "completed") };
}

/** Claude may repeat one final text block inside the same assistant message.
 * The message id is authoritative, so byte-identical speech blocks are one
 * user-visible statement rather than two transcript entries. */
function readableBlockSignature(block: unknown): string | null {
  if (!isRecord(block)) return null;
  if (block.type === "text" && typeof block.text === "string") {
    return `text\u0000${block.text}`;
  }
  if (block.type === "thinking" && typeof block.thinking === "string") {
    return `thinking\u0000${block.thinking}`;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
