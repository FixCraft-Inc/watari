import { existsSync } from "node:fs";
import { PendingQuestionSchema, validateQuestionResponse, type PendingQuestion, type QuestionResponse } from "../questions.ts";
import { dirname, join } from "node:path";

import {
  InputDeferredError,
  type AgentAdapter,
  type AgentEvent,
  type AgentId,
  type AgentModelOption,
  type BoundaryInbox,
  type ProjectContext,
} from "../models.ts";
import { ActivityTracker } from "../activity/tracker.ts";
import type { ActivityDetail } from "../activity/types.ts";
import { resolveExecutable } from "../project/checkout.ts";
import { formatCheckoutMap, readCheckoutFacts } from "../project/checkout-map.ts";
import { redactSummary } from "../security/redaction.ts";
import { withTimeout } from "../util/timeout.ts";
import { CapacityMonitor, type CapacityNoticePost, type CapacityStatusSource } from "./capacity-monitor.ts";
import type { ProviderStatusDocument } from "../provider-status-api.ts";
import { TeamStore, type RestoreSummary } from "../state/store.ts";
import { findArchivedChat, listArchivedChats, readArchive, type ChatListEntry } from "../state/chat-library.ts";
import { ChatArchive } from "../state/chat-archive.ts";
import type {
  AgentAvailability,
  AgentRuntimeState,
  MessagePriority,
  RuntimeEvent,
  TeamAgent,
  TeamHandoff,
  TeamMessage,
  TeamSnapshot,
  TeamWake,
} from "../state/types.ts";
import { chatExportMarkdown, handoffPrompt, resolveExportPath, UNREQUESTED_HANDOFF, writeExportFile } from "../team/export.ts";
import {
  probeTeamBridge,
  unknownBridge,
  withProviderReport,
  type BridgeStatus,
} from "../team/bridge-check.ts";
import {
  contextRefreshNotice,
  sharedGoalPrompt,
  startupRoleInstruction,
  teamMailPrompt,
  wakeNotice,
  type PeerSummary,
  type StartupRole,
} from "../team/instructions.ts";
import type { TeamMcpCommand, TeamMcpEnvironment } from "../team/provider-config.ts";
import {
  TeamApplicationService,
  type DeliveryReceipt,
  type HandoffReceipt,
  type PeerInterruption,
  type ScheduledWake,
  type WakeRequest,
} from "../team/service.ts";
import {
  defaultRoster,
  isSupportedProvider,
  type AgentDefinition,
  type SupportedProviderId,
} from "../team/roster.ts";
import { describeTaskPolicy, type ProjectTaskPolicy } from "../task-policy.ts";
import { BRIDGE_TOKEN_ENV } from "../team/stdio-mcp.ts";
import { IdentityBoundTeamTools } from "../team/tools.ts";
import { forecastDelivery, selectDeliverable, type DeliveryBoundary } from "./delivery-policy.ts";
import {
  backendName,
  createProviderAdapter,
  providerExecutableOverride,
  takesMailInTurn,
} from "./provider-adapters.ts";
import { providerBridgeReport } from "./provider-reports.ts";
import { ReplyTracker } from "./reply-tracker.ts";
import { EditOverlapWatch, type EditOverlap } from "./edit-overlap.ts";
import { selfCommand } from "./self.ts";
import { TranscriptWriter } from "./transcript-writer.ts";
import { isTransientCodexFailure } from "./transient-failure.ts";
import {
  isContextCompaction,
  isSafeBoundary,
  isToolEnd,
  isToolStart,
  isTurnCompleted,
  isTurnStarted,
} from "./turn-events.ts";
import {
  WakeScheduler,
  formatDuration,
  processIsAlive,
  resolveWakePath,
  type WakeOutcome,
} from "./wake-scheduler.ts";

/** A streaming provider can produce hundreds of events a second. Snapshots are
 * coalesced onto this cadence so the socket and the renderer see a steady
 * stream of frames instead of one per token. */
const SNAPSHOT_INTERVAL_MS = 60;

/**
 * How long a passing bridge check is trusted before the next send re-runs it.
 *
 * A bridge fails through events Watari never sees, such as a service restart
 * or a replaced executable, so a healthy answer is a recent observation rather
 * than a standing fact. Short enough to catch a break within one exchange, long
 * enough that a burst of messages does not spawn a handshake each time.
 */
const BRIDGE_TRUST_MS = 30_000;
/** A harness that has not come up by now is not coming up on its own. */
const START_TIMEOUT_MS = 45_000;
/** A harness that will not close cleanly must not hold the whole shutdown. */
const STOP_TIMEOUT_MS = 5_000;
/** How long a stop lets a running tool call finish before interrupting anyway. */
const STOP_DEFER_MS = 30_000;
/** The chat archive is rewritten at most this often while a chat runs. */
const ARCHIVE_INTERVAL_MS = 2_000;
/** How often the periodic archive write is the whole chat rather than its tail. */
const FULL_ARCHIVE_INTERVAL_MS = 60_000;
/** How long an export waits for every asked agent to hand over. */
const HANDOFF_TIMEOUT_MS = 5 * 60_000;
/** First retry of a handover a harness refused. Each further retry doubles it. */
const DELIVERY_RETRY_MS = 1_000;
const DELIVERY_RETRY_MAX_MS = 60_000;
/** How a stopped agent's detail marks that it was cut off mid-turn. */
const INTERRUPTED_DETAIL = "interrupted: the service stopped during a turn";
/** Goal briefs sent within this long of each other share one Git reading. */
const CHECKOUT_MAP_TTL_MS = 10_000;
/** One compaction can be reported twice, so refreshes closer than this are one. */
const COMPACTION_REFRESH_MS = 30_000;
const MAX_WAKES_PER_AGENT = 8;
const MAX_WAKES = 32;
const TRANSIENT_RETRY_MS = 5_000;
const MAX_TRANSIENT_RETRIES = 2;

export interface RuntimeOptions {
  readonly project: ProjectContext;
  readonly databasePath: string;
  readonly chatsDirectory?: string;
  readonly adapters?: Readonly<Record<string, AgentAdapter | undefined>>;
  /**
   * Builds the adapter for an agent that is configured or restarted while the
   * service runs. Tests supply one so a restart gets a fresh fake instead of a
   * real harness. Returning nothing falls back to the native provider.
   */
  readonly adapterFactory?: (definition: AgentDefinition) => AgentAdapter | undefined;
  readonly roster?: readonly AgentDefinition[];
  readonly taskPolicy?: ProjectTaskPolicy | undefined;
  /**
   * How a team bridge is probed. The real one spawns Watari's own stdio child
   * and speaks MCP to it. A test supplies its own so the scheduling around the
   * probe can be exercised without a subprocess.
   */
  readonly probeBridge?: typeof probeTeamBridge;
  /** Overridden by tests that need a wedged harness to resolve quickly. */
  readonly startTimeoutMs?: number;
  readonly stopTimeoutMs?: number;
  /** Tests shorten the wait a stop gives a running tool call. */
  readonly stopDeferMs?: number;
  /** Tests shorten the backoff for structured temporary Codex failures. */
  readonly transientRetryMs?: number;
  /** Tests shorten process and path wake polling. */
  readonly wakePollMs?: number;
  /** Test override for the token that managed bridges present. */
  readonly bridgeToken?: string;
  /** Where exports go when no path is given. Defaults to `exports/` beside the chats. */
  readonly exportsDirectory?: string;
  /** How long an export waits for agents' handoffs. */
  readonly handoffTimeoutMs?: number;
  /**
   * Read-only provider status (CodexLB, TeamClaude). When given, agents are
   * told once when their provider's pool runs low or out, and when it recovers.
   */
  readonly capacityStatus?: CapacityStatusSource;
  readonly capacityPollMs?: number;
  /**
   * Providers whose pool the native harnesses route through. A notice about
   * any other provider reaches nobody. Unset means every provider.
   */
  readonly capacityProviders?: ReadonlySet<string>;
}

/** An export in progress, waiting on the agents it asked for a handoff. */
interface PendingHandoff {
  readonly requestId: string;
  readonly since: number;
  /** Each agent still owing a handoff, with the id of the request it was sent. */
  readonly waiting: Map<AgentId, number>;
  readonly done: () => void;
}

export interface ChatExportResult {
  readonly path: string;
  /** Each asked agent and how its section was filled. */
  readonly handoffs: readonly { readonly agent: AgentId; readonly source: TeamHandoff["source"] }[];
}

export interface ResumedChat extends RestoreSummary {
  readonly chatId: string;
  readonly title: string;
}

export class CoordinatorRuntime {
  readonly #project: ProjectContext;
  readonly #probeBridge: typeof probeTeamBridge;
  readonly #adapterFactory: RuntimeOptions["adapterFactory"];
  readonly #startTimeoutMs: number;
  readonly #stopTimeoutMs: number;
  readonly #stopDeferMs: number;
  readonly #store: TeamStore;
  readonly #definitions = new Map<AgentId, AgentDefinition>();
  readonly #adapters = new Map<AgentId, AgentAdapter>();
  readonly #teamTools = new Map<AgentId, IdentityBoundTeamTools>();
  readonly #teamService: TeamApplicationService;
  readonly #taskPolicy: ProjectTaskPolicy | undefined;
  readonly #listeners = new Set<(event: RuntimeEvent) => void>();
  readonly #collectors = new Map<AgentId, Promise<void>>();
  readonly #delivering = new Set<AgentId>();
  /** Suppresses repeated outage messages until that peer accepts new work. */
  readonly #offlineNotified = new Set<AgentId>();
  /** Peers that reached a boundary, or gained mail, since the last publish. */
  readonly #deliveryPending = new Set<AgentId>();
  /** The exact stdio command each peer's harness was handed, for re-probing. */
  readonly #teamMcpCommands = new Map<AgentId, TeamMcpCommand>();
  readonly #bridges = new Map<AgentId, BridgeStatus>();
  readonly #bridgeConnections = new Map<AgentId, number>();
  readonly #reconfiguring = new Set<AgentId>();
  /** In-flight bridge checks, so concurrent sends share one handshake. */
  readonly #bridgeChecks = new Map<AgentId, Promise<BridgeStatus>>();
  readonly #transcript: TranscriptWriter;
  readonly #activityTracker: ActivityTracker;
  readonly #chatArchive: ChatArchive | null;
  readonly #suppliedAdapters = new Set<AgentId>();
  readonly #prepared = new Set<AgentId>();
  /**
   * Proves a bridge was launched for a managed alias by this service. Only the
   * harnesses Watari starts receive it, so a separately started provider that
   * was configured with the same alias cannot share a managed peer's inbox.
   */
  readonly #bridgeToken: string;
  readonly #teamMcpEnvironment: TeamMcpEnvironment;
  readonly #wakes: WakeScheduler;
  /** Peers whose harness pulls mail inside a turn through callbacks. */
  readonly #takesMailInTurn = new Set<AgentId>();
  /** Tool calls each peer has started and not finished. */
  readonly #runningTools = new Map<AgentId, Set<string>>();
  /** Stops waiting for a running tool call to finish. */
  readonly #deferredStops = new Map<AgentId, ReturnType<typeof setTimeout>>();
  /** Peers whose current turn was interrupted, so its end starts nothing new. */
  readonly #interrupted = new Set<AgentId>();
  /**
   * Peers the user stopped. Nothing automatic hands them mail, reminders, or
   * wakes until the user writes to them again: a peer that took its waiting
   * mail the moment the stopped turn ended had not been stopped.
   */
  readonly #stoppedByUser = new Set<AgentId>();
  /**
   * Nothing starts a model turn on its own until the user sends this service a
   * message. Reopening Watari used to wake peers with mail left from before,
   * or with a note to continue, which looked like an agent starting itself.
   */
  #awaitingUser = true;
  readonly #availabilityTimers = new Map<AgentId, ReturnType<typeof setTimeout>>();
  readonly #deliveryRetries = new Map<
    AgentId,
    { readonly timer: ReturnType<typeof setTimeout>; readonly delayMs: number }
  >();
  readonly #replies: ReplyTracker;
  /**
   * Bumped whenever an agent's harness is replaced or removed. A start or an
   * event stream that began under an older generation reports nothing, since
   * its harness is already being thrown away.
   */
  readonly #generations = new Map<AgentId, number>();
  readonly #questions = new Map<string, PendingQuestion>();
  readonly #transientRetries = new Map<AgentId, ReturnType<typeof setTimeout>>();
  readonly #transientAttempts = new Map<AgentId, number>();
  readonly #transientRetryMs: number;
  readonly #answeringQuestions = new Set<string>();
  /**
   * The goal each peer's current native conversation was told about.
   *
   * A peer that was not addressed by the first message, or whose harness was
   * restarted, would otherwise meet the goal as a bare peer message, or as a
   * user message with no context, and have to go and look it up.
   */
  readonly #briefed = new Map<AgentId, string>();
  /** When each peer was last handed its team state after a compaction. */
  readonly #refreshedAt = new Map<AgentId, number>();
  readonly #editOverlaps: EditOverlapWatch;
  /** Agents that were working when the previous service process stopped. */
  readonly #interruptedAtStop = new Set<AgentId>();
  /** Whether each harness started since the last announcement kept its conversation. */
  readonly #resumeOutcomes = new Map<AgentId, "resumed" | "fresh">();
  readonly #chatsDirectory: string | null;
  readonly #exportsDirectory: string | null;
  readonly #handoffTimeoutMs: number;
  #handoff: PendingHandoff | null = null;
  #checkoutMap: { readonly at: number; readonly text: string | null } | null = null;
  #archiveTimer: ReturnType<typeof setTimeout> | null = null;
  #archivedFullAt = 0;
  #snapshotTimer: ReturnType<typeof setTimeout> | null = null;
  #snapshotPending = false;
  #started = false;
  #stopping = false;
  readonly #capacityMonitor: CapacityMonitor | null;
  readonly #capacityStatus: CapacityStatusSource | null;
  readonly #capacityProviders: ReadonlySet<string> | null;

