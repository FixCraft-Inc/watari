import type { AgentId } from "../models.ts";
import { isAgentAlias } from "../team/identity.ts";
import { reviewGoal } from "../team/review.ts";
import {
  SUPPORTED_PROVIDERS,
  parseAgentDefinition,
  type AgentDefinitionUpdate,
} from "../team/roster.ts";

export type ParsedAction =
  | { readonly type: "send"; readonly target: "all" | AgentId; readonly text: string }
  | { readonly type: "interrupt"; readonly agent: AgentId }
  /** Interrupt a native turn: one peer, every working peer, or the focused one. */
  | { readonly type: "stop"; readonly agent: AgentId | "all" | null }
  /** Forget one agent's provider conversation, or every agent's. The chat stays. */
  | { readonly type: "clear"; readonly agent: AgentId | "all" }
  | { readonly type: "save" }
  | { readonly type: "export"; readonly handoff: boolean; readonly path: string | null }
  | { readonly type: "chats" }
  | { readonly type: "resume"; readonly chat: string }
  | { readonly type: "restart"; readonly agent: AgentId }
  | {
      readonly type: "approval";
      readonly agent: AgentId;
      readonly requestId: string;
      readonly decision: "accept" | "decline" | "cancel";
    }
  | { readonly type: "copy"; readonly scope: "last" | "all" | "goal" | "code" | "findings" }
  | { readonly type: "check" }
  | { readonly type: "agents" }
  | { readonly type: "questions" }
  | { readonly type: "models"; readonly agent?: AgentId }
  | { readonly type: "effort"; readonly agent: AgentId }
  | { readonly type: "new_chat" }
  | { readonly type: "agent_configure"; readonly definition: AgentDefinitionUpdate }
  | { readonly type: "agent_remove"; readonly agent: AgentId }
  | { readonly type: "status" }
  | { readonly type: "providers" }
  | { readonly type: "help" }
  | { readonly type: "complete" }
  | { readonly type: "detach" }
  | { readonly type: "quit" }
  | { readonly type: "unknown"; readonly input: string };

export interface CommandDoc {
  readonly usage: string;
  readonly description: string;
  /** Other spellings that reach the same action, so typing one finds it. */
  readonly aliases?: readonly string[];
  /** Contextual values offered for each argument, in order. */
  readonly completions?: readonly CommandArgumentCompletion[];
  /** Commands about the chat itself, which the help panel lists on their own. */
  readonly group?: "chat";
}

type CommandArgumentCompletion = "peer" | "peer-or-all" | "provider" | "chat" | readonly string[] | null;

export interface CommandPeer {
  readonly id: AgentId;
  /** Provider/model detail shown beside the configured identity. */
  readonly description?: string;
}

/** An archived chat as `/resume` offers it. */
export interface CommandChat {
  readonly id: string;
  readonly title: string;
  readonly current?: boolean;
}

export interface CommandSuggestion extends CommandDoc {
  /** Exact composer value inserted by Tab. */
  readonly completion: string;
}

