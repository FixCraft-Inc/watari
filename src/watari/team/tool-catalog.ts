import { z } from "zod";
import { TaskClassSchema } from "../task-policy.ts";

export interface TeamToolCatalogEntry {
  readonly name: string;
  readonly description: string;
  readonly inputShape: Readonly<Record<string, z.ZodType>>;
  readonly inputSchema: Record<string, unknown>;
  readonly validateInput: (input: unknown) => Record<string, unknown>;
}

function definition(
  name: string,
  description: string,
  inputShape: Readonly<Record<string, z.ZodType>>,
): TeamToolCatalogEntry {
  const validator = z.object(inputShape);
  return {
    name,
    description,
    inputShape,
    inputSchema: z.toJSONSchema(validator),
    validateInput: (input) => validator.parse(input) as Record<string, unknown>,
  };
}

const recipient = z.union([z.string(), z.array(z.string())]);

/**
 * One canonical catalog drives Codex dynamic tools and both MCP transports.
 *
 * Every definition travels with every model request of every peer, so a
 * description names what the tool does and the one rule a model would get
 * wrong without it. How to use the tools together lives in the agent protocol,
 * which a managed peer reads once per session.
 */
export const TEAM_TOOL_CATALOG: readonly TeamToolCatalogEntry[] = [
  definition("team_roster", "Your identity, peers, live state, and project delegation policy with ordered agent choices and role guidance.", {}),
  definition(
    "team_status",
    "Compact team view: peers, goal, questions you owe or await, open claims, TODOs, findings, wakes.",
    {},
  ),
  definition("team_goal", "Read the exact active shared goal.", {}),
  definition(
    "team_send",
    "Message peers, who never see your chat output. task_class must name a project class from team_roster and permits only its configured agents. Omit to to select the first available permitted peer. Explicit recipients are never rerouted. expects_reply asks a question, reply_to answers one. Normal batches, urgent goes first, stop interrupts a managed turn. Returns when each peer reads it.",
    {
      to: recipient.optional(),
      message: z.string().min(1).max(32_000),
      reply_to: z.number().int().positive().optional(),
      expects_reply: z.boolean().optional(),
      kind: z.enum(["peer", "review"]).optional(),
      priority: z.enum(["normal", "urgent", "stop"]).optional(),
      priority_reason: z.string().min(1).max(4_000).optional(),
      task_class: TaskClassSchema.optional(),
    },
  ),
  definition(
    "team_inbox",
    "Return unread mail and mark it read. Managed peers get mail pushed, so use after_id (20 per page, limit up to 100) only to look history up.",
    {
      after_id: z.number().int().nonnegative().optional(),
      limit: z.number().int().positive().max(100).optional(),
      acknowledge_through: z.number().int().nonnegative().optional(),
    },
  ),
  definition(
    "team_activity",
    "Recent command and edit summaries, optionally for one agent.",
    {
      agent: z.string().optional(),
      before: z.number().int().nonnegative().optional(),
      limit: z.number().int().positive().max(100).optional(),
    },
  ),
  definition(
    "team_activity_detail",
    "One activity's redacted detail (16 KiB default, 64 KiB max).",
    {
      activity_id: z.string().regex(/^act_[a-f0-9]{24}$/u),
      max_bytes: z.number().int().positive().max(64 * 1024).optional(),
    },
  ),
  definition(
    "team_job",
    "Reserve and report long-running or MCP work. Reserve resources before launching; active or unknown reservations block overlapping work until the owner settles them.",
    {
      action: z.enum(["reserve", "update", "list"]).optional(),
      title: z.string().min(1).max(512).optional(),
      source: z.string().min(1).max(256).optional(),
      resources: z.array(z.string().min(1).max(4_096)).min(1).max(64).optional(),
      job_id: z.string().regex(/^job_[a-f0-9]{24}$/u).optional(),
      state: z.enum(["pending", "running", "succeeded", "failed", "cancelled", "unknown"]).optional(),
      handle: z.string().max(4_096).nullable().optional(),
      result: z.string().max(32_000).nullable().optional(),
      note: z.string().max(4_000).nullable().optional(),
      all: z.boolean().optional(),
    },
  ),
  definition(
    "team_progress",
    "Record your stance and evidence on the active goal.",
    {
      goal_id: z.string().min(1).optional(),
      stance: z.enum(["assessing", "participating", "done", "blocked"]),
      evidence: z.string().max(32_000).optional(),
    },
  ),
  definition(
    "team_todo",
    "Shared TODO list for the goal. add takes items, update takes id with state, assignee (peer, me, none), or note, list takes filter. Assigning a peer notifies it.",
    {
      action: z.enum(["add", "update", "list"]),
      items: z.array(z.object({
        title: z.string().min(1).max(300),
        detail: z.string().max(4_000).optional(),
        assignee: z.string().optional(),
        paths: z.array(z.string()).max(50).optional(),
      })).min(1).max(20).optional(),
      id: z.number().int().positive().optional(),
      state: z.enum(["todo", "doing", "blocked", "done", "dropped"]).optional(),
      assignee: z.string().optional(),
      note: z.string().max(4_000).optional(),
      filter: z.enum(["open", "mine", "all"]).optional(),
    },
  ),
  definition(
    "team_wake",
    "Instead of watching a long job, schedule a wake and end your turn. A new turn starts when one condition is met (after_seconds, pid exits, path appears, command exits 0) or timeout_seconds passes. action cancel takes wake_id.",
    {
      action: z.enum(["schedule", "cancel", "list"]).optional(),
      note: z.string().min(1).max(2_000).optional(),
      after_seconds: z.number().int().min(1).max(86_400).optional(),
      pid: z.number().int().positive().optional(),
      path: z.string().min(1).max(4_096).optional(),
      command: z.array(z.string().max(8_192)).min(1).max(64).optional(),
      interval_seconds: z.number().int().min(10).max(3_600).optional(),
      timeout_seconds: z.number().int().min(10).max(86_400).optional(),
      wake_id: z.number().int().positive().optional(),
    },
  ),
  definition(
    "team_availability",
    "dnd with a reason before work that must not be steered, open when done. dnd holds normal mail and delays urgent mail to your turn end. Stop still interrupts.",
    {
      mode: z.enum(["open", "dnd"]),
      reason: z.string().min(1).max(300).optional(),
      minutes: z.number().int().min(1).max(240).optional(),
    },
  ),
  definition(
    "team_claim_update",
    "Activate, release, or supersede one of your claims.",
    {
      claim_id: z.string().min(1),
      state: z.enum(["active", "released", "superseded"]),
      note: z.string().max(4_000).optional(),
    },
  ),
  definition(
    "team_finding_update",
    "Author or target sets disposition. Any other peer cross-checks with verdict confirmed or refuted plus evidence; a refutation goes to the author.",
    {
      finding_id: z.string().min(1),
      disposition: z.enum(["open", "resolved", "accepted", "dismissed"]).optional(),
      verdict: z.enum(["confirmed", "refuted"]).optional(),
      evidence: z.string().min(1).max(4_000).optional(),
    },
  ),
  definition(
    "team_handoff",
    "Hand over your context when the user exports the chat: self-contained Markdown covering what you did, current state, decisions, and next steps, for a reader who has none of your context.",
    { markdown: z.string().min(1).max(64_000) },
  ),
  // The original creation and release names stay, so existing skills and
  // habits keep working.
  definition(
    "team_claim",
    "Claim scope and optional repo-relative paths before editing. Active unless state is proposed. Overlap with a live peer contests both and returns conflicts; an offline peer's overlapping claim is taken over.",
    {
      scope: z.string().min(1).max(4_000),
      paths: z.array(z.string()).max(100).optional(),
      note: z.string().max(4_000).optional(),
      goal_id: z.string().min(1).optional(),
      state: z.enum(["proposed", "active"]).optional(),
    },
  ),
  definition(
    "team_release",
    "Release one of your claims.",
    { claim_id: z.string().min(1), note: z.string().max(4_000).optional() },
  ),
  definition(
    "team_finding",
    "Record a finding. Severity is separate from message priority.",
    {
      target: z.string().optional(),
      scope: z.string().max(4_000).optional(),
      severity: z.enum(["info", "low", "medium", "high", "critical"]),
      summary: z.string().min(1).max(4_000),
      evidence: z.string().max(32_000).optional(),
    },
  ),
] as const;