  constructor(options: RuntimeOptions) {
    this.#project = options.project;
    this.#probeBridge = options.probeBridge ?? probeTeamBridge;
    this.#adapterFactory = options.adapterFactory;
    this.#startTimeoutMs = options.startTimeoutMs ?? START_TIMEOUT_MS;
    this.#stopTimeoutMs = options.stopTimeoutMs ?? STOP_TIMEOUT_MS;
    this.#stopDeferMs = options.stopDeferMs ?? STOP_DEFER_MS;
    this.#transientRetryMs = options.transientRetryMs ?? TRANSIENT_RETRY_MS;
    this.#bridgeToken = options.bridgeToken ?? crypto.randomUUID();
    // Native MCP launchers filter inherited environment variables. Carry the
    // service's state root explicitly so preflight and provider children reach
    // the same socket when XDG_STATE_HOME is customized.
    this.#teamMcpEnvironment = {
      [BRIDGE_TOKEN_ENV]: this.#bridgeToken,
      ...(process.env.XDG_STATE_HOME ? { XDG_STATE_HOME: process.env.XDG_STATE_HOME } : {}),
    };
    this.#store = new TeamStore(options.databasePath);
    this.#store.markJobsUnknown();
    this.#replies = new ReplyTracker(this.#store, (id) => this.#definitions.has(id as AgentId));
    this.#editOverlaps = new EditOverlapWatch(this.#project.launchDirectory);
    this.#chatArchive = options.chatsDirectory ? new ChatArchive(options.chatsDirectory) : null;
    this.#chatsDirectory = options.chatsDirectory ?? null;
    this.#exportsDirectory = options.exportsDirectory ??
      (options.chatsDirectory ? join(dirname(options.chatsDirectory), "exports") : null);
    this.#handoffTimeoutMs = options.handoffTimeoutMs ?? HANDOFF_TIMEOUT_MS;
    this.#capacityProviders = options.capacityProviders ?? null;
    this.#capacityStatus = options.capacityStatus ?? null;
    this.#capacityMonitor = options.capacityStatus
      ? new CapacityMonitor({
          source: options.capacityStatus,
          post: (notice) => this.#postCapacityNotice(notice),
          withdraw: (provider) => this.#withdrawCapacityNotice(provider),
          ...(options.capacityPollMs ? { intervalMs: options.capacityPollMs } : {}),
        })
      : null;
    // A chat outlives the service process. Its goal, messages, claims, TODOs,
    // and findings stay in the database, and each agent's own conversation is
    // resumed when its harness starts. Only /new starts over. Resetting here
    // made every restart, crash, and idle exit cost both agents their memory.
    for (const agent of this.#store.agents()) {
      if (agent.state === "busy" || agent.state === "waiting" || agent.detail === INTERRUPTED_DETAIL) {
        this.#interruptedAtStop.add(agent.id);
      }
    }
    if (this.#store.hasUserMessages()) this.#activateArchive();
    this.#transcript = new TranscriptWriter({
      insert: (event) => {
        const id = this.#store.persistAgentEvent(event);
        this.#publishTranscriptEvent(id);
        return id;
      },
      update: (id, summary, options) => {
        this.#store.updateAgentEvent(id, summary, options);
        this.#publishTranscriptEvent(id);
      },
    });
    this.#activityTracker = new ActivityTracker({
      repository: this.#store,
      onUpsert: (activity) => this.#broadcast({ type: "activity_upsert", activity }),
      onDetailChanged: (activityId, revision) =>
        this.#broadcast({ type: "activity_detail_changed", activityId, revision }),
    });
    this.#wakes = new WakeScheduler({
      cwd: this.#project.launchDirectory,
      onSettled: (wake, outcome) => this.#wakeSettled(wake, outcome),
      ...(options.wakePollMs ? { pollMs: options.wakePollMs } : {}),
    });
    this.#taskPolicy = options.taskPolicy;
    this.#teamService = new TeamApplicationService({
      store: this.#store,
      taskPolicy: this.#taskPolicy,
      canDelegate: (agent) => !this.#awaitingUser && !this.#stoppedByUser.has(agent) &&
        this.#availableAgentIds().includes(agent),
      bridgeHealth: () => this.bridges(),
      interruptPeer: (agent) => this.#interruptForStop(agent),
      onMutation: () => this.#markDeliveryPending(),
      coordination: {
        forecast: (recipient, priority) => this.#forecast(recipient, priority),
        scheduleWake: (agent, request) => this.#scheduleWake(agent, request),
        cancelWake: (agent, id) => this.#cancelWake(agent, id),
        setAvailability: (agent, mode, reason, minutes) =>
          this.#setAvailability(agent, mode, reason, minutes),
        recordHandoff: (agent, markdown) => this.#recordHandoff(agent, markdown),
      },
    });
    const roster = options.roster ?? defaultRoster();
    for (const definition of roster) this.#register(definition);
    for (const definition of roster) {
      this.#prepareDefinition(definition, options.adapters?.[definition.alias]);
    }
  }

  /** Records one agent profile in the roster and binds its team tools. */
  #register(definition: AgentDefinition): void {
    const id = definition.alias as AgentId;
    this.#definitions.set(id, definition);
    this.#store.registerAgent({
      id,
      backend: backendName(definition),
      displayName: definition.displayName,
      provider: definition.provider,
      model: definition.model ?? null,
      effort: definition.effort ?? null,
      mode: definition.mode,
      unrestricted: definition.unrestricted,
    });
    this.#teamTools.set(id, new IdentityBoundTeamTools({
      agent: id,
      service: this.#teamService,
    }));
  }

  async configureAgent(definition: AgentDefinition): Promise<void> {
    const id = definition.alias as AgentId;
    this.#cancelTransientRetry(id);
    const previousProvider = this.#definitions.get(id)?.provider;
    this.#reconfiguring.add(id);
    this.#bumpGeneration(id);
    const oldAdapter = this.#adapters.get(id);
    if (oldAdapter) {
      await oldAdapter.stop().catch(() => undefined);
      await this.#collectors.get(id)?.catch(() => undefined);
    }
    this.#forgetPeer(id, "the agent was reconfigured");
    this.#adapters.delete(id);
    this.#suppliedAdapters.delete(id);
    this.#prepared.delete(id);
    this.#collectors.delete(id);
    this.#teamMcpCommands.delete(id);
    this.#bridges.delete(id);
    this.#bridgeConnections.delete(id);
    this.#offlineNotified.delete(id);
    this.#register(definition);
    // A conversation belongs to one harness. Moving the alias to another
    // provider cannot carry it, while a new model or effort on the same one can.
    if (previousProvider !== undefined && previousProvider !== definition.provider) {
      this.#store.setAgentState(id, this.#stateOf(id) ?? "stopped", { sessionId: null });
    }
    const activeGoal = this.#store.activeGoal();
    if (activeGoal) this.#store.addGoalParticipant(activeGoal.id, id);
    this.#prepareDefinition(
      definition,
      definition.mode === "managed" ? this.#adapterFactory?.(definition) : undefined,
    );
    try {
      if (this.#started) {
        await this.#startAgent(id);
        this.#verifyBridgesInBackground(id);
      }
      this.#stateChanged();
    } finally {
      this.#reconfiguring.delete(id);
    }
  }

  /**
   * Starts a peer's native harness again with its current profile.
   *
   * User retries resume the conversation when available. Automatic recovery
   * only handles structured temporary failures and requires that resume to work.
   */
  async restartAgent(id: AgentId, options: { readonly nudge?: boolean; readonly automatic?: boolean } = {}): Promise<void> {
    const definition = this.#definitions.get(id);
    if (!definition) throw new Error(`Watari agent is not configured: ${id}`);
    if (definition.mode === "external") {
      throw new Error(`${id} is external. Restart it from its own ${definition.provider} session.`);
    }
    if (!options.automatic) this.#transientAttempts.delete(id);
    const failure = this.#stateOf(id) === "failed" ? this.#agent(id)?.detail ?? "a failure" : null;
    await this.configureAgent(definition);
    if (this.#started && this.#stateOf(id) !== "ready") {
      throw new Error(`${id} did not restart: ${this.#agent(id)?.detail ?? "unknown reason"}`);
    }
    if (options.automatic && this.#resumeOutcomes.get(id) !== "resumed") {
      this.#markAgentUnavailable(id, "Automatic recovery stopped because the saved conversation could not be resumed");
      this.#stateChanged();
      throw new Error(`${id}'s saved conversation could not be resumed`);
    }
    if (failure !== null) this.#announceRecovery(id, failure, options.nudge ?? true);
  }

  /**
   * Tells the peers that were told to carry on without this one that it is
   * back, and whether it remembers its work. The agent itself is asked to
   * pick its work up again, unless the user is about to message it anyway.
   */
  #announceRecovery(id: AgentId, failure: string, nudge: boolean): void {
    const goal = this.#store.activeGoal();
    const resumed = this.#resumeOutcomes.get(id) === "resumed";
    this.#resumeOutcomes.delete(id);
    if (!goal) return;
    const recipients = this.#availableAgentIds().filter((peer) => peer !== id);
    if (recipients.length > 0) {
      this.#store.addMessage({
        goalId: goal.id,
        sender: "watari",
        recipients,
        kind: "system",
        delivery: "passive",
        topic: presenceTopic(id),
        body: resumed
          ? `${this.#displayName(id)} (${id}) was restarted and kept its conversation, so it remembers its work.`
          : `${this.#displayName(id)} (${id}) was restarted with a fresh conversation that knows the goal but not ` +
            "its earlier work, so send it what it needs.",
      });
    }
    if (nudge) {
      this.#store.addMessage({
        goalId: goal.id,
        sender: "watari",
        recipients: [id],
        kind: "system",
        delivery: "direct",
        body: resumed
          ? `Your harness was restarted after ${excerpt(failure, 200)}. Your conversation is intact. ` +
            "Check team_status and your inbox for changed ownership, then check the working tree for a half-finished edit before continuing."
          : this.#restartBrief(id, `Your harness was restarted after ${excerpt(failure, 200)}, and your ` +
            "previous conversation could not be restored. Team state to pick up from:"),
      });
    }
    this.#markDeliveryPending();
  }

  /** The team state a peer needs when its conversation could not be kept. */
  #restartBrief(id: AgentId, headline: string): string {
    const roster = this.#peerSummaries();
    const alone = roster.every((peer) => peer.id === id);
    return this.#ownStateNotice(id, roster, headline) +
      (alone ? "" : "\nAsk your peers with team_send for anything else you need.");
  }

  /**
   * An agent's own open claims and TODOs, restated. An agent working alone
   * owns the unassigned TODOs too, since nobody else will pick them up.
   */
  #ownStateNotice(id: AgentId, roster: readonly PeerSummary[], headline?: string): string {
    const goal = this.#store.activeGoal();
    const alone = roster.every((peer) => peer.id === id);
    return contextRefreshNotice({
      taskPolicy: describeTaskPolicy(this.#taskPolicy),
      ...(headline === undefined ? {} : { headline }),
      recipient: id,
      goal,
      roster,
      claims: goal
        ? this.#store.claims(goal.id).filter((claim) =>
          claim.claimant === id && (claim.state === "proposed" || claim.state === "active" || claim.state === "contested")
        )
        : [],
      todos: this.#store.todos().filter((todo) =>
        (todo.assignee === id || (alone && todo.assignee === null)) &&
        (todo.state === "todo" || todo.state === "doing" || todo.state === "blocked")
      ),
      owed: this.#store.replyObligations(id),
      awaiting: this.#store.awaitedReplies(id).length,
    });
  }

  /**
   * After a service restart, asks the agents that were cut off mid-turn to
   * continue, and tells any agent that lost its conversation where to pick up.
   * An agent that was idle and kept its conversation needs nothing.
   */
  #announceResume(): void {
    const goal = this.#store.activeGoal();
    let announced = false;
    if (goal) {
      for (const [id, outcome] of this.#resumeOutcomes) {
        const wasWorking = this.#interruptedAtStop.has(id);
        if (outcome === "resumed" && !wasWorking) continue;
        this.#store.addMessage({
          goalId: goal.id,
          sender: "watari",
          recipients: [id],
          kind: "system",
          // Passive: it goes along with whatever the user sends next, and never
          // starts a turn the user did not ask for.
          delivery: "passive",
          body: outcome === "resumed"
            ? "Watari restarted and resumed your conversation. Your last turn was cut off when the service " +
              "stopped, so check the working tree for a half-finished edit before you go on."
            : this.#restartBrief(id, "Watari restarted, and your previous conversation could not be restored. " +
              "Team state to pick up from:"),
        });
        announced = true;
      }
    }
    this.#resumeOutcomes.clear();
    this.#interruptedAtStop.clear();
    if (announced) this.#markDeliveryPending();
  }

  async removeAgent(id: AgentId): Promise<void> {
    if (!this.#definitions.has(id)) throw new Error(`Watari agent is not configured: ${id}`);
    if (this.#definitions.size === 1) throw new Error("Watari needs at least one configured agent");
    this.#cancelTransientRetry(id);
    this.#transientAttempts.delete(id);
    this.#reconfiguring.add(id);
    this.#bumpGeneration(id);
    const adapter = this.#adapters.get(id);
    if (adapter) {
      await adapter.stop().catch(() => undefined);
      await this.#collectors.get(id)?.catch(() => undefined);
    }
    this.#forgetPeer(id, "the agent was removed");
    this.#stoppedByUser.delete(id);
    this.#adapters.delete(id);
    this.#suppliedAdapters.delete(id);
    this.#prepared.delete(id);
    this.#collectors.delete(id);
    this.#definitions.delete(id);
    this.#teamTools.delete(id);
    this.#teamMcpCommands.delete(id);
    this.#bridges.delete(id);
    this.#bridgeConnections.delete(id);
    this.#offlineNotified.delete(id);
    this.#deliveryPending.delete(id);
    this.#store.unregisterAgent(id);
    this.#reconfiguring.delete(id);
    this.#stateChanged();
  }

  #prepareDefinition(definition: AgentDefinition, supplied?: AgentAdapter): void {
    const id = definition.alias as AgentId;
    if (supplied) {
      this.#adapters.set(id, supplied);
      this.#suppliedAdapters.add(id);
      return;
    }
    if (definition.mode === "external") {
      this.#store.setAgentState(id, "stopped", { detail: "waiting for its provider" });
      this.#bridges.set(id, unknownBridge(id, "waiting for provider connection"));
      return;
    }
    if (!isSupportedProvider(definition.provider)) {
      this.#store.setAgentState(id, "failed", { detail: `no managed ${definition.provider} harness yet` });
      this.#bridges.set(id, unknownBridge(id, "provider adapter is not implemented"));
      return;
    }
    // The bridge command is derived from the identity, the provider and the
    // project, so it exists whether or not the harness binary does: a peer
    // whose harness is missing can still have a working coordination channel,
    // and saying which of the two is broken is the whole point of showing both.
    const teamMcpCommand = selfCommand([
      "mcp", "--agent", id, "--provider", definition.provider, this.#project.launchDirectory,
    ]);
    this.#teamMcpCommands.set(id, teamMcpCommand);
    this.#bridges.set(id, unknownBridge(id));
    const executable = resolveExecutable(
      definition.provider,
      providerExecutableOverride(definition.provider),
    );
    if (!executable) {
      this.#store.setAgentState(id, "failed", { detail: `${definition.provider} executable not found` });
      return;
    }
    const shared = {
      executable,
      agent: id,
      teamMcpCommand,
      teamMcpEnv: this.#teamMcpEnvironment,
      ...(definition.model ? { model: definition.model } : {}),
      ...(definition.effort ? { effort: definition.effort } : {}),
      unrestricted: definition.unrestricted,
    };
    if (takesMailInTurn(definition.provider)) this.#takesMailInTurn.add(id);
    this.#adapters.set(id, createProviderAdapter(definition.provider, shared, this.boundaryInbox(id)));
  }

  snapshot(): TeamSnapshot {
    const stored = this.#store.snapshot();
    return { ...stored, bridges: [...this.#bridges.values()], questions: [...this.#questions.values()] };
  }

  activityDetail(id: string): ActivityDetail | null {
    return this.#store.activityDetail(id);
  }

  /** Current bridge health, without re-probing. */
  bridges(): readonly BridgeStatus[] {
    return [...this.#bridges.values()];
  }

  /** Read the latest provider capacity for the TUI without exposing credentials. */
  async providerStatus(force = false): Promise<ProviderStatusDocument> {
    if (!this.#capacityStatus) {
      return { schemaVersion: 1, generatedAt: Date.now(), providers: [] };
    }
    return this.#capacityStatus.refresh({ force });
  }

  /**
   * Checks every configured peer's team bridge end to end.
   *
   * `force` re-probes even a recently healthy bridge, which is what the `/check`
   * command wants. The automatic preflight before a send trusts a recent pass.
   */
  async verifyBridges(force = false): Promise<readonly BridgeStatus[]> {
    const results = await Promise.all(
      [...this.#teamMcpCommands.keys()].map((id) => this.#checkBridge(id, force)),
    );
    this.#stateChanged();
    return results;
  }

  /**
   * One peer's bridge, reusing a check that is already running or recent.
   *
   * Two sends landing together must not spawn two handshakes against the same
   * stdio command, so an in-flight probe is shared rather than repeated.
   */
  async #checkBridge(id: AgentId, force: boolean): Promise<BridgeStatus> {
    const command = this.#teamMcpCommands.get(id);
    if (!command) {
      return unknownBridge(id, "no team bridge is configured for this peer");
    }
    const current = this.#bridges.get(id);
    if (
      !force &&
      current?.state === "ready" &&
      Date.now() - current.checkedAt < BRIDGE_TRUST_MS
    ) {
      return current;
    }
    const running = this.#bridgeChecks.get(id);
    if (running) return await running;

    this.#bridges.set(id, { ...(current ?? unknownBridge(id)), state: "checking" });
    this.#stateChanged();
    const check = this.#probeBridge({
      agent: id,
      command,
      cwd: this.#project.launchDirectory,
      env: this.#teamMcpEnvironment,
    }).finally(() => this.#bridgeChecks.delete(id));
    this.#bridgeChecks.set(id, check);

    const status = await check;
    // The agent was removed or reconfigured while the probe ran. Its answer is
    // about a bridge nobody uses, and a failure would be reported against an
    // agent that no longer exists.
    if (this.#teamMcpCommands.get(id) !== command) return status;
    // A provider report already on file stays authoritative about whether the
    // model can see the server. The probe only speaks for the relay behind it.
    const previous = current?.providerReported;
    this.#bridges.set(
      id,
      previous ? { ...status, providerReported: previous } : status,
    );
    this.#stateChanged();
    if (status.state === "failed") {
      this.#emitSynthetic(id, "warning", `Team bridge check failed: ${status.detail}`);
    }
    return status;
  }

  async callTeamTool(
    agent: AgentId,
    name: string,
    input: unknown,
  ): Promise<import("../team/tools.ts").TeamToolResult> {
    let tools = this.#teamTools.get(agent);
    if (!tools) {
      if (!this.#store.agents().some((registered) => registered.id === agent)) {
        return {
          ok: false,
          error: `Watari agent alias is not registered in this project: ${agent}`,
        };
      }
      tools = new IdentityBoundTeamTools({
        agent,
        service: this.#teamService,
      });
      this.#teamTools.set(agent, tools);
    }
    return await tools.call(name, input);
  }

  async availableModels(agent: AgentId): Promise<readonly AgentModelOption[]> {
    const definition = this.#definitions.get(agent);
    if (!definition || !isSupportedProvider(definition.provider)) {
      throw new Error(`${agent} does not expose a managed native model catalog`);
    }
    // Test/injected adapters own their catalog. Real Claude discovery consumes
    // a Query object, so use an ephemeral catalog transport and leave the chat
    // adapter untouched until the user sends a message.
    if (this.#suppliedAdapters.has(agent)) {
      const adapter = this.#requiredAdapter(agent);
      if (!adapter.availableModels) throw new Error(`${agent} does not expose model discovery`);
      return await adapter.availableModels();
    }
    return await this.#discoverProviderModels(definition.provider);
  }

  /**
   * Reads a native provider catalog before an agent exists.
   *
   * A running adapter is preferred because both catalogs are provider-wide.
   * If the roster has no such adapter, a read-only transport is initialized
   * solely for discovery and is always stopped before this call returns. No
   * thread prompt or model turn is submitted on either path.
   */
  async availableProviderModels(provider: SupportedProviderId): Promise<readonly AgentModelOption[]> {
    for (const [id, definition] of this.#definitions) {
      const adapter = this.#adapters.get(id);
      const state = this.#stateOf(id);
      if (
        definition.provider === provider &&
        adapter?.availableModels &&
        (state === "ready" || state === "busy" || state === "waiting")
      ) {
        if (this.#suppliedAdapters.has(id)) return await adapter.availableModels();
      }
    }

    return await this.#discoverProviderModels(provider);
  }

  async #discoverProviderModels(provider: SupportedProviderId): Promise<readonly AgentModelOption[]> {
    const executable = resolveExecutable(
      provider,
      providerExecutableOverride(provider),
    );
    if (!executable) throw new Error(`${provider} executable was not found`);
    const adapter = createProviderAdapter(provider, {
      executable,
      agent: "watari-catalog",
      readOnlyProbe: true,
    });
    try {
      await adapter.start(this.#project);
      if (!adapter.availableModels) throw new Error(`${provider} does not expose model discovery`);
      return await adapter.availableModels();
    } finally {
      await adapter.stop().catch(() => undefined);
    }
  }

  /** Records a provider-owned MCP process joining this project's team. The
   * reference count matters because a harness may reconnect while an older
   * transport is still closing. */
  registerBridge(agent: AgentId, provider: string, token?: string): void {
    const definition = this.#definitions.get(agent);
    if (!definition) throw new Error(`Watari agent alias is not configured: ${agent}`);
    if (definition.provider !== provider) {
      throw new Error(`agent ${agent} is configured for ${definition.provider}, not ${provider}`);
    }
    // A provider started by hand with a global MCP entry often uses the same
    // alias as the managed peer. Letting it in made two harnesses share one
    // identity, so one of them could read and acknowledge the other's mail.
    if (definition.mode === "managed" && token !== this.#bridgeToken) {
      throw new Error(
        `${agent} is a managed agent in this Watari project, and Watari starts its team bridge itself. ` +
          `A separately launched ${provider} session needs its own external alias, for example ` +
          `\`/agent add ${provider}-cli ${provider} mode=external\` with \`watari mcp --agent ${provider}-cli\`.`,
      );
    }
    const connections = (this.#bridgeConnections.get(agent) ?? 0) + 1;
    this.#bridgeConnections.set(agent, connections);
    this.#bridges.set(agent, {
      agent,
      state: "ready",
      detail: `${definition.provider} connected to the identity-bound team MCP bridge`,
      tools: [],
      missing: [],
      elapsedMs: 0,
      checkedAt: Date.now(),
      providerReported: "connected",
    });
    // Presence follows the bridge for an external peer, because that
    // connection is all Watari has of it. A managed peer's state belongs to its
    // harness. A relay connecting, Watari's own preflight included, must not
    // report a harness that never started as something other than broken.
    if (definition.mode === "external") {
      this.#store.setAgentState(agent, "waiting", {
        detail: "external provider connected; messages wait in its MCP inbox",
      });
    }
    this.#stateChanged();
  }

  unregisterBridge(agent: AgentId): void {
    const connections = Math.max(0, (this.#bridgeConnections.get(agent) ?? 0) - 1);
    if (connections > 0) {
      this.#bridgeConnections.set(agent, connections);
      return;
    }
    this.#bridgeConnections.delete(agent);
    if (this.#definitions.get(agent)?.mode === "external") {
      this.#store.setAgentState(agent, "stopped", { detail: "provider MCP connection closed" });
      this.#bridges.set(agent, unknownBridge(agent, "provider MCP connection closed"));
      this.#stateChanged();
    }
  }

  subscribe(listener: (event: RuntimeEvent) => void): () => void {
    this.#listeners.add(listener);
    listener({ type: "snapshot", snapshot: this.snapshot() });
    return () => this.#listeners.delete(listener);
  }

  /**
   * Whether stopping the coordinator now could abandon provider or peer work.
   * A ready managed harness is intentionally idle: the service owns it and can
   * close it. External connections use `waiting`, so their provider remains a
   * live team member even when it is not currently producing output. A pending
   * wake is work a peer handed to Watari, and the service is the only thing
   * that can deliver it.
   */
  hasActiveWork(): boolean {
    if (this.#questions.size > 0) return true;
    if (
      this.#reconfiguring.size > 0 ||
      this.#delivering.size > 0 ||
      this.#deliveryPending.size > 0 ||
      this.#wakes.pending > 0 ||
      this.#store.jobs({ activeOnly: true }).length > 0
    ) {
      return true;
    }
    // A harness that is still coming up is Watari's own work, not the team's.
    // With no client attached and nothing queued it is starting for nobody.
    // Counting it here is what let one wedged harness keep the whole service,
    // and every provider child under it, alive indefinitely.
    return this.#store.agents().some((agent) =>
      agent.state === "busy" || agent.state === "waiting"
    );
  }

  async start(): Promise<void> {
    if (this.#started) {
      return;
    }
    this.#started = true;
    for (const id of this.#agentIds()) {
      if (!this.#adapters.has(id) && this.#definitions.get(id)?.mode === "managed") {
        const detail = this.#store.agents().find((agent) => agent.id === id)?.detail;
        this.#markAgentUnavailable(id, detail ?? `${id} native harness is unavailable`);
      }
    }
    await Promise.all(this.#agentIds().map((id) => this.#startAgent(id)));
    this.#announceResume();
    this.#stateChanged();
    // Verify the coordination bridges now rather than at the first send. A
    // broken bridge is the one thing the user should know before they type, the
    // check spawns only Watari's own stdio child and makes no model call, and
    // running it in the background keeps it off the path that opens the UI.
    this.#verifyBridgesInBackground();
    this.#capacityMonitor?.start();
  }

  /**
   * Hands a provider capacity notice to the agents running on that provider.
   *
   * Passive, so it never starts a turn by itself: a working agent reads it at
   * its next tool boundary, an idle one with the next message it gets anyway.
   * One topic per provider, so an unread notice is replaced by a newer one
   * instead of piling up.
   */
  #postCapacityNotice(notice: CapacityNoticePost): void {
    if (this.#stopping) return;
    if (this.#capacityProviders && !this.#capacityProviders.has(notice.provider)) return;
    const recipients = this.#agentIds().filter((id) => this.#definitions.get(id)?.provider === notice.provider);
    if (recipients.length === 0) return;
    const checkpoint = notice.change === "checkpoint";
    this.#store.addMessage({
      goalId: this.#store.activeGoal()?.id ?? null,
      sender: "watari",
      recipients,
      kind: "system",
      delivery: "passive",
      priority: checkpoint ? "urgent" : "normal",
      ...(checkpoint ? { priorityReason: "every account the provider can route to is out of quota" } : {}),
      topic: `provider-capacity:${notice.provider}`,
      body: notice.body,
    });
    this.#markDeliveryPending();
  }

  #withdrawCapacityNotice(provider: string): void {
    if (this.#stopping || (this.#capacityProviders && !this.#capacityProviders.has(provider))) return;
    const recipients = this.#agentIds().filter((id) => this.#definitions.get(id)?.provider === provider);
    if (this.#store.discardUndeliveredTopic(`provider-capacity:${provider}`, recipients) > 0) this.#stateChanged();
  }

  /** Probes bridges without holding up the caller. Results arrive as state. */
  #verifyBridgesInBackground(agent?: AgentId): void {
    const targets = agent ? [agent] : [...this.#teamMcpCommands.keys()];
    if (targets.length === 0) return;
    void Promise.all(
      targets
        .filter((id) => this.#teamMcpCommands.has(id))
        .map((id) => this.#checkBridge(id, false).catch(() => undefined)),
    ).then(() => this.#stateChanged());
  }

  async sendUserMessage(target: "all" | AgentId, text: string): Promise<void> {
    if (target !== "all") await this.#reviveForUser(target);
    const recipients = target === "all" ? this.#availableAgentIds() : [target];
    if (recipients.length === 0) {
      throw new Error("no ready Watari agents are available");
    }
    // Session creation is lazy. The user has now actually submitted a message,
    // so initialize the provider-owned MCP transport before admission.
    await this.#prepareRecipients(recipients);
    // Nothing here should reach a peer whose coordination bridge is broken
    // without the user being told, so the check runs before the handover.
    await this.#preflight(recipients);
    // The user is back: mail held since the service started flows again, and
    // a peer the user stopped resumes taking it once it is written to.
    const wasAwaiting = this.#awaitingUser;
    this.#awaitingUser = false;
    for (const recipient of recipients) this.#stoppedByUser.delete(recipient);
    try {
      const existingGoal = this.#store.activeGoal();
      if (!existingGoal) {
        const goal = this.#store.createGoal({
          instruction: text,
          initialAddressee: target === "all" ? null : target,
          // Every peer participates in the goal even when only one was addressed:
          // the goal is shared state both can read through `team_goal`.
          participants: this.#availableAgentIds(),
        });
        const goalMessage = this.#store.addMessage({
          goalId: goal.id,
          sender: "user",
          // Addressed to whoever the user aimed at. Typing in one peer's tab is
          // a message to that peer. Broadcasting it there was the bug that made
          // every first message reach everybody regardless of the tab.
          recipients,
          kind: "goal",
          body: text,
        });
        const roster = this.#peerSummaries();
        const managed = recipients.filter((recipient) => this.#adapters.has(recipient));
        const lead = target === "all" ? managed[0] ?? recipients[0] : target;
        const roleOf = (recipient: AgentId): StartupRole =>
          recipient === lead ? "intake_lead" : "collaborator";
        // MCP-only peers do not receive a native provider prompt from Watari.
        // Put the same deterministic role contract in their bound inbox so their
        // first team_inbox call cannot mistake a broadcast for permission to race.
        for (const recipient of recipients) {
          if (this.#adapters.has(recipient)) continue;
          this.#store.addMessage({
            goalId: goal.id,
            sender: "watari",
            recipients: [recipient],
            kind: "system",
            body: startupRoleInstruction({
              taskPolicy: describeTaskPolicy(this.#taskPolicy),
              recipient,
              roster,
              role: roleOf(recipient),
              position: recipients.indexOf(recipient) + 1,
              pullsMail: true,
            }),
          });
        }
        this.#activateArchive();
        this.#chatArchive?.write(this.snapshot());
        this.#stateChanged();
        // Start the stable intake lead first. `send` opens the native turn but
        // does not await completion, so collaborators follow immediately without
        // all racing to believe they own decomposition.
        for (const recipient of managed) {
          await this.#sendToAgent(recipient, this.#goalBrief(recipient, roleOf(recipient), recipients));
          this.#briefed.set(recipient, goal.id);
        }
        for (const recipient of recipients) {
          if (this.#adapters.has(recipient)) this.#store.acknowledge(recipient, goalMessage.id);
        }
        return;
      }
      const userMessage = this.#store.addMessage({
        goalId: existingGoal.id,
        sender: "user",
        recipients,
        kind: "user",
        body: text,
      });
      this.#activateArchive();
      this.#chatArchive?.write(this.snapshot());
      this.#stateChanged();
      await Promise.all(recipients.flatMap((recipient) => this.#adapters.has(recipient)
        ? [
            this.#sendToAgent(recipient, this.#withGoalBrief(recipient, this.#withWaitingNotes(recipient, text), "user"))
              .then(() => this.#markBriefed(recipient)),
          ]
        : []));
      for (const recipient of recipients) {
        if (this.#adapters.has(recipient)) this.#store.acknowledge(recipient, userMessage.id);
      }
    } finally {
      // Peers held since the service started take their waiting mail once
      // this message has been handed over, never ahead of it.
      if (wasAwaiting) this.#markDeliveryPending();
    }
  }

  /**
   * Brings a peer the user addressed by name back if its harness failed.
   *
   * Refusing the message would leave no way back short of reconfiguring the
   * agent, while the user typing to that peer is an unambiguous request to use
   * it again.
   */
  async #reviveForUser(target: AgentId): Promise<void> {
    const definition = this.#definitions.get(target);
    if (!definition) throw new Error(`Watari agent is not configured: ${target}`);
    if (this.#availableAgentIds().includes(target)) return;
    if (definition.mode === "external") {
      throw new Error(
        `${target} is an external agent and its ${definition.provider} session is not connected. ` +
          `Start that session with \`watari mcp --agent ${target}\` configured as its MCP server.`,
      );
    }
    const state = this.#stateOf(target);
    if (state === "starting") throw new Error(`${target} is still starting. Send again in a moment.`);
    await this.restartAgent(target, { nudge: false });
  }

  /** How each live peer is described to the others, so work can be split by strength. */
  #peerSummaries(): PeerSummary[] {
    return this.#availableAgentIds().map((id) => {
      const definition = this.#definitions.get(id);
      return {
        id,
        provider: definition?.provider ?? "unknown",
        model: definition?.model ?? null,
        effort: definition?.effort ?? null,
        ...this.#taskPolicy?.agents[id],
      };
    });
  }

  /** The shared goal as a peer's native conversation first meets it. */
  #goalBrief(recipient: AgentId, role: StartupRole, addressed: readonly AgentId[]): string {
    const goal = this.#store.activeGoal();
    if (!goal) throw new Error("there is no active shared goal");
    const roster = this.#peerSummaries();
    const position = addressed.indexOf(recipient) + 1 || roster.findIndex((peer) => peer.id === recipient) + 1;
    return sharedGoalPrompt({
      taskPolicy: describeTaskPolicy(this.#taskPolicy),
      goalId: goal.id,
      instruction: goal.instruction,
      initialAddressee: goal.initialAddressee,
      recipient,
      roster,
      role,
      position: Math.max(position, 1),
      checkout: this.#readCheckoutMap(),
    });
  }

  /** Git facts for a goal brief, read at most once per burst of briefs. */
  #readCheckoutMap(): string | null {
    const now = Date.now();
    if (this.#checkoutMap && now - this.#checkoutMap.at < CHECKOUT_MAP_TTL_MS) return this.#checkoutMap.text;
    const root = this.#project.repositoryRoot;
    const facts = root ? readCheckoutFacts(root) : null;
    const text = facts
      ? (root === this.#project.launchDirectory ? "" : `Repository root: ${root}\n`) + formatCheckoutMap(facts)
      : null;
    this.#checkoutMap = { at: now, text };
    return text;
  }

  /**
   * Prefixes input with the active goal for a peer whose conversation has not
   * been told about it. The caller records the brief once the input is taken.
   */
  #withGoalBrief(recipient: AgentId, input: string, source: "user" | "mail"): string {
    const goal = this.#store.activeGoal();
    if (!goal || this.#briefed.get(recipient) === goal.id) return input;
    const brief = this.#goalBrief(recipient, "joining", []);
    return source === "user"
      ? `${brief}\n\nThe user's message to you:\n\n${input}`
      : `${brief}\n\n${input}`;
  }

  #markBriefed(recipient: AgentId): void {
    const goal = this.#store.activeGoal();
    if (goal) this.#briefed.set(recipient, goal.id);
  }

  /**
   * Verifies the team bridge of every peer about to be written to.
   *
   * This is the no-token admission gate. A peer whose bridge is down could work
   * alone, but silently starting a shared goal while coordination is broken is
   * precisely the unsafe case Watari exists to prevent. The user can repair or
   * remove that peer, then retry without having spent a model turn.
   */
  async #preflight(recipients: readonly AgentId[]): Promise<void> {
    const checked = recipients.filter((id) => this.#teamMcpCommands.has(id));
    if (checked.length === 0) return;
    const statuses = await Promise.all(checked.map((id) => this.#checkBridge(id, false)));
    const broken = statuses.filter((status) => status.state !== "ready");
    if (broken.length === 0) return;
    for (const status of broken) {
      this.#emitSynthetic(
        status.agent,
        "warning",
        `${this.#displayName(status.agent)} cannot reach the team bridge: ${status.detail}. ` +
          "It will work on its own but cannot coordinate.",
      );
    }
    this.#stateChanged();
    throw new Error(
      `message not sent; team MCP preflight failed: ${broken
        .map((status) => `${status.agent}: ${status.detail}`)
        .join("; ")}`,
    );
  }

  /** The user's stop. The peer then takes nothing automatic until the user writes to it. */
  async interrupt(agent: AgentId): Promise<void> {
    this.#cancelTransientRetry(agent);
    const adapter = this.#adapters.get(agent);
    if (!adapter?.interrupt) return;
    this.#interrupted.add(agent);
    this.#stoppedByUser.add(agent);
    await adapter.interrupt();
    this.#clearQuestions(agent);
    this.#stateChanged();
  }

  /**
   * Interrupts a managed peer for a stop message, at a point that cannot tear
   * work in half.
   *
   * A running tool call may be a patch being applied or a command halfway
   * through a checkout operation. The interrupt waits for that call to finish,
   * bounded so a long build cannot hold a stop off indefinitely, and the stop
   * message itself goes over once the turn has ended.
   */
  async #interruptForStop(agent: AgentId): Promise<PeerInterruption> {
    this.#cancelTransientRetry(agent);
    const definition = this.#definitions.get(agent);
    if (!definition) {
      return { agent, interrupted: false, limitation: "peer is not in the live roster" };
    }
    if (definition.mode === "external") {
      return {
        agent,
        interrupted: false,
        limitation: "external MCP-only peers cannot be interrupted; the stop-priority inbox entry was retained",
      };
    }
    const state = this.#stateOf(agent);
    if (state !== "busy" && state !== "waiting") {
      return { agent, interrupted: false, limitation: `managed peer has no active turn (${state ?? "unknown"})` };
    }
    const adapter = this.#adapters.get(agent);
    if (!adapter?.interrupt) {
      return { agent, interrupted: false, limitation: "managed harness does not expose interruption" };
    }
    if (this.#toolsRunning(agent)) {
      this.#deferStop(agent);
      return {
        agent,
        interrupted: false,
        deferred: true,
        limitation: `a tool call is running, so the interrupt lands when it finishes or after ${formatDuration(this.#stopDeferMs)}`,
      };
    }
    this.#interrupted.add(agent);
    await adapter.interrupt();
    return { agent, interrupted: true };
  }

  #deferStop(agent: AgentId): void {
    if (this.#deferredStops.has(agent)) return;
    const timer = setTimeout(() => void this.#fireDeferredStop(agent), this.#stopDeferMs);
    timer.unref?.();
    this.#deferredStops.set(agent, timer);
  }

  async #fireDeferredStop(agent: AgentId): Promise<void> {
    const timer = this.#deferredStops.get(agent);
    if (!timer) return;
    clearTimeout(timer);
    this.#deferredStops.delete(agent);
    const state = this.#stateOf(agent);
    if (state !== "busy" && state !== "waiting") return;
    this.#interrupted.add(agent);
    await this.#adapters.get(agent)?.interrupt?.().catch((error: unknown) => {
      this.#emitSynthetic(agent, "warning", `A held stop could not interrupt: ${errorMessage(error)}`);
    });
  }

  async newChat(): Promise<void> {
    if (this.#handoff) throw new Error("an export is collecting handoffs; start a new chat once it is written");
    this.#activityTracker.flush();
    this.#resetLiveState();
    this.#finishArchive();
    await Promise.all([...this.#adapters.entries()].map(async ([id, adapter]) => {
      await adapter.resetSession?.();
      this.#prepared.delete(id);
      this.#transcript.reset(id);
      this.#activityTracker.reset(id);
    }));
    this.#store.resetConversation();
    for (const id of this.#agentIds()) {
      if (this.#adapters.has(id)) {
        this.#store.setAgentState(id, "ready", { sessionId: null, detail: "fresh chat, nothing sent" });
      } else if ((this.#bridgeConnections.get(id) ?? 0) > 0) {
        this.#store.setAgentState(id, "waiting", { sessionId: null, detail: "external provider connected" });
      } else {
        this.#store.setAgentState(id, "stopped", { sessionId: null, detail: "waiting for its provider" });
      }
    }
    this.#offlineNotified.clear();
    this.#deliveryPending.clear();
    this.#stateChanged();
  }

  /**
   * Forgets one agent's provider conversation because the user asked for it.
   *
   * This is the only way an agent loses its context without its harness
   * failing. The chat, the transcript, and the team state all stay. The agent
   * gets its own team state with its next handover, and the other peers are
   * told, passively, that it no longer remembers its earlier work.
   */
  async clearAgentContext(id: AgentId): Promise<void> {
    this.#cancelTransientRetry(id);
    this.#transientAttempts.delete(id);
    const definition = this.#definitions.get(id);
    if (!definition) throw new Error(`Watari agent is not configured: ${id}`);
    const adapter = this.#adapters.get(id);
    if (!adapter) {
      throw new Error(`${id} is external, so its conversation belongs to its own ${definition.provider} session`);
    }
    if (!adapter.resetSession) throw new Error(`${id}'s harness cannot start a new conversation in place`);
    const state = this.#stateOf(id);
    if (state === "busy" || state === "waiting") this.#interrupted.add(id);
    // A cleared agent cannot hand over what it no longer has.
    if (this.#handoff?.waiting.delete(id) && this.#handoff.waiting.size === 0) this.#handoff.done();
    await adapter.resetSession();
    this.#clearQuestions(id);
    this.#prepared.delete(id);
    this.#briefed.delete(id);
    this.#runningTools.delete(id);
    this.#transcript.reset(id);
    this.#activityTracker.reset(id);
    this.#store.setAgentState(id, "ready", { sessionId: null, detail: "context cleared by the user" });
    const goal = this.#store.activeGoal();
    this.#store.addMessage({
      goalId: goal?.id ?? null,
      sender: "watari",
      recipients: [id],
      kind: "system",
      delivery: "passive",
      body: this.#restartBrief(
        id,
        "The user cleared your conversation, so you start without your earlier context in this chat. " +
          "Team state to pick up from:",
      ),
    });
    const others = this.#availableAgentIds().filter((peer) => peer !== id);
    if (others.length > 0) {
      this.#store.addMessage({
        goalId: goal?.id ?? null,
        sender: "watari",
        recipients: others,
        kind: "system",
        delivery: "passive",
        body: `The user cleared ${this.#displayName(id)} (${id})'s conversation context. It no longer ` +
          "remembers its earlier work in this chat, so send it what it needs rather than assuming it knows.",
      });
    }
    this.#markDeliveryPending();
    this.#stateChanged();
  }

  /** Archived chats, newest first, with the one open now marked. */
  listChats(): readonly ChatListEntry[] {
    if (!this.#chatsDirectory) return [];
    const current = this.#chatArchive?.id ?? null;
    return listArchivedChats(this.#chatsDirectory).map((chat) => ({ ...chat, current: chat.id === current }));
  }

  /**
   * Switches to an archived chat and continues it.
   *
   * The open chat is archived first, exactly as `/new` would. Each agent then
   * resumes the provider conversation it had in the restored chat, so the
   * harnesses keep their own context, not only the transcript. An agent whose
   * provider no longer has that conversation starts fresh and is briefed.
   */
  async resumeChat(query: string): Promise<ResumedChat> {
    if (!this.#chatsDirectory || !this.#chatArchive) throw new Error("this service keeps no chat archives");
    if (this.#handoff) throw new Error("an export is collecting handoffs; resume once it is written");
    const chat = findArchivedChat(this.#chatsDirectory, query);
    if (!chat) throw new Error(`no archived chat matches "${query}"; /chats lists them`);
    if (chat.id === this.#chatArchive.id) throw new Error("that is the chat already open");
    const restorable = readArchive(chat.path);
    await this.newChat();
    const summary = this.#store.restoreChat(restorable);
    for (const id of this.#agentIds()) {
      const adapter = this.#adapters.get(id);
      const saved = this.#agent(id)?.sessionId ?? null;
      if (!adapter) {
        const connected = (this.#bridgeConnections.get(id) ?? 0) > 0;
        this.#store.setAgentState(id, connected ? "waiting" : "stopped", {
          sessionId: saved,
          detail: connected ? "external provider connected" : "waiting for its provider",
        });
        continue;
      }
      const resumed = saved !== null && await this.#resumeConversation(id, adapter, saved);
      if (saved !== null) this.#resumeOutcomes.set(id, resumed ? "resumed" : "fresh");
      this.#store.setAgentState(id, "ready", {
        sessionId: resumed ? saved : null,
        detail: resumed ? "resumed its conversation" : "restored chat, fresh conversation",
      });
    }
    // Keep writing the archive the chat came from, not a copy of it.
    this.#chatArchive.adopt(chat.id);
    this.#announceResume();
    this.#stateChanged();
    return { chatId: chat.id, title: chat.title, ...summary };
  }

  /**
   * Writes the whole chat to its archive now.
   *
   * The database already holds every row as it happens. This is for a reader
   * who wants the portable JSON and JSONL copy current before they move on.
   */
  saveChat(): { readonly path: string } {
    if (!this.#chatArchive) throw new Error("this service keeps no chat archives");
    if (!this.#store.hasUserMessages()) throw new Error("nothing to save yet; this chat has no messages");
    this.#activateArchive();
    this.#activityTracker.flush();
    this.#store.checkpoint();
    const full = this.#store.snapshot({ full: true });
    const info = this.#chatArchive.write(
      this.#bridges.size === 0 ? full : { ...full, bridges: [...this.#bridges.values()] },
      this.#store.activityRecords(),
    );
    if (!info) throw new Error("the chat archive could not be written");
    return { path: info.jsonPath };
  }

  /**
   * Writes the chat as one Markdown document that can be continued anywhere.
   *
   * With `handoff`, every managed agent that has a conversation is first asked
   * for its own handoff through team_handoff, and the file waits for them, up
   * to a bound. An agent that answers in its reply instead has that reply used, and
   * one that does not answer in time is named as such.
   */
  async exportChat(
    options: { readonly path?: string; readonly handoff?: boolean; readonly timeoutMs?: number } = {},
  ): Promise<ChatExportResult> {
    const path = resolveExportPath({
      requested: options.path ?? null,
      launchDirectory: this.#project.launchDirectory,
      exportsDirectory: this.#exportsDirectory,
      kind: options.handoff ? "handoff" : "chat",
    });
    // Without a request, the handoffs agents saved on their own still go in,
    // so a wrap-up that ended with team_handoff costs no further turns.
    const handoffs = options.handoff
      ? await this.#collectHandoffs(options.timeoutMs ?? this.#handoffTimeoutMs)
      : this.#store.handoffs(UNREQUESTED_HANDOFF);
    this.#activityTracker.flush();
    const markdown = chatExportMarkdown({
      snapshot: this.#store.snapshot({ full: true }),
      project: this.#project,
      exportedAt: Date.now(),
      checkout: readCheckoutFacts(this.#project.repositoryRoot ?? this.#project.launchDirectory),
      handoffs,
    });
    writeExportFile(path, markdown);
    return { path, handoffs: handoffs.map((handoff) => ({ agent: handoff.agent, source: handoff.source })) };
  }

  /** Asks each agent with a conversation for its handoff and waits for them. */
  async #collectHandoffs(timeoutMs: number): Promise<readonly TeamHandoff[]> {
    if (this.#handoff) throw new Error("an export is already collecting handoffs");
    const participants = this.#agentIds().filter((id) => {
      const state = this.#stateOf(id);
      return this.#adapters.has(id) &&
        (state === "ready" || state === "busy" || state === "waiting") &&
        (this.#agent(id)?.sessionId != null || this.#prepared.has(id));
    });
    if (participants.length === 0) return [];
    const requestId = crypto.randomUUID().slice(0, 8);
    const since = Date.now();
    const goal = this.#store.activeGoal();
    const waiting = new Map<AgentId, number>();
    for (const id of participants) {
      const message = this.#store.addMessage({
        goalId: goal?.id ?? null,
        sender: "watari",
        recipients: [id],
        kind: "system",
        delivery: "direct",
        priority: "urgent",
        priorityReason: "the user is exporting this chat",
        body: handoffPrompt(requestId),
      });
      waiting.set(id, message.id);
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      timer.unref?.();
      this.#handoff = {
        requestId,
        since,
        waiting,
        done: () => {
          clearTimeout(timer);
          resolve();
        },
      };
      this.#markDeliveryPending();
      this.#stateChanged();
    });
    this.#handoff = null;
    const answered = new Set(this.#store.handoffs(requestId).map((handoff) => handoff.agent));
    for (const id of participants) {
      if (answered.has(id)) continue;
      const text = this.#store.assistantTextSince(id, since);
      this.#store.recordHandoff({
        requestId,
        agent: id,
        source: text ? "reply" : "none",
        content: text || `${this.#displayName(id)} did not answer before the export was written.`,
      });
    }
    this.#stateChanged();
    return this.#store.handoffs(requestId);
  }

  #recordHandoff(agent: AgentId, markdown: string): HandoffReceipt {
    const pending = this.#handoff;
    if (pending?.waiting.has(agent)) {
      this.#store.recordHandoff({ requestId: pending.requestId, agent, source: "tool", content: markdown });
      pending.waiting.delete(agent);
      if (pending.waiting.size === 0) pending.done();
      return { saved: true, requested: true, note: "handed over for the export" };
    }
    this.#store.recordHandoff({ requestId: UNREQUESTED_HANDOFF, agent, source: "tool", content: markdown });
    return { saved: true, requested: false, note: "saved, though no export was waiting for it" };
  }

  /**
   * The turn that took an export request ended without team_handoff. What the
   * agent said in it is its handoff, so the export need not wait out the clock.
   */
  #settleHandoffAtTurnEnd(id: AgentId): void {
    const pending = this.#handoff;
    const request = pending?.waiting.get(id);
    if (!pending || request === undefined) return;
    if (this.#peerMail(id).some((message) => message.id === request)) return;
    const text = this.#store.assistantTextSince(id, pending.since);
    if (!text) return;
    this.#store.recordHandoff({ requestId: pending.requestId, agent: id, source: "reply", content: text });
    pending.waiting.delete(id);
    if (pending.waiting.size === 0) pending.done();
  }

  completeActiveGoal(): void {
    const goal = this.#store.activeGoal();
    if (!goal) {
      throw new Error("there is no active shared goal");
    }
    this.#store.completeGoal(goal.id);
    const recipients = this.#availableAgentIds();
    if (recipients.length > 0) {
      this.#store.addMessage({
        goalId: goal.id,
        sender: "watari",
        recipients,
        kind: "system",
        // Informational only. It used to start a paid turn for every idle peer
        // just so each could read that the goal was over.
        delivery: "passive",
        body: "The user marked the shared goal complete.",
      });
    }
    this.#stateChanged();
  }

  async respondToApproval(
    agent: AgentId,
    requestId: string | number,
    decision: "accept" | "decline" | "cancel",
  ): Promise<void> {
    const adapter = this.#requiredAdapter(agent);
    this.#offlineNotified.delete(agent);
    this.#store.setAgentState(agent, "busy", {
      sessionId: sessionId(adapter),
      detail: `approval ${decision === "accept" ? "accepted" : decision === "decline" ? "declined" : "cancelled"}`,
    });
    this.#stateChanged();
    try {
      await adapter.send({ kind: "approval_response", requestId, decision });
    } catch (error) {
      this.#markAgentUnavailable(agent, errorMessage(error), sessionId(adapter));
      this.#stateChanged();
      throw error;
    }
  }

  async respondToQuestion(agent: AgentId, requestId: string, input: QuestionResponse): Promise<void> {
    const question = this.#questions.get(requestId);
    if (!question || question.agent !== agent || this.#answeringQuestions.has(requestId)) {
      throw new Error("question is no longer waiting");
    }
    const response = validateQuestionResponse(question, input);
    const adapter = this.#requiredAdapter(agent);
    this.#answeringQuestions.add(requestId);
    try {
      await adapter.send({ kind: "question_response", requestId, response });
      this.#questions.delete(requestId);
      if (this.#stateOf(agent) === "waiting") {
        this.#store.setAgentState(agent, this.#hasQuestions(agent) ? "waiting" : "busy", { detail: "question response sent" });
      }
      this.#stateChanged();
    } finally {
      this.#answeringQuestions.delete(requestId);
    }
  }

  #hasQuestions(agent: AgentId): boolean {
    return [...this.#questions.values()].some((question) => question.agent === agent && question.blocking !== false);
  }

  #clearQuestions(agent: AgentId): void {
    for (const [id, question] of this.#questions) if (question.agent === agent) this.#questions.delete(id);
  }

  async stop(): Promise<void> {
    if (this.#stopping) {
      return;
    }
    this.#stopping = true;
    this.#capacityMonitor?.stop();
    // An export waiting on handoffs writes what it has rather than hang.
    this.#handoff?.done();
    this.#resetLiveState();
    await Promise.all(
      [...this.#adapters.entries()].map(async ([id, adapter]) => {
        const state = this.#stateOf(id);
        const working = state === "busy" || state === "waiting";
        // One harness that will not answer must not keep the service, and the
        // rest of its children, alive. The provider processes themselves are
        // detached groups that Watari signals and then kills, so abandoning a
        // stuck close here still leaves nothing running behind us.
        await withTimeout(adapter.stop(), this.#stopTimeoutMs, `${id} did not stop`).catch(
          () => undefined,
        );
        // The session id is kept so the next service resumes this conversation.
        this.#store.setAgentState(id, "stopped", {
          sessionId: sessionId(adapter) ?? this.#agent(id)?.sessionId ?? null,
          detail: working ? INTERRUPTED_DETAIL : "the service stopped",
        });
      }),
    );
    // An adapter that never closed its event queue leaves its collector loop
    // running, and waiting on it unbounded is the same hang one step further down.
    await withTimeout(
      Promise.allSettled(this.#collectors.values()),
      this.#stopTimeoutMs,
      "agent event streams did not end",
    ).catch(() => undefined);
    if (this.#snapshotTimer) {
      clearTimeout(this.#snapshotTimer);
      this.#snapshotTimer = null;
    }
    this.#snapshotPending = false;
    this.#activityTracker.close();
    this.#publishState();
    // The chat is written out in full but kept: the next service continues it.
    this.#finishArchive();
    this.#store.close();
  }

  /**
   * The inbox a harness with in-turn callbacks pulls its mail from.
   *
   * Public so the provider adapter can be built with it, and so its policy can
   * be exercised without a real provider process.
   */
  boundaryInbox(id: AgentId): BoundaryInbox {
    return {
      atToolBoundary: async () => this.#pullAtToolBoundary(id),
      beforeTurnEnd: async () => this.#pullBeforeTurnEnd(id),
    };
  }

  #pullAtToolBoundary(id: AgentId): string | null {
    if (
      this.#stopping ||
      this.#stoppedByUser.has(id) ||
      this.#delivering.has(id) ||
      this.#stateOf(id) === "failed"
    ) {
      return null;
    }
    if (this.#deferredStops.has(id)) {
      void this.#fireDeferredStop(id);
      return null;
    }
    const delivery = selectDeliverable(this.#peerMail(id), { boundary: "tool", dnd: this.#isDnd(id) });
    return delivery.length > 0 ? this.#handOverInTurn(id, delivery) : null;
  }

  /**
   * What a peer should read instead of ending its turn.
   *
   * Mail that would otherwise start a new turn is handed over now, in the turn
   * the peer already paid for. A question it was handed and has not answered
   * gets its one reminder here too. The questions are read before the new mail
   * is handed over, so a question that arrives in this same batch is never
   * reminded before the peer has seen it.
   */
  #pullBeforeTurnEnd(id: AgentId): string | null {
    if (
      this.#stopping ||
      this.#delivering.has(id) ||
      this.#interrupted.has(id) ||
      this.#stoppedByUser.has(id) ||
      this.#stateOf(id) === "failed"
    ) {
      return null;
    }
    // Read before the new mail is handed over, so a question arriving in this
    // same batch is never reminded before the peer has seen it.
    const reminder = this.#replies.remindInTurn(id);
    const delivery = selectDeliverable(this.#peerMail(id), { boundary: "idle", dnd: this.#isDnd(id) });
    if (delivery.length === 0 && reminder === null) return null;
    const parts: string[] = [];
    if (delivery.length > 0) parts.push(this.#handOverInTurn(id, delivery));
    if (reminder !== null) {
      parts.push(reminder);
      this.#stateChanged();
    }
    return parts.join("\n\n");
  }

  #handOverInTurn(id: AgentId, messages: readonly TeamMessage[]): string {
    this.#store.acknowledgeMessages(id, messages.map((message) => message.id));
    const state = this.#stateOf(id);
    if (state) this.#store.setAgentState(id, state, { detail: `${deliveryDetail(messages)} inside its turn` });
    const text = this.#withGoalBrief(id, teamMailPrompt(messages), "mail");
    // Whatever a hook returns is handed to the model, so it counts as taken.
    this.#markBriefed(id);
    this.#stateChanged();
    return text;
  }

  #bumpGeneration(id: AgentId): void {
    this.#generations.set(id, (this.#generations.get(id) ?? 0) + 1);
  }

  /** Whether `adapter`, started under `generation`, is still this agent's harness. */
  #isCurrent(id: AgentId, adapter: AgentAdapter, generation: number): boolean {
    return (this.#generations.get(id) ?? 0) === generation && this.#adapters.get(id) === adapter;
  }

  async #startAgent(id: AgentId): Promise<void> {
    const adapter = this.#adapters.get(id);
    if (!adapter) {
      return;
    }
    const generation = this.#generations.get(id) ?? 0;
    const savedSession = this.#agent(id)?.sessionId ?? null;
    this.#store.setAgentState(id, "starting");
    this.#stateChanged();
    try {
      await withTimeout(
        adapter.start(this.#project),
        this.#startTimeoutMs,
        `${id} did not finish starting`,
      );
      // The agent was reconfigured or restarted while this start was in
      // flight. Its outcome belongs to a harness nobody uses any more, and
      // reporting it would mark the replacement ready or failed wrongly.
      if (!this.#isCurrent(id, adapter, generation)) {
        await adapter.stop().catch(() => undefined);
        return;
      }
      const resumed = savedSession !== null && await this.#resumeConversation(id, adapter, savedSession);
      if (!this.#isCurrent(id, adapter, generation)) {
        await adapter.stop().catch(() => undefined);
        return;
      }
      if (savedSession !== null) this.#resumeOutcomes.set(id, resumed ? "resumed" : "fresh");
      this.#store.setAgentState(id, "ready", {
        sessionId: resumed ? savedSession : null,
        detail: resumed ? "resumed its conversation" : "no chat started yet",
      });
      this.#collectors.set(id, this.#collectEvents(id, adapter, generation));
    } catch (error) {
      if (!this.#isCurrent(id, adapter, generation)) {
        await adapter.stop().catch(() => undefined);
        return;
      }
      const detail = errorMessage(error);
      this.#markAgentUnavailable(id, detail);
      this.#emitSynthetic(id, "error", `Could not start ${id}: ${detail}`);
      await adapter.stop().catch(() => undefined);
    }
  }

  /**
   * Continues the agent's saved provider conversation. It makes no model call.
   * When the provider no longer has it, the agent starts fresh and says so.
   */
  async #resumeConversation(id: AgentId, adapter: AgentAdapter, sessionId: string): Promise<boolean> {
    if (!adapter.resume) return false;
    try {
      await withTimeout(adapter.resume(sessionId), this.#startTimeoutMs, `${id} did not resume`);
    } catch (error) {
      this.#emitSynthetic(
        id,
        "warning",
        `Could not resume ${id}'s conversation ${sessionId}: ${errorMessage(error)}. It starts a fresh one.`,
      );
      return false;
    }
    this.#prepared.add(id);
    const goal = this.#store.activeGoal();
    if (goal) this.#briefed.set(id, goal.id);
    return true;
  }

  async #collectEvents(id: AgentId, adapter: AgentAdapter, generation: number): Promise<void> {
    this.#transcript.reset(id);
    try {
      for await (const event of adapter.events()) {
        if (!this.#isCurrent(id, adapter, generation)) continue;
        // Native forms and answers are live UI state, never archived payloads.
        this.#transcript.write(event.kind === "question" ? { ...event, payload: undefined } : event);
        const activity = this.#activityTracker.consume(event);
        if (
          activity?.detail.kind === "file_change" &&
          activity.summary.state === "completed" &&
          activity.detail.files.length > 0
        ) {
          this.#checkEditOverlap(id, activity.detail.files.map((file) => file.path));
        }
        this.#trackToolCalls(id, event);
        if (isContextCompaction(event)) this.#refreshAfterCompaction(id);
        const lifecycleChanged = this.#updateAgentFromEvent(id, adapter, event);
        if (lifecycleChanged) this.#stateChanged();
        if (isTurnCompleted(event)) {
          this.#turnEnded(id);
        } else if (isToolEnd(event) && this.#deferredStops.has(id) && !this.#toolsRunning(id)) {
          // The tool call a stop was waiting on has finished. The interrupt
          // lands now, and the stop message goes over once the turn has ended.
          void this.#fireDeferredStop(id);
          continue;
        }
        if (isSafeBoundary(event)) {
          void this.#deliverPeerMessages(id).catch((error: unknown) => {
            this.#emitSynthetic(id, "warning", `Peer message delivery failed: ${errorMessage(error)}`);
          });
        }
      }
    } catch (error) {
      if (!this.#stopping && this.#isCurrent(id, adapter, generation)) {
        const detail = `event stream failed: ${errorMessage(error)}`;
        this.#markAgentUnavailable(id, detail);
        this.#emitSynthetic(id, "error", `${this.#displayName(id)} ${detail}`);
        this.#stateChanged();
      }
      return;
    }
    if (
      !this.#stopping &&
      !this.#reconfiguring.has(id) &&
      this.#isCurrent(id, adapter, generation) &&
      this.#stateOf(id) !== "failed"
    ) {
      const detail = "native harness event stream ended unexpectedly";
      this.#markAgentUnavailable(id, detail);
      this.#emitSynthetic(id, "error", `${this.#displayName(id)} ${detail}`);
      this.#stateChanged();
    }
  }

  /**
   * Queues the peer's own team state after its harness compacted its context.
   *
   * Passive, so it arrives at the next tool boundary or with the next handover
   * and never starts a turn on its own.
   */
  #refreshAfterCompaction(id: AgentId): void {
    const now = Date.now();
    if (now - (this.#refreshedAt.get(id) ?? 0) < COMPACTION_REFRESH_MS) return;
    this.#refreshedAt.set(id, now);
    this.#store.addMessage({
      goalId: this.#store.activeGoal()?.id ?? null,
      sender: "watari",
      recipients: [id],
      kind: "system",
      delivery: "passive",
      body: this.#ownStateNotice(id, this.#peerSummaries()),
    });
    this.#stateChanged();
  }

  /**
   * Tells both peers when one changed a file the other claimed or changed.
   *
   * Urgent, because each further edit on either side makes the collision
   * harder to untangle, but it still waits for a safe boundary. Watari names
   * the file and the claim and leaves the resolution to the two peers.
   */
  #checkEditOverlap(editor: AgentId, paths: readonly string[]): void {
    const goal = this.#store.activeGoal();
    if (!goal) return;
    const overlaps = this.#editOverlaps.record({
      goalId: goal.id,
      editor,
      paths,
      claims: this.#store.claims(goal.id).filter((claim) =>
        claim.state === "proposed" || claim.state === "active" || claim.state === "contested"
      ),
      live: new Set(this.#availableAgentIds()),
    });
    for (const overlap of overlaps) {
      this.#store.addMessage({
        goalId: goal.id,
        sender: "watari",
        recipients: [overlap.editor, overlap.other],
        kind: "system",
        priority: "urgent",
        priorityReason: "Two peers are changing the same file in the shared checkout.",
        body: editOverlapNotice(overlap),
      });
    }
    if (overlaps.length > 0) this.#markDeliveryPending();
  }

  #trackToolCalls(id: AgentId, event: AgentEvent): void {
    if (!event.providerEventId) return;
    if (isToolStart(event)) {
      const running = this.#runningTools.get(id) ?? new Set<string>();
      running.add(event.providerEventId);
      this.#runningTools.set(id, running);
    } else if (isToolEnd(event)) {
      this.#runningTools.get(id)?.delete(event.providerEventId);
    }
  }

  #toolsRunning(id: AgentId): boolean {
    return (this.#runningTools.get(id)?.size ?? 0) > 0;
  }

  /**
   * Settles what a finished turn leaves behind.
   *
   * A question the peer was handed and did not answer gets one reminder. When
   * it was already reminded, the asker is told instead, so nobody keeps waiting
   * on a peer that moved on. Claude is reminded inside its turn by its Stop
   * hook, so for it this only escalates. A turn someone interrupted is left
   * alone, because starting it again would undo the interrupt.
   */
  #turnEnded(id: AgentId): void {
    this.#runningTools.delete(id);
    this.#settleHandoffAtTurnEnd(id);
    const deferred = this.#deferredStops.get(id);
    if (deferred) {
      clearTimeout(deferred);
      this.#deferredStops.delete(id);
    }
    const interrupted = this.#interrupted.delete(id);
    if (this.#stateOf(id) === "failed" || !this.#adapters.has(id)) return;
    if (this.#stoppedByUser.has(id) && this.#stateOf(id) === "ready") {
      this.#store.setAgentState(id, "ready", { detail: "stopped by you, waiting for your next message" });
    }
    const outcome = this.#replies.settleTurnEnd(id, { interrupted });
    if (outcome.reminded) this.#deliveryPending.add(id);
    // An escalation is mail for the askers, who may be idle.
    if (outcome.escalated) this.#markDeliveryPending();
    else if (outcome.reminded) this.#stateChanged();
  }

  #updateAgentFromEvent(id: AgentId, adapter: AgentAdapter, event: AgentEvent): boolean {
    const bridgeChanged = this.#readProviderBridgeReport(id, event);
    if (event.kind === "question") {
      if (this.#stateOf(id) === "failed") return bridgeChanged;
      const question = PendingQuestionSchema.parse(event.payload);
      if (question.agent !== id) throw new Error("question belongs to another agent");
      if (this.#questions.size >= 64 && !this.#questions.has(question.id)) throw new Error("question queue is full");
      this.#questions.set(question.id, question);
      if (question.blocking !== false) this.#store.setAgentState(id, "waiting", { sessionId: sessionId(adapter), detail: "waiting for your answer (ctrl+q)" });
      return true;
    }
    if (event.kind === "question_resolved") {
      if (event.providerEventId) this.#questions.delete(event.providerEventId);
      if (this.#stateOf(id) === "waiting" && !this.#hasQuestions(id)) {
        this.#store.setAgentState(id, "busy", { detail: event.summary });
      }
      return true;
    }
    if (event.kind === "error") {
      this.#markAgentUnavailable(id, event.summary, sessionId(adapter));
      if (this.#definitions.get(id)?.provider === "codex" && isTransientCodexFailure(event.payload)) {
        this.#scheduleTransientRetry(id, adapter);
      } else {
        this.#cancelTransientRetry(id);
      }
      return true;
    }
    // A provider can emit a terminal result after the event that explains its
    // failure. That bookkeeping must not revive the peer or overwrite the root
    // cause. A user retry sets the state to busy before its next events arrive.
    if (this.#stateOf(id) === "failed") {
      // A terminal policy/auth/quota error supersedes an earlier temporary
      // failure. Never let its already-scheduled retry run past that stop.
      if (isTurnCompleted(event) && event.payload && !isTransientCodexFailure(event.payload)) {
        this.#cancelTransientRetry(id);
      }
      return bridgeChanged;
    }
    if (event.kind === "approval") {
      this.#store.setAgentState(id, "waiting", { sessionId: sessionId(adapter), detail: event.summary });
      return true;
    }
    if (isTurnStarted(event)) {
      this.#offlineNotified.delete(id);
      this.#store.setAgentState(id, "busy", { sessionId: sessionId(adapter), detail: event.summary });
      return true;
    }
    if (isTurnCompleted(event)) {
      this.#cancelTransientRetry(id);
      this.#transientAttempts.delete(id);
      this.#offlineNotified.delete(id);
      this.#store.setAgentState(id, "ready", { sessionId: sessionId(adapter), detail: event.summary });
      return true;
    }
    if (event.kind === "session") {
      // Session initialization is metadata, not a turn boundary. Claude emits
      // system/init again while a steered turn is working, and Codex can announce
      // its thread after send() has already marked it busy. Preserve that state.
      const state = this.#stateOf(id);
      if (state) this.#store.setAgentState(id, state, { sessionId: sessionId(adapter) });
      return true;
    }
    return bridgeChanged;
  }

  /**
   * Records what a harness says about the team MCP server it was configured with.
   *
   * The two providers report it in different shapes and at different moments.
   * Codex sends a startup-status notification per server and Claude lists the
   * servers on its session init message, so each is normalised here rather
   * than in the UI. This answers a question the probe cannot: whether the
   * server reached the model's tool list at all.
   */
  #readProviderBridgeReport(id: AgentId, event: AgentEvent): boolean {
    const report = providerBridgeReport(event);
    if (!report) return false;
    const current = this.#bridges.get(id) ?? unknownBridge(id);
    this.#bridges.set(id, withProviderReport(current, report));
    return true;
  }

  async #sendToAgent(id: AgentId, text: string, detail = "user message queued"): Promise<void> {
    const adapter = this.#requiredAdapter(id);
    const previous = this.#stateOf(id);
    this.#offlineNotified.delete(id);
    this.#store.setAgentState(id, "busy", { sessionId: sessionId(adapter), detail });
    this.#stateChanged();
    try {
      await adapter.send({ kind: "message", text });
    } catch (error) {
      if (error instanceof InputDeferredError) {
        if (previous) this.#store.setAgentState(id, previous, { sessionId: sessionId(adapter) });
        this.#stateChanged();
        throw error;
      }
      this.#markAgentUnavailable(id, errorMessage(error), sessionId(adapter));
      this.#stateChanged();
      throw error;
    }
  }

  /**
   * Hands a peer the mail its current boundary allows, by sending it input.
   *
   * This runs at a safe native boundary rather than only when the recipient
   * falls idle. An agentic turn can last many minutes without returning to
   * `ready`, and waiting for that left peers talking past each other. Codex
   * takes the input through `turn/steer` once its running tool calls have all
   * finished. Claude takes mail inside a turn through its hooks instead, and
   * a harness with neither takes it when its turn ends.
   */
  async #deliverPeerMessages(id: AgentId): Promise<void> {
    if (this.#stopping || this.#delivering.has(id) || this.#deferredStops.has(id)) return;
    // Handing mail over by input starts a turn, which only the user may cause
    // for a peer they stopped, or before they have written anything at all.
    if (this.#awaitingUser || this.#stoppedByUser.has(id)) return;
    const boundary = this.#pushBoundary(id);
    if (!boundary) return;
    const delivery = selectDeliverable(this.#peerMail(id), { boundary, dnd: this.#isDnd(id) });
    if (delivery.length === 0) return;
    this.#delivering.add(id);
    let delivered = false;
    try {
      delivered = await this.#handOverBySend(id, delivery);
    } finally {
      this.#delivering.delete(id);
    }
    if (delivered) this.#clearDeliveryRetry(id);
    else this.#scheduleDeliveryRetry(id);
  }

  /** Where a delivery by input would land now, or null when it cannot happen by input. */
  #pushBoundary(id: AgentId): DeliveryBoundary | null {
    const adapter = this.#adapters.get(id);
    if (!adapter) return null;
    const state = this.#stateOf(id);
    if (state === "ready") return "idle";
    if (state === "waiting") return "tool";
    if (state !== "busy" || !adapter.capabilities().safeSteer || this.#toolsRunning(id)) return null;
    return "tool";
  }

  async #handOverBySend(id: AgentId, messages: readonly TeamMessage[]): Promise<boolean> {
    const adapter = this.#requiredAdapter(id);
    const previous = this.#stateOf(id);
    this.#offlineNotified.delete(id);
    this.#store.setAgentState(id, "busy", { sessionId: sessionId(adapter), detail: deliveryDetail(messages) });
    this.#stateChanged();
    try {
      await adapter.send({ kind: "message", text: this.#withGoalBrief(id, teamMailPrompt(messages), "mail") });
      this.#markBriefed(id);
    } catch (error) {
      // A refused handover is not an outage. A harness that actually died says
      // so through its own event stream, and until then the mail stays queued.
      if (previous && this.#stateOf(id) === "busy") {
        this.#store.setAgentState(id, previous, { sessionId: sessionId(adapter) });
      }
      if (!this.#deliveryRetries.has(id)) {
        this.#emitSynthetic(id, "warning", `Peer mail is waiting because the harness refused it: ${errorMessage(error)}`);
      }
      this.#stateChanged();
      return false;
    }
    this.#store.acknowledgeMessages(id, messages.map((message) => message.id));
    this.#stateChanged();
    return true;
  }

  #scheduleDeliveryRetry(id: AgentId): void {
    const current = this.#deliveryRetries.get(id);
    if (current) clearTimeout(current.timer);
    const delayMs = current ? Math.min(current.delayMs * 2, DELIVERY_RETRY_MAX_MS) : DELIVERY_RETRY_MS;
    const timer = setTimeout(() => {
      void this.#deliverPeerMessages(id).catch(() => undefined);
    }, delayMs);
    timer.unref?.();
    this.#deliveryRetries.set(id, { timer, delayMs });
  }

  #clearDeliveryRetry(id: AgentId): void {
    const retry = this.#deliveryRetries.get(id);
    if (!retry) return;
    clearTimeout(retry.timer);
    this.#deliveryRetries.delete(id);
  }

  /** Mail waiting for a peer that Watari hands over. The user's own messages go directly. */
  /**
   * Watari's own passive notes for a peer, such as "your last turn was cut off",
   * go in with the user's next message to it. They never start a turn, and a
   * peer that lost its conversation needs the team state before it acts on
   * the message, not at its first tool call.
   */
  #withWaitingNotes(id: AgentId, text: string): string {
    const notes = this.#peerMail(id).filter((message) => message.sender === "watari" && message.delivery === "passive");
    if (notes.length === 0) return text;
    this.#store.acknowledgeMessages(id, notes.map((message) => message.id));
    return `${teamMailPrompt(notes)}\n\n${text}`;
  }

  #peerMail(id: AgentId): readonly TeamMessage[] {
    return this.#store
      .pendingInbox(id)
      .filter((message) => message.sender !== "user" && message.sender !== id);
  }

  /**
   * A team tool changed durable state, which may have created peer mail.
   *
   * Mail for a working peer waits for that peer's next boundary, so one turn is
   * not steered once per message. An idle peer will not produce another
   * boundary on its own, so its mail goes at once.
   */
  #markDeliveryPending(): void {
    for (const id of this.#agentIds()) {
      if (this.#stateOf(id) === "ready") {
        this.#deliveryPending.add(id);
      }
    }
    this.#stateChanged();
  }

  #forecast(recipient: AgentId, priority: MessagePriority): DeliveryReceipt {
    const agent = this.#agent(recipient);
    const definition = this.#definitions.get(recipient);
    if (!agent || !definition) return { agent: recipient, delivery: "offline" };
    const adapter = this.#adapters.get(recipient);
    const dnd = this.#isDnd(recipient);
    const delivery = forecastDelivery({
      external: definition.mode === "external",
      state: agent.state,
      midTurn: this.#takesMailInTurn.has(recipient) || (adapter?.capabilities().safeSteer ?? false),
      dnd,
      priority,
    });
    const note = delivery === "held_dnd" || (dnd && delivery === "after_turn")
      ? `dnd: ${agent.availabilityReason ?? "focused"}` +
        (agent.availabilityUntil ? `, ends in ${formatDuration(agent.availabilityUntil - Date.now())}` : "")
      : delivery === "offline"
      ? agent.detail ?? undefined
      : undefined;
    return { agent: recipient, delivery, ...(note ? { note } : {}) };
  }

  #scheduleWake(agent: AgentId, request: WakeRequest): ScheduledWake {
    const definition = this.#definitions.get(agent);
    if (!definition) throw new Error(`Watari agent is not configured: ${agent}`);
    const condition = request.condition;
    if (condition.kind === "command" && (definition.mode !== "managed" || !definition.unrestricted)) {
      throw new Error(
        "a command condition runs with Watari's own permissions, so only managed agents with unrestricted " +
          "permissions may use it. Use pid, path, or after_seconds instead.",
      );
    }
    if (condition.kind === "pid" && !processIsAlive(condition.pid)) {
      throw new Error(`process ${condition.pid} is not running, so there is nothing to wait for`);
    }
    if (condition.kind === "path" && existsSync(resolveWakePath(this.#project.launchDirectory, condition.path))) {
      throw new Error(`${condition.path} already exists, so there is nothing to wait for`);
    }
    if (this.#store.pendingWakes(agent).length >= MAX_WAKES_PER_AGENT) {
      throw new Error(`${agent} already has ${MAX_WAKES_PER_AGENT} pending wakes. Cancel one first.`);
    }
    if (this.#wakes.pending >= MAX_WAKES) {
      throw new Error(`the team already has ${MAX_WAKES} pending wakes`);
    }
    const seconds = condition.kind === "timer" ? condition.afterSeconds : request.timeoutSeconds;
    const wake = this.#store.createWake({
      agent,
      condition,
      note: request.note,
      deadlineAt: Date.now() + seconds * 1_000,
    });
    this.#wakes.start(wake);
    this.#stateChanged();
    return definition.mode === "external"
      ? { wake, limitation: "external MCP peers cannot be woken, so the notice will wait in team_inbox" }
      : { wake };
  }

  #cancelWake(agent: AgentId, id: number): TeamWake {
    const wake = this.#store.wake(id);
    if (!wake || wake.agent !== agent) throw new Error(`wake ${id} is not one of ${agent}'s wakes`);
    if (wake.state !== "pending") throw new Error(`wake ${id} already ${wake.state}`);
    this.#wakes.cancel(id);
    const cancelled = this.#store.settleWake(id, "cancelled", "cancelled by its agent");
    this.#stateChanged();
    return cancelled ?? wake;
  }

  /** Turns a settled wake into a notice the peer receives like mail. */
  #wakeSettled(wake: TeamWake, outcome: WakeOutcome): void {
    if (this.#stopping) return;
    const settled = this.#store.settleWake(wake.id, outcome.state, outcome.summary);
    if (!settled || !this.#definitions.has(wake.agent)) return;
    this.#store.addMessage({
      goalId: this.#store.activeGoal()?.id ?? null,
      sender: "watari",
      recipients: [wake.agent],
      kind: "system",
      // The peer asked for this, so it reaches the peer even in do-not-disturb.
      delivery: "direct",
      body: wakeNotice(settled, outcome),
    });
    this.#markDeliveryPending();
  }

  #setAvailability(
    agent: AgentId,
    mode: AgentAvailability,
    reason: string | null,
    minutes: number | null,
  ): TeamAgent {
    const existing = this.#availabilityTimers.get(agent);
    if (existing) {
      clearTimeout(existing);
      this.#availabilityTimers.delete(agent);
    }
    const until = mode === "dnd" && minutes ? Date.now() + minutes * 60_000 : null;
    const updated = this.#store.setAvailability(agent, mode, { reason, until });
    if (until !== null) {
      const timer = setTimeout(() => {
        this.#availabilityTimers.delete(agent);
        const current = this.#agent(agent);
        if (this.#stopping || current?.availability !== "dnd" || current.availabilityUntil !== until) return;
        this.#store.setAvailability(agent, "open");
        this.#markDeliveryPending();
      }, until - Date.now());
      timer.unref?.();
      this.#availabilityTimers.set(agent, timer);
    }
    return updated;
  }

  #isDnd(id: AgentId): boolean {
    const agent = this.#agent(id);
    if (agent?.availability !== "dnd") return false;
    return agent.availabilityUntil === null || agent.availabilityUntil === undefined ||
      agent.availabilityUntil > Date.now();
  }

  /** Drops the live state tied to one peer's harness when it is replaced or removed. */
  #forgetPeer(id: AgentId, reason: string): void {
    this.#cancelTransientRetry(id);
    this.#clearQuestions(id);
    this.#store.markJobsUnknown(id);
    for (const wakeId of this.#wakes.cancelAgent(id)) {
      this.#store.settleWake(wakeId, "cancelled", reason);
    }
    const availability = this.#availabilityTimers.get(id);
    if (availability) clearTimeout(availability);
    this.#availabilityTimers.delete(id);
    const stop = this.#deferredStops.get(id);
    if (stop) clearTimeout(stop);
    this.#deferredStops.delete(id);
    this.#clearDeliveryRetry(id);
    this.#runningTools.delete(id);
    this.#interrupted.delete(id);
    this.#takesMailInTurn.delete(id);
    this.#briefed.delete(id);
    this.#refreshedAt.delete(id);
  }

  /** Forgets everything that only means something inside one chat. */
  #resetLiveState(): void {
    for (const id of this.#transientRetries.keys()) this.#cancelTransientRetry(id);
    this.#transientAttempts.clear();
    this.#questions.clear();
    this.#store.markJobsUnknown();
    this.#wakes.stop();
    for (const timer of this.#availabilityTimers.values()) clearTimeout(timer);
    this.#availabilityTimers.clear();
    for (const timer of this.#deferredStops.values()) clearTimeout(timer);
    this.#deferredStops.clear();
    for (const retry of this.#deliveryRetries.values()) clearTimeout(retry.timer);
    this.#deliveryRetries.clear();
    this.#runningTools.clear();
    this.#interrupted.clear();
    this.#briefed.clear();
    this.#refreshedAt.clear();
    this.#editOverlaps.reset();
    this.#checkoutMap = null;
    this.#resumeOutcomes.clear();
  }

  #cancelTransientRetry(id: AgentId): void {
    const timer = this.#transientRetries.get(id);
    if (timer) clearTimeout(timer);
    this.#transientRetries.delete(id);
  }

  #scheduleTransientRetry(id: AgentId, adapter: AgentAdapter): void {
    const goalId = this.#store.activeGoal()?.id;
    if (this.#transientRetries.has(id) || this.#stopping || !this.#started || this.#awaitingUser ||
      this.#stoppedByUser.has(id) || !goalId || !sessionId(adapter) ||
      this.#definitions.get(id)?.mode !== "managed") return;
    const attempts = this.#transientAttempts.get(id) ?? 0;
    if (attempts >= MAX_TRANSIENT_RETRIES) {
      if (attempts === MAX_TRANSIENT_RETRIES) {
        this.#emitSynthetic(id, "warning", "Automatic recovery exhausted two retries; the agent remains stopped");
        this.#transientAttempts.set(id, attempts + 1);
      }
      return;
    }
    const attempt = attempts + 1;
    this.#transientAttempts.set(id, attempt);
    const delayMs = this.#transientRetryMs * 2 ** attempts;
    const generation = this.#generations.get(id) ?? 0;
    this.#emitSynthetic(id, "warning", `Temporary provider failure: recovery ${attempt}/${MAX_TRANSIENT_RETRIES} in ${formatDuration(delayMs)}, preserving the conversation`);
    const timer = setTimeout(() => {
      this.#transientRetries.delete(id);
      if (this.#stopping || this.#awaitingUser || this.#stoppedByUser.has(id) ||
        this.#store.activeGoal()?.id !== goalId || this.#stateOf(id) !== "failed" ||
        !this.#isCurrent(id, adapter, generation)) return;
      void this.restartAgent(id, { automatic: true }).catch((error: unknown) => {
        this.#emitSynthetic(id, "warning", `Automatic recovery stopped: ${errorMessage(error)}`);
      });
    }, delayMs);
    timer.unref?.();
    this.#transientRetries.set(id, timer);
  }

  #stateOf(id: AgentId): AgentRuntimeState | undefined {
    return this.#agent(id)?.state;
  }

  #agent(id: AgentId): TeamAgent | undefined {
    return this.#store.agents().find((agent) => agent.id === id);
  }

  /** Marks one peer down and leaves one durable handoff for every other
   * available peer. Repeated terminal/provider errors retain the first useful
   * cause and do not spam the team. */
  #markAgentUnavailable(
    id: AgentId,
    detail: string,
    currentSessionId?: string | null,
  ): void {
    this.#clearQuestions(id);
    if (this.#offlineNotified.has(id)) return;
    const safeDetail = redactSummary(detail);
    // Peers read this in their own context, so it carries the cause, not a
    // provider's whole error payload.
    const shortDetail = excerpt(safeDetail, 300);
    this.#store.setAgentState(id, "failed", {
      ...(currentSessionId === undefined ? {} : { sessionId: currentSessionId }),
      detail: safeDetail,
    });
    this.#offlineNotified.add(id);
    this.#runningTools.delete(id);

    const recipients = this.#availableAgentIds().filter((peer) => peer !== id);
    if (recipients.length === 0) return;
    const goalId = this.#store.activeGoal()?.id ?? null;
    this.#replies.notifyOffline(id, shortDetail, recipients);
    const claims = goalId
      ? this.#store.claims(goalId).filter((claim) =>
        claim.claimant === id && (claim.state === "proposed" || claim.state === "active" || claim.state === "contested")
      )
      : [];
    const claimNote = claims.length > 0
      ? ` Its open claims, which a peer may take over after checking the working tree: ${claims
        .map((claim) => `${claim.id} (${excerpt(claim.summary, 80)})`)
        .join(", ")}.`
      : "";
    this.#store.addMessage({
      goalId,
      sender: "watari",
      recipients,
      kind: "system",
      priority: "urgent",
      priorityReason: "A managed peer went offline, and waiting for it would stall or misroute the active goal.",
      // Working peers read it at their next boundary. Idle peers are not woken
      // for it, since they are not waiting on anything this changes.
      delivery: "passive",
      topic: presenceTopic(id),
      body: `${this.#displayName(id)} (${id}) is offline: ${shortDetail}. Continue independently and do not wait for this peer.${claimNote}`,
    });
  }

  #stateChanged(): void {
    if (this.#snapshotTimer) {
      this.#snapshotPending = true;
      return;
    }
    this.#publishState();
    const timer = setTimeout(() => {
      this.#snapshotTimer = null;
      if (this.#snapshotPending) {
        this.#snapshotPending = false;
        this.#stateChanged();
      }
    }, SNAPSHOT_INTERVAL_MS);
    timer.unref?.();
    this.#snapshotTimer = timer;
  }

  #publishState(): void {
    // Clearing this before publishing exposes the state subscribers should act
    // on. Any actual handover immediately marks its recipient busy again.
    const due = [...this.#deliveryPending];
    this.#deliveryPending.clear();
    const snapshot = this.snapshot();
    this.#scheduleArchive();
    this.#broadcast({ type: "state_changed", snapshot });
    for (const id of due) {
      // Pending delivery is for a peer that is idle and so will reach no
      // boundary of its own. One that started working since is handed its
      // mail at its next boundary, never in the middle of a step.
      if (this.#stateOf(id) !== "ready") continue;
      void this.#deliverPeerMessages(id).catch((error: unknown) => {
        this.#emitSynthetic(id, "warning", `Peer message delivery failed: ${errorMessage(error)}`);
      });
    }
  }

  /**
   * Keeps the chat archive current without rewriting it on every state change.
   *
   * The archive is two whole-file rewrites of the snapshot. Writing it on each
   * publish meant megabytes of serialisation and disk writes per minute of a
   * busy team, for a file only read after the chat ends or the service crashes.
   */
  #scheduleArchive(): void {
    if (!this.#chatArchive?.active || this.#archiveTimer) return;
    const timer = setTimeout(() => {
      this.#archiveTimer = null;
      if (this.#stopping || !this.#chatArchive) return;
      // The bounded live snapshot keeps each write cheap. Once a minute the
      // whole chat is written instead, so the archive a crash leaves behind is
      // complete, not just the chat's last few hundred rows.
      if (Date.now() - this.#archivedFullAt >= FULL_ARCHIVE_INTERVAL_MS) {
        this.#archivedFullAt = Date.now();
        this.#chatArchive.write(this.#store.snapshot({ full: true }), this.#store.activityRecords());
      } else {
        this.#chatArchive.write(this.snapshot());
      }
    }, ARCHIVE_INTERVAL_MS);
    timer.unref?.();
    this.#archiveTimer = timer;
  }

  /** Names the archive after the chat's first message, so a resumed chat keeps one file. */
  #activateArchive(): void {
    if (!this.#chatArchive || this.#chatArchive.active) return;
    const first = this.#store.firstMessage();
    this.#chatArchive.activate(first?.createdAt, first ? `${first.createdAt}:${first.id}` : undefined);
  }

  /** Writes the finished chat whole, not only the rows a live snapshot keeps. */
  #finishArchive(): void {
    if (this.#archiveTimer) {
      clearTimeout(this.#archiveTimer);
      this.#archiveTimer = null;
    }
    if (!this.#chatArchive) return;
    const full = this.#store.snapshot({ full: true });
    this.#chatArchive.finish(
      this.#bridges.size === 0 ? full : { ...full, bridges: [...this.#bridges.values()] },
      this.#store.activityRecords(),
    );
  }

  #emitSynthetic(id: AgentId, kind: "warning" | "error", summary: string): void {
    const event: AgentEvent = { agent: id, kind, summary, timestamp: Date.now() };
    this.#transcript.write(event);
  }

  #publishTranscriptEvent(id: number): void {
    const event = this.#store.event(id);
    if (event) this.#broadcast({ type: "transcript_upsert", event });
  }

  #availableAgentIds(): AgentId[] {
    const states = new Map(this.#store.agents().map((agent) => [agent.id, agent.state]));
    return this.#agentIds().filter((id) => {
      const state = states.get(id);
      return (this.#adapters.has(id) || (this.#bridgeConnections.get(id) ?? 0) > 0) &&
        (state === "ready" || state === "busy" || state === "waiting");
    });
  }

  #agentIds(): AgentId[] {
    return [...this.#definitions.keys()];
  }

  #displayName(id: AgentId): string {
    return this.#definitions.get(id)?.displayName ?? id;
  }

  #requiredAdapter(id: AgentId): AgentAdapter {
    const adapter = this.#adapters.get(id);
    if (!adapter) {
      throw new Error(`${id} native harness is unavailable`);
    }
    return adapter;
  }

  async #prepareRecipients(recipients: readonly AgentId[]): Promise<void> {
    await Promise.all(recipients.map(async (id) => {
      if (this.#prepared.has(id)) return;
      const adapter = this.#adapters.get(id);
      if (!adapter?.prepare) return;
      await adapter.prepare();
      this.#prepared.add(id);
    }));
  }

  #broadcast(event: RuntimeEvent): void {
    for (const listener of this.#listeners) {
      listener(event);
    }
  }
}

