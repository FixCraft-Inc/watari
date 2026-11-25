import { z } from "zod";

import { isAgentAlias } from "./team/identity.ts";

export const TaskClassSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u);
const alias = z.string().refine(isAgentAlias, "invalid agent alias");

/** Project-owned roles stay attached to an alias when its harness changes. */
export const ProjectTaskPolicySchema = z.strictObject({
  classes: z.record(TaskClassSchema, z.strictObject({
    description: z.string().trim().min(1).max(1_000).optional(),
    /** Ordered allowlist. An unavailable alias is skipped, never substituted. */
    agents: z.array(alias).min(1).max(64).refine(
      (agents) => new Set(agents.map((id) => id.toLowerCase())).size === agents.length,
      "task class repeats an agent",
    ),
  })).refine((classes) => Object.keys(classes).length > 0 && Object.keys(classes).length <= 64,
    "task policy needs 1-64 classes"),
  agents: z.record(alias, z.strictObject({
    role: z.string().trim().min(1).max(256).optional(),
    guidance: z.string().trim().min(1).max(4_000).optional(),
    requireTaskClass: z.boolean().optional(),
    /** Exclusive within this project's team_job ledger. */
    resource: z.string().trim().min(1).max(256).refine(
      (value) => !value.includes("\0"), "resource must not contain NUL",
    ).optional(),
  })).refine((agents) => Object.keys(agents).length <= 64, "task policy allows at most 64 agent roles"),
});

export type ProjectTaskPolicy = z.infer<typeof ProjectTaskPolicySchema>;

export interface TaskCandidate {
  readonly id: string;
  readonly available: boolean;
}

export interface TaskChoice {
  readonly agent: string | null;
  readonly blocked: string | null;
}

/** No model names, provider ranking, or automatic downgrade lives here. */
export function planTaskAssignment(
  policy: ProjectTaskPolicy | undefined,
  taskClass: string,
  candidates: readonly TaskCandidate[],
): TaskChoice {
  const rule = policy && Object.hasOwn(policy.classes, taskClass) ? policy.classes[taskClass] : undefined;
  if (!rule) return { agent: null, blocked: `task class ${taskClass} is not configured for this project` };
  const agent = rule.agents.find((id) => candidates.some((peer) => peer.id === id && peer.available));
  return agent
    ? { agent, blocked: null }
    : { agent: null, blocked: `no permitted agent is available for ${taskClass} work (${rule.agents.join(", ")})` };
}

/** Classified direct sends are allowlist checks, never silent reroutes. */
export function checkTaskAssignment(
  policy: ProjectTaskPolicy | undefined,
  taskClass: string,
  recipient: string,
): void {
  const choice = planTaskAssignment(policy, taskClass, [{ id: recipient, available: true }]);
  if (!choice.agent) throw new Error(`cannot delegate ${taskClass} work to ${recipient}: ${choice.blocked}`);
}

export function describeTaskPolicy(policy: ProjectTaskPolicy | undefined): string | null {
  if (!policy) return null;
  return [
    "Project delegation policy (agent aliases in preference order):",
    ...Object.entries(policy.classes).map(([name, rule]) =>
      `${name}: ${rule.agents.join(" > ")}${rule.description ? `. ${rule.description}` : ""}`),
    "Use task_class when delegating. Omit to for automatic selection among available permitted peers. No permitted peer means the task is blocked.",
  ].join("\n");
}
