import type { AgentId, AgentModelOption } from "../models.ts";
import type { ProviderStatusDocument } from "../provider-status-api.ts";
import type { ActivityDetail } from "../activity/types.ts";
import { JsonLineDecoder } from "../process/jsonl.ts";
import type { BridgeStatus, RuntimeEvent, TeamSnapshot } from "../state/types.ts";
import type { ChatListEntry } from "../state/chat-library.ts";
import type { AgentDefinitionUpdate, SupportedProviderId } from "../team/roster.ts";
import type { ChatExportResult, ResumedChat } from "./runtime.ts";
import {
  ActivityDetailSchema,
  NegotiationResultSchema,
  SERVICE_API_VERSION,
  ServiceCommandSchema,
  ServiceEnvelopeSchema,
  ServiceInfoSchema,
  TeamSnapshotSchema,
  type ServiceCommand,
  type ServiceEnvelope,
  type ServiceInfo,
} from "./protocol.ts";
import { JsonSocketWriter } from "./socket-writer.ts";

interface ClientState {
  readonly decoder: JsonLineDecoder;
  readonly writer: JsonSocketWriter;
}

interface PendingResponse {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

/**
 * The Unix socket accepted a connection, but the peer could not complete the
 * local API handshake. Callers must not treat this like an absent service and
 * start a second daemon over the same project state.
 */
export class ServiceProtocolError extends Error {
  readonly socketPath: string;

  constructor(socketPath: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(
      `a Watari service answered at ${socketPath}, but local API v${SERVICE_API_VERSION} ` +
        `negotiation failed: ${detail}. Stop or upgrade the running service before starting another one`,
      { cause },
    );
    this.name = "ServiceProtocolError";
    this.socketPath = socketPath;
  }
}

export class RuntimeClient {
  readonly #socket: Bun.Socket<ClientState>;
  readonly #pending = new Map<string, PendingResponse>();
  readonly #listeners = new Set<(event: RuntimeEvent) => void>();
  #snapshot: TeamSnapshot | null = null;
  #requestId = 0;
  #closed = false;
  #closing = false;
  #fatalNotified = false;

  private constructor(socket: Bun.Socket<ClientState>) {
    this.#socket = socket;
  }

  static async connect(socketPath: string): Promise<RuntimeClient> {
    let client: RuntimeClient | null = null;
    const socket = await Bun.connect<ClientState>({
      unix: socketPath,
      data: { decoder: new JsonLineDecoder(), writer: null as unknown as JsonSocketWriter },
      socket: {
        open: (opened) => {
          opened.data = { decoder: new JsonLineDecoder(), writer: new JsonSocketWriter(opened) };
        },
        data: (opened, data) => {
          if (client) {
            client.#onData(opened, data);
          }
        },
        drain: (opened) => opened.data.writer.flush(),
        close: () => {
          if (client) {
            client.#onClose();
          }
        },
        error: () => {
          if (client) {
            client.#onClose();
          }
        },
      },
    });
    client = new RuntimeClient(socket);
    try {
      await client.#negotiate();
      return client;
    } catch (error) {
      client.close();
      throw new ServiceProtocolError(socketPath, error);
    }
  }

  get snapshot(): TeamSnapshot | null {
    return this.#snapshot;
  }

