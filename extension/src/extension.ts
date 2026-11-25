import * as vscode from "vscode";

import { status } from "./discovery.js";
import { TeamPanel } from "./panel.js";
import { SessionStore, type TeamSession } from "./session.js";
import { TeamViewProvider, firstFolder } from "./view.js";

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel("Watari", { log: true });
  const sessions = new SessionStore(log);
  const view = new TeamViewProvider(context, sessions);

  context.subscriptions.push(
    log,
    sessions,
    // One provider, both view ids. Only the container the context key selects is
    // ever resolved, so this registers the surface rather than duplicating it.
    ...[TeamViewProvider.viewType, TeamViewProvider.secondaryViewType].map((viewType) =>
      vscode.window.registerWebviewViewProvider(viewType, view, {
        // The team is a live conversation. Rebuilding its scroll position and
        // draft every time the sidebar is collapsed would lose the reader's
        // place in a transcript that is still moving.
        webviewOptions: { retainContextWhenHidden: true },
      }),
    ),
  );

  const onSession = (
    action: (session: TeamSession) => Promise<void> | void,
  ): (() => Promise<void>) => async () => {
    const session = sessions.active();
    if (!session) {
      view.reveal();
      void vscode.window.showWarningMessage("Open the Watari team first.");
      return;
    }
    await action(session);
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("watari.open", () => view.reveal()),
    vscode.commands.registerCommand("watari.openInEditor", () => {
      const folder = firstFolder();
      if (!folder) {
        void vscode.window.showErrorMessage(
          "Watari works on a folder. Open the checkout you want the agents to share.",
        );
        return;
      }
      TeamPanel.open(context, sessions, folder);
    }),
    vscode.commands.registerCommand("watari.showLog", () => log.show()),
    vscode.commands.registerCommand(
      "watari.reconnect",
      onSession((session) => session.reconnect()),
    ),
    vscode.commands.registerCommand(
      "watari.newChat",
      onSession((session) =>
        session.run(async (client) => client.newChat(), "started a fresh chat"),
      ),
    ),
    vscode.commands.registerCommand(
      "watari.completeGoal",
      onSession((session) =>
        session.run(async (client) => client.completeGoal(), "goal marked complete"),
      ),
    ),
    vscode.commands.registerCommand(
      "watari.checkBridges",
      onSession((session) =>
        session.run(async (client) => client.checkBridges(), "re-tested every team bridge"),
      ),
    ),
  );

  // A quiet, best-effort note. It must never block activation or pop a dialog:
  // most windows are not Watari projects, and a missing executable only becomes
  // interesting once someone actually asks for the team.
  void describeWorkspace(log);
}

export function deactivate(): void {
  // Sessions are disposed through context.subscriptions.
}

async function describeWorkspace(log: vscode.LogOutputChannel): Promise<void> {
  const folder = firstFolder();
  if (!folder) return;
  const executable = vscode.workspace
    .getConfiguration("watari", folder)
    .get<string>("executablePath", "watari");
  try {
    const report = await status(executable, folder.fsPath);
    log.info(
      `${folder.fsPath}: service ${report.service.state}, ` +
        `${report.service.apiVersion === null
          ? `expects api v${report.service.expectedApiVersion}`
          : `api v${report.service.apiVersion}`}`,
    );
  } catch (error) {
    log.info(`watari not available yet: ${error instanceof Error ? error.message : String(error)}`);
  }
}
