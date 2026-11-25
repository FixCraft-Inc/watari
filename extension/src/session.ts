import * as vscode from "vscode";

import { WatariClient } from "./client.js";
import { discover, startService, ExecutableMissingError } from "./discovery.js";
import type { RuntimeEvent } from "./protocol.js";

export interface ConnectionView {
  readonly state: "connecting" | "ready" | "closed";
  readonly detail: string;
  readonly project: string;
}

type Outbound =
  | { readonly type: "state"; readonly connection: ConnectionView; readonly snapshot: unknown }
  | { readonly type: "event"; readonly event: RuntimeEvent }
  | { readonly type: "connection"; readonly connection: ConnectionView }
  | { readonly type: "activityDetail"; readonly id: string; readonly detail: unknown }
  | { readonly type: "notice"; readonly level: "error" | "info"; readonly message: string };

/**
 * One team connection for one folder, independent of where it is displayed.
 *
 * The session is a client and never a host: it owns no provider process and
 * never keeps a team alive. Disposing it disconnects, and the service applies
 * its own idle grace afterwards exactly as it does when a terminal UI detaches.
 *
 * Display is deliberately not its concern. A sidebar view and an editor tab are
 * two `vscode.Webview` surfaces onto the same conversation, so the session holds
 * the socket and the state while the surface comes and goes underneath it —
 * which is also what makes a collapsed sidebar view cheap, since VSCode destroys
 * that webview and asks for it again later.
 */
export class TeamSession {
  readonly folder: vscode.Uri;
  readonly #log: vscode.LogOutputChannel;
  readonly #onConnection = new vscode.EventEmitter<ConnectionView>();
  readonly #surfaces = new Set<vscode.Webview>();
  #client: WatariClient | null = null;
  #connection: ConnectionView;
  #connecting: Promise<void> | null = null;
  #connectingAbort: AbortController | null = null;
  #disposed = false;

  readonly onDidChangeConnection = this.#onConnection.event;

  constructor(folder: vscode.Uri, log: vscode.LogOutputChannel) {
    this.folder = folder;
    this.#log = log;
    this.#connection = { state: "connecting", detail: "Looking for a service...", project: folder.fsPath };
  }

  get connection(): ConnectionView {
    return this.#connection;
  }

  get client(): WatariClient | null {
    return this.#client;
  }

  /** Attaches a webview surface. Returns a disposable that detaches it. */
  attachSurface(webview: vscode.Webview): vscode.Disposable {
    this.#surfaces.add(webview);
    const subscription = webview.onDidReceiveMessage((message: Record<string, unknown>) => {
      void this.handleMessage(message, webview);
    });
    return new vscode.Disposable(() => {
      subscription.dispose();
      this.#surfaces.delete(webview);
    });
  }

