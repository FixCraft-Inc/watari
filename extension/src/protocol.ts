/**
 * The Watari local API, version 2, as this extension needs to see it.
 *
 * These types are a hand-written mirror of `src/watari/service/protocol.ts` and
 * `src/watari/state/types.ts` in the Watari repository. They are copied rather
 * than imported because the service is a Bun program and this runs on Node in
 * the extension host; sharing a package was considered and deliberately not
 * done. The cost of that choice is drift, so the mirror is kept narrow — only
 * the fields the UI actually renders — and `API_VERSION` is negotiated on every
 * connection, which is what turns a protocol change into a clean refusal
 * instead of a wrong screen.
 */

export const API_VERSION = 2;

export type AgentRuntimeState =
  | "starting"
  | "ready"
  | "busy"
  | "waiting"
  | "failed"
  | "stopped";

export type MessageKind = "user" | "peer" | "system" | "goal" | "review";
export type MessagePriority = "normal" | "urgent" | "stop";
export type ClaimState = "proposed" | "active" | "contested" | "released" | "superseded";
export type BridgeState = "unknown" | "checking" | "ready" | "failed";
export type ActivityKind = "command" | "file_change";
export type ActivityState = "running" | "completed" | "failed" | "interrupted";

export interface TeamAgent {
  readonly id: string;
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
}

export interface TeamGoal {
  readonly id: string;
  readonly instruction: string;
  readonly origin: string;
  readonly initialAddressee: string | null;
  readonly state: "active" | "complete" | "cancelled";
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface TeamMessage {
  readonly id: number;
  readonly goalId: string | null;
  readonly sender: string;
  readonly recipients: readonly string[];
  readonly kind: MessageKind;
  readonly priority: MessagePriority;
  readonly priorityReason: string | null;
  readonly body: string;
  readonly createdAt: number;
}

export interface TeamClaim {
  readonly id: string;
  readonly goalId: string;
  readonly claimant: string;
  readonly summary: string;
  readonly paths: readonly string[];
  readonly state: ClaimState;
  readonly note: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface TeamFinding {
  readonly id: string;
  readonly author: string;
  readonly target: string | null;
  readonly scope: string | null;
  readonly severity: "info" | "low" | "medium" | "high" | "critical";
  readonly summary: string;
  readonly evidence: string | null;
  readonly disposition: "open" | "resolved" | "accepted" | "dismissed";
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface PersistedEvent {
  readonly id: number;
  readonly agent: string | null;
  readonly type: string;
  readonly summary: string;
  readonly providerEventId: string | null;
  readonly createdAt: number;
}

export interface ActivitySummary {
  readonly id: string;
  readonly agent: string;
  readonly kind: ActivityKind;
  readonly state: ActivityState;
  readonly title: string;
  readonly preview: string;
  readonly providerEventId: string;
  readonly revision: number;
  readonly startedAt: number;
  readonly updatedAt: number;
  readonly hasDetail: boolean;
}

export interface BridgeStatus {
  readonly agent: string;
  readonly state: BridgeState;
  readonly detail: string;
}

export interface ContentRetention {
  readonly truncated: boolean;
  readonly omittedBytes: number;
  readonly omittedLines: number;
}

export interface CommandActivityDetail {
  readonly kind: "command";
  readonly command: string;
  readonly cwd: string | null;
  readonly outputMode: "split" | "combined";
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly durationMs: number | null;
  readonly interrupted: boolean;
  readonly retention: ContentRetention;
}

export interface ChangedFileDetail {
  readonly path: string;
  readonly kind: "add" | "update" | "delete" | "move" | "unknown";
  readonly diff: string;
  readonly additions: number;
  readonly deletions: number;
  readonly retention: ContentRetention;
}

export interface FileChangeActivityDetail {
  readonly kind: "file_change";
  readonly files: readonly ChangedFileDetail[];
  readonly retention: ContentRetention;
}

export type ActivityDetail = CommandActivityDetail | FileChangeActivityDetail;

export interface TeamSnapshot {
  readonly schemaVersion: 2;
  readonly agents: readonly TeamAgent[];
  readonly activeGoal: TeamGoal | null;
  readonly messages: readonly TeamMessage[];
  readonly claims: readonly TeamClaim[];
  readonly findings: readonly TeamFinding[];
  readonly events: readonly PersistedEvent[];
  readonly activities: readonly ActivitySummary[];
  readonly bridges?: readonly BridgeStatus[];
}

export type RuntimeEvent =
  | { readonly type: "snapshot"; readonly snapshot: TeamSnapshot }
  | { readonly type: "state_changed"; readonly snapshot: TeamSnapshot }
  | { readonly type: "transcript_upsert"; readonly event: PersistedEvent }
  | { readonly type: "activity_upsert"; readonly activity: ActivitySummary }
  | { readonly type: "activity_detail_changed"; readonly activityId: string; readonly revision: number }
  | { readonly type: "fatal"; readonly message: string };

export type ResponseEnvelope =
  | { readonly type: "response"; readonly id: string; readonly ok: true; readonly value?: unknown }
  | { readonly type: "response"; readonly id: string; readonly ok: false; readonly error: string };

export type ServiceEnvelope = RuntimeEvent | ResponseEnvelope;

export function isResponse(value: ServiceEnvelope): value is ResponseEnvelope {
  return value.type === "response";
}

/** What `watari status --json` reports, narrowed to what discovery needs. */
export interface StatusReport {
  readonly command: "status";
  readonly stateDirectory: string;
  readonly service: {
    readonly state: "running" | "stopped" | "incompatible";
    readonly pid: number | null;
    readonly connectedClients: number;
    readonly socketPath: string;
    readonly apiVersion: number | null;
    readonly expectedApiVersion: number;
    readonly detail: string | null;
  };
  readonly ok: boolean;
}
