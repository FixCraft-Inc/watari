import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  RequestError,
  type Client,
  type InitializeResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionConfigOption,
  type SessionNotification,
  type Stream,
} from "@agentclientprotocol/sdk";

import type {
  AgentAdapter,
  AgentCapabilities,
  AgentEvent,
  AgentId,
  AgentInput,
  AgentModelOption,
  BoundaryInbox,
  ProjectContext,
} from "../models.ts";
import { ManagedProcess } from "../process/supervisor.ts";
import { redactSummary, redactUnknown } from "../security/redaction.ts";
import { TEAM_INSTRUCTIONS } from "../team/instructions.ts";
import {
  acpTeamMcpConfig,
  type TeamMcpCommand,
  type TeamMcpEnvironment,
} from "../team/provider-config.ts";
import type { ReasoningEffort } from "../team/roster.ts";
import { createAgentEventQueue } from "../util/event-queue.ts";
import { QuestionQueue } from "../questions.ts";
import type { QuestionField, QuestionResponse } from "../questions.ts";
import { compileQuestionForm } from "../question-form.ts";

const REQUEST_TIMEOUT_MS = 15_000;
/** How long a courtesy call to a dying provider may hold a shutdown. */
const SHUTDOWN_TIMEOUT_MS = 3_000;

type WireMessage = Stream["readable"] extends ReadableStream<infer Message>
  ? Message
  : never;

type AcpAgentCapabilities = NonNullable<InitializeResponse["agentCapabilities"]>;

interface PendingPermission {
  readonly request: RequestPermissionRequest;
  readonly resolve: (response: RequestPermissionResponse) => void;
}

/** What a harness needs to know to launch itself for one adapter. */
export interface AcpPosture {
  readonly readOnlyProbe: boolean;
  readonly unrestricted: boolean;
  /** The session carries the team bridge, so it needs the team instructions. */
  readonly team: boolean;
}

export interface AcpLaunch {
  /** Arguments after the executable that start the ACP server on stdio. */
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  /**
   * The harness put the team instructions into its own system prompt, where
   * they survive compaction and resume. Otherwise they lead the first prompt.
   */
  readonly systemInstructions: boolean;
  /**
   * The session mode (ACP category `mode`) this posture runs in. A harness that
   * restores the mode a saved session last ran in would otherwise resume a
   * restricted agent with the permissions it had before, so every new, resumed,
   * or loaded session that reports another mode is set to this one.
   */
  readonly sessionMode?: string;
}

/** One-shot commands a harness may run beside its ACP server. */
export interface AcpCatalogContext {
  readonly project: ProjectContext;
  readonly command: (...args: string[]) => [string, ...string[]];
  readonly timeoutMs: number;
}

/**
 * The parts of an ACP harness that differ from one to the next.
 *
 * The protocol is shared, so sessions, prompts, permissions, and streaming are
 * handled once by `AcpAdapter`. A harness only says how it is launched, how it
 * takes the team instructions, and whether it has a better model catalog than
 * the session's own `model` option.
 */
export interface AcpHarness {
  /** A harness may carry user questions on the permission wire. Classify before auto-allow. */
  permissionQuestion?(request: RequestPermissionRequest): {
    readonly fields: readonly QuestionField[];
    readonly respond: (response: QuestionResponse) => RequestPermissionResponse;
  } | null;
  /** How the harness names itself in transcript rows and errors. */
  readonly name: string;
  readonly defaultAgent: AgentId;
  launch(project: ProjectContext, posture: AcpPosture): AcpLaunch;
  discoverModels?(context: AcpCatalogContext): Promise<readonly AgentModelOption[]>;
  /**
   * The client request the harness sends at its tool boundaries to collect
   * input queued while it works. Watari answers it with team mail, which the
   * model then reads inside the turn it is already running instead of in a new
   * one. A harness without it takes mail only when its prompt completes.
   */
  readonly midTurnInbox?: string;
  /**
   * The request that asks a working harness to collect queued input at once,
   * even in the middle of a response, instead of at its next tool run. It
   * answers by sending its `midTurnInbox` request with `userInputOnly`.
   */
  readonly midTurnSendNow?: string;
}