  /**
   * Connects, or joins the attempt already in flight.
   *
   * Two surfaces can open at once — a sidebar view revealing while a command
   * opens an editor tab — and without this they would race into two services.
   */
  async connect(): Promise<void> {
    if (this.#disposed || this.#client) return;
    if (!this.#connecting) {
      const controller = new AbortController();
      this.#connectingAbort = controller;
      let pending: Promise<void>;
      pending = this.#connect(controller.signal).finally(() => {
        if (this.#connecting === pending) {
          this.#connecting = null;
          this.#connectingAbort = null;
        }
      });
      this.#connecting = pending;
    }
    await this.#connecting;
  }

  async reconnect(): Promise<void> {
    this.#connectingAbort?.abort();
    this.#client?.close();
    this.#client = null;
    await this.#connecting?.catch(() => undefined);
    await this.connect();
  }

  async run(action: (client: WatariClient) => Promise<void>, success: string): Promise<void> {
    const client = this.#client;
    if (!client) {
      void vscode.window.showWarningMessage("Watari is not connected for this folder.");
      return;
    }
    try {
      await action(client);
      void vscode.window.setStatusBarMessage(`Watari: ${success}`, 4000);
    } catch (error) {
      this.fail(error);
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#connectingAbort?.abort();
    this.#client?.close();
    this.#client = null;
    this.#surfaces.clear();
    this.#onConnection.dispose();
  }

  /** Answers one webview request. Public so a surface can replay `ready`. */
  async handleMessage(message: Record<string, unknown>, from: vscode.Webview): Promise<void> {
    const type = String(message.type ?? "");

    if (type === "ready") {
      const snapshot = this.#client?.snapshot;
      this.#send(from, snapshot
        ? { type: "state", connection: this.#connection, snapshot }
        : { type: "connection", connection: this.#connection });
      return;
    }
    if (type === "reconnect") {
      await this.reconnect();
      return;
    }

    const client = this.#client;
    if (!client) {
      this.#send(from, { type: "notice", level: "error", message: "Watari is not connected." });
      return;
    }

    try {
      if (type === "send") {
        await client.send(String(message.target ?? "all"), String(message.text ?? ""));
      } else if (type === "activityDetail") {
        const id = String(message.id ?? "");
        this.#send(from, { type: "activityDetail", id, detail: await client.activityDetail(id) });
      } else if (type === "interrupt") {
        await this.#confirmInterrupt(client, message.agents);
      } else if (type === "approve") {
        await client.approve(
          String(message.agent ?? ""),
          message.requestId as string | number,
          message.decision as "accept" | "decline" | "cancel",
        );
      } else if (type === "newChat") {
        await client.newChat();
      } else if (type === "completeGoal") {
        await client.completeGoal();
      } else if (type === "checkBridges") {
        await client.checkBridges();
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.#log.error(`${type} failed: ${detail}`);
      this.#send(from, { type: "notice", level: "error", message: detail });
    }
  }

  /**
   * Interrupts peers, once the reader has said so out loud.
   *
   * A native turn cannot be resumed after it is cut, so this is the one action
   * in the panel worth a modal. It is raised by VSCode rather than drawn in the
   * webview: the reader already trusts that dialog, and it cannot be dismissed
   * into an accidental yes by a stray click on the page.
   */
  async #confirmInterrupt(client: WatariClient, raw: unknown): Promise<void> {
    const agents = Array.isArray(raw) ? raw.map(String).filter((id) => id !== "") : [];
    if (agents.length === 0) return;

    const who = agents.length === 1 ? agents[0]! : `${agents.length} peers`;
    const choice = await vscode.window.showWarningMessage(
      `Interrupt ${who}?`,
      {
        modal: true,
        detail:
          "The current native turn stops where it is. Work already written to disk stays, " +
          "but the turn cannot be resumed.",
      },
      "Interrupt",
    );
    if (choice !== "Interrupt") return;

    for (const agent of agents) await client.interrupt(agent);
  }

  fail(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.#log.error(message);
    if (error instanceof ExecutableMissingError) {
      void vscode.window.showErrorMessage(message, "Open Settings").then((choice) => {
        if (choice === "Open Settings") {
          void vscode.commands.executeCommand("workbench.action.openSettings", "watari.executablePath");
        }
      });
      return;
    }
    void vscode.window.showErrorMessage(message);
  }

  async #connect(signal: AbortSignal): Promise<void> {
    const settings = vscode.workspace.getConfiguration("watari", this.folder);
    const executable = settings.get<string>("executablePath", "watari");
    const mayStart = settings.get<boolean>("startServiceOnOpen", true);
    const project = this.folder.fsPath;

    let connectingClient: WatariClient | null = null;
    try {
      this.#setConnection("connecting", "Looking for a service...");
      let found = await discover(executable, project, signal);

      if (!found.running) {
        if (!mayStart) {
          throw new Error(
            "No Watari service is running for this folder, and watari.startServiceOnOpen is off. " +
              "Run `watari serve` in a terminal, or turn the setting back on.",
          );
        }
        this.#setConnection("connecting", "Starting the Watari service...");
        found = await startService(executable, project, signal);
      }

      if (signal.aborted) return;
      this.#log.info(`connecting to ${found.socketPath} (api v${found.apiVersion ?? "unknown"})`);
      this.#setConnection("connecting", "Attaching...");
      const client = await WatariClient.connect(
        found.socketPath,
        {
          onEvent: (event) => this.#onRuntimeEvent(event),
          onClose: (reason) => {
            this.#client = null;
            this.#setConnection("closed", reason);
          },
        },
        signal,
      );
      connectingClient = client;
      if (this.#disposed || signal.aborted) {
        client.close();
        return;
      }
      this.#client = client;
      // Opening a view is attaching, not resetting. A fresh attach archives
      // whatever chat is open, which is `watari .` behaviour and never what
      // revealing a sidebar should do.
      await client.attach(false);
      const snapshot = await client.refresh();
      this.#setConnection("ready", `api v${found.apiVersion ?? "unknown"}`);
      this.#broadcast({ type: "state", connection: this.#connection, snapshot });
    } catch (error) {
      connectingClient?.close();
      if (this.#client === connectingClient) this.#client = null;
      if (signal.aborted) return;
      this.fail(error);
      this.#setConnection("closed", error instanceof Error ? error.message : String(error));
    }
  }

  #onRuntimeEvent(event: RuntimeEvent): void {
    if (event.type === "fatal") {
      this.#setConnection("closed", event.message);
      return;
    }
    this.#broadcast({ type: "event", event });
  }

  #setConnection(state: ConnectionView["state"], detail: string): void {
    if (this.#disposed) return;
    this.#connection = { state, detail, project: this.folder.fsPath };
    void vscode.commands.executeCommand("setContext", "watari.connected", state === "ready");
    this.#onConnection.fire(this.#connection);
    this.#broadcast({ type: "connection", connection: this.#connection });
  }

  #broadcast(message: Outbound): void {
    for (const surface of this.#surfaces) this.#send(surface, message);
  }

  #send(webview: vscode.Webview, message: Outbound): void {
    if (this.#disposed) return;
    void webview.postMessage(message);
  }
}

/** Sessions are per folder, so two checkouts in one window stay separate. */
export class SessionStore {
  readonly #sessions = new Map<string, TeamSession>();
  readonly #log: vscode.LogOutputChannel;

  constructor(log: vscode.LogOutputChannel) {
    this.#log = log;
  }

  get(folder: vscode.Uri): TeamSession {
    const key = folder.toString();
    let session = this.#sessions.get(key);
    if (!session) {
      session = new TeamSession(folder, this.#log);
      this.#sessions.set(key, session);
    }
    return session;
  }

  /** The session a command should act on: the only one, or none. */
  active(): TeamSession | null {
    return this.#sessions.size === 1 ? (this.#sessions.values().next().value ?? null) : null;
  }

  dispose(): void {
    for (const session of this.#sessions.values()) session.dispose();
    this.#sessions.clear();
  }
}
