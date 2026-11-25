/**
 * Human labels for provider tool activity.
 *
 * Providers describe their work with internal identifiers: Claude sends
 * `Bash` with a JSON input, Codex sends a `commandExecution` thread item. The
 * transcript should read like a work log instead, so both adapters funnel their
 * tool activity through here and emit one short verb plus the thing it acted
 * on. Nothing here inspects a provider UI; these are the documented payloads.
 */
export interface ToolLabel {
  readonly verb: string;
  readonly detail: string;
}

const MAX_DETAIL = 160;

const CLAUDE_VERBS: Record<string, string> = {
  Bash: "bash",
  BashOutput: "bash",
  KillShell: "bash",
  Read: "read",
  Write: "write",
  Edit: "edit",
  MultiEdit: "edit",
  NotebookEdit: "edit",
  Glob: "find",
  Grep: "search",
  WebFetch: "fetch",
  WebSearch: "web",
  Task: "task",
  TodoWrite: "plan",
  ExitPlanMode: "plan",
};

export function describeClaudeTool(name: string, input: unknown): ToolLabel {
  const record = isRecord(input) ? input : {};
  const teamTool = teamToolName(name);
  if (teamTool) {
    return { verb: "team", detail: clip(teamTool) };
  }
  const verb = CLAUDE_VERBS[name] ?? name.toLowerCase();
  const detail =
    firstString(record, [
      "command",
      "file_path",
      "notebook_path",
      "pattern",
      "url",
      "query",
      "description",
      "prompt",
    ]) ?? "";
  return { verb, detail: clip(detail) };
}

/** `mcp__watari__team_status` reads as `team status`, not as a symbol. */
function teamToolName(name: string): string | null {
  const match = /^mcp__(?<server>[^_]+(?:_[^_]+)*)__(?<tool>.+)$/u.exec(name);
  if (!match?.groups) return null;
  const tool = match.groups.tool ?? "";
  const server = match.groups.server ?? "";
  const readable = tool.replace(/_/gu, " ");
  return server === "watari" ? readable : `${server} ${readable}`;
}

export function describeCodexItem(item: Record<string, unknown>): ToolLabel | null {
  const type = typeof item.type === "string" ? item.type : "";
  switch (type) {
    case "commandExecution":
      return { verb: "bash", detail: clip(commandText(item.command)) };
    case "fileChange":
      return { verb: "edit", detail: clip(changedPaths(item.changes)) };
    case "mcpToolCall": {
      const server = typeof item.server === "string" ? item.server : "mcp";
      const tool = typeof item.tool === "string" ? item.tool.replace(/_/gu, " ") : "call";
      return { verb: server === "watari" ? "team" : "mcp", detail: clip(server === "watari" ? tool : `${server} ${tool}`) };
    }
    case "dynamicToolCall": {
      const tool = typeof item.tool === "string" ? item.tool.replace(/_/gu, " ") : "call";
      return { verb: "team", detail: clip(tool) };
    }
    case "webSearch":
      return { verb: "web", detail: clip(typeof item.query === "string" ? item.query : "") };
    case "imageGeneration":
      return { verb: "image", detail: "" };
    case "sleep":
      return { verb: "wait", detail: "" };
    default:
      return null;
  }
}

function commandText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.filter((part): part is string => typeof part === "string").join(" ");
  }
  return "";
}

function changedPaths(value: unknown): string {
  if (!Array.isArray(value)) return "";
  const paths = value
    .map((change) => (isRecord(change) && typeof change.path === "string" ? change.path : null))
    .filter((path): path is string => path !== null);
  if (paths.length <= 2) return paths.join("  ");
  return `${paths.slice(0, 2).join("  ")}  +${paths.length - 2} more`;
}

function firstString(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") {
      return value;
    }
  }
  return null;
}

/** Tool arguments can be whole scripts; the transcript only shows the head. */
function clip(value: string): string {
  const flat = value.replace(/\s+/gu, " ").trim();
  return flat.length <= MAX_DETAIL ? flat : `${flat.slice(0, MAX_DETAIL - 1)}…`;
}

export function formatToolLabel(label: ToolLabel): string {
  return label.detail ? `${label.verb}  ${label.detail}` : label.verb;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
