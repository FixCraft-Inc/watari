import { z } from "zod";
import { PendingQuestionSchema } from "../questions.ts";

import { ActivitySummarySchema } from "../activity/schemas.ts";
import { AGENT_ALIAS_PATTERN } from "../team/identity.ts";

const AgentAliasSchema = z.string().regex(AGENT_ALIAS_PATTERN);
const TimestampSchema = z.number().int().nonnegative();

const TeamAgentSchema = z.object({
  id: AgentAliasSchema,
  backend: z.string().min(1).max(256),
  displayName: z.string().min(1).max(256),
  provider: z.string().max(128).optional(),
  model: z.string().max(512).nullable().optional(),
  effort: z.string().max(128).nullable().optional(),
  mode: z.enum(["managed", "external"]).optional(),
  unrestricted: z.boolean().optional(),
  sessionId: z.string().max(1024).nullable(),
  state: z.enum(["starting", "ready", "busy", "waiting", "failed", "stopped"]),
  currentGoalId: z.string().max(256).nullable(),
  updatedAt: TimestampSchema,
  detail: z.string().max(64 * 1024).nullable(),
  availability: z.enum(["open", "dnd"]).optional(),
  availabilityReason: z.string().max(4_000).nullable().optional(),
  availabilityUntil: TimestampSchema.nullable().optional(),
});

const TeamGoalSchema = z.object({
  id: z.string().min(1).max(256),
  instruction: z.string().min(1).max(32_000),
  origin: z.string().min(1).max(128),
  initialAddressee: AgentAliasSchema.nullable(),
  state: z.enum(["active", "complete", "cancelled"]),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

const TeamMessageSchema = z.object({
  id: z.number().int().nonnegative(),
  goalId: z.string().max(256).nullable(),
  sender: z.string().min(1).max(128),
  recipients: z.array(AgentAliasSchema).max(256),
  kind: z.enum(["user", "peer", "system", "goal", "review"]),
  priority: z.enum(["normal", "urgent", "stop"]),
  priorityReason: z.string().min(1).max(4_000).nullable(),
  body: z.string().min(1).max(32_000),
  createdAt: TimestampSchema,
  replyTo: z.number().int().nonnegative().nullable().optional(),
  expectsReply: z.boolean().optional(),
  delivery: z.enum(["normal", "passive", "direct"]).optional(),
});

const TeamTodoSchema = z.object({
  id: z.number().int().positive(),
  goalId: z.string().max(256).nullable(),
  title: z.string().min(1).max(4_000),
  detail: z.string().max(32_000).nullable(),
  author: z.string().min(1).max(128),
  assignee: AgentAliasSchema.nullable(),
  paths: z.array(z.string().min(1).max(4_000)).max(512),
  state: z.enum(["todo", "doing", "blocked", "done", "dropped"]),
  note: z.string().max(4_000).nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

const WakeConditionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("timer"), afterSeconds: z.number().int().positive() }),
  z.object({ kind: z.literal("pid"), pid: z.number().int().positive() }),
  z.object({ kind: z.literal("path"), path: z.string().min(1).max(4_096) }),
  z.object({
    kind: z.literal("command"),
    argv: z.array(z.string().max(8_192)).min(1).max(64),
    intervalSeconds: z.number().int().positive(),
  }),
]);

const TeamWakeSchema = z.object({
  id: z.number().int().positive(),
  agent: AgentAliasSchema,
  condition: WakeConditionSchema,
  note: z.string().min(1).max(4_000),
  state: z.enum(["pending", "fired", "expired", "failed", "cancelled"]),
  createdAt: TimestampSchema,
  deadlineAt: TimestampSchema,
  settledAt: TimestampSchema.nullable(),
  outcome: z.string().max(64 * 1024).nullable(),
});

