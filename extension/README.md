# Watari for VS Code

Use the Watari sidebar to follow agent chats, command and edit activity, approval requests, and shared claims and findings. **Watari: Open Team in Editor** opens the same team in an editor tab. The terminal can be connected at the same time. [Watari setup](https://github.com/FixCraft-Inc/watari#try-it)

## Install from source

You need VS Code 1.85 or later, Bun, and a trusted local workspace. Build and link the Watari executable from the repository root, then build the extension package:

```bash
bun install --frozen-lockfile
bun run install:cli
cd extension
bun install --frozen-lockfile
bun run package
code --install-extension watari-vscode.vsix
```

If you built the CLI with `bun run build`, set `watari.executablePath` to the absolute path to `dist/watari`. By default the extension looks for `watari` on `PATH`.

Open the Git checkout the team will use. Select the Watari icon in the activity bar or run **Watari: Open Team** from the command palette. The extension starts the local service if needed. Turn off `watari.startServiceOnOpen` to attach only to an existing service. The secondary sidebar is also available in VS Code versions that support contributed containers there.

## Use the team panel

Global sends to the whole team. Select an agent tab to message that agent. Expand a command or edit card to read its details. Use the inline controls to handle approval requests or stop a running turn. Closing the panel disconnects the client, and active work continues in the Watari service.

## Develop and test

Run these commands from `extension/`:

```bash
bun install --frozen-lockfile
bun run check
bun run compile
```

Launch an Extension Development Host with this directory as its workspace. The webview tests use a stub DOM. `node preview.mjs` renders the panel with synthetic data and requires a local Chromium-family browser. The manual service smoke test uses `node smoke.mjs /path/to/checkout /path/to/watari`.

The extension negotiates the local API version before attaching. `watari status --json` supplies the socket path and API version. Its protocol definitions mirror the subset of the [service protocol](https://github.com/FixCraft-Inc/watari/blob/main/src/watari/service/protocol.ts) used by the panel.

## License

[GNU Affero General Public License v3.0 or later](https://github.com/FixCraft-Inc/watari/blob/main/extension/LICENSE.txt).
