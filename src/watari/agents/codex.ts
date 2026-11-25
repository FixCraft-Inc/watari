import type { InitializeResponse } from "../../generated/codex/InitializeResponse.ts";
import { QuestionQueue } from "../questions.ts";
import { compileQuestionForm } from "../question-form.ts";
import type { McpServerElicitationRequestParams } from "../../generated/codex/v2/McpServerElicitationRequestParams.ts";
import type { ToolRequestUserInputParams } from "../../generated/codex/v2/ToolRequestUserInputParams.ts";
import type { ServerRequest } from "../../generated/codex/ServerRequest.ts";
import type { DynamicToolCallParams } from "../../generated/codex/v2/DynamicToolCallParams.ts";
import type { ThreadResumeResponse } from "../../generated/codex/v2/ThreadResumeResponse.ts";
import type { ThreadStartParams } from "../../generated/codex/v2/ThreadStartParams.ts";
import type { ThreadResumeParams } from "../../generated/codex/v2/ThreadResumeParams.ts";
import type { ThreadStartResponse } from "../../generated/codex/v2/ThreadStartResponse.ts";
import type { TurnStartResponse } from "../../generated/codex/v2/TurnStartResponse.ts";
import type { ModelListResponse } from "../../generated/codex/v2/ModelListResponse.ts";
import type { PermissionsRequestApprovalResponse } from "../../generated/codex/v2/PermissionsRequestApprovalResponse.ts";
import { z } from "zod";

import {
  InputDeferredError,
  type AgentAdapter,
  type AgentCapabilities,
  type AgentEvent,
  type AgentId,
  type AgentModelOption,
  type AgentInput,
  type ProjectContext,
} from "../models.ts";
import { ManagedProcess } from "../process/supervisor.ts";
import { redactSecrets, redactSummary, redactUnknown } from "../security/redaction.ts";
import { TEAM_INSTRUCTIONS } from "../team/instructions.ts";
import {
  codexTeamMcpConfig,
  codexThreadPosture,
  type TeamMcpCommand,
  type TeamMcpEnvironment,
} from "../team/provider-config.ts";
import type { ReasoningEffort } from "../team/roster.ts";
import { describeCodexItem, formatToolLabel } from "./tool-summary.ts";
import {
  TEAM_TOOL_DEFINITIONS,
  type IdentityBoundTeamTools,
} from "../team/tools.ts";
import { createAgentEventQueue } from "../util/event-queue.ts";
import { TESTED_CODEX_VERSION } from "../compatibility.ts";

const REQUEST_TIMEOUT_MS = 15_000;
const WireEnvelopeSchema = z.looseObject({
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string().optional(),
  result: z.unknown().optional(),
  error: z.unknown().optional(),
  params: z.unknown().optional(),
});

type RequestId = string | number;
type PendingRequest = {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
};

export interface CodexAdapterOptions {
  readonly executable: string;
  readonly agent?: AgentId;
  readonly model?: string;
  readonly effort?: ReasoningEffort;
  readonly commandPrefix?: readonly [string, ...string[]];
  readonly requestTimeoutMs?: number;
  readonly readOnlyProbe?: boolean;
  readonly unrestricted?: boolean;
  readonly teamTools?: IdentityBoundTeamTools;
  readonly teamMcpCommand?: TeamMcpCommand;
  readonly teamMcpEnv?: TeamMcpEnvironment;
}

export class CodexAdapter implements AgentAdapter {
  readonly #questions: QuestionQueue;
  readonly #nativeQuestions = new Map<RequestId, AbortController>();
  readonly #agent: AgentId;
  readonly #executable: string;
  readonly #model: string | null;
  readonly #effort: ReasoningEffort | null;
  readonly #requestTimeoutMs: number;
  readonly #readOnlyProbe: boolean;
  readonly #unrestricted: boolean;
  readonly #commandPrefix: readonly [string, ...string[]] | null;
  readonly #teamTools: IdentityBoundTeamTools | null;
  readonly #teamMcpCommand: TeamMcpCommand | null;
  readonly #teamMcpEnv: TeamMcpEnvironment | undefined;
  readonly #events;
  readonly #pending = new Map<RequestId, PendingRequest>();
  readonly #approvals = new Map<RequestId, { readonly method: string; readonly params: unknown }>();
  #process: ManagedProcess | null = null;
  #project: ProjectContext | null = null;
  #threadId: string | null = null;
  #turnId: string | null = null;
  #requestId = 0;
  #stopping = false;

