import { connect, type Socket } from "node:net";

import {
  API_VERSION,
  isResponse,
  type ActivityDetail,
  type RuntimeEvent,
  type ServiceEnvelope,
  type TeamSnapshot,
} from "./protocol.js";
import {
  parseActivityDetail,
  parseNegotiation,
  parseServiceEnvelope,
  parseTeamSnapshot,
} from "./validation.js";

/** Enough to stop a runaway service from growing this process without bound.
 * The service applies its own 8 MiB cap in the other direction. */
const MAX_BUFFERED_BYTES = 16 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;

export type ConnectionState = "connecting" | "ready" | "closed";

export interface ClientEvents {
  readonly onEvent: (event: RuntimeEvent) => void;
  readonly onClose: (reason: string) => void;
}

interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

/**
 * A Watari local API client for the extension host.
 *
 * Watari's own client is a Bun program, so this is a second implementation of
 * the same conversation rather than a port. Two details of the wire protocol
 * are easy to get wrong and are handled here rather than by callers: `negotiate`
 * must be the first command on the socket, and its acknowledgement is followed
 * by an unsolicited snapshot — so replies are correlated by request id and
 * everything else is delivered as an event.
 */
export class WatariClient {
  readonly #socket: Socket;
  readonly #events: ClientEvents;
  readonly #pending = new Map<string, Pending>();
  #buffer = "";
  #requestId = 0;
  #snapshot: TeamSnapshot | null = null;
  #closed = false;
  #closing = false;

  private constructor(socket: Socket, events: ClientEvents) {
    this.#socket = socket;
    this.#events = events;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.#onData(chunk));
    socket.on("close", () => this.#onClose("The Watari service closed the connection."));
    socket.on("error", (error: Error) => this.#onClose(error.message));
  }

  static async connect(
    socketPath: string,
    events: ClientEvents,
    signal?: AbortSignal,
  ): Promise<WatariClient> {
    const socket = await new Promise<Socket>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error("Cancelled while connecting to the Watari service."));
        return;
      }
      const pending = connect(socketPath);
      const onAbort = (): void => {
        pending.destroy();
        reject(new Error("Cancelled while connecting to the Watari service."));
      };
      const onError = (error: Error): void => {
        signal?.removeEventListener("abort", onAbort);
        pending.destroy();
        reject(error);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      pending.once("error", onError);
      pending.once("connect", () => {
        pending.off("error", onError);
        signal?.removeEventListener("abort", onAbort);
        resolve(pending);
      });
    });

    const client = new WatariClient(socket, events);
    const onAbort = (): void => client.close();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const negotiated = parseNegotiation(await client.#request({
        type: "negotiate",
        versions: [API_VERSION],
      }));
      if (negotiated !== API_VERSION) {
        throw new Error(
          `This Watari service speaks API v${String(negotiated)}, and the extension ` +
            `speaks v${API_VERSION}. Update whichever is older.`,
        );
      }
      if (signal?.aborted) throw new Error("Cancelled while connecting to the Watari service.");
      return client;
    } catch (error) {
      client.close();
      throw error;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  get snapshot(): TeamSnapshot | null {
    return this.#snapshot;
  }

  async refresh(): Promise<TeamSnapshot> {
    const snapshot = parseTeamSnapshot(await this.#request({ type: "snapshot" }));
    this.#snapshot = snapshot;
    return snapshot;
  }

  /**
   * Announces this client as a UI attachment.
   *
   * `fresh` is what the terminal client passes for `watari .` versus
   * `watari attach .`: a fresh attach archives the previous chat and starts a
   * new one. An editor opening a panel is the attaching case, not the resetting
   * one, so this is called with `false` and `newChat()` stays an explicit act.
   */
  async attach(fresh: boolean): Promise<void> {
    await this.#request({ type: "ui_attach", fresh });
  }

  async send(target: "all" | string, text: string): Promise<void> {
    await this.#request({ type: "send", target, text });
  }

  async interrupt(agent: string): Promise<void> {
    await this.#request({ type: "interrupt", agent });
  }

  async approve(
    agent: string,
    requestId: string | number,
    decision: "accept" | "decline" | "cancel",
  ): Promise<void> {
    await this.#request({ type: "approval", agent, requestId, decision });
  }

  async activityDetail(activityId: string): Promise<ActivityDetail | null> {
    return parseActivityDetail(await this.#request({ type: "activity_detail", activityId }));
  }

  async completeGoal(): Promise<void> {
    await this.#request({ type: "complete_goal" });
  }

  async newChat(): Promise<void> {
    await this.#request({ type: "new_chat" });
  }

  async checkBridges(): Promise<void> {
    await this.#request({ type: "check_bridges" });
  }

  /** Used only by the opt-in scratch smoke test so it cannot orphan a daemon. */
  async shutdown(): Promise<void> {
    await this.#request({ type: "shutdown" });
  }

  close(): void {
    if (this.#closed) return;
    this.#closing = true;
    this.#socket.destroy();
    this.#onClose("closed");
  }

  #request(command: Record<string, unknown>): Promise<unknown> {
    if (this.#closed) {
      return Promise.reject(new Error("The Watari connection is closed."));
    }
    this.#requestId += 1;
    const id = `vscode-${process.pid}-${this.#requestId}`;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Watari did not answer "${String(command.type)}" in time.`));
      }, REQUEST_TIMEOUT_MS);
      this.#pending.set(id, { resolve, reject, timer });
      this.#socket.write(`${JSON.stringify({ id, ...command })}\n`, (error) => {
        if (!error) return;
        this.#pending.delete(id);
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  #onData(chunk: string): void {
    this.#buffer += chunk;
    if (this.#buffer.length > MAX_BUFFERED_BYTES) {
      this.#onClose("The Watari service sent more than this client will buffer.");
      this.#socket.destroy();
      return;
    }
    let newline = this.#buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line.trim() !== "") this.#onLine(line);
      newline = this.#buffer.indexOf("\n");
    }
  }

  #onLine(line: string): void {
    let envelope: ServiceEnvelope;
    try {
      envelope = parseServiceEnvelope(JSON.parse(line) as unknown);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.#failProtocol(detail);
      return;
    }

    if (isResponse(envelope)) {
      const pending = this.#pending.get(envelope.id);
      if (!pending) return;
      this.#pending.delete(envelope.id);
      clearTimeout(pending.timer);
      if (envelope.ok) pending.resolve(envelope.value);
      else pending.reject(new Error(envelope.error));
      return;
    }

    if (envelope.type === "snapshot" || envelope.type === "state_changed") {
      this.#snapshot = envelope.snapshot;
    } else if (envelope.type === "transcript_upsert" && this.#snapshot) {
      this.#snapshot = { ...this.#snapshot, events: upsert(this.#snapshot.events, envelope.event) };
    } else if (envelope.type === "activity_upsert" && this.#snapshot) {
      this.#snapshot = {
        ...this.#snapshot,
        activities: upsert(this.#snapshot.activities, envelope.activity),
      };
    }
    this.#events.onEvent(envelope);
  }

  #onClose(reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.#pending.clear();
    if (!this.#closing) this.#events.onClose(reason);
  }

  #failProtocol(reason: string): void {
    this.#onClose(reason);
    this.#socket.destroy();
  }
}

function upsert<T extends { readonly id: string | number }>(values: readonly T[], value: T): T[] {
  const index = values.findIndex((existing) => existing.id === value.id);
  if (index < 0) return [...values, value];
  const next = [...values];
  next[index] = value;
  return next;
}