const TeamJobSchema = z.object({
  id: z.string().regex(/^job_[a-f0-9]{24}$/u),
  owner: AgentAliasSchema,
  source: z.string().min(1).max(256),
  title: z.string().min(1).max(512),
  resources: z.array(z.string().min(1).max(4_096)).min(1).max(64),
  state: z.enum(["pending", "running", "succeeded", "failed", "cancelled", "unknown"]),
  handle: z.string().max(4_096).nullable(),
  result: z.string().max(32_000).nullable(),
  note: z.string().max(4_000).nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

const TeamClaimSchema = z.object({
  id: z.string().min(1).max(256),
  goalId: z.string().min(1).max(256),
  claimant: AgentAliasSchema,
  summary: z.string().min(1).max(4_000),
  paths: z.array(z.string().min(1).max(4_000)).max(512),
  state: z.enum(["proposed", "active", "contested", "released", "superseded"]),
  note: z.string().max(4_000).nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

const TeamFindingSchema = z.object({
  id: z.string().min(1).max(256),
  author: AgentAliasSchema,
  target: AgentAliasSchema.nullable(),
  scope: z.string().max(4_000).nullable(),
  severity: z.enum(["info", "low", "medium", "high", "critical"]),
  summary: z.string().min(1).max(4_000),
  evidence: z.string().max(32_000).nullable(),
  disposition: z.enum(["open", "resolved", "accepted", "dismissed"]),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  verdicts: z.array(z.object({
    reviewer: AgentAliasSchema,
    verdict: z.enum(["confirmed", "refuted"]),
    evidence: z.string().max(4_000).nullable(),
    createdAt: TimestampSchema,
  })).max(64).optional(),
});

export const PersistedEventSchema = z.object({
  id: z.number().int().nonnegative(),
  agent: AgentAliasSchema.nullable(),
  type: z.string().min(1).max(128),
  summary: z.string().max(64 * 1024),
  providerEventId: z.string().max(512).nullable(),
  createdAt: TimestampSchema,
});

const BridgeStatusSchema = z.object({
  agent: AgentAliasSchema,
  state: z.enum(["unknown", "checking", "ready", "failed"]),
  detail: z.string().max(64 * 1024),
  tools: z.array(z.string().max(256)).max(256),
  missing: z.array(z.string().max(256)).max(256),
  elapsedMs: z.number().nonnegative(),
  checkedAt: TimestampSchema,
  providerReported: z.string().max(256).optional(),
});

export const TeamSnapshotSchema = z.object({
  questions: z.array(PendingQuestionSchema).max(64).optional(),
  schemaVersion: z.literal(2),
  agents: z.array(TeamAgentSchema).max(256),
  activeGoal: TeamGoalSchema.nullable(),
  goals: z.array(TeamGoalSchema).max(2_000).optional(),
  messages: z.array(TeamMessageSchema).max(400),
  claims: z.array(TeamClaimSchema).max(2_000),
  findings: z.array(TeamFindingSchema).max(2_000),
  events: z.array(PersistedEventSchema).max(400),
  activities: z.array(ActivitySummarySchema).max(400),
  todos: z.array(TeamTodoSchema).max(2_000).optional(),
  wakes: z.array(TeamWakeSchema).max(256).optional(),
  jobs: z.array(TeamJobSchema).max(512).optional(),
  bridges: z.array(BridgeStatusSchema).max(256).optional(),
});

export const RuntimeEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("snapshot"), snapshot: TeamSnapshotSchema }),
  z.object({ type: z.literal("state_changed"), snapshot: TeamSnapshotSchema }),
  z.object({ type: z.literal("transcript_upsert"), event: PersistedEventSchema }),
  z.object({ type: z.literal("activity_upsert"), activity: ActivitySummarySchema }),
  z.object({
    type: z.literal("activity_detail_changed"),
    activityId: z.string().regex(/^act_[a-f0-9]{24}$/u),
    revision: z.number().int().positive(),
  }),
  z.object({ type: z.literal("fatal"), message: z.string().min(1).max(64 * 1024) }),
]);
