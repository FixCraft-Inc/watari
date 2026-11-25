import type { AgentId } from "../models.ts";
import { boundedActivityDetail } from "../activity/mcp-view.ts";
import {
  DEFAULT_MCP_DETAIL_BYTES,
  MAX_MCP_DETAIL_BYTES,
} from "../activity/retention.ts";
import type { DeliveryForecast } from "../service/delivery-policy.ts";
import { describeWakeCondition, formatDuration } from "../service/wake-scheduler.ts";
import type { BridgeStatus } from "./bridge-check.ts";
import {
  checkTaskAssignment,
  planTaskAssignment,
  type ProjectTaskPolicy,
  type TaskCandidate,
} from "../task-policy.ts";
import { pathsOverlap, type TeamStore } from "../state/store.ts";
import type {
  AgentAvailability,
  ClaimState,
  GoalStance,
  MessagePriority,
  TeamAgent,
  TeamClaim,
  TeamFinding,
  TeamJob,
  TeamJobState,
  TeamMessage,
  TeamTodo,
  TeamWake,
  TodoState,
  WakeCondition,
} from "../state/types.ts";
import { TEAM_TOOL_CATALOG } from "./tool-catalog.ts";

/** A wake that names no timeout gives up after this long and says so. */
const DEFAULT_WAKE_TIMEOUT_SECONDS = 4 * 60 * 60;
const DEFAULT_COMMAND_INTERVAL_SECONDS = 60;
const DEFAULT_DND_MINUTES = 30;
/** Messages one `team_inbox` history call returns, and the most it may ask for. */
const DEFAULT_HISTORY_LIMIT = 20;
const MAX_HISTORY_LIMIT = 100;

export interface PeerInterruption {
  readonly agent: AgentId;
  readonly interrupted: boolean;
  /** The interrupt waits for the peer's running tool call to finish. */
  readonly deferred?: boolean;
  readonly limitation?: string;
}

/** When one recipient will read a message, as far as the live runtime knows. */
export interface DeliveryReceipt {
  readonly agent: AgentId;
  readonly delivery: DeliveryForecast;
  /** Why the message waits, when `delivery` alone does not say. */
  readonly note?: string;
}

export interface WakeRequest {
  readonly condition: WakeCondition;
  readonly note: string;
  readonly timeoutSeconds: number;
}

export interface ScheduledWake {
  readonly wake: TeamWake;
  /** Set when the peer cannot be woken and will only find the notice in its inbox. */
  readonly limitation?: string;
}

/** What the live runtime adds to the durable team state. */
export interface TeamCoordination {
  forecast(recipient: AgentId, priority: MessagePriority): DeliveryReceipt;
  scheduleWake(agent: AgentId, request: WakeRequest): ScheduledWake;
  cancelWake(agent: AgentId, id: number): TeamWake;
  setAvailability(
    agent: AgentId,
    mode: AgentAvailability,
    reason: string | null,
    minutes: number | null,
  ): TeamAgent;
  /** Takes an agent's handoff for a chat export. */
  recordHandoff(agent: AgentId, markdown: string): HandoffReceipt;
}

export interface HandoffReceipt {
  readonly saved: true;
  /** Whether an export was waiting for this agent. */
  readonly requested: boolean;
  readonly note: string;
}

export interface TeamApplicationOptions {
  readonly store: TeamStore;
  readonly bridgeHealth?: () => readonly BridgeStatus[];
  readonly interruptPeer?: (agent: AgentId) => Promise<PeerInterruption>;
  readonly onMutation?: () => void;
  readonly coordination?: TeamCoordination;
  readonly taskPolicy?: ProjectTaskPolicy | undefined;
  /** Runtime-only holds and connection checks, beyond durable peer state. */
  readonly canDelegate?: (agent: AgentId) => boolean;
}

/** Application boundary shared by native dynamic tools and both MCP transports. */
export class TeamApplicationService {
  readonly #store: TeamStore;
  readonly #bridgeHealth: () => readonly BridgeStatus[];
  readonly #interruptPeer: (agent: AgentId) => Promise<PeerInterruption>;
  readonly #onMutation: () => void;
  readonly #coordination: TeamCoordination;
  readonly #taskPolicy: ProjectTaskPolicy | undefined;
  readonly #canDelegate: (agent: AgentId) => boolean;