export interface AcpAdapterOptions {
  readonly executable: string;
  readonly agent?: AgentId;
  readonly model?: string;
  readonly effort?: ReasoningEffort;
  /** Prefix used by deterministic fakes. Real launches use the executable. */
  readonly commandPrefix?: readonly [string, ...string[]];
  readonly requestTimeoutMs?: number;
  readonly readOnlyProbe?: boolean;
  readonly unrestricted?: boolean;
  readonly teamMcpCommand?: TeamMcpCommand;
  readonly teamMcpEnv?: TeamMcpEnvironment;
  /** Where team mail comes from when the harness asks for it mid-turn. */
  readonly boundaryInbox?: BoundaryInbox;
}

/**
 * A contained client for any harness that serves the Agent Client Protocol
 * over stdio. Transport startup is eager, while session creation stays lazy.
 */
export class AcpAdapter implements AgentAdapter {
  readonly #questions: QuestionQueue;
  readonly #harness: AcpHarness;
  readonly #agent: AgentId;
  readonly #executable: string;
  readonly #model: string | null;
  readonly #effort: ReasoningEffort | null;
  readonly #commandPrefix: readonly [string, ...string[]] | null;
  readonly #requestTimeoutMs: number;
  readonly #readOnlyProbe: boolean;
  readonly #unrestricted: boolean;
  readonly #teamMcpCommand: TeamMcpCommand | null;
  readonly #teamMcpEnv: TeamMcpEnvironment | undefined;
  readonly #boundaryInbox: BoundaryInbox | null;
  readonly #events;
  readonly #permissions = new Map<string, PendingPermission>();
  /** Input the harness has not taken yet: the next prompt, unless taken mid-turn. */
  readonly #messageQueue: string[] = [];
  /** The user stopped the turn, so queued input waits for the next message. */
  #held = false;
  #process: ManagedProcess | null = null;
  #connection: ClientSideConnection | null = null;
  #project: ProjectContext | null = null;
  #agentCapabilities: AcpAgentCapabilities = {};
  #systemInstructions = false;
  #sessionMode: string | null = null;
  #sessionId: string | null = null;
  #sessionPromise: Promise<string> | null = null;
  #configOptions: readonly SessionConfigOption[] = [];
  #turnTask: Promise<void> | null = null;
  #inputController: ReadableStreamDefaultController<WireMessage> | null = null;
  #instructionsSent = false;
  #stopping = false;
  #terminalErrorEmitted = false;
  /**
   * Some harnesses stream text without a message id. Every chunk would then
   * share one transcript row for the whole session, so a run of chunks of one
   * kind is given its own id, and anything else in between starts a new one.
   */
  #chunkRun: { readonly kind: "assistant" | "reasoning"; readonly id: string } | null = null;
  #chunkRuns = 0;

  constructor(harness: AcpHarness, options: AcpAdapterOptions) {
    this.#harness = harness;
    this.#agent = options.agent ?? harness.defaultAgent;
    this.#executable = options.executable;
    this.#model = options.model ?? null;
    this.#effort = options.effort ?? null;
    this.#commandPrefix = options.commandPrefix ?? null;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
    this.#readOnlyProbe = options.readOnlyProbe ?? false;
    this.#unrestricted = options.unrestricted ?? false;
    this.#teamMcpCommand = options.teamMcpCommand ?? null;
    this.#teamMcpEnv = options.teamMcpEnv;
    this.#boundaryInbox = options.boundaryInbox ?? null;
    this.#events = createAgentEventQueue(this.#agent);
    this.#questions = new QuestionQueue(this.#agent, (event) => this.#events.push(event));
  }

  get sessionId(): string | null {
    return this.#sessionId;
  }

