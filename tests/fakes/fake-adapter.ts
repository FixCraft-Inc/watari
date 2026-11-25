import type {
  AgentAdapter,
  AgentCapabilities,
  AgentEvent,
  AgentId,
  AgentInput,
  ProjectContext,
} from "../../src/watari/models.ts";
import { createAgentEventQueue } from "../../src/watari/util/event-queue.ts";

export class FakeAdapter implements AgentAdapter {
  readonly id: AgentId;
  readonly inputs: AgentInput[] = [];
  modelOptions: import("../../src/watari/models.ts").AgentModelOption[] = [];
  readonly #events;
  startedIn: ProjectContext | null = null;
  resumedSession: string | null = null;
  /** The provider's conversation id, as a real adapter reports it. */
  sessionId: string | null = null;
  /** Set to make resume() fail, standing in for a conversation the provider lost. */
  resumeError: Error | null = null;
  prepared = 0;
  resets = 0;
  interrupts = 0;
  safeSteer = true;
  /** Set to make start() or stop() hang, standing in for a wedged harness. */
  hangOnStart = false;
  hangOnStop = false;

  constructor(id: AgentId) {
    this.id = id;
    this.#events = createAgentEventQueue(id);
  }

  async start(project: ProjectContext): Promise<void> {
    this.startedIn = project;
    if (this.hangOnStart) await new Promise<void>(() => undefined);
  }

  /** Set to make the next send fail once, standing in for a refused handover. */
  sendError: Error | null = null;

  async send(input: AgentInput): Promise<void> {
    if (this.sendError) {
      const error = this.sendError;
      this.sendError = null;
      throw error;
    }
    this.inputs.push(input);
  }

  async prepare(): Promise<void> {
    this.prepared += 1;
  }

  async resetSession(): Promise<void> {
    this.resets += 1;
    this.resumedSession = null;
  }

  async interrupt(): Promise<void> {
    this.interrupts += 1;
  }

  async availableModels(): Promise<readonly import("../../src/watari/models.ts").AgentModelOption[]> {
    return this.modelOptions;
  }

  events(): AsyncIterable<AgentEvent> {
    return this.#events;
  }

  emit(
    kind: AgentEvent["kind"],
    summary: string,
    extras: Omit<Partial<AgentEvent>, "agent" | "kind" | "summary" | "timestamp"> & {
      readonly timestamp?: number;
    } = {},
  ): void {
    this.#events.push({ agent: this.id, kind, summary, timestamp: Date.now(), ...extras });
  }

  disconnect(): void {
    this.#events.close();
  }

  async stop(): Promise<void> {
    if (this.hangOnStop) await new Promise<void>(() => undefined);
    this.#events.close();
  }

  async resume(sessionId: string): Promise<void> {
    if (this.resumeError) throw this.resumeError;
    this.resumedSession = sessionId;
    this.sessionId = sessionId;
  }

  capabilities(): AgentCapabilities {
    return {
      structuredReasoningEvents: true,
      toolEvents: true,
      diffEvents: true,
      approvals: true,
      interrupt: true,
      bidirectionalInput: true,
      safeSteer: this.safeSteer,
      resume: true,
      mcp: true,
      skills: true,
      nativeSession: true,
      usageMetadata: true,
    };
  }
}