/** Single source of truth for the help overlay and the composer hints. */
export const COMMANDS: readonly CommandDoc[] = [
  { usage: "/all <text>", description: "send to every peer" },
  { usage: "/to <peer> <text>", description: "send to one peer", completions: ["peer", null] },
  { usage: "/goal <text>", description: "state the shared goal" },
  { usage: "/review [scope]", description: "team review with cross-checks" },
  { usage: "/done", description: "close the current goal" },
  {
    usage: "/stop [peer|all]",
    description: "interrupt a working turn",
    aliases: ["/interrupt"],
    completions: ["peer-or-all"],
  },
  {
    usage: "/retry <peer>",
    description: "restart the harness, keep its context",
    aliases: ["/restart"],
    completions: ["peer"],
  },
  { usage: "/approve [peer id]", description: "allow this request", completions: ["peer", null] },
  { usage: "/decline [peer id]", description: "refuse this request", completions: ["peer", null] },
  { usage: "/cancel [peer id]", description: "cancel this request", completions: ["peer", null] },
  {
    usage: "/copy [scope]",
    description: "reply, chat, code, findings",
    completions: [["all", "goal", "code", "findings"]],
    group: "chat",
  },
  { usage: "/check", description: "re-test configured team bridges", aliases: ["/mcp"] },
  { usage: "/agents", description: "show agent/provider configuration" },
  { usage: "/questions", description: "answer waiting native questions" },
  {
    usage: "/models [peer]",
    description: "add an agent, or change its model",
    completions: ["peer"],
  },
  {
    usage: "/model [peer]",
    description: "change the active agent's model",
    completions: ["peer"],
  },
  {
    usage: "/effort [peer]",
    description: "choose native effort for an agent",
    completions: ["peer"],
  },
  {
    usage: "/clear <peer|all>",
    description: "fresh agent context, keep the chat",
    completions: ["peer-or-all"],
    group: "chat",
  },
  { usage: "/new", description: "archive, start a new chat", group: "chat" },
  { usage: "/save", description: "write the chat archive now", group: "chat" },
  { usage: "/export [path]", description: "write the chat as Markdown", group: "chat" },
  { usage: "/handoff [path]", description: "export with agent handoffs", group: "chat" },
  { usage: "/chats", description: "list archived chats", aliases: ["/history"], group: "chat" },
  { usage: "/resume <chat>", description: "reopen an archived chat", completions: ["chat"], group: "chat" },
  {
    usage: "/agent add <peer> <provider>",
    description: "add or change one agent",
    aliases: ["/agent set"],
    completions: [null, "provider"],
  },
  {
    usage: "/agent remove <peer>",
    description: "remove a configured agent/tab",
    aliases: ["/model remove"],
    completions: ["peer"],
  },
  { usage: "/status", description: "roster and goal in footer", aliases: ["/roster"] },
  { usage: "/providers", description: "provider capacity, routing, and use order" },
  { usage: "/help", description: "open this panel", aliases: ["/keys"] },
  { usage: "/detach", description: "close the ui; active work continues" },
  { usage: "/quit", description: "stop the service and peers" },
];

export const KEYS: readonly CommandDoc[] = [
  { usage: "ctrl+q", description: "answer waiting native questions" },
  { usage: "drag", description: "select text to copy" },
  { usage: "right click", description: "copy selection or last reply" },
  { usage: "ctrl+shift+c", description: "copy selection or last reply" },
  { usage: "ctrl+y", description: "copy if ctrl+shift+c is taken" },
  { usage: "shift+drag", description: "select with the terminal instead" },
  { usage: "ctrl+c", description: "clear, then again to detach" },
  { usage: "ctrl+d", description: "detach from an empty composer" },
  { usage: "alt+←  alt+→", description: "previous or next chat" },
  { usage: "←  →", description: "switch chat when empty" },
  { usage: "ctrl+1..9", description: "jump to a chat by number" },
  { usage: "ctrl+t", description: "jump to global" },
  { usage: "ctrl+b", description: "toggle the side panel" },
  { usage: "ctrl+p", description: "agent and model setup" },
  { usage: "ctrl+m", description: "model and effort for this chat" },
  { usage: "pgup  pgdn", description: "scroll the transcript" },
  { usage: "↑  ↓", description: "recall sent messages when empty" },
  { usage: "@peer text", description: "send to one peer from any tab" },
  { usage: "ctrl+g", description: "open or close this panel" },
  { usage: "esc", description: "drop selection, or close this" },
];

/** The approval the strip is currently showing, if any. */
export interface PendingApproval {
  readonly agent: AgentId;
  readonly requestId: string;
}