  capabilities(): AgentCapabilities {
    return {
      structuredReasoningEvents: true,
      toolEvents: true,
      diffEvents: true,
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
    const name = this.#harness.name;
    if (this.#process) throw new Error(`${name} adapter is already started`);
    this.#project = project;
    const launch = this.#harness.launch(project, {
      readOnlyProbe: this.#readOnlyProbe,
      unrestricted: this.#unrestricted,
      team: this.#teamMcpCommand !== null,
    });
    this.#systemInstructions = launch.systemInstructions;
    this.#sessionMode = launch.sessionMode ?? null;

    const readable = new ReadableStream<WireMessage>({
      start: (controller) => {
        this.#inputController = controller;
      },
    });
    let process: ManagedProcess | null = null;
    const writable = new WritableStream<WireMessage>({
      write: (message) => {
        if (!process) throw new Error(`${name} ACP transport is not started`);
        process.writeJson(message);
      },
    });
    const stream: Stream = { readable, writable };
    this.#connection = new ClientSideConnection(() => this.#client(), stream);

    process = ManagedProcess.start({
      command: this.#command(...launch.args),
      cwd: project.launchDirectory,
      env: launch.env,
      onJsonLine: (line) => {
        if (!line.ok) {
          this.#emit("warning", line.error, { rawType: "malformed_jsonl" });
          return;
        }
        this.#inputController?.enqueue(line.value as WireMessage);
      },
      onDiagnostic: (message) => {
        if (message) this.#emit("warning", message, { rawType: "provider_stderr" });
      },
      onTransportError: (error) => this.#transportError(error),
    });
    this.#process = process;
    void this.#watchExit(process);

    const response = await withTimeout(
      this.#connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { elicitation: { form: {} } },
        clientInfo: { name: "watari", version: "0.1.0" },
      }),
      this.#requestTimeoutMs,
      `${name} ACP initialize`,
    );
    this.#agentCapabilities = response.agentCapabilities ?? {};
    const agentName = response.agentInfo?.title ?? response.agentInfo?.name ?? name;
    const version = response.agentInfo?.version ? ` ${response.agentInfo.version}` : "";
    this.#emit("status", `${agentName}${version} ACP initialized`, {
      rawType: "initialize",
      payload: response,
    });
  }

  /** Creates the ACP session and identity-bound MCP bridge, but starts no turn. */
  async prepare(): Promise<void> {
    await this.#ensureSession();
  }

  /**
   * The harness's own catalog. A harness without a dedicated catalog command
   * answers through the session's `model` option, which costs a session but
   * no model turn.
   */
  async availableModels(): Promise<readonly AgentModelOption[]> {
    const project = this.#requiredProject();
    if (this.#harness.discoverModels) {
      return await this.#harness.discoverModels({
        project,
        command: (...args) => this.#command(...args),
        timeoutMs: this.#requestTimeoutMs,
      });
    }
    await this.#ensureSession();
    const models = sessionModels(this.#configOptions);
    if (models.length === 0) {
      throw new Error(`${this.#harness.name} did not report any configured models`);
    }
    return models;
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
    await this.#ensureSession();
    this.#messageQueue.push(input.text);
    this.#held = false;
    // A harness that takes input mid-turn is asked to take it now, rather
    // than after a turn that may run for half an hour.
    if (this.#turnTask) void this.#requestSendNow();
    this.#startMessagePump();
  }

  events(): AsyncIterable<AgentEvent> {
    return this.#events;
  }

  /**
   * Cancels the running prompt. Input queued behind it is kept, but it waits
   * for the next message: a stop that started the next prompt the moment the
   * cancelled one ended did not stop anything.
   */
  async interrupt(): Promise<void> {
    this.#questions.cancelAll();
    if (!this.#sessionId) return;
    this.#held = true;
    this.#cancelPendingPermissions();
    await this.#requiredConnection().cancel({ sessionId: this.#sessionId });
  }

  /**
   * Continues a saved session with the bridge this service launched. `resume`
   * reattaches without replaying anything. `session/load` replays the history
   * first, which arrives before this session id is recorded and so never
   * reaches the transcript a second time.
   */
  async resume(sessionId: string): Promise<void> {
    const name = this.#harness.name;
    if (this.#sessionId) throw new Error(`${name} session is already active`);
    const project = this.#requiredProject();
    const params = { sessionId, cwd: project.launchDirectory, mcpServers: this.#mcpServers() };
    const connection = this.#requiredConnection();
    let options: readonly SessionConfigOption[];
    if (this.#agentCapabilities.sessionCapabilities?.resume) {
      const response = await withTimeout(connection.resumeSession(params), this.#requestTimeoutMs, `${name} session resume`);
      options = response.configOptions ?? [];
    } else if (this.#agentCapabilities.loadSession) {
      const response = await withTimeout(connection.loadSession(params), this.#requestTimeoutMs, `${name} session load`);
      options = response.configOptions ?? [];
    } else {
      throw new Error(`${name} cannot resume a saved session`);
    }
    this.#sessionId = sessionId;
    // The conversation already holds the instructions from its first prompt.
    this.#instructionsSent = true;
    await this.#applyProfile(options);
    this.#emit("session", `Resumed ${name} session ${sessionId}${this.#profileNote()}`, {
      rawType: "session/resume",
      providerEventId: sessionId,
    });
  }

  async resetSession(): Promise<void> {
    const name = this.#harness.name;
    this.#messageQueue.length = 0;
    this.#cancelPendingPermissions();
    const sessionId = this.#sessionId;
    if (!sessionId) {
      this.#instructionsSent = false;
      return;
    }
    await withTimeout(this.interrupt(), SHUTDOWN_TIMEOUT_MS, `${name} interrupt`).catch(() => undefined);
    if (this.#turnTask) {
      await withTimeout(this.#turnTask, this.#requestTimeoutMs, `${name} turn cancellation`).catch((error) => {
        this.#emit("warning", errorMessage(error), { rawType: "session/cancel" });
      });
    }
    // Closing is a courtesy an unresponsive ACP peer must not be able to hold
    // open, and only harnesses that advertise it understand it. The session
    // itself stays in the harness's history, like a Claude or Codex
    // conversation, rather than being deleted.
    if (this.#agentCapabilities.sessionCapabilities?.close) {
      await withTimeout(
        this.#requiredConnection().closeSession({ sessionId }),
        SHUTDOWN_TIMEOUT_MS,
        `${name} session close`,
      ).catch(() => undefined);
    }
    this.#sessionId = null;
    this.#sessionPromise = null;
    this.#configOptions = [];
    this.#instructionsSent = false;
    this.#chunkRun = null;
    this.#held = false;
  }

  /**
   * Ends the harness and keeps its conversation, so the next start resumes
   * it. Stopping used to delete the session, which cost this agent its memory
   * on every service restart while Claude and Codex kept theirs.
   */
  async stop(): Promise<void> {
    this.#questions.cancelAll();
    if (this.#stopping) return;
    this.#stopping = true;
    this.#messageQueue.length = 0;
    this.#cancelPendingPermissions();
    const process = this.#process;
    this.#process = null;
    if (process) await process.stop();
    this.#closeInput();
    this.#events.close();
  }

  #client(): Client {
    return {
      unstable_createElicitation: async (request) => {
        try {
          if (request.mode !== "form" || this.#readOnlyProbe || !("sessionId" in request) || request.sessionId !== this.#sessionId) throw new Error("unsupported input form");
          const form = compileQuestionForm(request.requestedSchema, request.message);
          const response = await this.#questions.ask(form.fields, undefined, form.decode);
          return response.action === "answer" ? { action: "accept", content: form.decode(response.answers) } : { action: "cancel" };
        } catch {
          this.#emit("warning", `${this.#harness.name} input form declined: unsupported or secure form`, { rawType: "question_unsupported" });
          return { action: "decline" };
        }
      },
      requestPermission: async (request) => await this.#requestPermission(request),
      sessionUpdate: async (notification) => {
        this.#handleSessionUpdate(notification);
      },
      // Harness extensions (`qwen/notify/...`, `_opencode/...`) describe the
      // harness's own UI. Nothing in them is team state, and rejecting them
      // only filled the harness's stderr with protocol errors.
      extNotification: async () => undefined,
      extMethod: async (method, params) => {
        if (method === this.#harness.midTurnInbox && !this.#readOnlyProbe) {
          return await this.#drainMidTurn(params);
        }
        throw RequestError.methodNotFound(method);
      },
    };
  }

  /**
   * Hands a working harness what is waiting for it: input sent since its
   * prompt started, then team mail. A send-now pull asks for user input only,
   * since it cuts into a response, while the pull after a tool run takes
   * both. Whatever is taken here never becomes a prompt of its own.
   */
  async #drainMidTurn(
    params: Record<string, unknown>,
  ): Promise<{ readonly messages: string[]; readonly hasQueuedPrompt: boolean }> {
    if (this.#stopping || this.#held || !this.#sessionId || params.sessionId !== this.#sessionId) {
      return { messages: [], hasQueuedPrompt: this.#messageQueue.length > 0 };
    }
    const messages = this.#messageQueue.splice(0);
    if (messages.length > 0) {
      this.#emit("status", `${this.#harness.name} took ${plural(messages.length, "queued message")} inside its turn`, {
        rawType: "mid_turn_input",
      });
    }
    if (params.userInputOnly !== true && this.#boundaryInbox) {
      const mail = await this.#boundaryInbox.atToolBoundary();
      if (mail) messages.push(mail);
    }
    return { messages, hasQueuedPrompt: this.#messageQueue.length > 0 };
  }

  /**
   * Asks the harness to collect queued input now. A harness that does not
   * know the request takes it after its next tool run, or as the next prompt.
   */
  async #requestSendNow(): Promise<void> {
    const method = this.#harness.midTurnSendNow;
    const sessionId = this.#sessionId;
    if (!method || !sessionId || this.#readOnlyProbe) return;
    await withTimeout(
      this.#requiredConnection().extMethod(method, { sessionId }),
      SHUTDOWN_TIMEOUT_MS,
      `${this.#harness.name} send-now`,
    ).catch(() => undefined);
  }

  async #requestPermission(request: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    try {
      const question = this.#harness.permissionQuestion?.(request);
      if (question) {
        if (this.#readOnlyProbe || request.sessionId !== this.#sessionId) return { outcome: { outcome: "cancelled" } };
        return question.respond(await this.#questions.ask(question.fields));
      }
    } catch {
      this.#emit("warning", `${this.#harness.name} question cancelled: unsupported or invalid form`, { rawType: "question_unsupported" });
      return { outcome: { outcome: "cancelled" } };
    }
    if (this.#unrestricted && !this.#readOnlyProbe) {
      const allowed = request.options.find((option) => option.kind === "allow_always")
        ?? request.options.find((option) => option.kind === "allow_once");
      return allowed
        ? { outcome: { outcome: "selected", optionId: allowed.optionId } }
        : { outcome: { outcome: "cancelled" } };
    }

    const requestId = request.toolCall.toolCallId;
    if (this.#permissions.has(requestId)) {
      return { outcome: { outcome: "cancelled" } };
    }
    this.#emit("approval", request.toolCall.title ?? `${this.#harness.name} requests approval`, {
      rawType: "session/request_permission",
      providerEventId: requestId,
      payload: request,
    });
    return await new Promise<RequestPermissionResponse>((resolve) => {
      this.#permissions.set(requestId, { request, resolve });
    });
  }

  #respondToApproval(
    requestId: string | number,
    decision: "accept" | "decline" | "cancel",
  ): void {
    const key = String(requestId);
    const pending = this.#permissions.get(key);
    if (!pending) throw new Error(`unknown ${this.#harness.name} approval request: ${key}`);
    this.#permissions.delete(key);
    if (decision === "cancel") {
      pending.resolve({ outcome: { outcome: "cancelled" } });
      return;
    }
    const kinds = decision === "accept"
      ? ["allow_once", "allow_always"]
      : ["reject_once", "reject_always"];
    const option = pending.request.options.find((candidate) => kinds.includes(candidate.kind));
    pending.resolve(option
      ? { outcome: { outcome: "selected", optionId: option.optionId } }
      : { outcome: { outcome: "cancelled" } });
  }

  #cancelPendingPermissions(): void {
    this.#questions.cancelAll();
    for (const pending of this.#permissions.values()) {
      pending.resolve({ outcome: { outcome: "cancelled" } });
    }
    this.#permissions.clear();
  }

  async #ensureSession(): Promise<string> {
    if (this.#sessionId) return this.#sessionId;
    if (this.#sessionPromise) return await this.#sessionPromise;
    const name = this.#harness.name;
    const project = this.#requiredProject();
    const creating = (async () => {
      const response = await withTimeout(
        this.#requiredConnection().newSession({
          cwd: project.launchDirectory,
          mcpServers: this.#mcpServers(),
        }),
        this.#requestTimeoutMs,
        `${name} session creation`,
      );
      this.#sessionId = response.sessionId;
      await this.#applyProfile(response.configOptions ?? []);
      this.#emit("session", `Started ${name} session ${response.sessionId}${this.#profileNote()}`, {
        rawType: "session/new",
        providerEventId: response.sessionId,
        payload: response,
      });
      return response.sessionId;
    })();
    this.#sessionPromise = creating;
    try {
      return await creating;
    } finally {
      this.#sessionPromise = null;
    }
  }

  /**
   * Puts the session in the posture's mode, then selects the configured model
   * and effort through the session's own config options. Harnesses name the
   * effort option differently (`effort`, `reasoning_effort`), so options are
   * found by their ACP category.
   */
  async #applyProfile(initialOptions: readonly SessionConfigOption[]): Promise<void> {
    const sessionId = this.#sessionId;
    if (!sessionId) throw new Error(`${this.#harness.name} session was not created`);
    this.#configOptions = initialOptions;
    const mode = this.#configOptions.find((option) => option.category === "mode")
      ?? this.#configOptions.find((option) => option.id === "mode");
    if (this.#sessionMode && mode?.type === "select" && mode.currentValue !== this.#sessionMode) {
      const response = await this.#requiredConnection().setSessionConfigOption({
        sessionId,
        configId: mode.id,
        value: this.#sessionMode,
      });
      this.#configOptions = response.configOptions;
    }
    if (this.#model) {
      const option = this.#requireChoice("model", this.#model);
      const response = await this.#requiredConnection().setSessionConfigOption({
        sessionId,
        configId: option.id,
        value: this.#model,
      });
      this.#configOptions = response.configOptions;
    }
    if (this.#effort) {
      const option = this.#requireChoice("thought_level", this.#effort);
      const response = await this.#requiredConnection().setSessionConfigOption({
        sessionId,
        configId: option.id,
        value: this.#effort,
      });
      this.#configOptions = response.configOptions;
    }
  }

  /**
   * What the session actually runs, as the harness reports it: a provider
   * default in the roster says nothing about which model that turned out to be.
   */
  #profileNote(): string {
    const current = (option: SessionConfigOption | undefined): string | null =>
      option?.type === "select" && typeof option.currentValue === "string" ? option.currentValue : null;
    const model = current(configOption(this.#configOptions, "model"));
    const effort = current(configOption(this.#configOptions, "thought_level"));
    const mode = current(this.#configOptions.find((option) => option.category === "mode"));
    const parts = [model, effort ? `effort ${effort}` : null, mode ? `mode ${mode}` : null]
      .filter((part): part is string => part !== null);
    return parts.length > 0 ? ` (${parts.join(", ")})` : "";
  }

  #requireChoice(category: "model" | "thought_level", value: string): SessionConfigOption {
    const label = category === "model" ? "model" : "effort";
    const option = configOption(this.#configOptions, category);
    if (!option || option.type !== "select") {
      throw new Error(`${this.#harness.name} did not expose the ${label} configuration option`);
    }
    if (!selectChoices(option).some((choice) => choice.value === value)) {
      throw new Error(`${this.#harness.name} does not support ${label} ${value}`);
    }
    return option;
  }

  #startMessagePump(): void {
    if (this.#turnTask) return;
    const task = this.#drainMessages();
    this.#turnTask = task.finally(() => {
      this.#turnTask = null;
      if (this.#messageQueue.length > 0 && !this.#stopping && !this.#held) this.#startMessagePump();
    });
  }

  async #drainMessages(): Promise<void> {
    const name = this.#harness.name;
    while (this.#messageQueue.length > 0 && !this.#stopping && !this.#held) {
      // Everything that arrived while the last prompt ran goes in as one
      // prompt rather than one turn each.
      const text = this.#messageQueue.splice(0).join("\n\n");
      const sessionId = this.#sessionId;
      if (!text || !sessionId) return;
      const lead = this.#teamMcpCommand !== null && !this.#systemInstructions && !this.#instructionsSent;
      const prompt = lead ? `${TEAM_INSTRUCTIONS}\n\n[WATARI MANAGED MESSAGE]\n${text}` : text;
      this.#instructionsSent = true;
      this.#chunkRun = null;
      this.#emit("status", `${name} turn started`, { rawType: "session/prompt" });
      try {
        const response = await this.#requiredConnection().prompt({
          sessionId,
          prompt: [{ type: "text", text: prompt }],
        });
        if (response.usage) {
          this.#emit("usage", `${name} usage updated`, {
            rawType: "session/prompt/usage",
            payload: response.usage,
          });
        }
        this.#emit("status", `${name} turn completed (${response.stopReason})`, {
          rawType: "session/prompt/completed",
          payload: response,
        });
      } catch (error) {
        this.#messageQueue.length = 0;
        this.#emit("error", `${name} prompt failed: ${errorMessage(error)}`, {
          rawType: "session/prompt/error",
        });
      }
    }
  }

  #handleSessionUpdate(notification: SessionNotification): void {
    if (notification.sessionId !== this.#sessionId) return;
    const name = this.#harness.name;
    const update = notification.update;
    const payload = redactUnknown(notification);
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
      case "agent_thought_chunk": {
        if (update.content.type !== "text") return;
        const kind = update.sessionUpdate === "agent_message_chunk" ? "assistant" : "reasoning";
        this.#emit(kind, update.content.text, {
          rawType: `session/update/${update.sessionUpdate}`,
          providerEventId: update.messageId ?? this.#chunkRunId(kind),
          payload,
        });
        return;
      }
      case "tool_call":
        this.#chunkRun = null;
        this.#emit("tool_start", toolSummary(update.title, update.kind), {
          rawType: "session/update/tool_call",
          providerEventId: update.toolCallId,
          payload,
        });
        return;
      case "tool_call_update": {
        this.#chunkRun = null;
        const summary = toolSummary(update.title ?? "tool", update.kind ?? undefined);
        const kind = update.status === "completed" || update.status === "failed"
          ? "tool_end"
          : "tool_output";
        this.#emit(kind, update.status === "failed" ? `${summary} failed` : summary, {
          rawType: "session/update/tool_call_update",
          providerEventId: update.toolCallId,
          payload,
        });
        return;
      }
      case "config_option_update":
        this.#configOptions = update.configOptions;
        return;
      // Echoes of the prompt Watari sent, and the harness's own slash-command
      // and mode menus, which no team member reads.
      case "user_message_chunk":
      case "available_commands_update":
      case "current_mode_update":
      case "session_info_update":
        return;
      case "usage_update":
        this.#emit("usage", `${name} usage updated`, {
          rawType: "session/update/usage",
          payload,
        });
        return;
      case "plan":
        this.#emit("status", `${name} plan updated`, {
          rawType: "session/update/plan",
          payload,
        });
        return;
      default: {
        const kind = String((update as { readonly sessionUpdate: unknown }).sessionUpdate);
        this.#emit("status", `${name} ${kind.replaceAll("_", " ")}`, {
          rawType: `session/update/${kind}`,
          payload,
        });
      }
    }
  }

  #chunkRunId(kind: "assistant" | "reasoning"): string {
    if (this.#chunkRun?.kind !== kind) {
      this.#chunkRuns += 1;
      this.#chunkRun = { kind, id: `${this.#sessionId ?? "session"}:${kind}:${this.#chunkRuns}` };
    }
    return this.#chunkRun.id;
  }

  #mcpServers() {
    return this.#teamMcpCommand ? [acpTeamMcpConfig(this.#teamMcpCommand, this.#teamMcpEnv)] : [];
  }

  #command(...args: string[]): [string, ...string[]] {
    return [...(this.#commandPrefix ?? [this.#executable]), ...args] as [string, ...string[]];
  }

  #requiredProject(): ProjectContext {
    if (!this.#project) throw new Error(`${this.#harness.name} adapter is not started`);
    return this.#project;
  }

  #requiredConnection(): ClientSideConnection {
    if (!this.#connection) throw new Error(`${this.#harness.name} ACP connection is not started`);
    return this.#connection;
  }

  async #watchExit(process: ManagedProcess): Promise<void> {
    const exitCode = await process.exited;
    this.#closeInput();
    if (this.#stopping) return;
    this.#terminalError(`${this.#harness.name} ACP process exited unexpectedly with code ${exitCode}`);
    this.#events.close();
  }

  #transportError(error: Error): void {
    this.#questions.cancelAll();
    if (this.#stopping) return;
    this.#terminalError(`${this.#harness.name} ACP transport failed: ${errorMessage(error)}`);
  }

  #terminalError(summary: string): void {
    this.#questions.cancelAll();
    if (this.#terminalErrorEmitted) return;
    this.#terminalErrorEmitted = true;
    this.#emit("error", summary, { rawType: "transport_error" });
  }

  #closeInput(): void {
    const controller = this.#inputController;
    this.#inputController = null;
    if (controller) controller.close();
  }

  #emit(
    kind: AgentEvent["kind"],
    summary: string,
    options: Pick<AgentEvent, "rawType" | "providerEventId" | "payload"> = {},
  ): void {
    this.#events.push({
      agent: this.#agent,
      kind,
      timestamp: Date.now(),
      summary: redactSummary(summary),
      ...options,
      ...(options.payload === undefined ? {} : { payload: redactUnknown(options.payload) }),
    });
  }
}

