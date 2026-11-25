# Watari

Watari runs Codex, Claude Code, OpenCode, and Qwen Code together in one Git checkout. Use the terminal or the [VS Code panel](extension/README.md) to give the team a goal, follow each agent's work, and answer approval requests.

Each agent has its own conversation. Watari connects to Codex app-server, the Claude Agent SDK, and the ACP servers provided by OpenCode and Qwen Code. Those native harnesses load their usual authentication and configuration and make the model requests. Watari runs them over structured interfaces and keeps the shared goal, mail, claims, TODOs, findings, and activity in a local SQLite database.

## Try it

Use Linux x64 with glibc, Git, and Bun 1.4.0. Install and configure the native tools you want to use. The default roster is Codex and Claude Code. The tested pins are Codex 0.169.0, Claude Code 2.1.325 with Agent SDK 0.3.325, and Qwen Code 0.27.3. OpenCode needs its `acp` command.

```bash
git clone https://github.com/FixCraft-Inc/watari.git
cd watari
bun install --frozen-lockfile
bun run build
./dist/watari doctor .
./dist/watari .
```

Pass the path to any other Git checkout to open a team there. To try the interface without provider accounts, run `bun run preview` in the Watari checkout. The preview uses a fixed demo.

The terminal opens on an agent tab. Send a message there to start with one agent, or use Global or `/all` to address the team. Open `/models` to add an agent and pick from the models and reasoning settings reported by its harness. New managed profiles use provider approval prompts by default. Use `/approve` or `/decline` on a pending request and Ctrl+Q to answer native questions. `/help` lists the commands and keys.

## Work as a team

Try a small task in a checkout you know:

```text
/all Inspect README.md and package.json. Check that the documented build and test commands match the scripts. Report any discrepancies with file and line references. Leave the files unchanged.
```

For an implementation task, use individual tabs to give peers different scopes. For example, send the implementation to Codex and give Claude a separate review in the same checkout:

```text
@codex Add a regression test for empty input in the parser. Claim the test file before editing and run the focused suite.
@claude Trace how the parser handles empty input and report edge cases with file and line references. Review only.
```

All managed agents use the same identity-bound MCP tools. Peers use `team_send` for cross-harness messages and threaded replies, `team_claim` to declare edit scopes, and `team_todo` and `team_finding` to record work and review evidence. Each peer sees the messages addressed to it. Its normal chat output appears in your UI.

Watari queues mail until the receiving harness can take it. Codex can accept a steer between tool batches, Claude Code can receive mail through Agent SDK callbacks, and Qwen Code 0.27.3 can collect it after a tool call. OpenCode takes queued mail when its current prompt completes. A separately launched harness can also join as an external MCP peer and read its own inbox. [Team setup and commands](docs/usage.md)

## Results

The source preview passed 700 core tests and 27 VS Code extension tests. The core suite exercises the stdio MCP bridge, cross-provider mail and replies, edit overlap, approvals, and chat recovery using simulated providers. An October 23, 2026 acceptance run in a disposable Git checkout exercised native Codex 0.163.0 and Claude Code 2.1.309, including mid-turn mail, approval handling, job reservations, and restart recovery.

The models come from the providers. Teams can divide work and check each other's findings, while messages and additional turns use context and provider quota. The results above cover integration behavior. A comparison of model quality, throughput, or cost per completed task would need a separate benchmark.

```bash
bun run check
cd extension
bun install --frozen-lockfile
bun run check
```

For optional status and provider routing controls, see the [provider dashboard](docs/provider-dashboard.md), [Gemini project pool](docs/GEMINI_POOL.md), and [Gemini Web status reader](docs/GEMINI_WEB.md).

## License

Watari and its VS Code extension use the [GNU Affero General Public License v3.0 or later](LICENSE). The generated types in `src/generated/codex/` come from [OpenAI Codex 0.169.0](https://github.com/openai/codex/tree/rust-v0.169.0) under the [Apache 2.0 license](licenses/openai-codex/LICENSE) and [upstream notice](licenses/openai-codex/NOTICE).
