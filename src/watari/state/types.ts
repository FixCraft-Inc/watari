import type { AgentId } from "../models.ts";
import type { ActivitySummary } from "../activity/types.ts";
import type { BridgeStatus } from "../team/bridge-check.ts";

export type { BridgeStatus };

export type AgentRuntimeState =
  | "starting"
  | "ready"
  | "busy"
  | "waiting"
  | "failed"
  | "stopped";

export type GoalState = "active" | "complete" | "cancelled";
export type GoalStance = "assessing" | "participating" | "done" | "blocked";
export type MessageKind = "user" | "peer" | "system" | "goal" | "review";
export type MessagePriority = "normal" | "urgent" | "stop";
/**
 * How a message may reach a peer that is idle or in do-not-disturb.
 *
 * `normal` starts a turn for an idle peer and respects do-not-disturb.
 * `passive` never starts a turn by itself and rides along with the next
 * delivery. `direct` starts a turn and ignores do-not-disturb, which is kept
 * for a peer's own wakeups and reply reminders.
 */
export type MessageDelivery = "normal" | "passive" | "direct";
export type AgentAvailability = "open" | "dnd";
export type TodoState = "todo" | "doing" | "blocked" | "done" | "dropped";
export type WakeState = "pending" | "fired" | "expired" | "failed" | "cancelled";
export type TeamJobState = "pending" | "running" | "succeeded" | "failed" | "cancelled" | "unknown";
export type WakeCondition =
  | { readonly kind: "timer"; readonly afterSeconds: number }
  | { readonly kind: "pid"; readonly pid: number }
  | { readonly kind: "path"; readonly path: string }
  | { readonly kind: "command"; readonly argv: readonly string[]; readonly intervalSeconds: number };
export type ClaimState =
  | "proposed"
  | "active"
  | "contested"
  | "released"
  | "superseded";

export interface TeamAgent {
  readonly id: AgentId;
  readonly backend: string;
  readonly displayName: string;
  readonly provider?: string;
  readonly model?: string | null;
  readonly effort?: string | null;
  readonly mode?: "managed" | "external";
  readonly unrestricted?: boolean;
  readonly sessionId: string | null;
  readonly state: AgentRuntimeState;
  readonly currentGoalId: string | null;
  readonly updatedAt: number;
  readonly detail: string | null;
  /** Optional so a snapshot from an older service still reads. */
  readonly availability?: AgentAvailability;
  readonly availabilityReason?: string | null;
  readonly availabilityUntil?: number | null;
}

