import type { TeamFinding, TeamGoal } from "../state/types.ts";

/** What `/review` reviews when the user names nothing. */
export const DEFAULT_REVIEW_SCOPE =
  "the uncommitted changes in this checkout (git status and git diff) and the code they affect";

/**
 * The goal `/review` opens.
 *
 * Two agents reading the same code and reporting separately is two opinions,
 * not a better review. What a team adds is coverage from splitting the work
 * and precision from checking each other's findings against the source, so
 * the protocol asks for exactly those two things and for a report that keeps
 * confirmed, disputed, and unchecked findings apart. It is the user's goal
 * text, shown in the transcript like any other, not a hidden instruction.
 */
export function reviewGoal(scope: string): string {
  const target = scope.trim() || DEFAULT_REVIEW_SCOPE;
  return `Review ${target}.

Run this as a team review. It is review only: do not edit files until the user asks for fixes.
1. Split: the intake coordinator divides the scope into areas with team_todo, one owner each, so peers work in parallel, and sends each peer its areas with team_send.
2. Review your areas independently against the real source, tests, and project instructions. Record each real defect with team_finding: severity, a file:line scope, and evidence another peer can check (the failing input, the code path, or command output). Skip style preferences unless they hide a bug.
3. Cross-check: verify every finding another peer recorded, using team_finding_update with verdict confirmed or refuted and your evidence. Answer a refutation of your own finding by withdrawing it (disposition dismissed) or replying with evidence.
4. Report: once every finding has a verdict, the intake coordinator writes the final report in its chat: confirmed findings by severity with file:line, disputed ones with both sides, and anything not covered.`;
}

const SEVERITY_ORDER: readonly TeamFinding["severity"][] = ["critical", "high", "medium", "low", "info"];

type FindingGroup = "confirmed" | "disputed" | "unverified" | "resolved" | "withdrawn";

const GROUP_TITLES: Readonly<Record<FindingGroup, string>> = {
  confirmed: "Confirmed by another peer",
  disputed: "Disputed",
  unverified: "Not yet checked by another peer",
  resolved: "Resolved",
  withdrawn: "Withdrawn",
};

/** Where a finding stands, from its disposition and its peers' verdicts. */
export function findingGroup(finding: TeamFinding): FindingGroup {
  if (finding.disposition === "dismissed") return "withdrawn";
  if (finding.disposition === "resolved") return "resolved";
  const verdicts = finding.verdicts ?? [];
  if (verdicts.some((entry) => entry.verdict === "refuted")) return "disputed";
  if (verdicts.some((entry) => entry.verdict === "confirmed")) return "confirmed";
  return "unverified";
}

/**
 * The team's findings as Markdown the user can paste into an issue or a PR.
 *
 * Findings are grouped by how far they were checked, then ordered by severity,
 * so the part worth acting on first is at the top. Evidence is clipped, since
 * the full text stays in Watari's state and archive.
 */
export function findingsReport(
  findings: readonly TeamFinding[],
  goal: Pick<TeamGoal, "instruction"> | null = null,
): string {
  if (findings.length === 0) return "No findings recorded.";
  const lines = [`# Findings (${findings.length})`];
  if (goal) lines.push("", `Goal: ${firstLine(goal.instruction, 200)}`);
  for (const group of Object.keys(GROUP_TITLES) as FindingGroup[]) {
    const members = findings
      .filter((finding) => findingGroup(finding) === group)
      .sort((left, right) =>
        SEVERITY_ORDER.indexOf(left.severity) - SEVERITY_ORDER.indexOf(right.severity) ||
        left.createdAt - right.createdAt
      );
    if (members.length === 0) continue;
    lines.push("", `## ${GROUP_TITLES[group]} (${members.length})`);
    for (const finding of members) lines.push("", ...findingLines(finding));
  }
  return lines.join("\n");
}

function findingLines(finding: TeamFinding): string[] {
  const verdicts = finding.verdicts ?? [];
  const checks = verdicts.map((entry) => `${entry.verdict} by ${entry.reviewer}`);
  const byline = [`by ${finding.author}`, ...checks].join(", ");
  const lines = [
    `- **${finding.severity}** ${oneLine(finding.summary)} (${byline}, \`${finding.id.slice(0, 8)}\`)`,
  ];
  if (finding.scope) lines.push(`  - Scope: ${oneLine(finding.scope)}`);
  if (finding.evidence) lines.push(`  - Evidence: ${firstLine(finding.evidence, 600)}`);
  for (const entry of verdicts) {
    if (entry.evidence) lines.push(`  - ${entry.reviewer} (${entry.verdict}): ${firstLine(entry.evidence, 400)}`);
  }
  return lines;
}

function oneLine(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

function firstLine(text: string, limit: number): string {
  const line = oneLine(text);
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}