  constructor(options: TeamApplicationOptions) {
    this.#store = options.store;
    this.#taskPolicy = options.taskPolicy;
    this.#canDelegate = options.canDelegate ?? (() => true);
    this.#bridgeHealth = options.bridgeHealth ?? (() => []);
    this.#interruptPeer = options.interruptPeer ?? (async (agent) => ({
      agent,
      interrupted: false,
      limitation: "this team host has no managed-turn interrupt control",
    }));
    this.#onMutation = options.onMutation ?? (() => undefined);
    this.#coordination = options.coordination ?? storeOnlyCoordination(options.store);
  }

  async execute(actor: AgentId, name: string, input: Record<string, unknown>): Promise<unknown> {
    const definition = TEAM_TOOL_CATALOG.find((entry) => entry.name === name);
    if (!definition) throw new Error(`unknown Watari team tool: ${name}`);
    const validated = definition.validateInput(input);
    switch (name) {
      case "team_roster":
        return this.#roster(actor);
      case "team_status":
        return this.#status(actor);
      case "team_goal":
        return this.#goal();
      case "team_send":
        return await this.#send(actor, validated);
      case "team_inbox":
        return this.#inbox(actor, validated);
      case "team_activity":
        return this.#activities(validated);
      case "team_activity_detail":
        return this.#activityDetail(validated);
      case "team_job":
        return this.#job(actor, validated);
      case "team_progress":
        return this.#progress(actor, validated);
      case "team_todo":
        return this.#todo(actor, validated);
      case "team_wake":
        return this.#wake(actor, validated);
      case "team_availability":
        return this.#availability(actor, validated);
      case "team_claim_update":
        return this.#claimUpdate(actor, validated);
      case "team_finding_update":
        return this.#findingUpdate(actor, validated);
      case "team_claim":
        return this.#claim(actor, validated);
      case "team_release":
        return this.#setClaimState(actor, validated, "released");
      case "team_finding":
        return this.#legacyFinding(actor, validated);
      case "team_handoff":
        return this.#coordination.recordHandoff(actor, String(validated.markdown));
      default:
        throw new Error(`unknown Watari team tool: ${name}`);
    }
  }

  /**
   * Who is on the team and what each runs on, so a peer can split work by
   * strength. The stored rows carried session ids, timestamps, and transport
   * names that cost tokens on every call and told a model nothing it could use.
   */
  #roster(actor: AgentId): unknown {
    const now = Date.now();
    return {
      you: actor,
      peers: this.#store.agents().map((agent) => compact({
        id: agent.id,
        provider: agent.provider,
        model: agent.model ?? undefined,
        effort: agent.effort ?? undefined,
        ...this.#taskPolicy?.agents[agent.id],
        mode: agent.mode === "external" ? "external" : undefined,
        state: agent.state,
        detail: agent.state === "failed" && agent.detail ? clip(agent.detail, 160) : undefined,
        dnd: agent.availability === "dnd"
          ? compact({
              reason: agent.availabilityReason ?? undefined,
              ends_in: agent.availabilityUntil ? formatDuration(agent.availabilityUntil - now) : undefined,
            })
          : undefined,
      })),
      ...(this.#taskPolicy ? { task_policy: this.#taskPolicy } : {}),
    };
  }

  #goal(): unknown {
    const goal = this.#store.activeGoal();
    if (!goal) return null;
    return compact({
      id: goal.id,
      instruction: goal.instruction,
      first_addressed: goal.initialAddressee ?? undefined,
      participants: this.#store.goalParticipants(goal.id).map((entry) => compact({
        agent: entry.agent,
        stance: entry.stance,
        evidence: entry.completionEvidence ? clip(entry.completionEvidence, 300) : undefined,
      })),
    });
  }

  /**
   * The broad coordination view, sized for a model to read.
   *
   * Every entry is clipped and every empty section is left out. The earlier
   * view returned full agent rows, every bridge's tool list, the whole goal
   * text, and activity ids without their content, which cost thousands of
   * tokens per call and told a peer little it could act on.
   */
  #status(actor: AgentId): unknown {
    const now = Date.now();
    const goal = this.#store.activeGoal();
    const bridges = new Map(this.#bridgeHealth().map((bridge) => [bridge.agent, bridge]));
    const wakes = this.#store.pendingWakes();
    const activeJobs = this.#store.jobs({ activeOnly: true });
    const jobs = activeJobs.slice(0, 32);
    // What each working peer touched last, so nobody has to ask "what are you on?".
    const latest = new Map<string, string>();
    for (const activity of this.#store.activitySummaries()) {
      latest.set(activity.agent, clip(`${activity.state === "running" ? "running " : ""}${activity.title}`, 120));
    }
    return compact({
      you: actor,
      peers: this.#store.agents().map((agent) => {
        const bridge = bridges.get(agent.id);
        const agentWakes = wakes.filter((wake) => wake.agent === agent.id).map((wake) => wake.id);
        return compact({
          id: agent.id,
          provider: agent.provider,
          mode: agent.mode === "external" ? "external" : undefined,
          state: agent.state,
          detail: agent.detail ? clip(agent.detail, 160) : undefined,
          doing: agent.state === "busy" ? latest.get(agent.id) : undefined,
          dnd: agent.availability === "dnd"
            ? compact({
                reason: agent.availabilityReason ?? undefined,
                ends_in: agent.availabilityUntil ? formatDuration(agent.availabilityUntil - now) : undefined,
              })
            : undefined,
          wakes: agentWakes,
          bridge: bridge?.state === "failed" ? clip(bridge.detail, 200) : undefined,
        });
      }),
      goal: goal
        ? {
            id: goal.id,
            instruction: goal.instruction.length > 600
              ? `${clip(goal.instruction, 600)} (clipped, team_goal has the full text)`
              : goal.instruction,
            participants: this.#store.goalParticipants(goal.id).map((entry) => ({
              agent: entry.agent,
              stance: entry.stance,
            })),
          }
        : null,
      unread: this.#store.pendingCount(actor) || undefined,
      you_owe: this.#store.replyObligations(actor).map((entry) => ({
        id: entry.messageId,
        from: entry.sender,
        text: clip(entry.body, 160),
      })),
      awaiting: this.#store.awaitedReplies(actor).map((entry) => ({
        id: entry.messageId,
        to: entry.recipient,
        delivered: entry.deliveredAt !== null,
      })),
      claims: goal
        ? this.#store.claims(goal.id).filter(isOpenClaim).map((claim) => compact({
            id: claim.id,
            claimant: claim.claimant,
            state: claim.state,
            scope: clip(claim.summary, 160),
            paths: claim.paths,
          }))
        : [],
      todos: this.#store.todos().filter(isOpenTodo).map(todoEntry),
      findings: this.#store.findings()
        .filter((finding) => finding.disposition === "open")
        .map((finding) => compact({
          id: finding.id,
          severity: finding.severity,
          author: finding.author,
          target: finding.target ?? undefined,
          summary: clip(finding.summary, 160),
          ...verdictSummary(finding),
        })),
      wakes: wakes.map((wake) => wakeEntry(wake, now)),
      jobs: jobs.map((job) => jobEntry(job)),
      jobs_more: activeJobs.length > jobs.length ? activeJobs.length - jobs.length : undefined,
    });
  }

  async #send(actor: AgentId, input: Record<string, unknown>): Promise<unknown> {
    const taskClass = optionalString(input.task_class);
    const candidates = taskClass === undefined ? [] : this.#taskCandidates(actor);
    let to = input.to;
    if (to === undefined) {
      if (!taskClass) throw new Error("message needs to or a project task_class for automatic delegation");
      const choice = planTaskAssignment(this.#taskPolicy, taskClass, candidates);
      if (!choice.agent) throw new Error(choice.blocked!);
      to = choice.agent;
    }
    const recipients = this.#resolveRecipients(actor, to);
    const priority = optionalEnum(input.priority, ["normal", "urgent", "stop"] as const, "normal");
    const priorityReason = optionalString(input.priority_reason);
    if (priority !== "normal" && !priorityReason) {
      throw new Error(`${priority} messages require priority_reason explaining why normal delivery is unsafe`);
    }
    if (priority === "normal" && priorityReason) {
      throw new Error("normal messages must omit priority_reason");
    }
    const replyTo = input.reply_to === undefined ? undefined : requiredInteger(input.reply_to, "reply_to");
    // Checked before a stop interrupts anyone, so a bad reference cannot cut a
    // peer's turn short for a message that is then refused.
    if (replyTo !== undefined && !this.#store.messageAddressedTo(replyTo, actor)) {
      throw new Error(`reply_to ${replyTo} is not a message addressed to ${actor}`);
    }
    const body = requiredString(input.message, "message");
    for (const recipient of recipients) {
      if (taskClass !== undefined) {
        checkTaskAssignment(this.#taskPolicy, taskClass, recipient);
        if (!candidates.some((peer) => peer.id === recipient && peer.available)) {
          throw new Error(`cannot delegate ${taskClass} work to ${recipient}: peer or project resource is unavailable`);
        }
      } else if (this.#taskPolicy?.agents[recipient]?.requireTaskClass && priority !== "stop" && replyTo === undefined) {
        throw new Error(`delegation to ${recipient} requires task_class from this project's policy (team_roster)`);
      }
    }

    const interruptions = priority === "stop"
      ? await Promise.all(recipients.map(async (recipient) => {
          try {
            return await this.#interruptPeer(recipient);
          } catch (error) {
            return {
              agent: recipient,
              interrupted: false,
              limitation: `managed interrupt failed: ${errorMessage(error)}`,
            };
          }
        }))
      : [];
    const message = this.#mutate(() => this.#store.addMessage({
      goalId: this.#store.activeGoal()?.id ?? null,
      sender: actor,
      recipients,
      kind: optionalEnum(input.kind, ["peer", "review"] as const, "peer"),
      priority,
      ...(priorityReason ? { priorityReason } : {}),
      ...(replyTo !== undefined ? { replyTo } : {}),
      ...(input.expects_reply === true ? { expectsReply: true } : {}),
      body,
    }));
    // The sender already has the text it wrote. It gets the id to thread on
    // and when each recipient will read it, which is what stops re-sending.
    return {
      id: message.id,
      deliveries: recipients.map((recipient) => this.#coordination.forecast(recipient, priority)),
      ...(interruptions.length > 0 ? { interruptions } : {}),
    };
  }

  /**
   * Mail the caller has not been handed yet, marked read as it is returned.
   *
   * Returning everything ever addressed to the caller on every call re-sent
   * the same bodies each time. History is still available through `after_id`.
   */
  #inbox(actor: AgentId, input: Record<string, unknown>): unknown {
    if (input.acknowledge_through !== undefined) {
      this.#store.acknowledge(actor, requiredInteger(input.acknowledge_through, "acknowledge_through"));
      this.#onMutation();
    }
    if (input.after_id !== undefined) {
      // History is for looking something up, not for re-reading the whole
      // conversation, which could otherwise return hundreds of full bodies.
      const limit = Math.min(optionalInteger(input.limit, DEFAULT_HISTORY_LIMIT, "limit"), MAX_HISTORY_LIMIT);
      const history = this.#store.inbox(actor, requiredInteger(input.after_id, "after_id"));
      const page = history.slice(0, limit).map(inboxEntry);
      return history.length > limit
        ? { messages: page, more: `call again with after_id ${history[limit - 1]!.id}` }
        : page;
    }
    const pending = this.#store.pendingInbox(actor);
    if (pending.length > 0) {
      this.#store.acknowledgeMessages(actor, pending.map((message) => message.id));
      this.#onMutation();
    }
    return pending.map(inboxEntry);
  }

  #activities(input: Record<string, unknown>): unknown {
    const limit = Math.min(optionalInteger(input.limit, 20, "limit"), 100);
    const before = input.before === undefined
      ? Number.POSITIVE_INFINITY
      : requiredInteger(input.before, "before");
    const agent = optionalString(input.agent);
    if (agent && !this.#store.agents().some((entry) => entry.id === agent)) {
      throw new Error(`activity agent is not in the Watari roster: ${agent}`);
    }
    return this.#store.activitySummaries()
      .filter((activity) => (!agent || activity.agent === agent) && activity.updatedAt < before)
      .slice(-limit)
      .map((activity) => compact({
        id: activity.id,
        agent: activity.agent,
        kind: activity.kind,
        state: activity.state,
        title: clip(activity.title, 200),
        preview: activity.preview ? clip(activity.preview, 240) : undefined,
        at: activity.updatedAt,
        detail: activity.hasDetail ? true : undefined,
      }));
  }

  #activityDetail(input: Record<string, unknown>): unknown {
    const id = requiredString(input.activity_id, "activity_id");
    const maximumBytes = Math.min(
      optionalInteger(input.max_bytes, DEFAULT_MCP_DETAIL_BYTES, "max_bytes"),
      MAX_MCP_DETAIL_BYTES,
    );
    const record = this.#store.activityRecord(id);
    if (!record) throw new Error(`activity not found: ${id}`);
    return {
      summary: record.summary,
      detail: boundedActivityDetail(record.detail, maximumBytes),
      maximumBytes,
    };
  }

  #job(actor: AgentId, input: Record<string, unknown>): unknown {
    const action = optionalEnum(input.action, ["reserve", "update", "list"] as const, "list");
    if (action === "list") {
      const all = input.all === true;
      const jobs = this.#store.jobs({ activeOnly: !all });
      const page = jobs.slice(0, 100).map(jobEntry);
      return jobs.length > page.length ? { jobs: page, more: jobs.length - page.length } : page;
    }
    if (action === "reserve") {
      const resources = optionalStringArray(input.resources);
      if (resources.length === 0) throw new Error("team_job reserve needs resources");
      const requiredResource = this.#taskPolicy?.agents[actor]?.resource;
      if (requiredResource && !resources.includes(requiredResource)) resources.push(requiredResource);
      const created = this.#mutate(() => this.#store.reserveJob({
        owner: actor,
        source: requiredString(input.source, "source"),
        title: requiredString(input.title, "title"),
        resources,
        ...(input.handle === undefined || input.handle === null ? {} : { handle: requiredString(input.handle, "handle") }),
        ...(input.note === undefined || input.note === null ? {} : { note: requiredString(input.note, "note") }),
      }));
      return jobEntry(created);
    }
    const id = requiredString(input.job_id, "job_id");
    const state = requiredEnum(
      input.state,
      ["pending", "running", "succeeded", "failed", "cancelled", "unknown"] as const,
      "state",
    ) as TeamJobState;
    const updated = this.#mutate(() => this.#store.updateJob(id, actor, {
      state,
      ...(input.handle !== undefined ? { handle: input.handle === null ? null : requiredString(input.handle, "handle") } : {}),
      ...(input.result !== undefined ? { result: input.result === null ? null : requiredString(input.result, "result") } : {}),
      ...(input.note !== undefined ? { note: input.note === null ? null : requiredString(input.note, "note") } : {}),
    }));
    return jobEntry(updated);
  }

  #progress(actor: AgentId, input: Record<string, unknown>): unknown {
    const goal = this.#store.activeGoal();
    if (!goal) throw new Error("there is no active shared goal");
    const requestedGoal = optionalString(input.goal_id);
    if (requestedGoal && requestedGoal !== goal.id) {
      throw new Error(`active goal is ${goal.id}, not ${requestedGoal}`);
    }
    const stance = requiredEnum(
      input.stance,
      ["assessing", "participating", "done", "blocked"] as const,
      "stance",
    ) as GoalStance;
    this.#store.setGoalStance(goal.id, actor, stance, optionalString(input.evidence));
    this.#onMutation();
    return this.#store.goalParticipants(goal.id).find((entry) => entry.agent === actor) ?? null;
  }

  #todo(actor: AgentId, input: Record<string, unknown>): unknown {
    const action = requiredEnum(input.action, ["add", "update", "list"] as const, "action");
    if (action === "list") {
      const filter = optionalEnum(input.filter, ["open", "mine", "all"] as const, "open");
      return this.#store.todos()
        .filter((todo) =>
          filter === "all" || (isOpenTodo(todo) && (filter === "open" || todo.assignee === actor))
        )
        .map(todoEntry);
    }
    if (action === "add") {
      if (!Array.isArray(input.items) || input.items.length === 0) {
        throw new Error("team_todo add needs items");
      }
      const items = input.items.map((item) => {
        const entry = item as Record<string, unknown>;
        const assignee = this.#resolveAssignee(actor, entry.assignee);
        const detail = optionalString(entry.detail);
        return {
          title: requiredString(entry.title, "title"),
          ...(detail ? { detail } : {}),
          ...(assignee !== undefined ? { assignee } : {}),
          ...(entry.paths !== undefined ? { paths: optionalStringArray(entry.paths) } : {}),
        };
      });
      const created = this.#mutate(() => this.#store.createTodos({
        goalId: this.#store.activeGoal()?.id ?? null,
        author: actor,
        items,
      }));
      this.#notifyAssignees(actor, created);
      return { added: created.map(todoEntry) };
    }
    const id = requiredInteger(input.id, "id");
    const previous = this.#store.todos().find((todo) => todo.id === id);
    const assignee = this.#resolveAssignee(actor, input.assignee);
    const note = optionalString(input.note);
    const updated = this.#mutate(() => this.#store.updateTodo(id, {
      ...(input.state !== undefined
        ? { state: requiredEnum(input.state, ["todo", "doing", "blocked", "done", "dropped"] as const, "state") as TodoState }
        : {}),
      ...(assignee !== undefined ? { assignee } : {}),
      ...(note ? { note } : {}),
    }));
    if (assignee && assignee !== previous?.assignee) this.#notifyAssignees(actor, [updated]);
    if (previous && isOpenTodo(previous) && !isOpenTodo(updated)) this.#reportClosedTodo(actor, updated);
    return todoEntry(updated);
  }

  /**
   * Tells whoever split the work that a piece of it closed, and tells them
   * once every piece has, which is when someone has to put the results
   * together. The first is a passive breadcrumb. The second starts a turn,
   * because an author waiting on its peers has usually ended its own.
   */
  #reportClosedTodo(actor: AgentId, todo: TeamTodo): void {
    const rostered = new Set(this.#store.agents().map((agent) => agent.id));
    const goalId = this.#store.activeGoal()?.id ?? null;
    if (todo.author !== actor && rostered.has(todo.author as AgentId)) {
      this.#mutate(() => this.#store.addMessage({
        goalId,
        sender: "watari",
        recipients: [todo.author as AgentId],
        kind: "system",
        delivery: "passive",
        body: `${actor} marked TODO #${todo.id} ${todo.state}: ${clip(todo.title, 160)}` +
          (todo.note ? `\nNote: ${clip(todo.note, 300)}` : ""),
      }));
    }
    const all = this.#store.todos().filter((entry) => entry.goalId === todo.goalId);
    if (all.length < 2 || all.some(isOpenTodo)) return;
    const authors = [...new Set(all.map((entry) => entry.author))]
      .filter((author) => author !== actor && rostered.has(author as AgentId)) as AgentId[];
    if (authors.length === 0) return;
    this.#mutate(() => this.#store.addMessage({
      goalId,
      sender: "watari",
      recipients: authors,
      kind: "system",
      body: `All ${all.length} TODOs for this goal are done or dropped. ` +
        "If you split this work, collect the results, check what is left, and report to the user.",
    }));
  }

  /** `me` names the caller and `none` clears the owner. */
  #resolveAssignee(actor: AgentId, value: unknown): AgentId | null | undefined {
    if (value === undefined) return undefined;
    const text = requiredString(value, "assignee").trim();
    if (text === "none") return null;
    const id = (text === "me" ? actor : text) as AgentId;
    if (!this.#store.agents().some((agent) => agent.id === id)) {
      throw new Error(`assignee is not in the Watari roster: ${text}`);
    }
    return id;
  }

  /**
   * Tells each peer that someone else gave it work, once per peer.
   *
   * The notice comes from Watari rather than from the assigner, so it is not
   * mistaken for the assigner answering one of that peer's questions.
   */
  #notifyAssignees(actor: AgentId, todos: readonly TeamTodo[]): void {
    const byAssignee = new Map<AgentId, TeamTodo[]>();
    for (const todo of todos) {
      if (!todo.assignee || todo.assignee === actor) continue;
      byAssignee.set(todo.assignee, [...(byAssignee.get(todo.assignee) ?? []), todo]);
    }
    for (const [assignee, assigned] of byAssignee) {
      this.#mutate(() => this.#store.addMessage({
        goalId: this.#store.activeGoal()?.id ?? null,
        sender: "watari",
        recipients: [assignee],
        kind: "system",
        body: assigned
          .map((todo) =>
            `${actor} assigned TODO #${todo.id} to you: ${todo.title}${todo.detail ? `\n${todo.detail}` : ""}`
          )
          .join("\n\n"),
      }));
    }
  }

  #wake(actor: AgentId, input: Record<string, unknown>): unknown {
    const now = Date.now();
    const action = optionalEnum(input.action, ["schedule", "cancel", "list"] as const, "schedule");
    if (action === "list") {
      return this.#store.pendingWakes(actor).map((wake) => wakeEntry(wake, now));
    }
    if (action === "cancel") {
      const cancelled = this.#mutate(() =>
        this.#coordination.cancelWake(actor, requiredInteger(input.wake_id, "wake_id"))
      );
      return wakeEntry(cancelled, now);
    }
    const conditions: WakeCondition[] = [];
    if (input.after_seconds !== undefined) {
      conditions.push({ kind: "timer", afterSeconds: requiredInteger(input.after_seconds, "after_seconds") });
    }
    if (input.pid !== undefined) {
      conditions.push({ kind: "pid", pid: requiredInteger(input.pid, "pid") });
    }
    if (input.path !== undefined) {
      conditions.push({ kind: "path", path: requiredString(input.path, "path") });
    }
    if (input.command !== undefined) {
      const argv = optionalStringArray(input.command);
      if (argv.length === 0 || !argv[0]?.trim()) throw new Error("command needs a program to run");
      conditions.push({
        kind: "command",
        argv,
        intervalSeconds: optionalInteger(input.interval_seconds, DEFAULT_COMMAND_INTERVAL_SECONDS, "interval_seconds"),
      });
    }
    const [condition] = conditions;
    if (conditions.length !== 1 || !condition) {
      throw new Error("schedule exactly one of after_seconds, pid, path, or command");
    }
    const scheduled = this.#mutate(() => this.#coordination.scheduleWake(actor, {
      condition,
      note: requiredString(input.note, "note"),
      timeoutSeconds: optionalInteger(input.timeout_seconds, DEFAULT_WAKE_TIMEOUT_SECONDS, "timeout_seconds"),
    }));
    return scheduled.limitation
      ? { wake: wakeEntry(scheduled.wake, now), limitation: scheduled.limitation }
      : {
          wake: wakeEntry(scheduled.wake, now),
          next: "End your turn now. Watari starts a new turn for you when this settles, so do not poll or sleep.",
        };
  }

  #availability(actor: AgentId, input: Record<string, unknown>): unknown {
    const mode = requiredEnum(input.mode, ["open", "dnd"] as const, "mode") as AgentAvailability;
    const reason = optionalString(input.reason) ?? null;
    if (mode === "dnd" && !reason) throw new Error("dnd needs a reason that peers can read");
    const minutes = mode === "dnd" ? optionalInteger(input.minutes, DEFAULT_DND_MINUTES, "minutes") : null;
    const agent = this.#mutate(() => this.#coordination.setAvailability(actor, mode, reason, minutes));
    return compact({
      mode: agent.availability ?? "open",
      reason: agent.availabilityReason ?? undefined,
      ends_in: agent.availabilityUntil ? formatDuration(agent.availabilityUntil - Date.now()) : undefined,
    });
  }

  #claimUpdate(actor: AgentId, input: Record<string, unknown>): unknown {
    const state = requiredEnum(
      input.state,
      ["active", "released", "superseded"] as const,
      "state",
    ) as ClaimState;
    return this.#setClaimState(actor, input, state);
  }

  #setClaimState(actor: AgentId, input: Record<string, unknown>, state: ClaimState): unknown {
    return claimEntry(this.#mutate(() => this.#store.setClaimState(
      requiredString(input.claim_id, "claim_id"),
      actor,
      state,
      optionalString(input.note),
    )));
  }

  /**
   * The author or target settles a finding's disposition. Any other peer
   * records a verdict, which is how a review becomes cross-checked rather than
   * one model's opinion. A refutation reaches the author, who has to either
   * answer it or withdraw the finding.
   */
  #findingUpdate(actor: AgentId, input: Record<string, unknown>): unknown {
    const id = requiredString(input.finding_id, "finding_id");
    if (input.disposition === undefined && input.verdict === undefined) {
      throw new Error("team_finding_update needs a disposition or a verdict");
    }
    let finding: TeamFinding | null = null;
    if (input.verdict !== undefined) {
      const verdict = requiredEnum(input.verdict, ["confirmed", "refuted"] as const, "verdict");
      const evidence = optionalString(input.evidence);
      if (verdict === "refuted" && !evidence) {
        throw new Error("a refuted verdict needs evidence the author can check");
      }
      finding = this.#mutate(() => this.#store.recordFindingVerdict(id, actor, verdict, evidence));
      if (this.#store.agents().some((agent) => agent.id === finding!.author)) {
        this.#mutate(() => this.#store.addMessage({
          goalId: this.#store.activeGoal()?.id ?? null,
          sender: "watari",
          recipients: [finding!.author],
          kind: "system",
          // A confirmation needs nothing from the author. A refutation does.
          delivery: verdict === "confirmed" ? "passive" : "normal",
          body: verdict === "confirmed"
            ? `${actor} confirmed your finding ${id}: ${sentence(finding!.summary, 160)}`
            : `${actor} refuted your finding ${id}: ${sentence(finding!.summary, 160)}\nEvidence: ${evidence}\n` +
              "Check it. Withdraw the finding with disposition dismissed, or answer with team_send.",
        }));
      }
    }
    if (input.disposition !== undefined) {
      const disposition = requiredEnum(
        input.disposition,
        ["open", "resolved", "accepted", "dismissed"] as const,
        "disposition",
      ) as TeamFinding["disposition"];
      finding = this.#mutate(() => this.#store.setFindingDisposition(id, actor, disposition));
    }
    return findingEntry(finding!);
  }

  /**
   * Creates a claim, active unless the caller only proposes it.
   *
   * A claim used to start as proposed and needed a second call to activate,
   * and it needed the goal id looked up first. Both cost a round trip for a
   * step every claim takes. Conflicts come back with the claim, so the caller
   * knows whom to talk to without reading the whole team state.
   */
  #claim(actor: AgentId, input: Record<string, unknown>): unknown {
    const goalId = optionalString(input.goal_id) ?? this.#store.activeGoal()?.id;
    if (!goalId) throw new Error("there is no active shared goal to claim scope in");
    const note = optionalString(input.note);
    const claim = this.#mutate(() => this.#store.createClaim({
      goalId,
      claimant: actor,
      summary: requiredString(input.scope, "scope"),
      paths: optionalStringArray(input.paths),
      state: optionalEnum(input.state, ["proposed", "active"] as const, "active"),
      ...(note ? { note } : {}),
    }));
    const conflicts = this.#store.claimConflicts(claim);
    this.#announceContest(actor, claim, conflicts);
    return compact({
      ...claimEntry(claim),
      conflicts: conflicts.map((other) => ({
        id: other.id,
        claimant: other.claimant,
        scope: clip(other.summary, 160),
        paths: other.paths,
      })),
      taken_over: claim.takenOver.map((other) => ({
        id: other.id,
        from: other.claimant,
        scope: clip(other.summary, 160),
      })),
    });
  }

  /**
   * Tells each peer whose claim a new one just contested. The caller sees the
   * conflicts in its result, and the other side used to find out only when an
   * edit collided. Passive, because it changes nothing until that peer works.
   */
  #announceContest(actor: AgentId, claim: TeamClaim, conflicts: readonly TeamClaim[]): void {
    const byClaimant = new Map<AgentId, TeamClaim[]>();
    for (const other of conflicts) {
      byClaimant.set(other.claimant, [...(byClaimant.get(other.claimant) ?? []), other]);
    }
    for (const [claimant, claims] of byClaimant) {
      this.#mutate(() => this.#store.addMessage({
        goalId: claim.goalId,
        sender: "watari",
        recipients: [claimant],
        kind: "system",
        delivery: "passive",
        body: `${actor}'s new claim ${claim.id} (${clip(claim.summary, 80)}) overlaps your ` +
          `${claims.length === 1 ? "claim" : "claims"} ${claims.map((other) => other.id).join(", ")} on ` +
          `${claim.paths.slice(0, 4).join(", ")}. Both stay contested until one of you releases or narrows. ` +
          "Settle it with team_send.",
      }));
    }
  }

  #legacyFinding(actor: AgentId, input: Record<string, unknown>): unknown {
    const target = optionalString(input.target);
    const finding = this.#mutate(() => this.#store.createFinding({
      author: actor,
      ...(target ? { target: target as AgentId } : {}),
      ...(optionalString(input.scope) ? { scope: optionalString(input.scope)! } : {}),
      severity: requiredEnum(
        input.severity,
        ["info", "low", "medium", "high", "critical"] as const,
        "severity",
      ),
      summary: requiredString(input.summary, "summary"),
      ...(optionalString(input.evidence) ? { evidence: optionalString(input.evidence)! } : {}),
    }));
    this.#announceFinding(actor, finding);
    return findingEntry(finding);
  }

  /**
   * Tells the other live peers a finding exists, with the id they need to
   * check it. Without this a peer asked to verify had to go and find the id
   * first, and a live run showed a model confirming a bug in its chat and
   * never recording the verdict. Passive, so it rides along with the next
   * handover instead of starting a turn.
   */
  #announceFinding(actor: AgentId, finding: TeamFinding): void {
    const peers = this.#store.agents()
      .filter((agent) =>
        agent.id !== actor && (agent.state === "ready" || agent.state === "busy" || agent.state === "waiting")
      )
      .map((agent) => agent.id);
    if (peers.length === 0) return;
    const where = finding.scope ? `, ${clip(finding.scope, 120)}` : "";
    this.#mutate(() => this.#store.addMessage({
      goalId: this.#store.activeGoal()?.id ?? null,
      sender: "watari",
      recipients: peers,
      kind: "system",
      delivery: "passive",
      body: `${actor} recorded finding ${finding.id} (${finding.severity}${where}): ${sentence(finding.summary, 200)} ` +
        "If it touches code you know, check it and record team_finding_update with a verdict.",
    }));
  }

  #taskCandidates(actor: AgentId): TaskCandidate[] {
    const jobs = this.#store.jobs({ activeOnly: true });
    return this.#store.agents().filter((peer) => peer.id !== actor).map((peer) => {
      const resource = this.#taskPolicy?.agents[peer.id]?.resource;
      return {
        id: peer.id,
        available: this.#canDelegate(peer.id) && ["ready", "busy", "waiting"].includes(peer.state) &&
          !(peer.availability === "dnd" && (peer.availabilityUntil === null ||
            peer.availabilityUntil === undefined || peer.availabilityUntil > Date.now())) &&
          !jobs.some((job) => resource && pathsOverlap([resource], job.resources)),
      };
    });
  }

  #resolveRecipients(actor: AgentId, value: unknown): AgentId[] {
    const requested = typeof value === "string" ? [value] : optionalStringArray(value);
    const peers = this.#store.agents().map((agent) => agent.id).filter((id) => id !== actor);
    if (requested.includes("all")) return peers;
    const allowed = new Set(peers);
    for (const recipient of requested) {
      if (!allowed.has(recipient as AgentId)) throw new Error(`unknown or self recipient: ${recipient}`);
    }
    if (requested.length === 0) throw new Error("message requires at least one recipient");
    return requested as AgentId[];
  }

  #mutate<T>(operation: () => T): T {
    const value = operation();
    this.#onMutation();
    return value;
  }
}

