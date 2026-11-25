import { existsSync, mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import type { ProjectContext } from "../models.ts";
import type { CheckoutFacts } from "../project/checkout-map.ts";
import { redactSecrets } from "../security/redaction.ts";
import type { TeamAgent, TeamHandoff, TeamSnapshot } from "../state/types.ts";
import { buildEntries, entriesMarkdown, speakerNames } from "../chat/entries.ts";
import { findingsReport } from "./review.ts";

/** The request id of a handoff an agent saved without an export asking for it. */
export const UNREQUESTED_HANDOFF = "unrequested";

export interface ChatExportInput {
  /** The whole chat, not the bounded live snapshot. */
  readonly snapshot: TeamSnapshot;
  readonly project: ProjectContext;
  readonly exportedAt: number;
  readonly checkout?: CheckoutFacts | null;
  /** What each agent handed over, when the export asked them. */
  readonly handoffs?: readonly TeamHandoff[];
}

/**
 * A chat as one Markdown document that any agent, anywhere, can continue from.
 *
 * It leads with what a successor needs first: the goal, the state of the
 * checkout, and each agent's own handoff under `## AGENT <alias>`. The team
 * state and the full conversation follow as the record behind them. Reasoning
 * is left out, as it is from `/copy all`, and secrets are redacted on the way
 * out because the file is meant to travel.
 */
export function chatExportMarkdown(input: ChatExportInput): string {
  const { snapshot } = input;
  const parts: string[] = [];
  const goal = snapshot.activeGoal;
  const title = goal ? firstLine(goal.instruction) : firstUserMessage(snapshot) ?? "Watari chat";
  parts.push(`# ${title}`);
  parts.push([
    `- Exported: ${new Date(input.exportedAt).toISOString()}`,
    `- Project: \`${input.project.repositoryRoot ?? input.project.launchDirectory}\``,
    ...(input.checkout?.branch ? [`- Branch: \`${input.checkout.branch}\``] : []),
    `- Agents: ${snapshot.agents.map(describeAgent).join(", ") || "none"}`,
    `- Messages: ${snapshot.messages.length}`,
  ].join("\n"));
  parts.push([
    "> To continue this work in any agent session, give it this file and ask it to",
    "> pick up from the handoffs below. Each `## AGENT` section is that agent's own",
    "> account of where it stopped. The conversation at the end is the full record.",
  ].join("\n"));

  parts.push("## Goal");
  parts.push(goal ? goal.instruction.trim() : "No shared goal is open.");

  if (input.checkout) {
    parts.push("## Checkout");
    const changes = input.checkout.changes;
    parts.push(changes.length === 0
      ? "The working tree was clean at export."
      : [
        `${changes.length} uncommitted path${changes.length === 1 ? "" : "s"} at export:`,
        "",
        ...changes.slice(0, 200).map((change) => `- \`${change.status}\` ${change.path}`),
        ...(changes.length > 200 ? [`- … and ${changes.length - 200} more`] : []),
      ].join("\n"));
  }

  for (const agent of handoffOrder(snapshot.agents, input.handoffs ?? [])) {
    const handoff = latestHandoff(input.handoffs ?? [], agent.id);
    if (!handoff) continue;
    parts.push(`## AGENT ${agent.id}`);
    parts.push(`_${describeAgent(agent)} · ${handoffSource(handoff)}_`);
    parts.push(handoff.content.trim() || "_No handoff was given._");
  }

  const teamState = teamStateMarkdown(snapshot);
  if (teamState) {
    parts.push("## Team state");
    parts.push(teamState);
  }

  parts.push("## Conversation");
  const conversation = entriesMarkdown(
    buildEntries(snapshot, null, Number.POSITIVE_INFINITY),
    speakerNames(snapshot.agents),
  );
  parts.push(conversation || "_Nothing was said in this chat._");

  return `${redactSecrets(parts.join("\n\n")).trimEnd()}\n`;
}

/** The team's standing state: claims, TODOs, open questions, and findings. */
function teamStateMarkdown(snapshot: TeamSnapshot): string {
  const sections: string[] = [];
  const claims = snapshot.claims.filter((claim) =>
    claim.state === "active" || claim.state === "proposed" || claim.state === "contested"
  );
  if (claims.length > 0) {
    sections.push([
      "### Claims",
      "",
      ...claims.map((claim) =>
        `- **${claim.claimant}** (${claim.state}): ${firstLine(claim.summary)}${
          claim.paths.length > 0 ? ` — ${claim.paths.map((path) => `\`${path}\``).join(", ")}` : ""
        }`
      ),
    ].join("\n"));
  }
  const todos = snapshot.todos ?? [];
  if (todos.length > 0) {
    sections.push([
      "### TODOs",
      "",
      ...todos.map((todo) =>
        `- [${todo.state === "done" ? "x" : " "}] #${todo.id} ${firstLine(todo.title)} (${todo.state}${
          todo.assignee ? `, ${todo.assignee}` : ""
        })${todo.note ? ` — ${firstLine(todo.note)}` : ""}`
      ),
    ].join("\n"));
  }
  if (snapshot.findings.length > 0) {
    // Demoted two levels so its groups sit under this section, not beside it.
    sections.push(findingsReport(snapshot.findings, null).replace(/^(#+) /gmu, "##$1 "));
  }
  return sections.join("\n\n");
}

function handoffOrder(agents: readonly TeamAgent[], handoffs: readonly TeamHandoff[]): readonly TeamAgent[] {
  const known = new Set(agents.map((agent) => agent.id));
  const extra = [...new Set(handoffs.map((handoff) => handoff.agent))]
    .filter((id) => !known.has(id))
    .map((id): TeamAgent => ({
      id,
      backend: "unknown",
      displayName: id,
      sessionId: null,
      state: "stopped",
      currentGoalId: null,
      updatedAt: 0,
      detail: null,
    }));
  return [...agents, ...extra];
}

function latestHandoff(handoffs: readonly TeamHandoff[], agent: string): TeamHandoff | null {
  const own = handoffs.filter((handoff) => handoff.agent === agent);
  return own.findLast((handoff) => handoff.source === "tool") ?? own.findLast((handoff) => handoff.source === "reply") ?? own.at(-1) ?? null;
}

function handoffSource(handoff: TeamHandoff): string {
  if (handoff.source === "tool") return "written for this export";
  if (handoff.source === "reply") return "taken from its reply to the export request";
  return "did not answer the export request";
}

function describeAgent(agent: TeamAgent): string {
  const details = [agent.provider, agent.model, agent.effort].filter((part): part is string => Boolean(part));
  return details.length > 0 ? `${agent.id} (${details.join(", ")})` : agent.id;
}

function firstUserMessage(snapshot: TeamSnapshot): string | null {
  const message = snapshot.messages.find((candidate) => candidate.sender === "user");
  return message ? firstLine(message.body) : null;
}

function firstLine(value: string): string {
  const line = value.trim().split("\n")[0]?.trim() ?? "";
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
}

/** Asks a peer for what someone else would need to continue its work. */
export function handoffPrompt(requestId: string): string {
  return [
    `The user is exporting this chat (export ${requestId}) so the work can be continued in another session, possibly by a different agent that has none of your context.`,
    "",
    "Call team_handoff once with a self-contained Markdown handoff. Cover:",
    "- what you were asked to do and what you actually did, with file paths",
    "- the current state: what is finished, what is half-done, what is untested",
    "- decisions you made and why, and approaches you ruled out",
    "- open problems, risks, and the exact next steps you would take",
    "- anything a successor must know that is not in the code or the chat",
    "",
    "Write it for a reader who starts cold. Do not paste whole files. After the handoff, carry on only if you are in the middle of work the user asked for. Otherwise end your turn.",
  ].join("\n");
}

/**
 * Where an export goes. A given path is read from the launch directory, and a
 * directory gets a dated file inside it. No path means the project's private
 * `exports/` directory.
 */
export function resolveExportPath(options: {
  readonly requested?: string | null;
  readonly launchDirectory: string;
  readonly exportsDirectory: string | null;
  readonly kind: "chat" | "handoff";
  readonly at?: number;
}): string {
  const stamp = new Date(options.at ?? Date.now()).toISOString().replaceAll(":", "-").replace(/\.\d+Z$/u, "Z");
  const name = `${stamp}-${options.kind}.md`;
  const requested = options.requested?.trim();
  if (requested) {
    const target = resolve(options.launchDirectory, requested);
    return existsSync(target) && statSync(target).isDirectory() ? join(target, name) : target;
  }
  if (!options.exportsDirectory) throw new Error("give the export a file path");
  return join(options.exportsDirectory, name);
}

/** Writes an export whole or not at all, private to the user. */
export function writeExportFile(path: string, markdown: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const staging = `${path}.${process.pid}.tmp`;
  writeFileSync(staging, markdown, { encoding: "utf8", mode: 0o600 });
  renameSync(staging, path);
}
