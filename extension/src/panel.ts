import * as vscode from "vscode";

import { teamHtml } from "./html.js";
import type { SessionStore } from "./session.js";

/**
 * The team as an editor tab.
 *
 * The sidebar is the primary surface; this exists for the times a transcript
 * wants the whole width — reading a long diff, or following two peers at once.
 * It is a second window onto the same session, not a second connection, so both
 * surfaces can be open together and stay in step.
 */
export class TeamPanel {
  static #open: TeamPanel | null = null;

  readonly #panel: vscode.WebviewPanel;
  readonly #disposables: vscode.Disposable[] = [];

  private constructor(
    panel: vscode.WebviewPanel,
    context: vscode.ExtensionContext,
    sessions: SessionStore,
    folder: vscode.Uri,
  ) {
    this.#panel = panel;
    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, "media", "watari.svg");
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")],
    };
    panel.webview.html = teamHtml(context.extensionUri, panel.webview, "panel");

    const session = sessions.get(folder);
    this.#disposables.push(session.attachSurface(panel.webview));
    panel.onDidDispose(() => this.dispose(), null, this.#disposables);
    void session.connect();
  }

  static open(context: vscode.ExtensionContext, sessions: SessionStore, folder: vscode.Uri): void {
    if (TeamPanel.#open) {
      TeamPanel.#open.#panel.reveal(vscode.ViewColumn.Active);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "watari.teamPanel",
      `Watari — ${vscode.workspace.asRelativePath(folder, false) || folder.fsPath}`,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    TeamPanel.#open = new TeamPanel(panel, context, sessions, folder);
  }

  dispose(): void {
    if (TeamPanel.#open === this) TeamPanel.#open = null;
    for (const disposable of this.#disposables.splice(0)) disposable.dispose();
  }
}