/** Serves a store without a live runtime, which is what tests and tools use. */
function storeOnlyCoordination(store: TeamStore): TeamCoordination {
  const noWakes = (): never => {
    throw new Error("this team host cannot schedule wakeups");
  };
  return {
    forecast: (agent) => ({ agent, delivery: "inbox" }),
    scheduleWake: noWakes,
    cancelWake: noWakes,
    setAvailability: (agent, mode, reason, minutes) =>
      store.setAvailability(agent, mode, {
        reason,
        until: mode === "dnd" && minutes ? Date.now() + minutes * 60_000 : null,
      }),
    recordHandoff: (agent, markdown) => {
      store.recordHandoff({ requestId: "unrequested", agent, source: "tool", content: markdown });
      return { saved: true, requested: false, note: "saved; no export was waiting for it" };
    },
  };
}

function inboxEntry(message: TeamMessage): Record<string, unknown> {
  return compact({
    id: message.id,
    from: message.sender,
    kind: message.kind === "peer" ? undefined : message.kind,
    priority: message.priority === "normal" ? undefined : message.priority,
    priority_reason: message.priorityReason ?? undefined,
    reply_to: message.replyTo ?? undefined,
    expects_reply: message.expectsReply ? true : undefined,
    text: message.body,
  });
}

function claimEntry(claim: TeamClaim): Record<string, unknown> {
  return compact({
    id: claim.id,
    claimant: claim.claimant,
    state: claim.state,
    scope: clip(claim.summary, 160),
    paths: claim.paths,
    note: claim.note ? clip(claim.note, 200) : undefined,
  });
}