export function parseCommand(
  text: string,
  tab: number,
  agents: readonly AgentId[] = ["codex", "claude"],
  pending: PendingApproval | null = null,
): ParsedAction {
  if (!text.startsWith("/")) {
    // `@peer text` addresses one peer from whichever tab the reader is on.
    const mention = /^@([A-Za-z0-9][A-Za-z0-9_.-]*)\s+(\S[\s\S]*)$/u.exec(text);
    const named = mention ? agents.find((agent) => agent.toLowerCase() === mention[1]!.toLowerCase()) : undefined;
    if (mention && named) return { type: "send", target: named, text: mention[2]!.trim() };
    return { type: "send", target: targetForTab(tab, agents), text };
  }

  const [head = "", ...rest] = text.split(/\s+/u);
  const tail = text.slice(head.length).trim();

  switch (head) {
    case "/quit":
      return { type: "quit" };
    case "/detach":
      return { type: "detach" };
    case "/status":
    case "/roster":
      return { type: "status" };
    case "/providers":
      return rest.length === 0 ? { type: "providers" } : { type: "unknown", input: text };
    case "/help":
    case "/keys":
      return { type: "help" };
    case "/done":
      return { type: "complete" };
    case "/new":
      return rest.length === 0 ? { type: "new_chat" } : { type: "unknown", input: text };
    case "/clear": {
      // Never implicit: wiping a context names who it is for.
      const agent = rest[0] ?? "";
      if (rest.length !== 1) return { type: "unknown", input: text };
      return agent === "all" || isAgentAlias(agent) ? { type: "clear", agent } : { type: "unknown", input: text };
    }
    case "/save":
      return rest.length === 0 ? { type: "save" } : { type: "unknown", input: text };
    case "/export":
    case "/handoff":
      return { type: "export", handoff: head === "/handoff", path: tail || null };
    case "/chats":
    case "/history":
      return { type: "chats" };
    case "/resume":
      return tail ? { type: "resume", chat: tail } : { type: "chats" };
    case "/stop": {
      if (rest.length > 1) return { type: "unknown", input: text };
      const agent = rest[0];
      if (agent === undefined) return { type: "stop", agent: null };
      return agent === "all" || isAgentAlias(agent) ? { type: "stop", agent } : { type: "unknown", input: text };
    }
    case "/check":
    case "/mcp":
      return { type: "check" };
    case "/agents":
      return { type: "agents" };
    case "/questions":
      return { type: "questions" };
    case "/models": {
      if (rest.length === 0) return { type: "models" };
      const agent = rest[0] ?? "";
      return isAgentAlias(agent) && rest.length === 1
        ? { type: "models", agent }
        : { type: "unknown", input: text };
    }
    case "/model": {
      if (rest[0] === "remove") {
        const agent = rest[1] ?? "";
        return isAgentAlias(agent) && rest.length === 2
          ? { type: "agent_remove", agent }
          : { type: "unknown", input: text };
      }
      if (rest.length > 1) return { type: "unknown", input: text };
      const agent = rest[0] ?? (targetForTab(tab, agents) === "all" ? agents[0] : targetForTab(tab, agents));
      return agent !== "all" && isAgentAlias(agent)
        ? { type: "models", agent }
        : { type: "unknown", input: text };
    }
    case "/effort": {
      if (rest.length > 1) return { type: "unknown", input: text };
      const agent = rest[0] ?? (targetForTab(tab, agents) === "all" ? agents[0] : targetForTab(tab, agents));
      return agent !== "all" && isAgentAlias(agent)
        ? { type: "effort", agent }
        : { type: "unknown", input: text };
    }
    case "/agent":
      return parseAgentCommand(rest, text);
    case "/copy": {
      const scope = rest[0] ?? "";
      if (scope === "" ) return { type: "copy", scope: "last" };
      if (scope === "all" || scope === "goal" || scope === "code" || scope === "findings") {
        return { type: "copy", scope };
      }
      return { type: "unknown", input: text };
    }
    case "/all":
    case "/goal":
      return tail ? { type: "send", target: "all", text: tail } : { type: "unknown", input: text };
    case "/review":
      // Every peer reviews, whichever tab it was typed in: the point is
      // splitting the work and checking each other.
      return { type: "send", target: "all", text: reviewGoal(tail) };
    case "/retry":
    case "/restart": {
      const agent = rest[0] ?? (targetForTab(tab, agents) === "all" ? "" : targetForTab(tab, agents));
      return isAgentAlias(agent) && rest.length <= 1
        ? { type: "restart", agent }
        : { type: "unknown", input: text };
    }
    case "/to": {
      const agent = rest[0] ?? "";
      const body = tail.slice(agent.length).trim();
      return isAgentAlias(agent) && body
        ? { type: "send", target: agent, text: body }
        : { type: "unknown", input: text };
    }
    case "/interrupt": {
      if (rest.length === 0) return { type: "stop", agent: null };
      const agent = rest[0] ?? "";
      return isAgentAlias(agent) && rest.length === 1
        ? { type: "interrupt", agent }
        : { type: "unknown", input: text };
    }
    case "/approve":
    case "/decline":
    case "/cancel": {
      const decision = head === "/approve" ? "accept" : head === "/decline" ? "decline" : "cancel";
      // Bare `/approve` answers the request the strip is showing. The peer and
      // id are still accepted in full, which is what a second pending request
      // or a scripted answer needs.
      if (rest.length === 0) {
        return pending
          ? { type: "approval", agent: pending.agent, requestId: pending.requestId, decision }
          : { type: "unknown", input: text };
      }
      const agent = rest[0] ?? "";
      const requestId = rest[1] ?? "";
      if (!isAgentAlias(agent) || !requestId || rest.length !== 2) {
        return { type: "unknown", input: text };
      }
      return { type: "approval", agent, requestId, decision };
    }
    default:
      return { type: "unknown", input: text };
  }
}