  constructor(options: CodexAdapterOptions) {
    this.#agent = options.agent ?? "codex";
    this.#questions = new QuestionQueue(this.#agent, (event) => this.#events.push(event));
    this.#executable = options.executable;
    this.#model = options.model ?? null;
    this.#effort = options.effort ?? null;
    this.#events = createAgentEventQueue(this.#agent);
    this.#requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
    this.#readOnlyProbe = options.readOnlyProbe ?? false;
    this.#unrestricted = options.unrestricted ?? false;
    this.#commandPrefix = options.commandPrefix ?? null;
    this.#teamTools = options.teamTools ?? null;
    this.#teamMcpCommand = options.teamMcpCommand ?? null;
    this.#teamMcpEnv = options.teamMcpEnv;
    if (this.#teamTools && this.#teamMcpCommand) {
      throw new Error("Codex team tools must use exactly one transport");
    }
  }

  get sessionId(): string | null {
    return this.#threadId;
  }

  capabilities(): AgentCapabilities {
    return {
      structuredReasoningEvents: true,
      toolEvents: true,
      diffEvents: true,
      approvals: true,
      interrupt: true,
      bidirectionalInput: true,
      safeSteer: true,
      resume: true,
      mcp: true,
      skills: true,
      nativeSession: true,
      usageMetadata: true,
    };
  }