  subscribe(listener: (event: RuntimeEvent) => void): () => void {
    this.#listeners.add(listener);
    if (this.#snapshot) {
      listener({ type: "snapshot", snapshot: this.#snapshot });
    }
    return () => this.#listeners.delete(listener);
  }

  async refresh(): Promise<TeamSnapshot> {
    const value = await this.#request({ id: this.#nextId(), type: "snapshot" });
    const snapshot = TeamSnapshotSchema.parse(value) as TeamSnapshot;
    this.#snapshot = snapshot;
    return snapshot;
  }

  async info(): Promise<ServiceInfo> {
    return ServiceInfoSchema.parse(await this.#request({ id: this.#nextId(), type: "info" }));
  }

  async getActivityDetail(activityId: string): Promise<ActivityDetail | null> {
    const value = await this.#request({ id: this.#nextId(), type: "activity_detail", activityId });
    return ActivityDetailSchema.nullable().parse(value);
  }

  /**
   * Registers this connection as a UI. `keptRunningChat` says a fresh chat was
   * asked for but the current one was kept because its peers are still working.
   */
  async attachUi(fresh: boolean): Promise<{ readonly keptRunningChat: boolean }> {
    const value = await this.#request({ id: this.#nextId(), type: "ui_attach", fresh });
    return { keptRunningChat: isRecord(value) && value.keptRunningChat === true };
  }

  async callTeamTool(
    agent: AgentId,
    name: string,
    input: unknown,
  ): Promise<import("../team/tools.ts").TeamToolResult> {
    return (await this.#request({
      id: this.#nextId(),
      type: "team_tool",
      agent,
      name,
      input,
    })) as import("../team/tools.ts").TeamToolResult;
  }

  async send(target: "all" | AgentId, text: string): Promise<void> {
    await this.#request({ id: this.#nextId(), type: "send", target, text });
  }

  async interrupt(agent: AgentId): Promise<void> {
    await this.#request({ id: this.#nextId(), type: "interrupt", agent });
  }

  async approve(
    agent: AgentId,
    requestId: string | number,
    decision: "accept" | "decline" | "cancel",
  ): Promise<void> {
    await this.#request({ id: this.#nextId(), type: "approval", agent, requestId, decision });
  }

  async answerQuestion(agent: AgentId, requestId: string, response: import("../questions.ts").QuestionResponse): Promise<void> {
    await this.#request({ id: this.#nextId(), type: "question", agent, requestId, response });
  }

  async shutdown(): Promise<void> {
    await this.#request({ id: this.#nextId(), type: "shutdown" });
  }

  /** Re-runs the team bridge round trip for every peer and returns the result. */
  async checkBridges(): Promise<readonly BridgeStatus[]> {
    const value = await this.#request({ id: this.#nextId(), type: "check_bridges" });
    return Array.isArray(value) ? (value as BridgeStatus[]) : [];
  }

  async providerStatus(force = false): Promise<ProviderStatusDocument> {
    return await this.#request({ id: this.#nextId(), type: "provider_status", force }) as ProviderStatusDocument;
  }

  async registerBridge(agent: AgentId, provider: string, token?: string): Promise<void> {
    await this.#request({
      id: this.#nextId(),
      type: "bridge_connected",
      agent,
      provider,
      ...(token ? { token } : {}),
    });
  }

  async unregisterBridge(agent: AgentId): Promise<void> {
    await this.#request({ id: this.#nextId(), type: "bridge_disconnected", agent });
  }

  async configureAgent(definition: AgentDefinitionUpdate): Promise<void> {
    await this.#request({ id: this.#nextId(), type: "agent_configure", definition });
  }

  async removeAgent(agent: AgentId): Promise<void> {
    await this.#request({ id: this.#nextId(), type: "agent_remove", agent });
  }

  /** Starts a managed agent's native harness again with its current profile. */
  async restartAgent(agent: AgentId): Promise<void> {
    await this.#request({ id: this.#nextId(), type: "agent_restart", agent });
  }

  async availableModels(agent: AgentId): Promise<readonly AgentModelOption[]> {
    const value = await this.#request({ id: this.#nextId(), type: "model_list", agent });
    return Array.isArray(value) ? value as AgentModelOption[] : [];
  }

  async availableProviderModels(provider: SupportedProviderId): Promise<readonly AgentModelOption[]> {
    const value = await this.#request({ id: this.#nextId(), type: "provider_model_list", provider });
    return Array.isArray(value) ? value as AgentModelOption[] : [];
  }

  /** Makes one agent forget its provider conversation. The chat stays. */
  async clearAgent(agent: AgentId): Promise<void> {
    await this.#request({ id: this.#nextId(), type: "agent_clear", agent });
  }

  async listChats(): Promise<readonly ChatListEntry[]> {
    const value = await this.#request({ id: this.#nextId(), type: "chat_list" });
    return Array.isArray(value) ? value as ChatListEntry[] : [];
  }

  async resumeChat(chat: string): Promise<ResumedChat> {
    return await this.#request({ id: this.#nextId(), type: "chat_resume", chat }) as ResumedChat;
  }

  async saveChat(): Promise<{ readonly path: string }> {
    return await this.#request({ id: this.#nextId(), type: "chat_save" }) as { readonly path: string };
  }

