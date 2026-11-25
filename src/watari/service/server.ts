import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import type { AgentId, ProjectContext } from "../models.ts";
import { JsonLineDecoder } from "../process/jsonl.ts";
import { configureProcessLedger, reapLeftoverProcesses } from "../process/ledger.ts";
import { runProcessCleanups } from "../process/shutdown.ts";
import { redactSecrets } from "../security/redaction.ts";
import type { RuntimeEvent } from "../state/types.ts";
import { loadProjectConfig, removeAgent, saveProjectConfig, upsertAgent } from "../team/config.ts";
import { parseAgentDefinition } from "../team/roster.ts";
import { CoordinatorRuntime, type RuntimeOptions } from "./runtime.ts";
import {
  SERVICE_API_VERSION,
  ServiceCommandSchema,
  ServiceEnvelopeSchema,
  type ServiceCommand,
  type ServiceEnvelope,
} from "./protocol.ts";
import { JsonSocketWriter } from "./socket-writer.ts";

interface ConnectionState {
  readonly decoder: JsonLineDecoder;
  readonly writer: JsonSocketWriter;
  apiVersion: number | null;
  /** A snapshot was skipped while this client was behind. It gets the latest once it catches up. */
  staleSnapshot: boolean;
}

const DEFAULT_IDLE_EXIT_MS = 10_000;
/**
 * Unwritten output past which a client gets no further snapshots until it
 * catches up. A snapshot is the whole team state and only the newest matters,
 * so queueing each one let a UI busy redrawing fall behind by dozens of them
 * during a burst and be dropped for exceeding its output bound.
 */
const SNAPSHOT_BACKLOG_BYTES = 1024 * 1024;

export interface ServiceOptions {
  readonly project: ProjectContext;
  readonly databasePath: string;
  readonly chatsDirectory?: string;
  readonly configPath?: string;
  readonly socketPath: string;
  readonly lockPath?: string;
  readonly adapters?: RuntimeOptions["adapters"];
  /** Test override; `false` is useful only for an explicitly persistent host. */
  readonly idleExitMs?: number | false;
  /** Test override for the token that managed bridges present. */
  readonly bridgeToken?: string;
  /** Provider status for agent capacity notices. Unset means no polling. */
  readonly capacityStatus?: RuntimeOptions["capacityStatus"];
  readonly capacityProviders?: RuntimeOptions["capacityProviders"];
}

export class WatariService {
  readonly #options: ServiceOptions;
  #runtime: CoordinatorRuntime | null = null;
  readonly #clients = new Set<Bun.Socket<ConnectionState>>();
  readonly #uiClients = new Set<Bun.Socket<ConnectionState>>();
  /** Provider stdio bridges are transport plumbing, not user keepalives. */
  readonly #bridgeClients = new Map<
    Bun.Socket<ConnectionState>,
    { readonly agent: AgentId; readonly provider: string }
  >();
  readonly #idleExitMs: number | null;
  #listener: Bun.SocketListener<ConnectionState> | null = null;
  #unsubscribe: (() => void) | null = null;
  #stopPromise: Promise<void> | null = null;
  #ownsLock = false;
  #ownsSocket = false;
  #activeOperations = 0;
  #idleExitTimer: ReturnType<typeof setTimeout> | null = null;
  readonly #stopped: Promise<void>;
  readonly #resolveStopped: () => void;