  async start(project: ProjectContext): Promise<void> {
    if (this.#process) {
      throw new Error("Codex adapter is already started");
    }
    this.#project = project;
    this.#process = ManagedProcess.start({
      command: this.#commandPrefix ?? [this.#executable, "app-server", "--stdio"],
      cwd: project.launchDirectory,
      onJsonLine: (line) => this.#handleLine(line),
      onDiagnostic: (message) => this.#diagnostic(message),
      onTransportError: (error) => this.#transportError(error),
    });
    void this.#watchExit(this.#process);
    const response = await this.#request<InitializeResponse>("initialize", {
      clientInfo: {
        name: "watari",
        title: "Watari",
        version: "0.1.0",
      },
      capabilities: {
          experimentalApi: true,
        requestAttestation: false,
        mcpServerOpenaiFormElicitation: false,
        requiredHumanApproval: false,
      },
    });
    this.#process.writeJson({ method: "initialized" });
    this.#emit("status", `Codex app-server initialized (${response.userAgent})`, {
      rawType: "initialize",
      payload: {
        platformFamily: response.platformFamily,
        platformOs: response.platformOs,
        supportedVersion: TESTED_CODEX_VERSION,
      },
    });
  }

  async send(input: AgentInput): Promise<void> {
    if (input.kind === "question_response") {
      this.#questions.respond(input.requestId, input.response);
      return;
    }
    if (input.kind === "approval_response") {
      this.#respondToApproval(input.requestId, input.decision);
      return;
    }
    const threadId = await this.#ensureThread();
    const activeTurn = this.#turnId;
    if (activeTurn) {
      try {
        await this.#steer(threadId, activeTurn, input.text);
        return;
      } catch (error) {
        // A turn can finish between Watari choosing to steer it and Codex
        // reading the request. Once that turn is gone the input opens the next
        // turn. A turn that is still running but refused the steer, such as a
        // compaction or a review, is not an outage, so the input waits.
        if (this.#turnId === activeTurn) {
          throw new InputDeferredError(
            `Codex could not take input inside its turn: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
          );
        }
      }
    }
    const response = await this.#request<TurnStartResponse>("turn/start", {
      threadId,
      input: [{ type: "text", text: input.text, text_elements: [] }],
      ...(this.#model ? { model: this.#model } : {}),
      ...(this.#effort ? { effort: this.#effort } : {}),
    });
    this.#turnId = response.turn.id;
  }

  /**
   * Steers the running turn. When Codex answers that a different turn is
   * active, it names that turn, and the input is offered to it once. Watari's
   * record can only be wrong if a notice it relied on was not this thread's,
   * and failing every later handover over it left peer mail waiting for the
   * whole of a long turn.
   */
  async #steer(threadId: string, turnId: string, text: string): Promise<void> {
    const input = [{ type: "text", text, text_elements: [] }];
    try {
      await this.#request("turn/steer", { threadId, expectedTurnId: turnId, input });
    } catch (error) {
      const actual = activeTurnFromSteerError(error);
      if (!actual || actual === turnId || this.#turnId !== turnId) throw error;
      this.#turnId = actual;
      await this.#request("turn/steer", { threadId, expectedTurnId: actual, input });
    }
  }

  /** Whether a notification belongs to a thread other than this agent's own. */
  #foreignThread(params: Record<string, unknown>): boolean {
    return typeof params.threadId === "string" && this.#threadId !== null && params.threadId !== this.#threadId;
  }

  /** Starts the thread so Codex resolves the injected MCP server before the
   * user's first message. thread/start itself performs no paid model turn. */
  async prepare(): Promise<void> {
    await this.#ensureThread();
  }

  async availableModels(): Promise<readonly AgentModelOption[]> {
    const response = await this.#request<ModelListResponse>("model/list", {
      cursor: null,
      limit: 100,
      includeHidden: false,
    });
    return response.data.map((model) => ({
      id: model.model || model.id,
      displayName: model.displayName || model.model || model.id,
      description: model.description,
      efforts: model.supportedReasoningEfforts.map((effort) => effort.reasoningEffort),
      isDefault: model.isDefault,
    }));
  }

  /**
   * Continues a saved thread with the configuration a new one would get. The
   * team bridge carries this service's token, so it has to be handed over
   * again, as do the team instructions and the permission posture.
   */
  async resume(sessionId: string): Promise<void> {
    const project = this.#requiredProject();
    const params: ThreadResumeParams & Record<string, unknown> = {
      threadId: sessionId,
      cwd: project.launchDirectory,
      excludeTurns: true,
      ...(this.#model ? { model: this.#model } : {}),
      ...(this.#teamTools || this.#teamMcpCommand ? { developerInstructions: TEAM_INSTRUCTIONS } : {}),
      ...(this.#teamMcpCommand
        ? { config: codexTeamMcpConfig(this.#teamMcpCommand, project.launchDirectory, this.#teamMcpEnv) }
        : {}),
      ...codexThreadPosture({ readOnlyProbe: this.#readOnlyProbe, unrestricted: this.#unrestricted }),
    };
    const response = await this.#request<ThreadResumeResponse>("thread/resume", params);
    this.#threadId = response.thread.id;
    this.#turnId = null;
    const running = response.model ? ` (${response.model}${response.modelProvider ? ` via ${response.modelProvider}` : ""})` : "";
    this.#emit("session", `Resumed Codex thread ${response.thread.id}${running}`, {
      rawType: "thread/resume",
      providerEventId: response.thread.id,
    });
  }

  async interrupt(): Promise<void> {
    this.#questions.cancelAll();
    if (!this.#threadId || !this.#turnId) {
      return;
    }
    await this.#request("turn/interrupt", {
      threadId: this.#threadId,
      turnId: this.#turnId,
    });
  }

  async resetSession(): Promise<void> {
    await this.interrupt().catch(() => undefined);
    this.#threadId = null;
    this.#turnId = null;
  }

  async stop(): Promise<void> {
    this.#questions.cancelAll();
    this.#stopping = true;
    const process = this.#process;
    this.#process = null;
    this.#rejectPending(new Error("Codex adapter stopped"));
    if (process) {
      await process.stop();
    }
    this.#events.close();
  }

  events(): AsyncIterable<AgentEvent> {
    return this.#events;
  }

  async #ensureThread(): Promise<string> {
    if (this.#threadId) {
      return this.#threadId;
    }
    const project = this.#requiredProject();
    // Typed against the generated app-server schema so a renamed field or an
    // invalid sandbox value fails the build instead of the first real turn.
    const params: ThreadStartParams & Record<string, unknown> = {
      cwd: project.launchDirectory,
      serviceName: "watari",
      ...(this.#model ? { model: this.#model } : {}),
      ...(this.#teamTools || this.#teamMcpCommand
        ? {
            developerInstructions: TEAM_INSTRUCTIONS,
          }
        : {}),
      ...(this.#teamTools
        ? {
            dynamicTools: TEAM_TOOL_DEFINITIONS.map((definition) => ({
              type: "function",
              name: definition.name,
              description: definition.description,
              inputSchema: definition.inputSchema,
              deferLoading: false,
            })),
          }
        : {}),
      ...(this.#teamMcpCommand
        ? { config: codexTeamMcpConfig(this.#teamMcpCommand, project.launchDirectory, this.#teamMcpEnv) }
        : {}),
      ...codexThreadPosture({
        readOnlyProbe: this.#readOnlyProbe,
        unrestricted: this.#unrestricted,
      }),
    };
    const response = await this.#request<ThreadStartResponse>("thread/start", params);
    this.#threadId = response.thread.id;
    return response.thread.id;
  }

  async #request<T = unknown>(method: string, params: unknown): Promise<T> {
    const process = this.#requiredProcess();
    const id = ++this.#requestId;
    const response = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Codex request timed out: ${method}`));
      }, this.#requestTimeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
    });
    process.writeJson({ method, id, params });
    return (await response) as T;
  }

  #handleLine(result: import("../process/jsonl.ts").JsonLineResult): void {
    if (!result.ok) {
      this.#emit("warning", result.error, {
        rawType: "malformed_jsonl",
        payload: { preview: redactSecrets(result.raw).slice(0, 512) },
      });
      return;
    }
    const envelope = WireEnvelopeSchema.safeParse(result.value);
    if (!envelope.success) {
      this.#emit("warning", "Codex emitted an invalid protocol envelope", {
        rawType: "invalid_envelope",
        payload: envelope.error.issues,
      });
      return;
    }
    const message = envelope.data;
    const id = requestId(message.id);
    if (id !== null && ("result" in message || "error" in message)) {
      this.#handleResponse(id, message);
      return;
    }
    const method = message.method ?? null;
    if (!method) {
      this.#emit("warning", "Codex emitted an unrecognized protocol envelope", {
        rawType: "unknown",
      });
      return;
    }
    if (id !== null) {
      this.#handleServerRequest(message as unknown as ServerRequest);
      return;
    }
    this.#handleNotification({ method, params: message.params });
  }

  #handleResponse(id: RequestId, message: Record<string, unknown>): void {
    const pending = this.#pending.get(id);
    if (!pending) {
      this.#emit("warning", `Codex response had no pending request: ${id}`, {
        rawType: "orphan_response",
      });
      return;
    }
    clearTimeout(pending.timer);
    this.#pending.delete(id);
    if ("error" in message && message.error !== undefined) {
      pending.reject(new Error(protocolErrorMessage(message.error)));
    } else {
      pending.resolve(message.result);
    }
  }

  #handleServerRequest(request: ServerRequest): void {
    const id = request.id;
    const method = request.method;
    if (isApprovalMethod(method)) {
      this.#approvals.set(id, { method, params: request.params });
      this.#emit("approval", `Codex requests approval: ${method}`, {
        rawType: method,
        providerEventId: String(id),
        payload: request.params,
      });
      return;
    }
    if (method === "item/tool/call") {
      void this.#handleDynamicTool(id, request.params as DynamicToolCallParams);
      return;
    }
    if (method === "mcpServer/elicitation/request") {
      void this.#askForm(id, request.params as McpServerElicitationRequestParams);
      return;
    }
    if (method === "item/tool/requestUserInput") {
      void this.#askUser(id, request.params as ToolRequestUserInputParams);
      return;
    }
    this.#requiredProcess().writeJson({
      id,
      error: {
        code: -32601,
        message: `Watari does not support server request ${method}`,
      },
    });
    this.#emit("warning", `Unsupported Codex server request rejected: ${method}`, {
      rawType: method,
      providerEventId: String(id),
    });
  }

  async #askForm(id: RequestId, params: McpServerElicitationRequestParams): Promise<void> {
    const controller = new AbortController();
    this.#nativeQuestions.set(id, controller);
    let result: unknown = { action: "decline", content: null, _meta: null };
    try {
      if (params.mode !== "form" || this.#readOnlyProbe) throw new Error("unsupported input form");
      const form = compileQuestionForm(params.requestedSchema, params.message);
      const response = await this.#questions.ask(form.fields, controller.signal, form.decode);
      result = response.action === "answer" ? { action: "accept", content: form.decode(response.answers), _meta: null } : { action: "cancel", content: null, _meta: null };
    } catch {
      this.#emit("warning", "Codex MCP input form declined: unsupported or secure form", { rawType: "question_unsupported" });
    }
    if (this.#nativeQuestions.get(id) !== controller) return;
    this.#nativeQuestions.delete(id);
    try { this.#process?.writeJson({ id, result }); }
    catch { this.#emit("warning", "Codex form response could not reach the provider"); }
  }

  async #askUser(id: RequestId, params: ToolRequestUserInputParams): Promise<void> {
    const controller = new AbortController();
    this.#nativeQuestions.set(id, controller);
    let answers: Record<string, { answers: string[] }> = {};
    try {
      if (!Array.isArray(params.questions) || params.questions.length < 1 || params.questions.length > 8) throw new Error("invalid question count");
      if (this.#readOnlyProbe || params.questions.some((question) => question.isSecret)) {
        throw new Error("secret questions require the provider's secure input surface");
      }
      const response = await this.#questions.ask(params.questions.map((question) => ({
        id: question.id, header: question.header, question: question.question,
        options: question.options ?? [], multiSelect: false,
        allowOther: question.isOther || !question.options?.length,
      })), controller.signal, undefined, params.isBlocking);
      if (response.action === "answer") answers = Object.fromEntries(Object.entries(response.answers).map(([key, values]) => [key, { answers: values }]));
    } catch {
      this.#emit("warning", "Codex question cancelled: unsupported or invalid input form", { rawType: "question_unsupported" });
    }
    // The server may resolve a nonblocking question or lose its process first.
    if (this.#nativeQuestions.get(id) !== controller) return;
    this.#nativeQuestions.delete(id);
    try { this.#process?.writeJson({ id, result: { answers } }); }
    catch { this.#emit("error", "Codex question response could not reach the provider", { rawType: "transport" }); }
  }

  async #handleDynamicTool(id: RequestId, params: DynamicToolCallParams): Promise<void> {
    if (!this.#teamTools) {
      this.#requiredProcess().writeJson({
        id,
        error: { code: -32601, message: "Watari team tools are not enabled" },
      });
      return;
    }
    const result = await this.#teamTools.call(params.tool, params.arguments);
    this.#requiredProcess().writeJson({
      id,
      result: {
        contentItems: [{ type: "inputText", text: JSON.stringify(result) }],
        success: result.ok,
      },
    });
  }

  #respondToApproval(
    id: RequestId,
    decision: "accept" | "decline" | "cancel",
  ): void {
    // Transcript IDs and slash-command arguments are strings. Resolve them
    // back to the original JSON-RPC ID, including numeric zero, before replying.
    if (!this.#approvals.has(id)) {
      const original = [...this.#approvals.keys()].find((key) => String(key) === String(id));
      if (original !== undefined) id = original;
    }
    const approval = this.#approvals.get(id);
    if (!approval) {
      throw new Error(`unknown Codex approval request: ${id}`);
    }
    this.#approvals.delete(id);
    const method = approval.method;
    if (method === "item/permissions/requestApproval") {
      this.#requiredProcess().writeJson({ id, result: permissionsDecision(approval.params, decision) });
      return;
    }
    if (
      method === "item/commandExecution/requestApproval" ||
      method === "item/fileChange/requestApproval" ||
      method === "applyPatchApproval" ||
      method === "execCommandApproval"
    ) {
      this.#requiredProcess().writeJson({ id, result: { decision } });
      return;
    }
    this.#requiredProcess().writeJson({
      id,
      error: { code: -32000, message: "Approval type is unsupported; denied closed" },
    });
  }

  #handleNotification(notification: { readonly method: string; readonly params: unknown }): void {
    const method = notification.method;
    const params = notification.params;
    if (!isRecord(params)) {
      this.#invalidNotification(method, "params must be an object");
      return;
    }
    switch (method) {
      case "serverRequest/resolved": {
        const id = params.requestId as RequestId;
        const pending = this.#nativeQuestions.get(id);
        this.#nativeQuestions.delete(id);
        pending?.abort();
        break;
      }
      case "thread/started": {
        const threadId = nestedString(params, "thread", "id");
        if (!threadId) {
          this.#invalidNotification(method, "thread.id must be a string");
          break;
        }
        // A sub-agent Codex spawns starts a thread of its own on the same
        // connection. This agent's thread is the one it started first.
        if (this.#threadId !== null && threadId !== this.#threadId) {
          this.#emit("status", `Codex sub-agent thread ${threadId} started`, {
            rawType: "subagent/thread/started",
            providerEventId: threadId,
          });
          break;
        }
        this.#threadId = threadId;
        this.#emit("session", `Codex thread ${threadId} started`, {
          rawType: method,
          providerEventId: threadId,
        });
        break;
      }
      case "turn/started": {
        const turnId = nestedString(params, "turn", "id");
        if (!turnId) {
          this.#invalidNotification(method, "turn.id must be a string");
          break;
        }
        // Sub-agent turns arrive here too. Taking one for this agent's turn
        // made every later steer name the wrong turn, and Codex refused them.
        if (this.#foreignThread(params)) {
          this.#emit("status", `Codex sub-agent turn ${turnId} started`, {
            rawType: "subagent/turn/started",
            providerEventId: turnId,
          });
          break;
        }
        this.#turnId = turnId;
        this.#emit("status", `Codex turn ${turnId} started`, {
          rawType: method,
          providerEventId: turnId,
        });
        break;
      }
      case "turn/completed": {
        const turn = isRecord(params.turn) ? params.turn : null;
        if (!turn || typeof turn.id !== "string") {
          this.#invalidNotification(method, "turn.id must be a string");
          break;
        }
        const turnId = turn.id;
        if (this.#foreignThread(params)) {
          this.#emit("status", `Codex sub-agent turn completed: ${String(turn.status ?? "unknown")}`, {
            rawType: "subagent/turn/completed",
            providerEventId: turnId,
          });
          break;
        }
        this.#turnId = null;
        this.#emit("status", `Codex turn completed: ${String(turn.status ?? "unknown")}`, {
          rawType: method,
          providerEventId: turnId,
          payload: turn.error,
        });
        break;
      }
      case "item/agentMessage/delta": {
        if (typeof params.delta !== "string" || typeof params.itemId !== "string") {
          this.#invalidNotification(method, "delta and itemId must be strings");
          break;
        }
        this.#emit("assistant", params.delta, {
          rawType: method,
          providerEventId: params.itemId,
        });
        break;
      }
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/textDelta": {
        if (typeof params.delta !== "string" || typeof params.itemId !== "string") {
          this.#invalidNotification(method, "delta and itemId must be strings");
          break;
        }
        this.#emit("reasoning", params.delta, {
          rawType: method,
          providerEventId: params.itemId,
        });
        break;
      }
      case "command/exec/outputDelta":
      case "process/outputDelta":
      case "item/commandExecution/outputDelta":
        this.#emit("tool_output", "Codex command output", {
          rawType: method,
          ...(typeof params.itemId === "string" ? { providerEventId: params.itemId } : {}),
          payload: params,
        });
        break;
      case "turn/diff/updated":
        this.#emit("diff", "Codex updated the turn diff", {
          rawType: method,
          payload: { diff: params.diff },
        });
        break;
      case "item/started": {
        const item = isRecord(params.item) ? params.item : null;
        if (!item || typeof item.type !== "string" || typeof item.id !== "string") {
          this.#invalidNotification(method, "item.type and item.id must be strings");
          break;
        }
        if (ECHOED_ITEM_TYPES.has(item.type)) break;
        const label = describeCodexItem(item);
        this.#emit(threadItemKind(item.type, true), label ? formatToolLabel(label) : readableItemType(item.type), {
          rawType: method,
          providerEventId: item.id,
          payload: item,
        });
        break;
      }
      case "item/completed": {
        const item = isRecord(params.item) ? params.item : null;
        if (!item || typeof item.type !== "string" || typeof item.id !== "string") {
          this.#invalidNotification(method, "item.type and item.id must be strings");
          break;
        }
        if (ECHOED_ITEM_TYPES.has(item.type)) break;
        const label = describeCodexItem(item);
        this.#emit(threadItemKind(item.type, false), label ? formatToolLabel(label) : readableItemType(item.type), {
          rawType: method,
          providerEventId: item.id,
          payload: item,
        });
        break;
      }
      // How the app-server actually loaded each configured MCP server. This is
      // the only place Codex says whether the team bridge reached the model's
      // tool list, so it is kept rather than folded into the generic default.
      case "mcpServer/startupStatus/updated": {
        const status = typeof params.status === "string" ? params.status : "unknown";
        const name = typeof params.name === "string" ? params.name : "unknown";
        const error = typeof params.error === "string" ? params.error : null;
        this.#emit(status === "failed" ? "warning" : "status", `MCP server ${name} is ${status}`, {
          rawType: method,
          providerEventId: name,
          payload: { name, status, error, failureReason: params.failureReason ?? null },
        });
        break;
      }
      case "error": {
        // A retrying error is Codex recovering on its own, such as a dropped
        // stream falling back from WebSockets to HTTPS. Reporting it as an
        // error marked a working peer offline and told the team to carry on
        // without it.
        const retrying = params.willRetry === true;
        // A sub-agent's failure is its parent's to handle, not this peer going down.
        const subagent = this.#foreignThread(params);
        const prefix = subagent ? "Codex sub-agent: " : retrying ? "Codex is retrying after: " : "";
        this.#emit(retrying || subagent ? "warning" : "error", turnErrorMessage(params, prefix), {
          rawType: method,
          payload: { willRetry: retrying, codexErrorInfo: isRecord(params.error) ? params.error.codexErrorInfo : null },
        });
        break;
      }
      case "warning":
      case "guardianWarning":
      case "deprecationNotice":
      case "configWarning":
        this.#emit("warning", summarizePayload(params), {
          rawType: method,
          payload: params,
        });
        break;
      default:
        this.#emit("status", `Codex event: ${method}`, {
          rawType: method,
          payload: params,
        });
    }
  }

  #invalidNotification(method: string, reason: string): void {
    this.#emit("warning", `Invalid Codex ${method} notification: ${reason}`, {
      rawType: "invalid_notification",
      payload: { method, reason },
    });
  }

  #diagnostic(message: string): void {
    if (message) {
      this.#emit("warning", message, { rawType: "stderr" });
    }
  }

  #transportError(error: Error): void {
    this.#emit("error", redactSecrets(error.message), { rawType: "transport" });
  }

  async #watchExit(process: ManagedProcess): Promise<void> {
    const code = await process.exited;
    if (!this.#stopping) {
      this.#emit("error", `Codex app-server exited unexpectedly with code ${code}`, {
        rawType: "process_exit",
      });
      this.#rejectPending(new Error(`Codex app-server exited with code ${code}`));
    }
  }

  #rejectPending(error: Error): void {
    const questions = [...this.#nativeQuestions.values()];
    this.#nativeQuestions.clear();
    for (const controller of questions) controller.abort();
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
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
      throw new Error("Codex adapter is not started");
    }
    return this.#project;
  }

  #requiredProcess(): ManagedProcess {
    if (!this.#process) {
      throw new Error("Codex adapter is not started");
    }
    return this.#process;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nestedString(
  value: Record<string, unknown>,
  objectKey: string,
  stringKey: string,
): string | null {
  const nested = value[objectKey];
  if (!isRecord(nested)) {
    return null;
  }
  const candidate = nested[stringKey];
  return typeof candidate === "string" ? candidate : null;
}