/**
 * Completes both command phrases and their contextual arguments.
 *
 * A route such as `/agent remove <peer>` has two distinct completion stages:
 * first `remove`, then one of the live configured identities. Keeping those
 * stages explicit prevents whitespace from turning the palette off and keeps
 * Tab from collapsing every `/agent …` command back to `/agent `.
 */
export function commandSuggestions(
  input: string,
  peers: readonly (AgentId | CommandPeer)[] = ["codex", "claude"],
  chats: readonly CommandChat[] = [],
): readonly CommandSuggestion[] {
  if (input.startsWith("@")) return mentionSuggestions(input, peers);
  if (!input.startsWith("/")) return [];
  const query = input.toLowerCase();
  const peerChoices = peers.map((peer) =>
    typeof peer === "string" ? { id: peer } : peer
  );
  const suggestions: CommandSuggestion[] = [];

  for (const command of COMMANDS) {
    for (const route of commandRoutes(command)) {
      if (route.alias && query === "/") continue;
      if (route.path.startsWith(query)) {
        suggestions.push({
          ...command,
          usage: routeUsage(command, route.path),
          completion: route.path + (hasArguments(command) ? " " : ""),
        });
        continue;
      }
      const argumentPrefix = `${route.path} `;
      if (!query.startsWith(argumentPrefix)) continue;
      suggestions.push(
        ...argumentSuggestions(
          command,
          route.path,
          input.slice(argumentPrefix.length),
          peerChoices,
          chats,
        ),
      );
    }
  }

  const seen = new Set<string>();
  return suggestions.filter((suggestion) => {
    if (seen.has(suggestion.completion)) return false;
    seen.add(suggestion.completion);
    return true;
  });
}

/**
 * How a known command is spelled, for when one was typed with the wrong
 * arguments. Saying "usage: /to <peer> <text>" is the difference between a
 * typo costing one keystroke and costing a trip to the help panel.
 */
export function usageFor(input: string): string | null {
  const query = input.trim().toLowerCase();
  if (!query.startsWith("/")) return null;
  const matches = COMMANDS.flatMap((command) =>
    commandRoutes(command).map((route) => ({ command, route }))
  )
    .filter(({ route }) => query === route.path || query.startsWith(`${route.path} `))
    .sort((left, right) => right.route.path.length - left.route.path.length);
  return matches[0]?.command.usage ?? null;
}

export function completeCommand(command: CommandDoc | CommandSuggestion): string {
  if ("completion" in command) return command.completion;
  const path = commandPath(command);
  return path + (hasArguments(command) ? " " : "");
}

