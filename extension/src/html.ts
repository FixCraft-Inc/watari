import { randomBytes } from "node:crypto";

import * as vscode from "vscode";

/**
 * The webview shell, shared by every surface.
 *
 * The content security policy is the reason this is one function rather than a
 * string in each host: the panel renders model output, so scripts are limited
 * to the two files below by nonce, and nothing may be loaded off the network.
 */
export function teamHtml(
  extensionUri: vscode.Uri,
  webview: vscode.Webview,
  surface: "view" | "panel",
): string {
  const asset = (name: string): string =>
    webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", name)).toString();
  const nonce = randomNonce();
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${asset("main.css")}" rel="stylesheet">
<title>Watari</title>
</head>
<body data-surface="${surface}">
<div id="root"></div>
<script nonce="${nonce}" src="${asset("icons.js")}"></script>
<script nonce="${nonce}" src="${asset("markdown.js")}"></script>
<script nonce="${nonce}" src="${asset("main.js")}"></script>
</body>
</html>`;
}

function randomNonce(): string {
  return randomBytes(24).toString("base64url");
}