function requestId(value: unknown): RequestId | null {
  return typeof value === "string" || typeof value === "number" ? value : null;
}

/** The turn Codex says is active when it refuses a steer for naming another. */
function activeTurnFromSteerError(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error);
  return /expected active turn id `[^`]*` but found `([^`]+)`/u.exec(message)?.[1] ?? null;
}

/** `error` notifications carry a TurnError under `error`, not a top-level message. */
function turnErrorMessage(params: Record<string, unknown>, prefix: string): string {
  const error = isRecord(params.error) ? params.error : null;
  const message = error && typeof error.message === "string" && error.message
    ? error.message
    : protocolErrorMessage(params);
  const info = error?.codexErrorInfo;
  const kind = typeof info === "string" ? info : isRecord(info) ? Object.keys(info)[0] : undefined;
  const detail = kind && kind !== "other" && !message.includes(kind) ? ` (${kind})` : "";
  return redactSecrets(`${prefix}${message}${detail}`);
}

function protocolErrorMessage(value: unknown): string {
  if (isRecord(value) && typeof value.message === "string") {
    return redactSecrets(value.message);
  }
  return redactSecrets(summarizePayload(value));
}

function summarizePayload(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (isRecord(value)) {
    for (const key of ["message", "summary", "error"] as const) {
      if (typeof value[key] === "string") {
        return value[key];
      }
    }
  }
  return "Provider emitted structured diagnostic data";
}

/**
 * The answer to a request for extra sandbox permissions. Accepting grants what
 * was asked for this turn only. Declining grants nothing, which the protocol
 * expresses as an empty grant rather than an error, so the turn carries on
 * inside its existing sandbox instead of failing the tool call outright.
 */
export function permissionsDecision(
  params: unknown,
  decision: "accept" | "decline" | "cancel",
): PermissionsRequestApprovalResponse {
  if (decision !== "accept") return { permissions: {}, scope: "turn" };
  const requested = isRecord(params) && isRecord(params.permissions) ? params.permissions : {};
  const permissions: PermissionsRequestApprovalResponse["permissions"] = {};
  if (isRecord(requested.network)) {
    permissions.network = requested.network as NonNullable<PermissionsRequestApprovalResponse["permissions"]["network"]>;
  }
  if (isRecord(requested.fileSystem)) {
    permissions.fileSystem = requested.fileSystem as NonNullable<PermissionsRequestApprovalResponse["permissions"]["fileSystem"]>;
  }
  return { permissions, scope: "turn" };
}

function isApprovalMethod(method: string): boolean {
  return (
    method.endsWith("requestApproval") ||
    method === "applyPatchApproval" ||
    method === "execCommandApproval"
  );
}

/** Codex echoes the prompt back as a thread item. Watari already stored that
 * as the message it sent, so echoing it would show the goal twice. */
const ECHOED_ITEM_TYPES = new Set(["userMessage", "hookPrompt"]);

/** `agentMessage` reads as `agent message`, so a fallback row is still prose. */
function readableItemType(type: string): string {
  return type.replace(/([a-z0-9])([A-Z])/gu, "$1 $2").toLowerCase();
}

function threadItemKind(
  type: string,
  started: boolean,
): AgentEvent["kind"] {
  if (type === "commandExecution" || type === "mcpToolCall" || type === "dynamicToolCall") {
    return started ? "tool_start" : "tool_end";
  }
  if (type === "fileChange") {
    return "edit";
  }
  if (type === "reasoning") {
    return "reasoning";
  }
  if (type === "agentMessage") {
    return "assistant";
  }
  return "status";
}