function commandPath(command: CommandDoc): string {
  const argument = command.usage.search(/\s(?:<|\[)/u);
  return (argument < 0 ? command.usage : command.usage.slice(0, argument)).toLowerCase();
}

function hasArguments(command: CommandDoc): boolean {
  return commandPath(command).length < command.usage.length;
}

function commandRoutes(command: CommandDoc): readonly { readonly path: string; readonly alias: boolean }[] {
  return [
    { path: commandPath(command), alias: false },
    ...(command.aliases ?? []).map((alias) => ({ path: alias.toLowerCase(), alias: true })),
  ];
}

function routeUsage(command: CommandDoc, path: string): string {
  if (!path.includes(" ") && path !== commandPath(command)) return command.usage;
  return `${path}${command.usage.slice(commandPath(command).length)}`;
}

function argumentSuggestions(
  command: CommandDoc,
  path: string,
  remainder: string,
  peers: readonly CommandPeer[],
  chats: readonly CommandChat[],
): readonly CommandSuggestion[] {
  const trailingSpace = /\s$/u.test(remainder);
  const values = remainder.trim() === "" ? [] : remainder.trim().split(/\s+/u);
  const argumentIndex = trailingSpace ? values.length : Math.max(0, values.length - 1);
  const completed = trailingSpace ? values : values.slice(0, -1);
  const prefix = trailingSpace ? "" : values.at(-1)?.toLowerCase() ?? "";
  const completion = command.completions?.[argumentIndex];
  if (completion === undefined || completion === null) return [];

  const choices: readonly { readonly value: string; readonly description?: string }[] =
    completion === "peer" || completion === "peer-or-all"
      ? [
          ...peers
            .filter((peer) => peer.id.toLowerCase().startsWith(prefix))
            .map((peer) => ({ value: peer.id, ...(peer.description ? { description: peer.description } : {}) })),
          ...(completion === "peer-or-all" && "all".startsWith(prefix)
            ? [{ value: "all", description: "every agent" }]
            : []),
        ]
      : completion === "chat"
      ? chats
          .filter((chat) => !chat.current && chat.id.toLowerCase().includes(prefix))
          .map((chat) => ({ value: chat.id, description: chat.title }))
      : completion === "provider"
      ? SUPPORTED_PROVIDERS
          .filter((provider) => provider.startsWith(prefix))
          .map((provider) => ({ value: provider, description: `${provider} native harness` }))
      : completion
          .filter((choice) => choice.startsWith(prefix))
          .map((choice) => ({ value: choice }));
  const needsNextArgument = argumentIndex + 1 < (command.completions?.length ?? 0);

  return choices.map((choice) => {
    const value = [path, ...completed, choice.value].join(" ");
    return {
      ...command,
      usage: value,
      description: choice.description ?? command.description,
      completion: value + (needsNextArgument ? " " : ""),
    };
  });
}

/** `@co` offers the peers whose alias starts that way, completed with a space. */
function mentionSuggestions(
  input: string,
  peers: readonly (AgentId | CommandPeer)[],
): readonly CommandSuggestion[] {
  const match = /^@([A-Za-z0-9_.-]*)$/u.exec(input);
  if (!match) return [];
  const prefix = match[1]!.toLowerCase();
  return peers
    .map((peer) => (typeof peer === "string" ? { id: peer } : peer))
    .filter((peer) => peer.id.toLowerCase().startsWith(prefix))
    .map((peer) => ({
      usage: `@${peer.id}`,
      description: peer.description ?? `send to ${peer.id} from any tab`,
      completion: `@${peer.id} `,
    }));
}

export function targetForTab(tab: number, agents: readonly AgentId[] = ["codex", "claude"]): "all" | AgentId {
  return tab <= 0 ? "all" : agents[tab - 1] ?? "all";
}

function parseAgentCommand(parts: readonly string[], original: string): ParsedAction {
  const [operation, alias, provider, ...settings] = parts;
  if (operation === "remove" && isAgentAlias(alias) && parts.length === 2) {
    return { type: "agent_remove", agent: alias };
  }
  if ((operation !== "add" && operation !== "set") || !isAgentAlias(alias) || !provider) {
    return { type: "unknown", input: original };
  }
  const values = new Map(settings.map((setting) => {
    const separator = setting.indexOf("=");
    return separator > 0 ? [setting.slice(0, separator), setting.slice(separator + 1)] : ["model", setting];
  }));
  if (
    [...values.keys()].some((key) => !["model", "effort", "mode", "permissions"].includes(key)) ||
    (values.has("permissions") && !["bypass", "prompt"].includes(values.get("permissions") ?? ""))
  ) {
    return { type: "unknown", input: original };
  }
  try {
    const { unrestricted, ...definition } = parseAgentDefinition({
      alias,
      provider,
      ...(values.get("model") ? { model: values.get("model") } : {}),
      ...(values.get("effort") ? { effort: values.get("effort") } : {}),
      ...(values.get("mode") ? { mode: values.get("mode") } : {}),
      ...(values.has("permissions") ? { unrestricted: values.get("permissions") === "bypass" } : {}),
    });
    return {
      type: "agent_configure",
      definition: { ...definition, ...(values.has("permissions") ? { unrestricted } : {}) },
    };
  } catch {
    return { type: "unknown", input: original };
  }
}