function findingEntry(finding: TeamFinding): Record<string, unknown> {
  return compact({
    id: finding.id,
    author: finding.author,
    target: finding.target ?? undefined,
    severity: finding.severity,
    disposition: finding.disposition,
    summary: clip(finding.summary, 160),
    ...verdictSummary(finding),
  });
}

/** Who checked a finding and how, without repeating their evidence. */
function verdictSummary(finding: TeamFinding): Record<string, unknown> {
  const verdicts = finding.verdicts ?? [];
  const by = (kind: "confirmed" | "refuted") =>
    verdicts.filter((entry) => entry.verdict === kind).map((entry) => entry.reviewer);
  return compact({ confirmed_by: by("confirmed"), refuted_by: by("refuted") });
}

function todoEntry(todo: TeamTodo): Record<string, unknown> {
  return compact({
    id: todo.id,
    state: todo.state,
    assignee: todo.assignee ?? undefined,
    title: todo.title,
    paths: todo.paths,
    note: todo.note ? clip(todo.note, 200) : undefined,
  });
}

function wakeEntry(wake: TeamWake, now: number): Record<string, unknown> {
  return compact({
    id: wake.id,
    agent: wake.agent,
    state: wake.state,
    waiting_for: describeWakeCondition(wake.condition),
    times_out_in: wake.state === "pending" ? formatDuration(wake.deadlineAt - now) : undefined,
    outcome: wake.outcome ?? undefined,
  });
}