/** Finds a session option by its ACP category, falling back to known ids. */
function configOption(
  options: readonly SessionConfigOption[],
  category: "model" | "thought_level",
): SessionConfigOption | undefined {
  const ids = category === "model" ? ["model"] : ["effort", "reasoning_effort", "thought_level"];
  return options.find((option) => option.category === category)
    ?? options.find((option) => ids.includes(option.id));
}

interface SelectChoice {
  readonly value: string;
  readonly name: string;
  readonly description?: string | null;
}

function selectChoices(option: SessionConfigOption): readonly SelectChoice[] {
  if (option.type !== "select") return [];
  return option.options.flatMap((entry) => "options" in entry ? entry.options : [entry]);
}

/**
 * The models a session offers, with the efforts it offers beside them. A
 * `default` effort is the harness's own choice, which Watari already offers as
 * "provider default", so it is not listed twice.
 */
export function sessionModels(options: readonly SessionConfigOption[]): AgentModelOption[] {
  const model = configOption(options, "model");
  if (!model || model.type !== "select") return [];
  const effort = configOption(options, "thought_level");
  const efforts = effort
    ? selectChoices(effort).map((choice) => choice.value).filter((value) => value !== "default")
    : [];
  return selectChoices(model).map((choice) => ({
    id: choice.value,
    displayName: choice.name || choice.value,
    description: choice.description?.trim() || choice.name || choice.value,
    efforts,
    ...(choice.value === model.currentValue ? { isDefault: true } : {}),
  }));
}

function toolSummary(title: string, kind: string | undefined): string {
  const cleanTitle = title.trim();
  if (!kind || cleanTitle.toLowerCase().startsWith(kind.toLowerCase())) return cleanTitle || "tool";
  return `${kind}  ${cleanTitle}`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function errorMessage(error: unknown): string {
  return redactSummary(error instanceof Error ? error.message : String(error));
}

export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