  /** Writes the chat as Markdown, asking the agents for handoffs first when `handoff`. */
  async exportChat(options: { readonly path?: string; readonly handoff: boolean; readonly timeoutMs?: number }): Promise<ChatExportResult> {
    return await this.#request({
      id: this.#nextId(),
      type: "chat_export",
      handoff: options.handoff,
      ...(options.path ? { path: options.path } : {}),
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    }) as ChatExportResult;
  }

  async completeGoal(): Promise<void> {
    await this.#request({ id: this.#nextId(), type: "complete_goal" });
  }

  async newChat(): Promise<void> {
    await this.#request({ id: this.#nextId(), type: "new_chat" });
  }

  close(): void {
    if (this.#closed) return;
    this.#closing = true;
    this.#socket.end();
    this.#onClose();
  }

  #request(command: ServiceCommand): Promise<unknown> {
    if (this.#closed) {
      return Promise.reject(new Error("Watari service connection is closed"));
    }
    const response = new Promise<unknown>((resolve, reject) => {
      this.#pending.set(command.id, { resolve, reject });
    });
    try {
      this.#socket.data.writer.send(ServiceCommandSchema.parse(command));
    } catch (error) {
      this.#pending.delete(command.id);
      return Promise.reject(error);
    }
    return response;
  }

  #onData(socket: Bun.Socket<ClientState>, data: Buffer): void {
    let lines;
    try {
      lines = socket.data.decoder.push(data);
    } catch (error) {
      this.#notifyFatal(error instanceof Error ? error.message : String(error));
      socket.end();
      return;
    }
    for (const line of lines) {
      if (!line.ok) {
        this.#notifyFatal(line.error);
        continue;
      }
      const parsed = ServiceEnvelopeSchema.safeParse(line.value);
      if (!parsed.success) {
        this.#notifyFatal("Watari service sent an invalid envelope");
        continue;
      }
      this.#handleEnvelope(parsed.data as ServiceEnvelope);
    }
  }

  #handleEnvelope(envelope: ServiceEnvelope): void {
    if (envelope.type === "response") {
      const pending = this.#pending.get(envelope.id);
      if (!pending) {
        return;
      }
      this.#pending.delete(envelope.id);
      if (envelope.ok) {
        pending.resolve(envelope.value);
      } else {
        pending.reject(new Error(envelope.error));
      }
      return;
    }
    if (envelope.type === "fatal") {
      this.#notifyFatal(envelope.message);
      return;
    }
    if (envelope.type === "snapshot" || envelope.type === "state_changed") {
      this.#snapshot = envelope.snapshot;
    } else if (envelope.type === "transcript_upsert" && this.#snapshot) {
      this.#snapshot = {
        ...this.#snapshot,
        events: upsertById(this.#snapshot.events, envelope.event),
      };
    } else if (envelope.type === "activity_upsert" && this.#snapshot) {
      this.#snapshot = {
        ...this.#snapshot,
        activities: upsertById(this.#snapshot.activities, envelope.activity),
      };
    }
    this.#notify(envelope as RuntimeEvent);
  }

  #notify(event: RuntimeEvent): void {
    for (const listener of this.#listeners) {
      listener(event);
    }
  }

  #notifyFatal(message: string): void {
    if (this.#fatalNotified) return;
    this.#fatalNotified = true;
    this.#notify({ type: "fatal", message });
  }

  #onClose(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#snapshot = null;
    for (const pending of this.#pending.values()) {
      pending.reject(new Error("Watari service connection closed"));
    }
    this.#pending.clear();
    if (!this.#closing) {
      this.#notifyFatal("Watari service connection closed");
    }
  }

  #nextId(): string {
    this.#requestId += 1;
    return `${process.pid}-${this.#requestId}`;
  }

  async #negotiate(): Promise<void> {
    const value = await this.#request({
      id: this.#nextId(),
      type: "negotiate",
      versions: [SERVICE_API_VERSION],
    });
    NegotiationResultSchema.parse(value);
  }
}

function upsertById<T extends { readonly id: string | number }>(
  values: readonly T[],
  value: T,
): readonly T[] {
  const index = values.findIndex((existing) => existing.id === value.id);
  if (index < 0) return [...values, value];
  const next = [...values];
  next[index] = value;
  return next;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