function jobEntry(job: TeamJob): Record<string, unknown> {
  return compact({
    id: job.id,
    owner: job.owner,
    source: job.source,
    title: clip(job.title, 200),
    resources: job.resources,
    state: job.state,
    handle: job.handle ? clip(job.handle, 300) : undefined,
    result: job.result ? clip(job.result, 600) : undefined,
    note: job.note ? clip(job.note, 300) : undefined,
    updated_at: job.updatedAt,
  });
}

/** Drops absent values and empty lists, so a quiet team reads as a short answer. */
function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) =>
      entry !== undefined && !(Array.isArray(entry) && entry.length === 0)
    ),
  );
}

function clip(text: string, limit: number): string {
  const line = text.replace(/\s+/gu, " ").trim();
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

/** A clipped line that ends in exactly one full stop, for text that continues after it. */
function sentence(text: string, limit: number): string {
  return `${clip(text, limit).replace(/[.!?…]+$/u, "")}.`;
}

function isOpenClaim(claim: { readonly state: ClaimState }): boolean {
  return claim.state !== "released" && claim.state !== "superseded";
}

function isOpenTodo(todo: TeamTodo): boolean {
  return todo.state === "todo" || todo.state === "doing" || todo.state === "blocked";
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function optionalStringArray(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error("expected an array of strings");
  }
  return value;
}

function requiredInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}

function optionalInteger(value: unknown, fallback: number, label: string): number {
  return value === undefined ? fallback : requiredInteger(value, label);
}

function requiredEnum<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  label: string,
): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new Error(`${label} must be one of: ${allowed.join(", ")}`);
  }
  return value;
}

function optionalEnum<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  fallback: T[number],
): T[number] {
  return value === undefined ? fallback : requiredEnum(value, allowed, "value");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