  constructor(options: ServiceOptions) {
    this.#options = options;
    this.#idleExitMs = options.idleExitMs === false
      ? null
      : options.idleExitMs ?? DEFAULT_IDLE_EXIT_MS;
    if (this.#idleExitMs !== null && (!Number.isFinite(this.#idleExitMs) || this.#idleExitMs < 0)) {
      throw new Error("Watari idle exit delay must be a non-negative finite number");
    }
    let resolveStopped: () => void = () => {};
    this.#stopped = new Promise<void>((resolve) => {
      resolveStopped = resolve;
    });
    this.#resolveStopped = resolveStopped;
  }

  get stopped(): Promise<void> {
    return this.#stopped;
  }

  async start(): Promise<void> {
    if (this.#options.lockPath) {
      acquireLock(this.#options.lockPath);
      this.#ownsLock = true;
      // A service that was killed outright left its harnesses unsupervised.
      // They are ended before any conversation is resumed, so one context never
      // runs in two harnesses against the same checkout.
      const ledger = join(dirname(this.#options.lockPath), "harnesses.json");
      await reapLeftoverProcesses(ledger);
      configureProcessLedger(ledger);
    }
    try {
      const config = this.#options.configPath ? loadProjectConfig(this.#options.configPath) : undefined;
      this.#runtime = new CoordinatorRuntime({
        project: this.#options.project,
        databasePath: this.#options.databasePath,
        ...(this.#options.chatsDirectory ? { chatsDirectory: this.#options.chatsDirectory } : {}),
        ...(config
          ? { roster: config.agents, taskPolicy: config.taskPolicy }
          : {}),
        ...(this.#options.adapters ? { adapters: this.#options.adapters } : {}),
        ...(this.#options.bridgeToken ? { bridgeToken: this.#options.bridgeToken } : {}),
        ...(this.#options.capacityStatus ? { capacityStatus: this.#options.capacityStatus } : {}),
        ...(this.#options.capacityProviders ? { capacityProviders: this.#options.capacityProviders } : {}),
      });
      removeStaleSocket(this.#options.socketPath);
      this.#listener = Bun.listen<ConnectionState>({
        unix: this.#options.socketPath,
        socket: {
          open: (socket) => {
            socket.data = {
              decoder: new JsonLineDecoder(),
              writer: new JsonSocketWriter(socket),
              apiVersion: null,
              staleSnapshot: false,
            };
            this.#clients.add(socket);
            this.#cancelIdleExit();
          },
          data: (socket, data) => this.#onData(socket, data),
          drain: (socket) => {
            socket.data.writer.flush();
            this.#sendDeferredSnapshot(socket);
          },
          close: (socket) => {
            this.#dropClient(socket);
          },
          error: (socket) => {
            this.#dropClient(socket);
          },
        },
      });
      this.#ownsSocket = true;
      chmodSync(this.#options.socketPath, 0o600);
      const runtime = this.#requiredRuntime();
      this.#unsubscribe = runtime.subscribe((event) => {
        this.#broadcast(event);
        this.#scheduleIdleExitIfNeeded();
      });
      void runtime.start().catch((error) => {
        this.#broadcast({ type: "fatal", message: errorMessage(error) });
      });
    } catch (error) {
      this.#unsubscribe?.();
      this.#unsubscribe = null;
      this.#listener?.stop(true);
      this.#listener = null;
      this.#removeSocket();
      const runtime = this.#runtime;
      this.#runtime = null;
      await runtime?.stop().catch(() => undefined);
      this.#releaseLock();
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.#stopPromise ??= this.#stopInternal();
    await this.#stopPromise;
  }

  #onData(socket: Bun.Socket<ConnectionState>, data: Buffer): void {
    let lines;
    try {
      lines = socket.data.decoder.push(data);
    } catch (error) {
      this.#send(socket, responseError("invalid", errorMessage(error)));
      socket.end();
      return;
    }
    for (const line of lines) {
      if (!line.ok) {
        this.#send(socket, responseError("invalid", line.error));
        continue;
      }
      const parsed = ServiceCommandSchema.safeParse(line.value);
      if (!parsed.success) {
        this.#send(socket, responseError(requestIdFrom(line.value), "invalid local API command"));
        continue;
      }
      if (socket.data.apiVersion === null && parsed.data.type !== "negotiate") {
        this.#send(socket, responseError(parsed.data.id, "API version negotiation is required first"));
        continue;
      }
      void this.#handleCommand(socket, parsed.data);
    }
  }

  async #handleCommand(socket: Bun.Socket<ConnectionState>, command: ServiceCommand): Promise<void> {
    this.#activeOperations += 1;
    this.#cancelIdleExit();
    try {
      switch (command.type) {
        case "negotiate":
          if (socket.data.apiVersion !== null) {
            throw new Error("API version was already negotiated on this connection");
          }
          if (!command.versions.includes(SERVICE_API_VERSION)) {
            throw new Error(`Watari requires local API version ${SERVICE_API_VERSION}`);
          }
          socket.data.apiVersion = SERVICE_API_VERSION;
          this.#send(socket, responseOk(command.id, { apiVersion: SERVICE_API_VERSION }));
          this.#send(socket, {
            type: "snapshot",
            snapshot: this.#requiredRuntime().snapshot(),
          });
          break;
        case "snapshot":
          this.#send(socket, responseOk(command.id, this.#requiredRuntime().snapshot()));
          break;
        case "info":
          this.#send(socket, responseOk(command.id, {
            schemaVersion: SERVICE_API_VERSION,
            pid: process.pid,
            connectedClients: this.#clients.size,
            bridges: Object.fromEntries(
              this.#requiredRuntime().snapshot().agents.map((agent) => [agent.id, "identity-bound stdio MCP"]),
            ),
          }));
          break;
        case "activity_detail":
          this.#send(socket, responseOk(
            command.id,
            this.#requiredRuntime().activityDetail(command.activityId),
          ));
          break;
        case "ui_attach": {
          // Opening the UI always continues the current chat. Only /new starts
          // another. Resetting on open threw both agents' work and memory away
          // whenever the UI had been closed. `fresh` is still accepted from
          // older clients and only decides whether they are told so.
          const continuing = this.#requiredRuntime().snapshot().messages.some((message) => message.sender === "user");
          this.#uiClients.add(socket);
          this.#send(socket, responseOk(command.id, { keptRunningChat: command.fresh && continuing }));
          break;
        }
        case "team_tool":
          this.#send(socket, responseOk(
            command.id,
            await this.#requiredRuntime().callTeamTool(
              command.agent,
              command.name,
              command.input,
            ),
          ));
          break;
        case "send":
          await this.#requiredRuntime().sendUserMessage(command.target, command.text);
          this.#send(socket, responseOk(command.id));
          break;
        case "interrupt":
          await this.#requiredRuntime().interrupt(command.agent);
          this.#send(socket, responseOk(command.id));
          break;
        case "question":
          await this.#requiredRuntime().respondToQuestion(command.agent, command.requestId, command.response);
          this.#send(socket, responseOk(command.id));
          break;
        case "approval":
          await this.#requiredRuntime().respondToApproval(
            command.agent,
            command.requestId,
            command.decision,
          );
          this.#send(socket, responseOk(command.id));
          break;
        case "shutdown":
          this.#send(socket, responseOk(command.id));
          queueMicrotask(() => void this.stop());
          break;
        case "complete_goal":
          this.#requiredRuntime().completeActiveGoal();
          this.#send(socket, responseOk(command.id));
          break;
        case "new_chat":
          await this.#requiredRuntime().newChat();
          this.#send(socket, responseOk(command.id));
          break;
        case "check_bridges": {
          // An explicit check always re-probes: the user asking is exactly the
          // case where a cached pass is not what they want to be told.
          const statuses = await this.#requiredRuntime().verifyBridges(true);
          this.#send(socket, responseOk(command.id, statuses));
          break;
        }
        case "provider_status":
          this.#send(socket, responseOk(
            command.id,
            await this.#requiredRuntime().providerStatus(command.force === true),
          ));
          break;
        case "bridge_connected":
          if (this.#bridgeClients.has(socket)) {
            throw new Error("this local connection already has a bound MCP identity");
          }
          this.#requiredRuntime().registerBridge(command.agent, command.provider, command.token);
          this.#bridgeClients.set(socket, { agent: command.agent, provider: command.provider });
          this.#send(socket, responseOk(command.id));
          break;
        case "bridge_disconnected": {
          const binding = this.#bridgeClients.get(socket);
          if (!binding || binding.agent !== command.agent) {
            throw new Error("this local connection is not bound to that MCP identity");
          }
          this.#requiredRuntime().unregisterBridge(command.agent);
          this.#bridgeClients.delete(socket);
          this.#send(socket, responseOk(command.id));
          break;
        }
        case "agent_configure": {
          const configPath = this.#requiredConfigPath();
          const config = loadProjectConfig(configPath);
          const previous = config.agents.find((agent) =>
            agent.alias.toLowerCase() === command.definition.alias.toLowerCase()
          );
          const definition = parseAgentDefinition({
            ...command.definition,
            unrestricted: command.definition.unrestricted ?? previous?.unrestricted,
          });
          const agents = upsertAgent(config.agents, definition);
          saveProjectConfig(configPath, { ...config, agents });
          await this.#requiredRuntime().configureAgent(definition);
          this.#send(socket, responseOk(command.id));
          break;
        }
        case "agent_remove": {
          const configPath = this.#requiredConfigPath();
          const config = loadProjectConfig(configPath);
          const agents = removeAgent(config.agents, command.agent);
          saveProjectConfig(configPath, { ...config, agents });
          await this.#requiredRuntime().removeAgent(command.agent);
          this.#send(socket, responseOk(command.id));
          break;
        }
        case "agent_restart":
          await this.#requiredRuntime().restartAgent(command.agent);
          this.#send(socket, responseOk(command.id));
          break;
        case "agent_clear":
          await this.#requiredRuntime().clearAgentContext(command.agent);
          this.#send(socket, responseOk(command.id));
          break;
        case "chat_list":
          this.#send(socket, responseOk(command.id, this.#requiredRuntime().listChats()));
          break;
        case "chat_resume":
          this.#send(socket, responseOk(command.id, await this.#requiredRuntime().resumeChat(command.chat)));
          break;
        case "chat_save":
          this.#send(socket, responseOk(command.id, this.#requiredRuntime().saveChat()));
          break;
        case "chat_export":
          this.#send(socket, responseOk(command.id, await this.#requiredRuntime().exportChat({
            handoff: command.handoff,
            ...(command.path ? { path: command.path } : {}),
            ...(command.timeoutMs ? { timeoutMs: command.timeoutMs } : {}),
          })));
          break;
        case "model_list":
          this.#send(socket, responseOk(command.id, await this.#requiredRuntime().availableModels(command.agent)));
          break;
        case "provider_model_list":
          this.#send(socket, responseOk(
            command.id,
            await this.#requiredRuntime().availableProviderModels(command.provider),
          ));
          break;
      }
    } catch (error) {
      this.#send(socket, responseError(command.id, errorMessage(error)));
    } finally {
      this.#activeOperations -= 1;
      this.#scheduleIdleExitIfNeeded();
    }
  }

  #broadcast(event: RuntimeEvent): void {
    for (const client of this.#clients) {
      if (client.data.apiVersion !== SERVICE_API_VERSION) continue;
      // A team bridge only relays tool calls and reads their responses.
      // Streaming every transcript fragment and snapshot to it made each MCP
      // child parse and validate the whole team's output for nothing.
      if (this.#bridgeClients.has(client) && !this.#uiClients.has(client)) continue;
      if (event.type === "state_changed" && client.data.writer.queuedBytes > SNAPSHOT_BACKLOG_BYTES) {
        client.data.staleSnapshot = true;
        continue;
      }
      this.#deliver(client, event);
    }
  }

  /** Sends the current snapshot to a client that skipped some while it was behind. */
  #sendDeferredSnapshot(client: Bun.Socket<ConnectionState>): void {
    if (!client.data.staleSnapshot || client.data.writer.queuedBytes > SNAPSHOT_BACKLOG_BYTES) return;
    const runtime = this.#runtime;
    if (!runtime) return;
    this.#deliver(client, { type: "state_changed", snapshot: runtime.snapshot() });
  }

  #deliver(client: Bun.Socket<ConnectionState>, event: RuntimeEvent): void {
    try {
      this.#send(client, event);
      if (event.type === "state_changed") client.data.staleSnapshot = false;
    } catch (error) {
      // Written to service.log. A dropped UI used to leave no trace of why.
      console.error(`watari service: dropped a local client after ${event.type}: ${errorMessage(error)}`);
      client.end();
    }
  }

  #send(socket: Bun.Socket<ConnectionState>, envelope: ServiceEnvelope): void {
    socket.data.writer.send(ServiceEnvelopeSchema.parse(envelope));
  }

  async #stopInternal(): Promise<void> {
    this.#cancelIdleExit();
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#listener?.stop(false);
    this.#listener = null;
    for (const client of this.#clients) {
      client.end();
    }
    this.#clients.clear();
    this.#uiClients.clear();
    this.#bridgeClients.clear();
    try {
      await this.#runtime?.stop();
      this.#runtime = null;
    } finally {
      this.#removeSocket();
      this.#releaseLock();
      this.#resolveStopped();
    }
  }

  #releaseLock(): void {
    if (!this.#ownsLock || !this.#options.lockPath) {
      return;
    }
    this.#ownsLock = false;
    releaseLock(this.#options.lockPath);
  }

  #removeSocket(): void {
    if (!this.#ownsSocket) {
      return;
    }
    this.#ownsSocket = false;
    removeOwnedSocket(this.#options.socketPath);
  }

  #requiredRuntime(): CoordinatorRuntime {
    if (!this.#runtime) {
      throw new Error("Watari service runtime is not started");
    }
    return this.#runtime;
  }

  #requiredConfigPath(): string {
    if (!this.#options.configPath) throw new Error("this Watari service was started without an agent config path");
    return this.#options.configPath;
  }

  #dropClient(socket: Bun.Socket<ConnectionState>): void {
    this.#clients.delete(socket);
    this.#uiClients.delete(socket);
    const bridge = this.#bridgeClients.get(socket);
    this.#bridgeClients.delete(socket);
    if (bridge && this.#runtime) {
      // An MCP subprocess can be killed before it sends bridge_disconnected.
      // Tie presence to the socket lifetime so that cannot leave a phantom
      // external agent keeping the coordinator alive forever.
      this.#runtime.unregisterBridge(bridge.agent);
    }
    this.#scheduleIdleExitIfNeeded();
  }

  #scheduleIdleExitIfNeeded(): void {
    if (this.#stopPromise || this.#idleExitMs === null || !this.#isIdle()) {
      this.#cancelIdleExit();
      return;
    }
    if (this.#idleExitTimer) return;
    this.#idleExitTimer = setTimeout(() => {
      this.#idleExitTimer = null;
      if (this.#isIdle()) void this.stop();
    }, this.#idleExitMs);
    this.#idleExitTimer.unref?.();
  }

  #cancelIdleExit(): void {
    if (!this.#idleExitTimer) return;
    clearTimeout(this.#idleExitTimer);
    this.#idleExitTimer = null;
  }

  #isIdle(): boolean {
    if (!this.#runtime || this.#activeOperations > 0) return false;
    // A newly connected socket remains a keepalive until it identifies itself
    // as provider bridge plumbing. This closes the connect → ui_attach race.
    const hasKeepaliveClient = [...this.#clients].some((client) =>
      this.#uiClients.has(client) || !this.#bridgeClients.has(client)
    );
    return !hasKeepaliveClient && !this.#runtime.hasActiveWork();
  }
}

