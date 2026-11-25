export type AgentId = "codex" | "claude" | (string & {});

export type AgentEventKind =
  | "session"
  | "assistant"
  | "reasoning"
  | "tool_start"
  | "tool_output"
  | "tool_end"
  | "edit"
  | "diff"
  | "approval"
  | "question"
  | "question_resolved"
  | "warning"
  | "error"
  | "peer_message"
  | "status"
  | "usage";

export interface AgentEvent {
  readonly agent: AgentId;
  readonly kind: AgentEventKind;
  readonly timestamp: number;
  readonly summary: string;
  readonly rawType?: string;
  readonly providerEventId?: string;
  readonly payload?: unknown;
}

export interface AgentCapabilities {
  readonly structuredReasoningEvents: boolean;
  readonly toolEvents: boolean;
  readonly diffEvents: boolean;
  readonly approvals: boolean;
  readonly interrupt: boolean;
  readonly bidirectionalInput: boolean;
  readonly safeSteer: boolean;
  readonly resume: boolean;
  readonly mcp: boolean;
  readonly skills: boolean;
  readonly nativeSession: boolean;
  readonly usageMetadata: boolean;
}

export interface AgentModelOption {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly efforts: readonly string[];
  readonly isDefault?: boolean;
}

export interface ProjectContext {
  readonly launchDirectory: string;
  readonly repositoryRoot: string | null;
}

export type ApprovalDecision = "accept" | "decline" | "cancel";

export type AgentInput =
  | {
      readonly kind: "question_response";
      readonly requestId: string;
      readonly response: import("./questions.ts").QuestionResponse;
    }
  | {
      readonly kind: "message";
      readonly text: string;
    }
  | {
      readonly kind: "approval_response";
      readonly requestId: string | number;
      readonly decision: ApprovalDecision;
    };

export interface AgentAdapter {
  /** The provider's own id for the current conversation, once it has one. */
  readonly sessionId?: string | null;
  start(project: ProjectContext): Promise<void>;
  /** Prepare a provider session and its tools without starting a model turn. */
  prepare?(): Promise<void>;
  availableModels?(): Promise<readonly AgentModelOption[]>;
  send(input: AgentInput): Promise<void>;
  events(): AsyncIterable<AgentEvent>;
  interrupt?(): Promise<void>;
  stop(): Promise<void>;
  resume(sessionId: string): Promise<void>;
  /** Forget the provider conversation while keeping the contained transport. */
  resetSession?(): Promise<void>;
  capabilities(): AgentCapabilities;
}

/**
 * Lets an adapter ask the runtime for mail at points only the harness sees.
 *
 * Some providers expose their tool boundaries and the end of a turn as
 * callbacks rather than as events Watari could act on in time. The adapter
 * calls these there, and whatever text comes back is handed to the model
 * inside the same turn. Anything returned is already marked delivered.
 */
export interface BoundaryInbox {
  /** Every tool call in the batch finished and the model has not continued yet. */
  atToolBoundary(): Promise<string | null>;
  /** The model is about to end its turn. Returned text keeps the turn going. */
  beforeTurnEnd(): Promise<string | null>;
}

/**
 * The harness is healthy but cannot take this input now, for example because
 * its turn is compacting. The input is offered again at a later boundary
 * instead of being treated as an outage.
 */
export class InputDeferredError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "InputDeferredError";
  }
}

export interface CheckResult {
  readonly id: string;
  readonly status: "pass" | "warn" | "fail";
  readonly summary: string;
  readonly detail?: string;
}

export interface DoctorReport {
  readonly schemaVersion: 1;
  readonly command: "doctor";
  readonly project: ProjectContext;
  readonly checks: readonly CheckResult[];
  readonly ok: boolean;
}

export interface ProbeReport {
  readonly schemaVersion: 1;
  readonly command: "probe";
  readonly adapter: "codex" | "claude" | "opencode" | "qwen";
  readonly mode: "handshake" | "live";
  readonly project: ProjectContext;
  readonly capabilities: AgentCapabilities;
  readonly events: readonly AgentEvent[];
  readonly sessionId?: string;
  readonly ok: boolean;
  readonly limitation?: string;
}

export interface StatusReport {
  readonly schemaVersion: 1;
  readonly command: "status";
  readonly project: ProjectContext;
  readonly stateDirectory: string;
  readonly service: {
    readonly state: "running" | "stopped" | "incompatible";
    readonly pid: number | null;
    readonly connectedClients: number;
    /** Where a local client connects. Reported so a frontend outside this
     * repository does not have to re-derive Watari's private state layout. */
    readonly socketPath: string;
    /** The version successfully negotiated with the running service. It is
     * null when there is no compatible service to ask. */
    readonly apiVersion: number | null;
    /** The local API version this executable and its bundled clients expect. */
    readonly expectedApiVersion: number;
    /** Actionable context when a socket exists but cannot speak this API. */
    readonly detail: string | null;
  };
  readonly agents: readonly {
    readonly id: AgentId;
    readonly state: import("./state/types.ts").AgentRuntimeState;
    readonly backend: string;
    readonly provider?: string;
    readonly model?: string | null;
    readonly effort?: string | null;
    readonly mode?: "managed" | "external";
    readonly unrestricted?: boolean;
    readonly teamBridge: string;
    readonly sessionId: string | null;
    readonly detail: string | null;
  }[];
  readonly ok: boolean;
}
