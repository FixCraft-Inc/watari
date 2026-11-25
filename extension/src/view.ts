import * as vscode from "vscode";

import { teamHtml } from "./html.js";
import type { SessionStore, TeamSession } from "./session.js";

/**
 * The team as a sidebar view.
 *
 * This is the primary surface, and it is a `WebviewView` rather than an editor
 * tab on purpose: the team is something you consult while reading code, so it
 * belongs beside the editor rather than competing with it for the same space.
 *
 * It is contributed to two containers at once — the activity bar on the left
 * and the secondary side bar on the right, where the other coding assistants
 * sit — so the reader opens it wherever their hands already are. Both are
 * windows onto one `TeamSession`, so they show the same conversation and stay
 * in step. A VSCode older than 1.106 takes no contribution to the secondary
 * side bar and quietly shows only the left one.
 */
export class TeamViewProvider implements vscode.WebviewViewProvider {
  /** The container in the activity bar, on the left. */
  static readonly viewType = "watari.team";
  /** The container in the secondary side bar, on the right. */
  static readonly secondaryViewType = "watari.teamSecondary";

  readonly #context: vscode.ExtensionContext;
  readonly #sessions: SessionStore;
  /** Both containers can be open at once, so this is a set rather than a slot. */
  readonly #views = new Set<vscode.WebviewView>();

  constructor(context: vscode.ExtensionContext, sessions: SessionStore) {
    this.#context = context;
    this.#sessions = sessions;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.#views.add(view);
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.#context.extensionUri, "media")],
    };
    view.webview.html = teamHtml(this.#context.extensionUri, view.webview, "view");
    view.onDidDispose(() => this.#views.delete(view));

    const folder = firstFolder();
    if (!folder) {
      // Nothing to attach to. The view still renders and says so, rather than
      // showing an empty chat that would never fill.
      void view.webview.postMessage({
        type: "connection",
        connection: {
          state: "closed",
          detail: "Open the folder you want the agents to share.",
          project: "",
        },
      });
      return;
    }

    const session = this.#sessions.get(folder);
    const attached = session.attachSurface(view.webview);
    view.onDidDispose(() => {
      attached.dispose();
    });

    const visibilityChanged = view.onDidChangeVisibility(() => {
      // A collapsed view is destroyed and rebuilt by VSCode, so becoming
      // visible again is the moment to make sure there is still a connection.
      if (view.visible) void session.connect();
    });

    this.#describe(session, view);
    const connectionChanged = session.onDidChangeConnection(() => this.#describe(session, view));
    view.onDidDispose(() => {
      visibilityChanged.dispose();
      connectionChanged.dispose();
    });
    void session.connect();
  }

  /**
   * Brings the team into view.
   *
   * A view already on screen is simply focused; otherwise the secondary side
   * bar is opened, because that is where the other assistants live and so where
   * the reader is most likely to want this one. Only if that container does not
   * exist — a VSCode older than 1.106 — does the activity bar answer.
   */
  reveal(): void {
    for (const view of this.#views) {
      if (view.visible) {
        view.show(true);
        return;
      }
    }
    const first = this.#views.values().next().value;
    if (first) {
      first.show(true);
      return;
    }
    void vscode.commands.executeCommand(`${TeamViewProvider.secondaryViewType}.focus`).then(
      undefined,
      () => vscode.commands.executeCommand(`${TeamViewProvider.viewType}.focus`),
    );
  }

  /** The view's own subtitle carries connection state, so the transcript does
   * not have to spend a row on it while everything is working. */
  #describe(session: TeamSession, view: vscode.WebviewView): void {
    const connection = session.connection;
    view.description =
      connection.state === "ready"
        ? vscode.workspace.asRelativePath(session.folder, false)
        : connection.state === "connecting"
          ? "connecting..."
          : "disconnected";
  }
}

export function firstFolder(): vscode.Uri | null {
  return vscode.workspace.workspaceFolders?.[0]?.uri ?? null;
}
