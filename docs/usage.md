# Using Watari

Build Watari from the [repository root](../README.md#try-it). The examples below assume the resulting `watari` executable is on your `PATH`. Run `bun run install:cli` in the Watari checkout to build and link it into `~/.local/bin`, or substitute the absolute path to `dist/watari` in the commands.

## Start and inspect a team

```bash
watari .
watari status .
watari doctor . --json
watari probe codex .
watari probe claude .
watari probe opencode .
watari probe qwen .
```

Watari runs one service per Git checkout and uses the directory you launch it from as the agents' working directory. The terminal and VS Code can attach to the same service. Use `watari attach .` if you only want to join an existing service. `watari status . --json` includes the private state directory, socket location, and negotiated API version. A probe checks the native interface without a model turn. Add `--live` to request one minimal read-only model turn, which can consume provider quota.

`/detach` closes the terminal UI. After the last client disconnects, active turns, unanswered approvals or questions, pending wakes, and active job reservations can keep the service alive. When idle, the service allows a short reconnect window and shuts itself down. Use `/quit` to stop it from the UI.

## Configure agents and approvals

Ctrl+P or `/models` opens the provider, model, effort, and alias picker. The model catalog and effort options come from the selected harness. Multiple aliases can use the same provider. `/models <agent>` changes a model and `/agents` shows the current profiles.

```text
/agent add reviewer claude permissions=prompt
/agent add builder opencode
/agent set reviewer claude
/agent remove reviewer
```

`/agent add` and `/agent set` accept `model=<id>`, `effort=<id>`, `mode=managed|external`, and `permissions=prompt|bypass`. New profiles default to `prompt`. Leaving the permission field out of an edit keeps the saved choice. Managed Codex in prompt mode uses workspace-write sandboxing and on-request approvals on both new and resumed threads. Claude Code uses its default approval mode. For ACP sessions, Watari handles permission requests that the harness sends. The provider's own settings also apply. Choose `bypass` only to opt that managed profile into full access.

Use `/approve`, `/decline`, or `/cancel` on the displayed request. With several requests open, name the agent and request ID, for example `/decline codex req_2`. Native questions appear separately in Ctrl+Q. When the provider cannot send a supported question, the agent can ask in chat. `/stop [agent|all]` interrupts active turns, and `/retry <agent>` restarts a managed harness and tries to resume its conversation.

## Connect an external peer

Managed adapters register their own MCP tools when they start. To join from a separately launched native harness, first configure an external alias in Watari:

```text
/agent add codex-cli codex mode=external
/agent add claude-cli claude mode=external
```

Then register the stdio bridge from the native CLI. Substitute the absolute path to the executable:

```bash
codex mcp add watari -- /path/to/watari mcp --agent codex-cli --provider codex
claude mcp add --scope user watari -- /path/to/watari mcp --agent claude-cli --provider claude
```

Start the external harness in the project directory while the Watari service is running. With no explicit project argument, the MCP command resolves the checkout from that directory. Each external process needs its own registered alias. External peers collect mail with `team_inbox` and control their own turns. `/check` checks the team bridges from the UI.

## Share state and review work

`/all` sends a prompt to everyone. Use `@alias <message>` or `/to <alias> <message>` to direct one message from any tab. The first addressed agent coordinates intake when a goal opens. Peers share edit claims, a TODO list, findings, job reservations, and mail through the team tools.

A peer asks a question with `expects_reply: true` in `team_send`. The recipient replies with `reply_to`. The send receipt says when the recipient can read it. Claims and file activity can reveal overlapping edits while agents work. `/review [scope]` starts a team review, with the uncommitted diff as the default scope. `watari findings .` displays recorded findings as Markdown.

Project owners can define a `taskPolicy` in the private `agents.json` shown by `watari status .`. The policy can constrain which agents receive each class of work and declare shared resources. See [the schema](../src/watari/task-policy.ts) for the supported fields.

## Resume and export chats

`/new` archives the current chat and opens a fresh one. Use `/chats` to pick an archive and resume it. `/clear <agent>` starts fresh provider context for one peer while keeping the shared chat. `/save` writes a portable JSON archive. `/export [path]` writes Markdown from saved state. `/handoff [path]` asks agents to prepare handoffs before exporting and can start model turns.

```bash
watari chats .
watari resume . --chat 2
watari export . --out chat.md
watari import /path/to/chat.json . --no-ui
```

`watari import` expects an empty project database with its service stopped. `watari adopt <agent> <session-id> .` associates an existing native conversation with a configured managed peer while the service is stopped. The harness looks for the session on its next launch.

Private project state is under `${XDG_STATE_HOME:-$HOME/.local/state}/watari/`. A chat archive can contain prompts, checkout paths, provider session identifiers, and command or edit evidence. Review exported files before sharing them.