export async function runService(options: ServiceOptions): Promise<void> {
  const service = new WatariService(options);
  await service.start();
  const stop = () => void service.stop();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  // A closed terminal sends SIGHUP, whose default is to die without cleanup.
  process.once("SIGHUP", stop);
  await service.stopped;
  // Whatever the adapters could not close politely still has a process group,
  // and a detached group outlives its parent. Nothing Watari started may be
  // left running once the service it belonged to is gone.
  await runProcessCleanups();
}

function responseOk(id: string, value?: unknown): ServiceEnvelope {
  return { type: "response", id, ok: true, ...(value === undefined ? {} : { value }) };
}

function responseError(id: string, error: string): ServiceEnvelope {
  return { type: "response", id, ok: false, error: redactSecrets(error) };
}

function requestIdFrom(value: unknown): string {
  if (typeof value === "object" && value !== null && "id" in value && typeof value.id === "string") {
    return value.id;
  }
  return "invalid";
}

function removeStaleSocket(path: string): void {
  if (!existsSync(path)) {
    return;
  }
  if (!lstatSync(path).isSocket()) {
    throw new Error(`refusing to replace non-socket runtime path: ${path}`);
  }
  unlinkSync(path);
}

function removeOwnedSocket(path: string): void {
  if (existsSync(path) && lstatSync(path).isSocket()) {
    unlinkSync(path);
  }
}

function errorMessage(error: unknown): string {
  return redactSecrets(error instanceof Error ? error.message : String(error));
}

function acquireLock(path: string): void {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = openSync(path, "wx", 0o600);
      try {
        writeFileSync(descriptor, `${process.pid}\n`, { encoding: "utf8" });
      } finally {
        closeSync(descriptor);
      }
      return;
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) {
        throw error;
      }
      if (!lstatSync(path).isFile()) {
        throw new Error(`refusing to replace non-file Watari service lock: ${path}`);
      }
      const owner = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
      if (!Number.isSafeInteger(owner) || owner <= 0) {
        throw new Error(`Watari service lock has an invalid owner: ${path}`);
      }
      if (processIsAlive(owner)) {
        throw new Error(`Watari service is already running with pid ${owner}`);
      }
      unlinkSync(path);
    }
  }
  throw new Error("could not acquire the Watari service lock");
}

function releaseLock(path: string): void {
  if (!existsSync(path)) {
    return;
  }
  const owner = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
  if (owner === process.pid) {
    unlinkSync(path);
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return hasErrorCode(error, "EPERM");
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