function editOverlapNotice(overlap: EditOverlap): string {
  const why = overlap.claim
    ? `it is inside ${overlap.other}'s claim ${overlap.claim.id} (${excerpt(overlap.claim.summary, 80)})`
    : `${overlap.other} changed it earlier in this goal`;
  return `Edit overlap on ${overlap.path}: ${overlap.editor} just changed it, and ${why}. ` +
    `${overlap.editor}, hold further edits to that file until you two agree. ` +
    `${overlap.other}, check the working tree before your next edit there. Settle it with team_send.`;
}

/** Offline and restart notices about one peer: only the latest one still matters. */
function presenceTopic(id: AgentId): string {
  return `presence:${id}`;
}

function deliveryDetail(messages: readonly TeamMessage[]): string {
  const [only] = messages;
  if (messages.length === 1 && only) {
    return only.sender === "watari" ? "watari notice" : `peer message from ${only.sender}`;
  }
  return `${messages.length} peer messages delivered`;
}

function excerpt(text: string, limit: number): string {
  const line = text.replace(/\s+/gu, " ").trim();
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

function sessionId(adapter: AgentAdapter): string | null {
  return adapter.sessionId ?? null;
}

function errorMessage(error: unknown): string {
  return redactSummary(error instanceof Error ? error.message : String(error));
}