export interface TeamGoal {
  readonly id: string;
  readonly instruction: string;
  readonly origin: string;
  readonly initialAddressee: AgentId | null;
  readonly state: GoalState;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface TeamMessage {
  readonly id: number;
  readonly goalId: string | null;
  readonly sender: string;
  readonly recipients: readonly AgentId[];
  readonly kind: MessageKind;
  readonly priority: MessagePriority;
  readonly priorityReason: string | null;
  readonly body: string;
  readonly createdAt: number;
  /** The message this one answers, when the sender said so. */
  readonly replyTo?: number | null;
  /** The sender is waiting for an answer from each recipient. */
  readonly expectsReply?: boolean;
  readonly delivery?: MessageDelivery;
}

export interface GoalParticipant {
  readonly goalId: string;
  readonly agent: AgentId;
  readonly stance: GoalStance;
  readonly completionEvidence: string | null;
  readonly updatedAt: number;
}

export interface InboxCursor {
  readonly agent: AgentId;
  readonly latestMessageId: number;
  readonly acknowledgedThrough: number;
  readonly pendingCount: number;
}

export interface TeamClaim {
  readonly id: string;
  readonly goalId: string;
  readonly claimant: AgentId;
  readonly summary: string;
  readonly paths: readonly string[];
  readonly state: ClaimState;
  readonly note: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export type FindingVerdictKind = "confirmed" | "refuted";

/** One peer's independent check of another peer's finding. */
export interface FindingVerdict {
  readonly reviewer: AgentId;
  readonly verdict: FindingVerdictKind;
  readonly evidence: string | null;
  readonly createdAt: number;
}

export interface TeamFinding {
  readonly id: string;
  readonly author: AgentId;
  readonly target: AgentId | null;
  readonly scope: string | null;
  readonly severity: "info" | "low" | "medium" | "high" | "critical";
  readonly summary: string;
  readonly evidence: string | null;
  readonly disposition: "open" | "resolved" | "accepted" | "dismissed";
  readonly createdAt: number;
  readonly updatedAt: number;
  /** Present once another peer has checked it. Optional so older snapshots still read. */
  readonly verdicts?: readonly FindingVerdict[];
}

/** A shared TODO item the whole team and the user can see. */
export interface TeamTodo {
  readonly id: number;
  readonly goalId: string | null;
  readonly title: string;
  readonly detail: string | null;
  /** A roster identity, or `user`. */
  readonly author: string;
  readonly assignee: AgentId | null;
  readonly paths: readonly string[];
  readonly state: TodoState;
  readonly note: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** A peer's request to be woken when a condition is met. */
export interface TeamWake {
  readonly id: number;
  readonly agent: AgentId;
  readonly condition: WakeCondition;
  readonly note: string;
  readonly state: WakeState;
  readonly createdAt: number;
  /** When the wake gives up and reports a timeout. A timer fires here. */
  readonly deadlineAt: number;
  readonly settledAt: number | null;
  readonly outcome: string | null;
}

/** A durable reservation for work that may outlive one provider turn. */
export interface TeamJob {
  readonly id: string;
  readonly owner: AgentId;
  /** Adapter or MCP name, for example `mcp:ci`. */
  readonly source: string;
  readonly title: string;
  /** Opaque resource identities shared by cooperating tools. */
  readonly resources: readonly string[];
  readonly state: TeamJobState;
  /** Provider/MCP handle, PID, or result path when one exists. */
  readonly handle: string | null;
  readonly result: string | null;
  readonly note: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** A question a peer has been handed and has not answered yet. */
export interface ReplyObligation {
  readonly messageId: number;
  readonly sender: string;
  readonly recipient: AgentId;
  readonly body: string;
  readonly createdAt: number;
  readonly nudgedAt: number | null;
}

/** A question a peer asked and is still waiting on. */
export interface AwaitedReply {
  readonly messageId: number;
  readonly recipient: AgentId;
  readonly body: string;
  readonly createdAt: number;
  readonly deliveredAt: number | null;
}

export interface PersistedEvent {
  readonly id: number;
  readonly agent: AgentId | null;
  readonly type: string;
  readonly summary: string;
  readonly providerEventId: string | null;
  readonly createdAt: number;
}

/**
 * What one agent handed over when the user exported the chat to continue it
 * elsewhere. `tool` came through team_handoff, `reply` is the text of the turn
 * it answered in, and `none` means it did not answer in time.
 */
export interface TeamHandoff {
  readonly id: number;
  readonly requestId: string;
  readonly agent: AgentId;
  readonly source: "tool" | "reply" | "none";
  readonly content: string;
  readonly createdAt: number;
}

export interface TeamSnapshot {
  /** Live native requests, retained across client detach, invalid after service restart. */
  readonly questions?: readonly import("../questions.ts").PendingQuestion[];
  readonly schemaVersion: 2;
  readonly agents: readonly TeamAgent[];
  readonly activeGoal: TeamGoal | null;
  /** Full goal history is included in portable/full snapshots; live clients only need activeGoal. */
  readonly goals?: readonly TeamGoal[];
  readonly messages: readonly TeamMessage[];
  readonly claims: readonly TeamClaim[];
  readonly findings: readonly TeamFinding[];
  readonly events: readonly PersistedEvent[];
  readonly activities: readonly ActivitySummary[];
  /** Optional so a snapshot from an older service still reads. */
  readonly todos?: readonly TeamTodo[];
  readonly wakes?: readonly TeamWake[];
  /** Durable jobs and resource reservations; absent in older snapshots. */
  readonly jobs?: readonly TeamJob[];
  /**
   * Health of each peer's team MCP bridge.
   *
   * Optional because it is the runtime's knowledge, not the database's: the
   * store persists team state, while whether a provider can still reach that
   * state over stdio is measured live and is meaningless after a restart.
   */
  readonly bridges?: readonly BridgeStatus[];
}

export type RuntimeEvent =
  | { readonly type: "snapshot"; readonly snapshot: TeamSnapshot }
  | { readonly type: "state_changed"; readonly snapshot: TeamSnapshot }
  | { readonly type: "transcript_upsert"; readonly event: PersistedEvent }
  | { readonly type: "activity_upsert"; readonly activity: ActivitySummary }
  | { readonly type: "activity_detail_changed"; readonly activityId: string; readonly revision: number }
  | { readonly type: "fatal"; readonly message: string };
