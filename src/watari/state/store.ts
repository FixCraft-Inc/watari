import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import type { AgentEvent, AgentId } from "../models.ts";
import { SqliteActivityRepository } from "../activity/repository.ts";
import type { ActivityDetail, ActivityRecord, ActivitySummary } from "../activity/types.ts";
import { redactSummary, redactUnknown } from "../security/redaction.ts";
import { AGENT_ALIAS_PATTERN } from "../team/identity.ts";
import type {
  AgentAvailability,
  AgentRuntimeState,
  AwaitedReply,
  ClaimState,
  FindingVerdict,
  FindingVerdictKind,
  GoalParticipant,
  GoalStance,
  InboxCursor,
  MessageDelivery,
  MessageKind,
  MessagePriority,
  ReplyObligation,
  PersistedEvent,
  TeamAgent,
  TeamClaim,
  TeamFinding,
  TeamGoal,
  TeamJob,
  TeamJobState,
  TeamHandoff,
  TeamMessage,
  TeamSnapshot,
  TeamTodo,
  TeamWake,
  TodoState,
  WakeCondition,
  WakeState,
} from "./types.ts";

const MAX_MESSAGE_CHARS = 32_000;
const MAX_SUMMARY_CHARS = 4_000;
const MAX_EVENT_HISTORY = 400;
const MAX_MESSAGE_HISTORY = 400;
/** Shared TODO items one chat may hold. The list coordinates work, it is not a tracker. */
const MAX_TODOS = 200;
const MAX_HANDOFF_CHARS = 64_000;
const MAX_TODO_TITLE_CHARS = 300;
const MAX_WAKE_NOTE_CHARS = 2_000;
const MAX_AVAILABILITY_REASON_CHARS = 300;
/** Settled wakes kept beside the pending ones, newest first. */
const MAX_WAKE_HISTORY = 100;
/** Durable reservations are bounded so a forgotten MCP cannot grow state forever. */
const MAX_TEAM_JOBS = 512;
const MAX_JOB_HISTORY = 100;
const MAX_JOB_TITLE_CHARS = 512;
const MAX_JOB_SOURCE_CHARS = 256;
const MAX_JOB_RESOURCE_CHARS = 4_096;
const MAX_JOB_HANDLE_CHARS = 4_096;
const MAX_JOB_RESULT_CHARS = 32_000;
const MAX_JOB_NOTE_CHARS = 4_000;
/** Questions listed at once for one peer. */
const MAX_OPEN_QUESTIONS = 50;
/** Free pages after a reset worth handing back, about 8 MiB at the default page size. */
const VACUUM_FREE_PAGES = 2_048;
/** Bumped when a repair has to run once against databases written by an
 * earlier build. Stored in SQLite's own `user_version`, which is shared with
 * `ACTIVITY_BACKFILL_VERSION`. This migration runs first and must stay the
 * lower of the two. */
const COMPACTED_STREAM_VERSION = 3;
/** Pages of write-ahead log tolerated before SQLite folds it back in. */
const WAL_AUTOCHECKPOINT_PAGES = 256;
/** Lifecycle rows an earlier build wrote alongside the streamed text. */
const LEGACY_ITEM_MARKER = /^[a-zA-Z]+ (?:started|completed)$/u;

type SqlRow = Record<string, unknown>;

export interface CreateGoalInput {
  readonly instruction: string;
  readonly initialAddressee: AgentId | null;
  readonly participants: readonly AgentId[];
}

export interface AddMessageInput {
  readonly goalId: string | null;
  readonly sender: string;
  readonly recipients: readonly AgentId[];
  readonly kind: MessageKind;
  readonly priority?: MessagePriority;
  readonly priorityReason?: string;
  readonly body: string;
  /** A message addressed to the sender that this one answers. */
  readonly replyTo?: number;
  readonly expectsReply?: boolean;
  readonly delivery?: MessageDelivery;
  /**
   * What the message reports on, such as one peer's availability. A newer
   * message on the same topic replaces older ones a recipient has not been
   * handed yet, so a peer that went offline and back three times while its
   * reader was busy is reported once, as it is now.
   */
  readonly topic?: string;
}

export interface CreateClaimInput {
  readonly goalId: string;
  readonly claimant: AgentId;
  readonly summary: string;
  readonly paths?: readonly string[];
  readonly note?: string;
  /** `proposed` unless the claimant starts at once. Overlap still contests it. */
  readonly state?: "proposed" | "active";
}

export interface CreateFindingInput {
  readonly author: AgentId;
  readonly target?: AgentId;
  readonly scope?: string;
  readonly severity: TeamFinding["severity"];
  readonly summary: string;
  readonly evidence?: string;
}

/** An archived chat as `restoreChat` needs it. */
export interface RestorableChat {
  readonly activeGoal: TeamGoal | null;
  readonly goals?: readonly TeamGoal[];
  readonly agents: readonly Pick<TeamAgent, "id" | "sessionId">[];
  readonly messages: readonly TeamMessage[];
  readonly claims: readonly TeamClaim[];
  readonly findings: readonly TeamFinding[];
  readonly todos: readonly TeamTodo[];
  readonly events: readonly PersistedEvent[];
  readonly activities: readonly ActivityRecord[];
}

export interface RestoreSummary {
  readonly goal: string | null;
  readonly messages: number;
  readonly claims: number;
  readonly todos: number;
  readonly findings: number;
  readonly events: number;
  readonly activities: number;
}

/** A new claim, with the offline peers' claims it superseded. */
export interface CreatedClaim extends TeamClaim {
  readonly takenOver: readonly TeamClaim[];
}

export interface CreateTodoInput {
  readonly goalId: string | null;
  /** A roster identity, or `user`. */
  readonly author: string;
  readonly items: readonly {
    readonly title: string;
    readonly detail?: string;
    readonly assignee?: AgentId | null;
    readonly paths?: readonly string[];
  }[];
}

export interface UpdateTodoInput {
  readonly state?: TodoState;
  /** `null` clears the owner. */
  readonly assignee?: AgentId | null;
  readonly note?: string;
}

export interface CreateWakeInput {
  readonly agent: AgentId;
  readonly condition: WakeCondition;
  readonly note: string;
  readonly deadlineAt: number;
}

export interface ReserveJobInput {
  readonly owner: AgentId;
  readonly source: string;
  readonly title: string;
  readonly resources: readonly string[];
  readonly handle?: string;
  readonly note?: string;
}

export interface UpdateJobInput {
  readonly state: TeamJobState;
  readonly handle?: string | null;
  readonly result?: string | null;
  readonly note?: string | null;
}

export class TeamStore {
  readonly #database: Database;
  readonly #activities: SqliteActivityRepository;
  /**
   * The roster is read on every provider event to decide lifecycle and
   * delivery, and it only changes on lifecycle transitions. Every write to
   * `agents` clears this.
   */
  #agentsCache: readonly TeamAgent[] | null = null;

  constructor(databasePath: string) {
    if (databasePath !== ":memory:") {
      mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
    }
    this.#database = new Database(databasePath, { create: true, strict: true });
    this.#database.exec("PRAGMA foreign_keys = ON");
    this.#database.exec("PRAGMA journal_mode = WAL");
    // A streaming turn rewrites its transcript row on every fragment, which is
    // a WAL frame each time. Left alone the log grows into the megabytes within
    // minutes, so it is folded back into the database as it goes.
    this.#database.exec(`PRAGMA wal_autocheckpoint = ${WAL_AUTOCHECKPOINT_PAGES}`);
    this.#migrate();
    this.#activities = new SqliteActivityRepository(this.#database);
  }

  /** Folds the write-ahead log back into the database file. */
  checkpoint(): void {
    this.#database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }

  close(): void {
    try {
      this.checkpoint();
    } catch {
      // A checkpoint is an optimisation. A reader holding the log must not
      // stop the store from closing.
    }
    this.#database.close(false);
  }

  /** Clears the conversation; project-level jobs remain because remote work may still be alive. */
  resetConversation(): void {
    this.#database.transaction(() => {
      this.#database.exec("DELETE FROM message_recipients");
      this.#database.exec("DELETE FROM messages");
      this.#database.exec("DELETE FROM claims");
      this.#database.exec("DELETE FROM finding_verdicts");
      this.#database.exec("DELETE FROM findings");
      this.#database.exec("DELETE FROM todos");
      this.#database.exec("DELETE FROM wakes");
      this.#database.exec("DELETE FROM sqlite_sequence WHERE name IN ('todos', 'wakes')");
      this.#database.exec("DELETE FROM goal_participants");
      this.#database.exec("DELETE FROM goals");
      this.#database.exec("DELETE FROM events");
      this.#database.exec("DELETE FROM handoffs");
      this.#activities.reset();
      this.#database.exec(
        "UPDATE agents SET session_id = NULL, current_goal_id = NULL, detail = NULL, " +
          "availability = 'open', availability_reason = NULL, availability_until = NULL",
      );
    })();
    this.#agentsCache = null;
    this.#reclaimSpace();
  }

  /**
   * Hands a finished chat's pages back to the filesystem.
   *
   * Deleting rows only moves pages onto SQLite's free list, so a project that
   * once held a long chat kept a database file of tens of megabytes with no
   * rows in it. Vacuuming a freshly emptied database is quick.
   */
  #reclaimSpace(): void {
    try {
      const row = this.#database.query("PRAGMA freelist_count").get() as
        | { freelist_count?: number }
        | null;
      if ((row?.freelist_count ?? 0) >= VACUUM_FREE_PAGES) this.#database.exec("VACUUM");
    } catch {
      // Reclaiming space is an optimisation and must not fail a reset.
    }
  }

  registerAgent(input: {
    readonly id: AgentId;
    readonly backend: string;
    readonly displayName: string;
    readonly provider?: string;
    readonly model?: string | null;
    readonly effort?: string | null;
    readonly mode?: "managed" | "external";
    readonly unrestricted?: boolean;
  }): void {
    const now = Date.now();
    this.#database
      .query(`
        INSERT INTO agents(
          id, backend, display_name, provider, model, effort, mode,
          unrestricted, configured, state, updated_at
        )
        VALUES (
          $id, $backend, $displayName, $provider, $model, $effort, $mode,
          $unrestricted, 1, 'starting', $now
        )
        ON CONFLICT(id) DO UPDATE SET
          backend = excluded.backend,
          display_name = excluded.display_name,
          provider = excluded.provider,
          model = excluded.model,
          effort = excluded.effort,
          mode = excluded.mode,
          unrestricted = excluded.unrestricted,
          configured = 1,
          updated_at = excluded.updated_at
      `)
      .run({
        ...input,
        provider: input.provider ?? input.id,
        model: input.model ?? null,
        effort: input.effort ?? null,
        mode: input.mode ?? "managed",
        unrestricted: input.unrestricted === true ? 1 : 0,
        now,
      });
    this.#agentsCache = null;
  }

  unregisterAgent(id: AgentId): void {
    const result = this.#database
      .query(`
        UPDATE agents
        SET configured = 0, state = 'stopped', current_goal_id = NULL,
            detail = 'not configured', updated_at = $now
        WHERE id = $id
      `)
      .run({ id, now: Date.now() });
    this.#agentsCache = null;
    if (result.changes !== 1) throw new Error(`unknown agent: ${id}`);
  }

  setAgentState(
    id: AgentId,
    state: AgentRuntimeState,
    options: { readonly sessionId?: string | null; readonly detail?: string | null } = {},
  ): void {
    const current = this.#database
      .query("SELECT session_id, detail FROM agents WHERE id = $id")
      .get({ id }) as SqlRow | null;
    if (!current) {
      throw new Error(`unknown agent: ${id}`);
    }
    this.#database
      .query(`
        UPDATE agents
        SET state = $state, session_id = $sessionId, detail = $detail, updated_at = $now
        WHERE id = $id
      `)
      .run({
        id,
        state,
        sessionId: options.sessionId === undefined ? asNullableString(current.session_id) : options.sessionId,
        detail:
          options.detail === undefined
            ? asNullableString(current.detail)
            : boundedDetail(options.detail),
        now: Date.now(),
      });
    this.#agentsCache = null;
  }

  /** Records whether a peer may be steered. `until` is when do-not-disturb lapses. */
  setAvailability(
    id: AgentId,
    availability: AgentAvailability,
    options: { readonly reason?: string | null; readonly until?: number | null } = {},
  ): TeamAgent {
    const dnd = availability === "dnd";
    const result = this.#database
      .query(`
        UPDATE agents
        SET availability = $availability, availability_reason = $reason, availability_until = $until
        WHERE id = $id AND configured = 1
      `)
      .run({
        id,
        availability,
        reason: dnd ? sanitizeOptional(options.reason, MAX_AVAILABILITY_REASON_CHARS) : null,
        until: dnd ? options.until ?? null : null,
      });
    this.#agentsCache = null;
    if (result.changes !== 1) throw new Error(`agent is not configured: ${id}`);
    return required(this.agents().find((agent) => agent.id === id) ?? null, `agent is not configured: ${id}`);
  }

  createGoal(input: CreateGoalInput): TeamGoal {
    const instruction = requireText(input.instruction, "goal instruction", MAX_MESSAGE_CHARS);
    if (this.activeGoal()) {
      throw new Error("a shared goal is already active");
    }
    const participants = uniqueAgents(input.participants);
    if (participants.length === 0) {
      throw new Error("a shared goal requires at least one participant");
    }
    if (input.initialAddressee && !participants.includes(input.initialAddressee)) {
      throw new Error(`initial addressee is not active: ${input.initialAddressee}`);
    }
    const goalId = crypto.randomUUID();
    const now = Date.now();
    const transaction = this.#database.transaction(() => {
      this.#database
        .query(`
          INSERT INTO goals(id, instruction, origin, initial_addressee, state, created_at, updated_at)
          VALUES ($id, $instruction, 'user', $initialAddressee, 'active', $now, $now)
        `)
        .run({ id: goalId, instruction, initialAddressee: input.initialAddressee, now });
      for (const agent of participants) {
        this.#database
          .query(`
            INSERT INTO goal_participants(goal_id, agent, stance, updated_at)
            VALUES ($goalId, $agent, 'assessing', $now)
          `)
          .run({ goalId, agent, now });
        this.#database
          .query("UPDATE agents SET current_goal_id = $goalId, updated_at = $now WHERE id = $agent")
          .run({ goalId, agent, now });
      }
    });
    transaction();
    this.#agentsCache = null;
    return required(this.activeGoal(), "newly-created goal was not persisted");
  }

  addGoalParticipant(goalId: string, agent: AgentId): void {
    const now = Date.now();
    this.#database.transaction(() => {
      this.#database
        .query(`
          INSERT OR IGNORE INTO goal_participants(goal_id, agent, stance, updated_at)
          VALUES ($goalId, $agent, 'assessing', $now)
        `)
        .run({ goalId, agent, now });
      this.#database
        .query("UPDATE agents SET current_goal_id = $goalId, updated_at = $now WHERE id = $agent")
        .run({ goalId, agent, now });
    })();
    this.#agentsCache = null;
  }

  setGoalStance(goalId: string, agent: AgentId, stance: GoalStance, evidence?: string): void {
    const result = this.#database
      .query(`
        UPDATE goal_participants
        SET stance = $stance, completion_evidence = $evidence, updated_at = $now
        WHERE goal_id = $goalId AND agent = $agent
      `)
      .run({
        goalId,
        agent,
        stance,
        evidence: sanitizeOptional(evidence, MAX_MESSAGE_CHARS),
        now: Date.now(),
      });
    if (result.changes !== 1) {
      throw new Error(`agent ${agent} is not participating in goal ${goalId}`);
    }
  }

  /** Closes the goal and releases the claims made for it, which nobody owns any more. */
  completeGoal(goalId: string): void {
    const now = Date.now();
    const transaction = this.#database.transaction(() => {
      const result = this.#database
        .query("UPDATE goals SET state = 'complete', updated_at = $now WHERE id = $goalId AND state = 'active'")
        .run({ goalId, now });
      if (result.changes !== 1) {
        throw new Error(`active goal not found: ${goalId}`);
      }
      this.#database
        .query("UPDATE agents SET current_goal_id = NULL, updated_at = $now WHERE current_goal_id = $goalId")
        .run({ goalId, now });
      this.#database
        .query(`
          UPDATE claims
          SET state = 'released',
              note = COALESCE(note || ' · ', '') || 'released when the goal was completed',
              updated_at = $now
          WHERE goal_id = $goalId AND state IN ('proposed', 'active', 'contested')
        `)
        .run({ goalId, now });
    });
    transaction();
    this.#agentsCache = null;
  }

  addMessage(input: AddMessageInput): TeamMessage {
    const body = requireText(input.body, "message", MAX_MESSAGE_CHARS);
    const sender = requireIdentity(input.sender, "sender");
    const priority = input.priority ?? "normal";
    const priorityReason = sanitizeOptional(input.priorityReason, MAX_SUMMARY_CHARS);
    if (priority === "normal" && priorityReason !== null) {
      throw new Error("normal messages cannot carry priority_reason");
    }
    if (priority !== "normal" && priorityReason === null) {
      throw new Error(`${priority} messages require priority_reason`);
    }
    const recipients = uniqueAgents(input.recipients);
    if (recipients.length === 0) {
      throw new Error("message requires at least one recipient");
    }
    const replyTo = input.replyTo ?? null;
    if (replyTo !== null && !this.messageAddressedTo(replyTo, sender as AgentId)) {
      throw new Error(`reply_to ${replyTo} is not a message addressed to ${sender}`);
    }
    const now = Date.now();
    const topic = input.topic ?? null;
    let messageId = 0;
    const transaction = this.#database.transaction(() => {
      if (topic !== null) this.#supersedeTopic(topic, recipients, now);
      const result = this.#database
        .query(`
          INSERT INTO messages(
            goal_id, sender, kind, priority, priority_reason, body, created_at,
            reply_to, expects_reply, delivery, topic
          )
          VALUES (
            $goalId, $sender, $kind, $priority, $priorityReason, $body, $now,
            $replyTo, $expectsReply, $delivery, $topic
          )
        `)
        .run({
          goalId: input.goalId,
          sender,
          kind: input.kind,
          priority,
          priorityReason,
          body,
          now,
          replyTo,
          expectsReply: input.expectsReply ? 1 : 0,
          delivery: input.delivery ?? "normal",
          topic,
        });
      messageId = Number(result.lastInsertRowid);
      for (const recipient of recipients) {
        this.#database
          .query("INSERT INTO message_recipients(message_id, recipient) VALUES ($messageId, $recipient)")
          .run({ messageId, recipient });
      }
      if (sender !== "watari" && sender !== "user") {
        this.#settleAnsweredQuestions(sender, recipients, replyTo, now);
      }
    });
    transaction();
    return required(this.#messageById(messageId), "newly-created message was not persisted");
  }

  /**
   * Puts an archived chat back so the next service continues it.
   *
   * Only into a database with no chat of its own. Every restored message
   * counts as handed over and every restored question as settled, so history
   * is not delivered again and nobody is reminded about it. Each agent keeps
   * the provider session id it had, which is what lets its conversation resume.
   */
  restoreChat(chat: RestorableChat): RestoreSummary {
    if (this.hasUserMessages() || this.activeGoal()) {
      throw new Error("this project already has a chat, so there is nothing to restore into");
    }
    const configured = new Set(this.agents().map((agent) => agent.id));
    // New archives carry all goals so completed goals remain valid parents for
    // their claims and TODOs. Older archives only have activeGoal and still
    // restore through the fallback below.
    const goals = chat.goals?.length ? chat.goals : (chat.activeGoal ? [chat.activeGoal] : []);
    const goal = goals.find((candidate) => candidate.state === "active") ?? chat.activeGoal ?? null;
    const goalId = goal?.id ?? null;
    const goalIds = new Set(goals.map((candidate) => candidate.id));
    let messages = 0;
    this.#database.transaction(() => {
      // Preserve historical authors and recipients without adding providers to
      // the target roster. Archives can also reference peers removed before
      // export, so the visible archived roster alone is not sufficient.
      const identities = new Set([
        ...chat.agents.map((agent) => agent.id),
        ...chat.messages.flatMap((message) => message.recipients),
        ...chat.claims.map((claim) => claim.claimant),
        ...chat.findings.flatMap((finding) => [finding.author, finding.target,
          ...(finding.verdicts ?? []).map((verdict) => verdict.reviewer)]),
        ...chat.todos.map((todo) => todo.assignee),
      ].filter((id): id is string => id !== null));
      for (const id of identities) {
        if (typeof id !== "string" || !AGENT_ALIAS_PATTERN.test(id)) {
          throw new Error("chat archive contains an invalid agent identity");
        }
        this.#database.query(`
          INSERT INTO agents(id, backend, display_name, provider, mode, unrestricted, configured, state, updated_at)
          VALUES ($id, 'archived', $id, 'unknown', 'external', 0, 0, 'stopped', $now)
          ON CONFLICT(id) DO NOTHING
        `).run({ id, now: Date.now() });
      }
      for (const archivedGoal of goals) {
        this.#database
          .query(`
            INSERT INTO goals(id, instruction, origin, initial_addressee, state, created_at, updated_at)
            VALUES ($id, $instruction, $origin, $initialAddressee, $state, $createdAt, $updatedAt)
          `)
          .run({
            id: archivedGoal.id,
            instruction: archivedGoal.instruction,
            origin: archivedGoal.origin ?? "user",
            initialAddressee: archivedGoal.initialAddressee && configured.has(archivedGoal.initialAddressee)
              ? archivedGoal.initialAddressee
              : null,
            state: archivedGoal.state,
            createdAt: archivedGoal.createdAt,
            updatedAt: archivedGoal.updatedAt,
          });
        if (archivedGoal.id === goalId) {
          for (const agent of configured) {
            this.#database
              .query(`
                INSERT INTO goal_participants(goal_id, agent, stance, completion_evidence, updated_at)
                VALUES ($goalId, $agent, 'participating', NULL, $now)
              `)
              .run({ goalId: archivedGoal.id, agent, now: archivedGoal.updatedAt });
          }
        }
      }
      for (const message of chat.messages) {
        const recipients = message.recipients;
        this.#database
          .query(`
            INSERT INTO messages(id, goal_id, sender, kind, priority, priority_reason, body, created_at,
              reply_to, expects_reply, delivery)
            VALUES ($id, $goalId, $sender, $kind, $priority, $priorityReason, $body, $createdAt,
              $replyTo, $expectsReply, $delivery)
          `)
          .run({
            id: message.id,
            goalId: message.goalId && goalIds.has(message.goalId) ? message.goalId : null,
            sender: message.sender,
            kind: message.kind,
            priority: message.priority,
            priorityReason: message.priorityReason,
            body: message.body,
            createdAt: message.createdAt,
            replyTo: message.replyTo ?? null,
            expectsReply: message.expectsReply ? 1 : 0,
            delivery: message.delivery ?? "normal",
          });
        for (const recipient of recipients) {
          this.#database
            .query(`
              INSERT INTO message_recipients(message_id, recipient, delivered_at, acknowledged_at, replied_at)
              VALUES ($id, $recipient, $at, $at, $replied)
            `)
            .run({
              id: message.id,
              recipient,
              at: message.createdAt,
              replied: message.expectsReply ? message.createdAt : null,
            });
        }
        messages += 1;
      }
      for (const claim of chat.claims) {
        if (!goalIds.has(claim.goalId)) continue;
        this.#database
          .query(`
            INSERT INTO claims(id, goal_id, claimant, summary, paths_json, state, note, created_at, updated_at)
            VALUES ($id, $goalId, $claimant, $summary, $paths, $state, $note, $createdAt, $updatedAt)
          `)
          .run({
            id: claim.id,
            goalId: claim.goalId,
            claimant: claim.claimant,
            summary: claim.summary,
            paths: JSON.stringify(claim.paths),
            state: claim.state,
            note: claim.note,
            createdAt: claim.createdAt,
            updatedAt: claim.updatedAt,
          });
      }
      for (const finding of chat.findings) {
        this.#database
          .query(`
            INSERT INTO findings(id, author, target, scope, severity, summary, evidence, disposition, created_at, updated_at)
            VALUES ($id, $author, $target, $scope, $severity, $summary, $evidence, $disposition, $createdAt, $updatedAt)
          `)
          .run({
            id: finding.id,
            author: finding.author,
            target: finding.target,
            scope: finding.scope,
            severity: finding.severity,
            summary: finding.summary,
            evidence: finding.evidence,
            disposition: finding.disposition,
            createdAt: finding.createdAt,
            updatedAt: finding.updatedAt,
          });
        for (const verdict of finding.verdicts ?? []) {
          this.#database
            .query(`
              INSERT INTO finding_verdicts(finding_id, reviewer, verdict, evidence, created_at)
              VALUES ($id, $reviewer, $verdict, $evidence, $createdAt)
            `)
            .run({ id: finding.id, reviewer: verdict.reviewer, verdict: verdict.verdict, evidence: verdict.evidence, createdAt: verdict.createdAt });
        }
      }
      for (const todo of chat.todos) {
        this.#database
          .query(`
            INSERT INTO todos(id, goal_id, title, detail, author, assignee, paths_json, state, note, created_at, updated_at)
            VALUES ($id, $goalId, $title, $detail, $author, $assignee, $paths, $state, $note, $createdAt, $updatedAt)
          `)
          .run({
            id: todo.id,
            goalId: todo.goalId && goalIds.has(todo.goalId) ? todo.goalId : null,
            title: todo.title,
            detail: todo.detail,
            author: todo.author,
            assignee: todo.assignee,
            paths: JSON.stringify(todo.paths),
            state: todo.state,
            note: todo.note,
            createdAt: todo.createdAt,
            updatedAt: todo.updatedAt,
          });
      }
      for (const event of chat.events) {
        this.#database
          .query(`
            INSERT INTO events(id, agent, type, summary, provider_event_id, payload_json, created_at)
            VALUES ($id, $agent, $type, $summary, $providerEventId, NULL, $createdAt)
          `)
          .run({
            id: event.id,
            agent: event.agent,
            type: event.type,
            summary: event.summary,
            providerEventId: event.providerEventId,
            createdAt: event.createdAt,
          });
      }
      for (const record of chat.activities) this.#activities.save(record);
      for (const agent of chat.agents) {
        if (!configured.has(agent.id)) continue;
        this.#database
          .query("UPDATE agents SET session_id = $sessionId, state = 'stopped', detail = $detail WHERE id = $id")
          .run({ id: agent.id, sessionId: agent.sessionId, detail: "restored from the chat archive" });
      }
    })();
    this.#agentsCache = null;
    return {
      goal: goalId,
      messages,
      claims: this.claims().length,
      todos: this.todos().length,
      findings: this.findings().length,
      events: chat.events.length,
      activities: chat.activities.length,
    };
  }

  /** The chat's first message, which names the chat across service restarts. */
  firstMessage(): { readonly id: number; readonly createdAt: number } | null {
    const row = this.#database.query("SELECT id, created_at FROM messages ORDER BY id LIMIT 1").get() as SqlRow | null;
    return row ? { id: asNumber(row.id), createdAt: asNumber(row.created_at) } : null;
  }

  /** Whether the user has said anything in this chat, which is what makes it worth keeping. */
  hasUserMessages(): boolean {
    return this.#database.query("SELECT 1 FROM messages WHERE sender = 'user' LIMIT 1").get() !== null;
  }

  /** Whether a peer is one of a message's recipients, which is what it may reply to. */
  messageAddressedTo(messageId: number, agent: AgentId): boolean {
    assertNonNegativeInteger(messageId, "reply_to");
    return this.#database
      .query("SELECT 1 FROM message_recipients WHERE message_id = $messageId AND recipient = $agent")
      .get({ messageId, agent }) !== null;
  }

  /**
   * Marks the questions a new message answers.
   *
   * The `reply_to` target is answered whether or not it was handed over yet.
   * Any other message from the answerer to an asker also settles the questions
   * from that asker which the answerer has already seen. Models often answer
   * without naming the message, and reminding a peer about a question it
   * answered in substance would cost a turn for nothing.
   */
  #settleAnsweredQuestions(
    answerer: string,
    askers: readonly AgentId[],
    replyTo: number | null,
    now: number,
  ): void {
    if (replyTo !== null) {
      this.#database
        .query(`
          UPDATE message_recipients SET replied_at = $now
          WHERE message_id = $replyTo AND recipient = $answerer AND replied_at IS NULL
        `)
        .run({ now, replyTo, answerer });
    }
    for (const asker of askers) {
      this.#database
        .query(`
          UPDATE message_recipients SET replied_at = $now
          WHERE recipient = $answerer
            AND replied_at IS NULL
            AND acknowledged_at IS NOT NULL
            AND message_id IN (SELECT id FROM messages WHERE sender = $asker AND expects_reply = 1)
        `)
        .run({ now, answerer, asker });
    }
  }

  inbox(agent: AgentId, afterId = 0): readonly TeamMessage[] {
    assertNonNegativeInteger(afterId, "after_id");
    const rows = this.#database
      .query(`
        SELECT m.*
        FROM messages m
        JOIN message_recipients mr ON mr.message_id = m.id
        WHERE mr.recipient = $agent AND m.id > $afterId
        ORDER BY m.id ASC
        LIMIT 200
      `)
      .all({ agent, afterId }) as SqlRow[];
    return this.#messagesFromRows(rows);
  }

  pendingInbox(agent: AgentId): readonly TeamMessage[] {
    const rows = this.#database
      .query(`
        SELECT m.*
        FROM messages m
        JOIN message_recipients mr ON mr.message_id = m.id
        WHERE mr.recipient = $agent AND mr.acknowledged_at IS NULL
        ORDER BY m.id ASC
        LIMIT 200
      `)
      .all({ agent }) as SqlRow[];
    return this.#messagesFromRows(rows);
  }

  /** Messages addressed to a peer that it has not been handed or read. */
  pendingCount(agent: AgentId): number {
    const row = this.#database
      .query("SELECT COUNT(*) AS count FROM message_recipients WHERE recipient = $agent AND acknowledged_at IS NULL")
      .get({ agent }) as { count?: number } | null;
    return row?.count ?? 0;
  }

  acknowledge(agent: AgentId, throughId: number): void {
    assertNonNegativeInteger(throughId, "acknowledge_through");
    this.#database
      .query(`
        UPDATE message_recipients
        SET acknowledged_at = $now,
            delivered_at = COALESCE(delivered_at, $now)
        WHERE recipient = $agent AND message_id <= $throughId
      `)
      .run({ agent, throughId, now: Date.now() });
  }

  /** Marks earlier messages on `topic` that `recipients` were never handed as handed over. */
  discardUndeliveredTopic(topic: string, recipients: readonly AgentId[]): number {
    return recipients.length > 0 ? this.#supersedeTopic(topic, recipients, Date.now()) : 0;
  }

  #supersedeTopic(topic: string, recipients: readonly AgentId[], now: number): number {
    const placeholders = recipients.map((_recipient, index) => `$r${index}`).join(", ");
    return this.#database
      .query(`
        UPDATE message_recipients
        SET delivered_at = $now, acknowledged_at = $now
        WHERE delivered_at IS NULL
          AND recipient IN (${placeholders})
          AND message_id IN (SELECT id FROM messages WHERE topic = $topic)
      `)
      .run({ topic, now, ...Object.fromEntries(recipients.map((recipient, index) => [`r${index}`, recipient])) }).changes;
  }

  acknowledgeMessages(agent: AgentId, messageIds: readonly number[]): void {
    const ids = [...new Set(messageIds)];
    if (ids.length === 0) return;
    for (const id of ids) assertNonNegativeInteger(id, "message_id");
    const placeholders = ids.map((_id, index) => `$id${index}`).join(", ");
    const parameters = Object.fromEntries(ids.map((id, index) => [`id${index}`, id]));
    this.#database
      .query(`
        UPDATE message_recipients
        SET acknowledged_at = $now,
            delivered_at = COALESCE(delivered_at, $now)
        WHERE recipient = $agent AND message_id IN (${placeholders})
      `)
      .run({ agent, now: Date.now(), ...parameters });
  }

  /** Questions a peer has been handed and has not answered, oldest first. */
  replyObligations(agent: AgentId): readonly ReplyObligation[] {
    return this.#openQuestions(agent, true);
  }

  /** Questions addressed to a peer that are still open, seen or not. */
  unsettledQuestionsTo(agent: AgentId): readonly ReplyObligation[] {
    return this.#openQuestions(agent, false);
  }

  #openQuestions(agent: AgentId, handedOver: boolean): readonly ReplyObligation[] {
    const rows = this.#database
      .query(`
        SELECT m.id, m.sender, m.body, m.created_at, mr.nudged_at
        FROM message_recipients mr
        JOIN messages m ON m.id = mr.message_id
        WHERE mr.recipient = $agent
          AND m.expects_reply = 1
          AND mr.replied_at IS NULL
          AND mr.escalated_at IS NULL
          ${handedOver ? "AND mr.acknowledged_at IS NOT NULL" : ""}
        ORDER BY m.id
        LIMIT ${MAX_OPEN_QUESTIONS}
      `)
      .all({ agent }) as SqlRow[];
    return rows.map((row) => ({
      messageId: asNumber(row.id),
      sender: asString(row.sender),
      recipient: agent,
      body: asString(row.body),
      createdAt: asNumber(row.created_at),
      nudgedAt: asNullableNumber(row.nudged_at),
    }));
  }

  /** Questions a peer asked that nobody has answered or given up on. */
  awaitedReplies(agent: AgentId): readonly AwaitedReply[] {
    const rows = this.#database
      .query(`
        SELECT m.id, m.body, m.created_at, mr.recipient, mr.acknowledged_at
        FROM messages m
        JOIN message_recipients mr ON mr.message_id = m.id
        WHERE m.sender = $agent
          AND m.expects_reply = 1
          AND mr.replied_at IS NULL
          AND mr.escalated_at IS NULL
        ORDER BY m.id
        LIMIT ${MAX_OPEN_QUESTIONS}
      `)
      .all({ agent }) as SqlRow[];
    return rows.map((row) => ({
      messageId: asNumber(row.id),
      recipient: asString(row.recipient) as AgentId,
      body: asString(row.body),
      createdAt: asNumber(row.created_at),
      deliveredAt: asNullableNumber(row.acknowledged_at),
    }));
  }

  /** The peer was reminded of these questions. */
  markNudged(agent: AgentId, messageIds: readonly number[]): void {
    this.#stampRecipients("nudged_at", agent, messageIds);
  }

  /** The askers were told these questions will not be answered in time. */
  markEscalated(agent: AgentId, messageIds: readonly number[]): void {
    this.#stampRecipients("escalated_at", agent, messageIds);
  }

  #stampRecipients(
    column: "nudged_at" | "escalated_at",
    agent: AgentId,
    messageIds: readonly number[],
  ): void {
    const ids = [...new Set(messageIds)];
    if (ids.length === 0) return;
    for (const id of ids) assertNonNegativeInteger(id, "message_id");
    const placeholders = ids.map((_id, index) => `$id${index}`).join(", ");
    const parameters = Object.fromEntries(ids.map((id, index) => [`id${index}`, id]));
    this.#database
      .query(`
        UPDATE message_recipients SET ${column} = $now
        WHERE recipient = $agent AND message_id IN (${placeholders})
      `)
      .run({ agent, now: Date.now(), ...parameters });
  }

  inboxCursors(): readonly InboxCursor[] {
    const rows = this.#database.query(`
      SELECT recipient, message_id, acknowledged_at
      FROM message_recipients
      ORDER BY recipient, message_id
    `).all() as SqlRow[];
    const found = new Map<AgentId, InboxCursor>();
    const hasGap = new Set<AgentId>();
    for (const row of rows) {
      const agent = asString(row.recipient) as AgentId;
      const messageId = asNumber(row.message_id);
      const current = found.get(agent) ?? {
        agent,
        latestMessageId: 0,
        acknowledgedThrough: 0,
        pendingCount: 0,
      };
      const acknowledged = row.acknowledged_at !== null;
      if (!acknowledged) hasGap.add(agent);
      found.set(agent, {
        ...current,
        latestMessageId: messageId,
        acknowledgedThrough: acknowledged && !hasGap.has(agent)
          ? messageId
          : current.acknowledgedThrough,
        pendingCount: current.pendingCount + (acknowledged ? 0 : 1),
      });
    }
    return this.agents().map((agent) => {
      const row = found.get(agent.id);
      return row ?? { agent: agent.id, latestMessageId: 0, acknowledgedThrough: 0, pendingCount: 0 };
    });
  }

  /**
   * Records a claim. Overlap with a live peer's open claim contests both.
   *
   * Overlap with a claim whose owner is offline supersedes that claim instead.
   * A peer that went down cannot answer a contest, and the offline notice
   * already invites the others to take its scope over after checking the
   * working tree. Contesting it left the takeover and the dead claim both
   * contested for the rest of the goal.
   */
  createClaim(input: CreateClaimInput): CreatedClaim {
    const summary = requireText(input.summary, "claim summary", MAX_SUMMARY_CHARS);
    const paths = normalizePaths(input.paths ?? []);
    const id = this.#newId("claims");
    const now = Date.now();
    // A removed agent is not listed at all, and it is as unable to answer as
    // one that failed.
    const live = new Set(
      this.agents()
        .filter((agent) => agent.state !== "failed" && agent.state !== "stopped")
        .map((agent) => agent.id),
    );
    const takenOver: string[] = [];
    const transaction = this.#database.transaction(() => {
      this.#database
        .query(`
          INSERT INTO claims(id, goal_id, claimant, summary, paths_json, state, note, created_at, updated_at)
          VALUES ($id, $goalId, $claimant, $summary, $pathsJson, $state, $note, $now, $now)
        `)
        .run({
          id,
          goalId: input.goalId,
          claimant: input.claimant,
          summary,
          pathsJson: JSON.stringify(paths),
          state: input.state ?? "proposed",
          note: sanitizeOptional(input.note, MAX_SUMMARY_CHARS),
          now,
        });
      if (paths.length > 0) {
        const others = this.claims(input.goalId).filter(
          (claim) => claim.claimant !== input.claimant && isOpenClaim(claim.state),
        );
        for (const other of others) {
          if (!pathsOverlap(paths, other.paths)) continue;
          if (!live.has(other.claimant)) {
            this.#database
              .query(`
                UPDATE claims
                SET state = 'superseded',
                    note = COALESCE(note || ' · ', '') || $note,
                    updated_at = $now
                WHERE id = $otherId
              `)
              .run({
                otherId: other.id,
                note: `taken over by ${input.claimant} while ${other.claimant} was offline`,
                now,
              });
            takenOver.push(other.id);
            continue;
          }
          this.#database
            .query("UPDATE claims SET state = 'contested', updated_at = $now WHERE id IN ($newId, $otherId)")
            .run({ newId: id, otherId: other.id, now });
        }
      }
    });
    transaction();
    const claim = required(this.#claimById(id), "newly-created claim was not persisted");
    return {
      ...claim,
      takenOver: takenOver.map((otherId) => required(this.#claimById(otherId), `claim not found: ${otherId}`)),
    };
  }

  /**
   * Changes a claim's state. A claim that stops being open lets every claim it
   * was contesting go back to active, unless another live overlap remains.
   */
  setClaimState(id: string, actor: AgentId, state: ClaimState, note?: string): TeamClaim {
    const claim = required(this.#claimById(id), `claim not found: ${id}`);
    if (claim.claimant !== actor && state !== "contested") {
      throw new Error(`only ${claim.claimant} may change claim ${id} to ${state}`);
    }
    this.#database.transaction(() => {
      this.#database
        .query("UPDATE claims SET state = $state, note = $note, updated_at = $now WHERE id = $id")
        .run({ id, state, note: sanitizeOptional(note, MAX_SUMMARY_CHARS), now: Date.now() });
      if (!isOpenClaim(state)) this.#settleContests(claim);
    })();
    return required(this.#claimById(id), `claim not found after update: ${id}`);
  }

  /** Returns contested claims that only overlapped `closed` to active. */
  #settleContests(closed: TeamClaim): void {
    if (closed.paths.length === 0) return;
    const open = this.claims(closed.goalId).filter((claim) => isOpenClaim(claim.state));
    for (const contested of open) {
      if (contested.state !== "contested" || !pathsOverlap(contested.paths, closed.paths)) continue;
      const stillContested = open.some((other) =>
        other.id !== contested.id &&
        other.claimant !== contested.claimant &&
        pathsOverlap(contested.paths, other.paths)
      );
      if (stillContested) continue;
      this.#database
        .query("UPDATE claims SET state = 'active', updated_at = $now WHERE id = $id")
        .run({ id: contested.id, now: Date.now() });
    }
  }

  /**
   * A short id for a claim or finding, unique within the chat.
   *
   * Models quote these ids back to each other and to the tools. Eight hex
   * characters survive that where a full UUID got lost or mangled, and a chat
   * holds few enough rows that a collision is retried rather than feared.
   */
  #newId(table: "claims" | "findings"): string {
    for (;;) {
      const id = crypto.randomUUID().replaceAll("-", "").slice(0, 8);
      if (this.#database.query(`SELECT 1 FROM ${table} WHERE id = $id`).get({ id }) === null) return id;
    }
  }

  /** Open claims by other peers whose paths overlap this one. */
  claimConflicts(claim: TeamClaim): readonly TeamClaim[] {
    if (claim.paths.length === 0) return [];
    return this.claims(claim.goalId).filter((other) =>
      other.id !== claim.id &&
      other.claimant !== claim.claimant &&
      isOpenClaim(other.state) &&
      pathsOverlap(claim.paths, other.paths)
    );
  }

  createFinding(input: CreateFindingInput): TeamFinding {
    if (input.target && !this.agents().some((agent) => agent.id === input.target)) {
      throw new Error(`finding target is not in the Watari roster: ${input.target}`);
    }
    const id = this.#newId("findings");
    const now = Date.now();
    this.#database
      .query(`
        INSERT INTO findings(
          id, author, target, scope, severity, summary, evidence, disposition, created_at, updated_at
        ) VALUES (
          $id, $author, $target, $scope, $severity, $summary, $evidence, 'open', $now, $now
        )
      `)
      .run({
        id,
        author: input.author,
        target: input.target ?? null,
        scope: sanitizeOptional(input.scope, MAX_SUMMARY_CHARS),
        severity: input.severity,
        summary: requireText(input.summary, "finding summary", MAX_SUMMARY_CHARS),
        evidence: sanitizeOptional(input.evidence, MAX_MESSAGE_CHARS),
        now,
      });
    return required(this.#findingById(id), "newly-created finding was not persisted");
  }

  setFindingDisposition(
    id: string,
    actor: AgentId,
    disposition: TeamFinding["disposition"],
  ): TeamFinding {
    const finding = required(this.#findingById(id), `finding not found: ${id}`);
    if (finding.author !== actor && finding.target !== actor) {
      throw new Error(
        `only finding author ${finding.author} or target ${finding.target ?? "none"} may update ${id}`,
      );
    }
    this.#database
      .query("UPDATE findings SET disposition = $disposition, updated_at = $now WHERE id = $id")
      .run({ id, disposition, now: Date.now() });
    return required(this.#findingById(id), `finding not found after update: ${id}`);
  }

  /**
   * Records another peer's independent check of a finding.
   *
   * A finding one peer wrote and a second peer confirmed against the source is
   * worth more than either peer's confidence, and a refuted one tells the user
   * where the team disagrees. Each reviewer holds one current verdict, so
   * changing its mind replaces the earlier one.
   */
  recordFindingVerdict(
    id: string,
    reviewer: AgentId,
    verdict: FindingVerdictKind,
    evidence?: string,
  ): TeamFinding {
    const finding = required(this.#findingById(id), `finding not found: ${id}`);
    if (finding.author === reviewer) {
      throw new Error(`${reviewer} wrote finding ${id}, so another peer has to verify it`);
    }
    this.#requireConfiguredAgent(reviewer, "reviewer");
    const now = Date.now();
    this.#database.transaction(() => {
      this.#database
        .query(`
          INSERT INTO finding_verdicts(finding_id, reviewer, verdict, evidence, created_at)
          VALUES ($id, $reviewer, $verdict, $evidence, $now)
          ON CONFLICT(finding_id, reviewer)
          DO UPDATE SET verdict = excluded.verdict, evidence = excluded.evidence, created_at = excluded.created_at
        `)
        .run({ id, reviewer, verdict, evidence: sanitizeOptional(evidence, MAX_SUMMARY_CHARS), now });
      this.#database.query("UPDATE findings SET updated_at = $now WHERE id = $id").run({ id, now });
    })();
    return required(this.#findingById(id), `finding not found after update: ${id}`);
  }

  findings(): readonly TeamFinding[] {
    const verdicts = this.#verdictsByFinding();
    return (this.#database.query("SELECT * FROM findings ORDER BY created_at").all() as SqlRow[]).map(
      (row) => withVerdicts(findingFromRow(row), verdicts.get(asString(row.id))),
    );
  }

  #verdictsByFinding(findingId?: string): Map<string, FindingVerdict[]> {
    const rows = (findingId
      ? this.#database
        .query("SELECT * FROM finding_verdicts WHERE finding_id = $findingId ORDER BY created_at")
        .all({ findingId })
      : this.#database.query("SELECT * FROM finding_verdicts ORDER BY created_at").all()) as SqlRow[];
    const grouped = new Map<string, FindingVerdict[]>();
    for (const row of rows) {
      const key = asString(row.finding_id);
      const verdict: FindingVerdict = {
        reviewer: asString(row.reviewer) as AgentId,
        verdict: asString(row.verdict) as FindingVerdictKind,
        evidence: asNullableString(row.evidence),
        createdAt: asNumber(row.created_at),
      };
      const list = grouped.get(key);
      if (list) list.push(verdict);
      else grouped.set(key, [verdict]);
    }
    return grouped;
  }

  createTodos(input: CreateTodoInput): readonly TeamTodo[] {
    if (input.items.length === 0) throw new Error("a TODO list addition needs at least one item");
    const author = requireIdentity(input.author, "author");
    const existing = this.#database.query("SELECT COUNT(*) AS count FROM todos").get() as
      | { count?: number }
      | null;
    if ((existing?.count ?? 0) + input.items.length > MAX_TODOS) {
      throw new Error(`the shared TODO list holds at most ${MAX_TODOS} items per chat`);
    }
    const now = Date.now();
    const ids: number[] = [];
    this.#database.transaction(() => {
      for (const item of input.items) {
        const assignee = item.assignee ?? null;
        if (assignee !== null) this.#requireConfiguredAgent(assignee, "TODO assignee");
        const result = this.#database
          .query(`
            INSERT INTO todos(goal_id, title, detail, author, assignee, paths_json, state, note, created_at, updated_at)
            VALUES ($goalId, $title, $detail, $author, $assignee, $paths, 'todo', NULL, $now, $now)
          `)
          .run({
            goalId: input.goalId,
            title: requireText(item.title, "TODO title", MAX_TODO_TITLE_CHARS),
            detail: sanitizeOptional(item.detail, MAX_SUMMARY_CHARS),
            author,
            assignee,
            paths: JSON.stringify(normalizePaths(item.paths ?? [])),
            now,
          });
        ids.push(Number(result.lastInsertRowid));
      }
    })();
    return ids.map((id) => required(this.#todoById(id), "newly-created TODO was not persisted"));
  }

  updateTodo(id: number, input: UpdateTodoInput): TeamTodo {
    assertNonNegativeInteger(id, "id");
    const todo = required(this.#todoById(id), `TODO not found: ${id}`);
    if (input.state === undefined && input.assignee === undefined && input.note === undefined) {
      throw new Error("a TODO update needs a state, an assignee, or a note");
    }
    if (input.assignee) this.#requireConfiguredAgent(input.assignee, "TODO assignee");
    this.#database
      .query(`
        UPDATE todos
        SET state = $state, assignee = $assignee, note = $note, updated_at = $now
        WHERE id = $id
      `)
      .run({
        id,
        state: input.state ?? todo.state,
        assignee: input.assignee === undefined ? todo.assignee : input.assignee,
        note: input.note === undefined ? todo.note : sanitizeOptional(input.note, MAX_SUMMARY_CHARS),
        now: Date.now(),
      });
    return required(this.#todoById(id), `TODO not found after update: ${id}`);
  }

  /** Keeps what an agent handed over for an export. The newest one per agent wins. */
  recordHandoff(input: {
    readonly requestId: string;
    readonly agent: AgentId;
    readonly source: TeamHandoff["source"];
    readonly content: string;
  }): TeamHandoff {
    const content = input.source === "none" ? input.content : requireText(input.content, "handoff", MAX_HANDOFF_CHARS);
    const now = Date.now();
    const result = this.#database
      .query(`
        INSERT INTO handoffs(request_id, agent, source, content, created_at)
        VALUES ($requestId, $agent, $source, $content, $now)
      `)
      .run({ requestId: input.requestId, agent: input.agent, source: input.source, content, now });
    return {
      id: Number(result.lastInsertRowid),
      requestId: input.requestId,
      agent: input.agent,
      source: input.source,
      content,
      createdAt: now,
    };
  }

  handoffs(requestId: string): readonly TeamHandoff[] {
    const rows = this.#database
      .query("SELECT * FROM handoffs WHERE request_id = $requestId ORDER BY id")
      .all({ requestId }) as SqlRow[];
    return rows.map((row) => ({
      id: asNumber(row.id),
      requestId: asString(row.request_id),
      agent: asString(row.agent) as AgentId,
      source: asString(row.source) as TeamHandoff["source"],
      content: asString(row.content),
      createdAt: asNumber(row.created_at),
    }));
  }

  /** What an agent said, not thought, since `since`, oldest first. */
  assistantTextSince(agent: AgentId, since: number): string {
    const rows = this.#database
      .query(`
        SELECT summary FROM events
        WHERE agent = $agent AND type = 'assistant' AND created_at >= $since
        ORDER BY id
      `)
      .all({ agent, since }) as SqlRow[];
    return rows.map((row) => asNullableString(row.summary)?.trim() ?? "").filter(Boolean).join("\n\n");
  }

  todos(): readonly TeamTodo[] {
    return (this.#database.query("SELECT * FROM todos ORDER BY id").all() as SqlRow[]).map(todoFromRow);
  }

  createWake(input: CreateWakeInput): TeamWake {
    this.#requireConfiguredAgent(input.agent, "wake agent");
    const now = Date.now();
    const result = this.#database
      .query(`
        INSERT INTO wakes(agent, condition_json, note, state, created_at, deadline_at, settled_at, outcome)
        VALUES ($agent, $condition, $note, 'pending', $now, $deadline, NULL, NULL)
      `)
      .run({
        agent: input.agent,
        condition: JSON.stringify(input.condition),
        note: requireText(input.note, "wake note", MAX_WAKE_NOTE_CHARS),
        now,
        deadline: input.deadlineAt,
      });
    return required(this.#wakeById(Number(result.lastInsertRowid)), "newly-created wake was not persisted");
  }

  /** Records how a pending wake ended. A wake that already ended is left as it was. */
  settleWake(id: number, state: Exclude<WakeState, "pending">, outcome: string | null): TeamWake | null {
    const result = this.#database
      .query(`
        UPDATE wakes SET state = $state, outcome = $outcome, settled_at = $now
        WHERE id = $id AND state = 'pending'
      `)
      .run({ id, state, outcome: outcome === null ? null : redactSummary(outcome), now: Date.now() });
    return result.changes === 1 ? this.#wakeById(id) : null;
  }

  wake(id: number): TeamWake | null {
    return this.#wakeById(id);
  }

  pendingWakes(agent?: AgentId): readonly TeamWake[] {
    const rows = (agent
      ? this.#database.query("SELECT * FROM wakes WHERE state = 'pending' AND agent = $agent ORDER BY id").all({ agent })
      : this.#database.query("SELECT * FROM wakes WHERE state = 'pending' ORDER BY id").all()) as SqlRow[];
    return rows.map(wakeFromRow);
  }

  /**
   * Atomically reserves every named resource. Pending/running/unknown jobs
   * block a new reservation; an unknown job is deliberately not expired by
   * Watari because the process may still be alive after an observer restart.
   */
  reserveJob(input: ReserveJobInput): TeamJob {
    this.#requireConfiguredAgent(input.owner, "job owner");
    const source = requireText(input.source, "job source", MAX_JOB_SOURCE_CHARS);
    const title = requireText(input.title, "job title", MAX_JOB_TITLE_CHARS);
    const resources = normalizeJobResources(input.resources);
    const note = input.note === undefined ? null : requireText(input.note, "job note", MAX_JOB_NOTE_CHARS);
    const handle = input.handle === undefined ? null : requireText(input.handle, "job handle", MAX_JOB_HANDLE_CHARS);
    return this.#database.transaction(() => {
      const conflicts: TeamJob[] = [];
      const active = (this.#database
        .query("SELECT * FROM team_jobs WHERE state IN ('pending', 'running', 'unknown') ORDER BY created_at")
        .all() as SqlRow[]).map(teamJobFromRow);
      for (const job of active) {
        if (pathsOverlap(resources, job.resources)) conflicts.push(job);
      }
      if (conflicts.length > 0) {
        const detail = conflicts
          .map((job) => `${job.id} (${job.owner}, ${job.state}, ${job.resources.join(", ")})`)
          .join("; ");
        throw new Error(`job resources are reserved by ${detail}`);
      }
      this.#pruneJobs();
      const count = this.#database.query("SELECT COUNT(*) AS count FROM team_jobs WHERE state IN ('pending', 'running', 'unknown')").get() as { count?: number } | null;
      if ((count?.count ?? 0) >= MAX_TEAM_JOBS - MAX_JOB_HISTORY) {
        throw new Error(`Watari allows at most ${MAX_TEAM_JOBS - MAX_JOB_HISTORY} active jobs; reconcile existing jobs first`);
      }
      const now = Date.now();
      const id = `job_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
      this.#database.query(`
        INSERT INTO team_jobs(id, owner, source, title, resources_json, state, handle, result, note, created_at, updated_at)
        VALUES ($id, $owner, $source, $title, $resources, 'pending', $handle, NULL, $note, $now, $now)
      `).run({ id, owner: input.owner, source, title, resources: JSON.stringify(resources), handle, note, now });
      return required(this.#jobById(id), "newly-created job was not persisted");
    }).immediate();
  }

  updateJob(id: string, owner: AgentId, input: UpdateJobInput): TeamJob {
    const job = required(this.#jobById(requireJobId(id)), `job not found: ${id}`);
    if (job.owner !== owner) throw new Error(`job ${id} belongs to ${job.owner}; only its owner may update it`);
    if (!["pending", "running", "succeeded", "failed", "cancelled", "unknown"].includes(input.state)) {
      throw new Error("invalid job state");
    }
    if (!isActiveJob(job.state) && input.state !== job.state) {
      throw new Error(`job ${id} is terminal (${job.state}); reserve a new job for new work`);
    }
    if (input.state === "pending" && job.state !== "pending") {
      throw new Error(`job ${id} cannot return to pending from ${job.state}`);
    }
    const now = Date.now();
    this.#database.query(`
      UPDATE team_jobs SET state = $state, handle = $handle, result = $result, note = $note, updated_at = $now
      WHERE id = $id AND owner = $owner
    `).run({
      id, owner, state: input.state,
      handle: input.handle === undefined ? job.handle : sanitizeOptional(input.handle, MAX_JOB_HANDLE_CHARS),
      result: input.result === undefined ? job.result : sanitizeOptional(input.result, MAX_JOB_RESULT_CHARS),
      note: input.note === undefined ? job.note : sanitizeOptional(input.note, MAX_JOB_NOTE_CHARS),
      now,
    });
    return required(this.#jobById(id), `job disappeared while updating: ${id}`);
  }

  jobs(options: { readonly owner?: AgentId; readonly activeOnly?: boolean } = {}): readonly TeamJob[] {
    const where: string[] = [];
    if (options.owner) where.push("owner = $owner");
    if (options.activeOnly) where.push("state IN ('pending', 'running', 'unknown')");
    const clause = where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "";
    const query = this.#database.query(`SELECT * FROM team_jobs${clause} ORDER BY updated_at DESC, id DESC LIMIT ${MAX_TEAM_JOBS}`);
    const rows = (options.owner ? query.all({ owner: options.owner }) : query.all()) as SqlRow[];
    return rows
      .map(teamJobFromRow);
  }

  job(id: string): TeamJob | null { return this.#jobById(requireJobId(id)); }

  /** Called by the runtime when observation stops, never by read-only clients. */
  markJobsUnknown(owner?: AgentId): void {
    const query = this.#database.query("UPDATE team_jobs SET state = 'unknown' WHERE state IN ('pending', 'running')" +
      (owner ? " AND owner = $owner" : ""));
    if (owner) query.run({ owner });
    else query.run();
  }


  /** Pending wakes plus the most recently settled ones. */
  wakes(): readonly TeamWake[] {
    const rows = this.#database
      .query(`
        SELECT * FROM wakes WHERE state = 'pending'
        UNION ALL
        SELECT * FROM (SELECT * FROM wakes WHERE state != 'pending' ORDER BY id DESC LIMIT $limit)
        ORDER BY id
      `)
      .all({ limit: MAX_WAKE_HISTORY }) as SqlRow[];
    return rows.map(wakeFromRow);
  }

  goalParticipants(goalId: string): readonly GoalParticipant[] {
    const rows = this.#database
      .query("SELECT * FROM goal_participants WHERE goal_id = $goalId ORDER BY agent")
      .all({ goalId }) as SqlRow[];
    return rows.map((row) => ({
      goalId: asString(row.goal_id),
      agent: asString(row.agent) as AgentId,
      stance: asString(row.stance) as GoalStance,
      completionEvidence: asNullableString(row.completion_evidence),
      updatedAt: asNumber(row.updated_at),
    }));
  }

  /** Returns the new row id so a streaming event can keep rewriting one row. */
  persistAgentEvent(event: AgentEvent): number {
    const payload = event.payload === undefined ? null : JSON.stringify(redactUnknown(event.payload));
    const row = this.#database
      .query(`
        INSERT INTO events(agent, type, summary, provider_event_id, payload_json, created_at)
        VALUES ($agent, $type, $summary, $providerEventId, $payload, $createdAt)
        RETURNING id
      `)
      .get({
        agent: event.agent,
        type: event.kind,
        summary: redactSummary(event.summary),
        providerEventId: event.providerEventId ?? null,
        payload,
        createdAt: event.timestamp,
      }) as { id: number } | null;
    if (!row) {
      throw new Error("event insert did not return a row id");
    }
    return row.id;
  }

  /** Rewrites a row that a provider is still streaming into. A finished unit of
   * work also changes type, so the transcript can show that it completed. */
  updateAgentEvent(
    id: number,
    summary: string,
    options: { readonly payload?: unknown; readonly type?: string } = {},
  ): void {
    const payload = options.payload === undefined ? null : JSON.stringify(redactUnknown(options.payload));
    this.#database
      .query(`
        UPDATE events
        SET summary = $summary,
            payload_json = CASE WHEN $payload IS NULL THEN payload_json ELSE $payload END,
            type = COALESCE($type, type)
        WHERE id = $id
      `)
      .run({
        id,
        summary: redactSummary(summary),
        payload,
        type: options.type ?? null,
      });
  }

  event(id: number): import("./types.ts").PersistedEvent | null {
    const row = this.#database.query("SELECT * FROM events WHERE id = $id").get({ id }) as SqlRow | null;
    return row ? persistedEventFromRow(row) : null;
  }

  findActivityByProvider(agent: AgentId, providerEventId: string): ActivityRecord | null {
    return this.#activities.findByProvider(agent, providerEventId);
  }

  activityRecord(id: string): ActivityRecord | null {
    return this.#activities.record(id);
  }

  activityRecords(): readonly ActivityRecord[] {
    return this.#activities.records();
  }

  activitySummaries(): readonly ActivitySummary[] {
    return this.#activities.summaries();
  }

  activityDetail(id: string): ActivityDetail | null {
    return this.#activities.detail(id);
  }

  #pruneJobs(): void {
    this.#database.exec(`DELETE FROM team_jobs WHERE state IN ('succeeded', 'failed', 'cancelled')
      AND id NOT IN (SELECT id FROM team_jobs WHERE state IN ('succeeded', 'failed', 'cancelled')
                    ORDER BY updated_at DESC, id DESC LIMIT ${MAX_JOB_HISTORY})`);
  }

  #jobById(id: string): TeamJob | null {
    const row = this.#database.query("SELECT * FROM team_jobs WHERE id = $id").get({ id }) as SqlRow | null;
    return row ? teamJobFromRow(row) : null;
  }

  saveActivity(record: ActivityRecord): void {
    this.#activities.save(record);
  }

  activeGoal(): TeamGoal | null {
    const row = this.#database
      .query("SELECT * FROM goals WHERE state = 'active' ORDER BY created_at DESC LIMIT 1")
      .get() as SqlRow | null;
    return row ? goalFromRow(row) : null;
  }

  agents(): readonly TeamAgent[] {
    this.#agentsCache ??= (
      this.#database.query("SELECT * FROM agents WHERE configured = 1 ORDER BY id").all() as SqlRow[]
    ).map(agentFromRow);
    return this.#agentsCache;
  }

  claims(goalId?: string): readonly TeamClaim[] {
    const rows = (goalId
      ? this.#database.query("SELECT * FROM claims WHERE goal_id = $goalId ORDER BY created_at").all({ goalId })
      : this.#database.query("SELECT * FROM claims ORDER BY created_at").all()) as SqlRow[];
    return rows.map(claimFromRow);
  }

  /**
   * The team state clients render.
   *
   * The live snapshot keeps the most recent messages and events so every
   * broadcast stays bounded. `full` is for the chat archive, which must keep a
   * long chat whole instead of only its last few hundred rows.
   */
  snapshot(options: { readonly full?: boolean } = {}): TeamSnapshot {
    const messages = (options.full
      ? this.#database.query("SELECT * FROM messages ORDER BY id DESC").all()
      : this.#database
        .query("SELECT * FROM messages ORDER BY id DESC LIMIT $limit")
        .all({ limit: MAX_MESSAGE_HISTORY })) as SqlRow[];
    const events = (options.full
      ? this.#database.query("SELECT * FROM events ORDER BY id DESC").all()
      : this.#database
        .query("SELECT * FROM events ORDER BY id DESC LIMIT $limit")
        .all({ limit: MAX_EVENT_HISTORY })) as SqlRow[];
    const todos = this.todos();
    const wakes = this.wakes();
    const jobs = this.jobs();
    const goals = options.full ? this.goals() : undefined;
    return {
      schemaVersion: 2,
      agents: this.agents(),
      activeGoal: this.activeGoal(),
      ...(goals ? { goals } : {}),
      messages: this.#messagesFromRows(messages.reverse()),
      claims: this.claims(),
      findings: this.findings(),
      events: events.reverse().map(persistedEventFromRow),
      activities: this.#activities.summaries(),
      ...(todos.length > 0 ? { todos } : {}),
      ...(wakes.length > 0 ? { wakes } : {}),
      ...(jobs.length > 0 ? { jobs } : {}),
    };
  }

  /** Full goal history for portable archives; live snapshots use activeGoal. */
  goals(): readonly TeamGoal[] {
    return (this.#database.query("SELECT * FROM goals ORDER BY created_at").all() as SqlRow[]).map(goalFromRow);
  }

  /**
   * Builds messages with their recipients from one query.
   *
   * Reading recipients per message cost one query for each of the hundreds of
   * messages in every snapshot, and snapshots are built on each state change.
   */
  #messagesFromRows(rows: readonly SqlRow[]): TeamMessage[] {
    if (rows.length === 0) return [];
    let low = Number.POSITIVE_INFINITY;
    let high = 0;
    for (const row of rows) {
      const id = asNumber(row.id);
      if (id < low) low = id;
      if (id > high) high = id;
    }
    const recipients = new Map<number, AgentId[]>();
    const lookup = this.#database
      .query(`
        SELECT message_id, recipient FROM message_recipients
        WHERE message_id BETWEEN $low AND $high
        ORDER BY message_id, recipient
      `)
      .all({ low, high }) as SqlRow[];
    for (const row of lookup) {
      const id = asNumber(row.message_id);
      const recipient = asString(row.recipient) as AgentId;
      const list = recipients.get(id);
      if (list) list.push(recipient);
      else recipients.set(id, [recipient]);
    }
    return rows.map((row) => messageFromRow(row, recipients.get(asNumber(row.id)) ?? []));
  }

  #messageById(id: number): TeamMessage | null {
    const row = this.#database.query("SELECT * FROM messages WHERE id = $id").get({ id }) as SqlRow | null;
    return row ? this.#messagesFromRows([row])[0] ?? null : null;
  }

  #claimById(id: string): TeamClaim | null {
    const row = this.#database.query("SELECT * FROM claims WHERE id = $id").get({ id }) as SqlRow | null;
    return row ? claimFromRow(row) : null;
  }

  #findingById(id: string): TeamFinding | null {
    const row = this.#database.query("SELECT * FROM findings WHERE id = $id").get({ id }) as SqlRow | null;
    return row ? withVerdicts(findingFromRow(row), this.#verdictsByFinding(id).get(id)) : null;
  }

  #todoById(id: number): TeamTodo | null {
    const row = this.#database.query("SELECT * FROM todos WHERE id = $id").get({ id }) as SqlRow | null;
    return row ? todoFromRow(row) : null;
  }

  #wakeById(id: number): TeamWake | null {
    const row = this.#database.query("SELECT * FROM wakes WHERE id = $id").get({ id }) as SqlRow | null;
    return row ? wakeFromRow(row) : null;
  }

  #requireConfiguredAgent(id: AgentId, label: string): void {
    if (!this.agents().some((agent) => agent.id === id)) {
      throw new Error(`${label} is not in the Watari roster: ${id}`);
    }
  }

  #migrate(): void {
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS agents(
        id TEXT PRIMARY KEY,
        backend TEXT NOT NULL,
        display_name TEXT NOT NULL,
        provider TEXT NOT NULL DEFAULT 'unknown',
        model TEXT,
        effort TEXT,
        mode TEXT NOT NULL DEFAULT 'managed',
        unrestricted INTEGER NOT NULL DEFAULT 0,
        configured INTEGER NOT NULL DEFAULT 1,
        session_id TEXT,
        state TEXT NOT NULL,
        current_goal_id TEXT,
        detail TEXT,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS goals(
        id TEXT PRIMARY KEY,
        instruction TEXT NOT NULL,
        origin TEXT NOT NULL,
        initial_addressee TEXT,
        state TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS goal_participants(
        goal_id TEXT NOT NULL REFERENCES goals(id),
        agent TEXT NOT NULL REFERENCES agents(id),
        stance TEXT NOT NULL,
        completion_evidence TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(goal_id, agent)
      );
      CREATE TABLE IF NOT EXISTS messages(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        goal_id TEXT REFERENCES goals(id),
        sender TEXT NOT NULL,
        kind TEXT NOT NULL,
        priority TEXT NOT NULL,
        priority_reason TEXT,
        body TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS message_recipients(
        message_id INTEGER NOT NULL REFERENCES messages(id),
        recipient TEXT NOT NULL REFERENCES agents(id),
        delivered_at INTEGER,
        acknowledged_at INTEGER,
        PRIMARY KEY(message_id, recipient)
      );
      CREATE TABLE IF NOT EXISTS claims(
        id TEXT PRIMARY KEY,
        goal_id TEXT NOT NULL REFERENCES goals(id),
        claimant TEXT NOT NULL REFERENCES agents(id),
        summary TEXT NOT NULL,
        paths_json TEXT,
        state TEXT NOT NULL,
        note TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS findings(
        id TEXT PRIMARY KEY,
        author TEXT NOT NULL REFERENCES agents(id),
        target TEXT REFERENCES agents(id),
        scope TEXT,
        severity TEXT NOT NULL,
        summary TEXT NOT NULL,
        evidence TEXT,
        disposition TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS finding_verdicts(
        finding_id TEXT NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
        reviewer TEXT NOT NULL REFERENCES agents(id),
        verdict TEXT NOT NULL,
        evidence TEXT,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(finding_id, reviewer)
      );
      CREATE TABLE IF NOT EXISTS events(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent TEXT,
        type TEXT NOT NULL,
        summary TEXT,
        provider_event_id TEXT,
        payload_json TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS todos(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        goal_id TEXT,
        title TEXT NOT NULL,
        detail TEXT,
        author TEXT NOT NULL,
        assignee TEXT REFERENCES agents(id),
        paths_json TEXT NOT NULL DEFAULT '[]',
        state TEXT NOT NULL,
        note TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS wakes(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent TEXT NOT NULL REFERENCES agents(id),
        condition_json TEXT NOT NULL,
        note TEXT NOT NULL,
        state TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        deadline_at INTEGER NOT NULL,
        settled_at INTEGER,
        outcome TEXT
      );
      CREATE TABLE IF NOT EXISTS handoffs(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id TEXT NOT NULL,
        agent TEXT NOT NULL,
        source TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS team_jobs(
        id TEXT PRIMARY KEY,
        owner TEXT NOT NULL REFERENCES agents(id),
        source TEXT NOT NULL,
        title TEXT NOT NULL,
        resources_json TEXT NOT NULL,
        state TEXT NOT NULL,
        handle TEXT,
        result TEXT,
        note TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_goal ON messages(goal_id, id);
      CREATE INDEX IF NOT EXISTS idx_recipients_agent ON message_recipients(recipient, message_id);
      CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at, id);
      CREATE INDEX IF NOT EXISTS idx_wakes_state ON wakes(state, id);
      CREATE INDEX IF NOT EXISTS idx_team_jobs_state ON team_jobs(state, updated_at);
    `);
    this.#ensureColumn("events", "provider_event_id", "TEXT");
    this.#ensureColumn("messages", "priority_reason", "TEXT");
    this.#ensureColumn("messages", "reply_to", "INTEGER");
    this.#ensureColumn("messages", "expects_reply", "INTEGER NOT NULL DEFAULT 0");
    this.#ensureColumn("messages", "delivery", "TEXT NOT NULL DEFAULT 'normal'");
    this.#ensureColumn("messages", "topic", "TEXT");
    this.#ensureColumn("message_recipients", "replied_at", "INTEGER");
    this.#ensureColumn("message_recipients", "nudged_at", "INTEGER");
    this.#ensureColumn("message_recipients", "escalated_at", "INTEGER");
    this.#ensureColumn("agents", "provider", "TEXT NOT NULL DEFAULT 'unknown'");
    this.#ensureColumn("agents", "model", "TEXT");
    this.#ensureColumn("agents", "effort", "TEXT");
    this.#ensureColumn("agents", "mode", "TEXT NOT NULL DEFAULT 'managed'");
    this.#ensureColumn("agents", "unrestricted", "INTEGER NOT NULL DEFAULT 0");
    this.#ensureColumn("agents", "configured", "INTEGER NOT NULL DEFAULT 1");
    this.#ensureColumn("agents", "availability", "TEXT NOT NULL DEFAULT 'open'");
    this.#ensureColumn("agents", "availability_reason", "TEXT");
    this.#ensureColumn("agents", "availability_until", "INTEGER");
    this.#compactStreamedEvents();
  }

  /**
   * Folds a pre-existing database's per-fragment rows back into one row per
   * message.
   *
   * Earlier builds persisted every streamed delta as its own event, so a
   * database written by one of them holds a transcript of single words. New
   * writes are already coalesced. This repairs what is on disk so an existing
   * project does not stay unreadable after the upgrade. It runs once, guarded
   * by the schema version, and only touches assistant and reasoning rows that
   * carry a provider identifier.
   */
  #compactStreamedEvents(): void {
    const version = databaseVersion(this.#database);
    if (version >= COMPACTED_STREAM_VERSION) {
      return;
    }
    const groups = this.#database
      .query(`
        SELECT agent, type, provider_event_id AS providerEventId
        FROM events
        WHERE type IN ('assistant', 'reasoning') AND provider_event_id IS NOT NULL
        GROUP BY agent, type, provider_event_id
        HAVING COUNT(*) > 1
      `)
      .all() as SqlRow[];

    this.#database.transaction(() => {
      for (const group of groups) {
        const rows = this.#database
          .query(`
            SELECT id, summary FROM events
            WHERE type = $type AND provider_event_id = $providerEventId
              AND agent IS $agent
            ORDER BY id
          `)
          .all({
            type: asString(group.type),
            providerEventId: asString(group.providerEventId),
            agent: asNullableString(group.agent),
          }) as SqlRow[];
        const first = rows[0];
        if (!first) continue;
        const merged = rows
          .map((row) => asNullableString(row.summary) ?? "")
          .filter((summary) => !LEGACY_ITEM_MARKER.test(summary))
          .join("");
        const survivors = merged.trim() === "" ? [] : [asNumber(first.id)];
        if (survivors.length > 0) {
          this.#database
            .query("UPDATE events SET summary = $summary WHERE id = $id")
            .run({ id: asNumber(first.id), summary: merged });
        }
        for (const row of rows) {
          const id = asNumber(row.id);
          if (survivors.includes(id)) continue;
          this.#database.query("DELETE FROM events WHERE id = $id").run({ id });
        }
      }
      this.#removeDuplicateClaudeBlocks();
    })();
    this.#database.exec(`PRAGMA user_version = ${COMPACTED_STREAM_VERSION}`);
  }

  /** Claude can close two content-block indices with identical text under one
   * message id. Exact-id compaction cannot see that `msg#0` and `msg#1` were the
   * same statement. This removes the later duplicate and any empty speech row
   * left by a redacted thinking block, including rows written after version 2. */
  #removeDuplicateClaudeBlocks(): void {
    const rows = this.#database
      .query(`
        SELECT id, agent, type, summary, provider_event_id AS providerEventId
        FROM events
        WHERE type IN ('assistant', 'reasoning')
        ORDER BY id
      `)
      .all() as SqlRow[];
    const previousByScope = new Map<
      string,
      { readonly message: string; readonly summary: string }
    >();
    for (const row of rows) {
      const id = asNumber(row.id);
      const summary = asNullableString(row.summary) ?? "";
      if (summary.trim() === "") {
        this.#database.query("DELETE FROM events WHERE id = $id").run({ id });
        continue;
      }
      const providerEventId = asNullableString(row.providerEventId);
      const match = providerEventId ? /^(?<message>.+)#\d+$/u.exec(providerEventId) : null;
      const message = match?.groups?.message;
      if (!message) continue;
      const scope = `${asNullableString(row.agent) ?? "watari"}\u0000${asString(row.type)}`;
      const previous = previousByScope.get(scope);
      if (previous?.message === message && previous.summary === summary) {
        this.#database.query("DELETE FROM events WHERE id = $id").run({ id });
      } else {
        previousByScope.set(scope, { message, summary });
      }
    }
  }

  #ensureColumn(table: string, column: string, declaration: string): void {
    const columns = this.#database.query(`PRAGMA table_info(${table})`).all() as SqlRow[];
    if (!columns.some((entry) => entry.name === column)) {
      this.#database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
    }
  }
}

function agentFromRow(row: SqlRow): TeamAgent {
  const agent: TeamAgent = {
    id: asString(row.id) as AgentId,
    backend: asString(row.backend),
    displayName: asString(row.display_name),
    provider: asString(row.provider),
    model: asNullableString(row.model),
    effort: asNullableString(row.effort),
    mode: asString(row.mode) === "external" ? "external" : "managed",
    unrestricted: asNumber(row.unrestricted) !== 0,
    sessionId: asNullableString(row.session_id),
    state: asString(row.state) as AgentRuntimeState,
    currentGoalId: asNullableString(row.current_goal_id),
    detail: asNullableString(row.detail),
    updatedAt: asNumber(row.updated_at),
  };
  // Open is the default and is left out, so the snapshot every client receives
  // carries availability only for the peers that asked not to be disturbed.
  if (row.availability !== "dnd") return agent;
  return {
    ...agent,
    availability: "dnd",
    availabilityReason: asNullableString(row.availability_reason),
    availabilityUntil: asNullableNumber(row.availability_until),
  };
}

function goalFromRow(row: SqlRow): TeamGoal {
  return {
    id: asString(row.id),
    instruction: asString(row.instruction),
    origin: asString(row.origin),
    initialAddressee: asNullableString(row.initial_addressee) as AgentId | null,
    state: asString(row.state) as TeamGoal["state"],
    createdAt: asNumber(row.created_at),
    updatedAt: asNumber(row.updated_at),
  };
}

function messageFromRow(row: SqlRow, recipients: readonly AgentId[]): TeamMessage {
  const replyTo = asNullableNumber(row.reply_to);
  const delivery = row.delivery === "passive" || row.delivery === "direct"
    ? row.delivery as MessageDelivery
    : null;
  return {
    id: asNumber(row.id),
    goalId: asNullableString(row.goal_id),
    sender: asString(row.sender),
    recipients,
    kind: asString(row.kind) as MessageKind,
    priority: asString(row.priority) as MessagePriority,
    priorityReason: asNullableString(row.priority_reason),
    body: asString(row.body),
    createdAt: asNumber(row.created_at),
    // Defaults are left out, so a message only carries what makes it different.
    ...(replyTo !== null ? { replyTo } : {}),
    ...(asNullableNumber(row.expects_reply) ? { expectsReply: true } : {}),
    ...(delivery ? { delivery } : {}),
  };
}

function claimFromRow(row: SqlRow): TeamClaim {
  return {
    id: asString(row.id),
    goalId: asString(row.goal_id),
    claimant: asString(row.claimant) as AgentId,
    summary: asString(row.summary),
    paths: parsePaths(row.paths_json),
    state: asString(row.state) as ClaimState,
    note: asNullableString(row.note),
    createdAt: asNumber(row.created_at),
    updatedAt: asNumber(row.updated_at),
  };
}

function findingFromRow(row: SqlRow): TeamFinding {
  return {
    id: asString(row.id),
    author: asString(row.author) as AgentId,
    target: asNullableString(row.target) as AgentId | null,
    scope: asNullableString(row.scope),
    severity: asString(row.severity) as TeamFinding["severity"],
    summary: asString(row.summary),
    evidence: asNullableString(row.evidence),
    disposition: asString(row.disposition) as TeamFinding["disposition"],
    createdAt: asNumber(row.created_at),
    updatedAt: asNumber(row.updated_at),
  };
}

/** Verdicts are optional on the wire, so a finding nobody checked carries none. */
function withVerdicts(finding: TeamFinding, verdicts: readonly FindingVerdict[] | undefined): TeamFinding {
  return verdicts && verdicts.length > 0 ? { ...finding, verdicts } : finding;
}

function todoFromRow(row: SqlRow): TeamTodo {
  return {
    id: asNumber(row.id),
    goalId: asNullableString(row.goal_id),
    title: asString(row.title),
    detail: asNullableString(row.detail),
    author: asString(row.author),
    assignee: asNullableString(row.assignee) as AgentId | null,
    paths: parsePaths(row.paths_json),
    state: asString(row.state) as TodoState,
    note: asNullableString(row.note),
    createdAt: asNumber(row.created_at),
    updatedAt: asNumber(row.updated_at),
  };
}

function wakeFromRow(row: SqlRow): TeamWake {
  return {
    id: asNumber(row.id),
    agent: asString(row.agent) as AgentId,
    condition: JSON.parse(asString(row.condition_json)) as WakeCondition,
    note: asString(row.note),
    state: asString(row.state) as WakeState,
    createdAt: asNumber(row.created_at),
    deadlineAt: asNumber(row.deadline_at),
    settledAt: asNullableNumber(row.settled_at),
    outcome: asNullableString(row.outcome),
  };
}

function teamJobFromRow(row: SqlRow): TeamJob {
  const resources = parsePaths(row.resources_json);
  if (resources.length === 0) throw new Error(`job ${asString(row.id)} has no resources`);
  return {
    id: asString(row.id),
    owner: asString(row.owner) as AgentId,
    source: asString(row.source),
    title: asString(row.title),
    resources,
    state: asString(row.state) as TeamJobState,
    handle: asNullableString(row.handle),
    result: asNullableString(row.result),
    note: asNullableString(row.note),
    createdAt: asNumber(row.created_at),
    updatedAt: asNumber(row.updated_at),
  };
}

function persistedEventFromRow(row: SqlRow): import("./types.ts").PersistedEvent {
  return {
    id: asNumber(row.id),
    agent: asNullableString(row.agent) as AgentId | null,
    type: asString(row.type),
    summary: asNullableString(row.summary) ?? "",
    providerEventId: asNullableString(row.provider_event_id),
    createdAt: asNumber(row.created_at),
  };
}

function parsePaths(value: unknown): readonly string[] {
  const parsed = JSON.parse(asNullableString(value) ?? "[]") as unknown;
  return Array.isArray(parsed) ? parsed.filter((path): path is string => typeof path === "string") : [];
}

function databaseVersion(database: Database): number {
  return (database.query("PRAGMA user_version").get() as { user_version?: number } | null)?.user_version ?? 0;
}

function uniqueAgents(values: readonly AgentId[]): AgentId[] {
  return [...new Set(values.map((value) => requireIdentity(value, "agent") as AgentId))];
}

function requireIdentity(value: string, label: string): string {
  const normalized = value.trim();
  if (!AGENT_ALIAS_PATTERN.test(normalized)) {
    throw new Error(`${label} must be a valid Watari agent identity`);
  }
  return normalized;
}

function requireText(value: string, label: string, maxLength: number): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${label} must not be empty`);
  }
  if (normalized.length > maxLength) {
    throw new Error(`${label} exceeds ${maxLength} characters`);
  }
  return redactSummary(normalized);
}

/**
 * A status detail, which comes from provider text rather than from a tool
 * call. It is clipped, never refused: throwing here ran inside the event loop
 * and turned one long provider error into a peer marked failed for the wrong
 * reason.
 */
function boundedDetail(value: string | null): string | null {
  const text = value?.trim();
  if (!text) return null;
  const redacted = redactSummary(text);
  return redacted.length > MAX_SUMMARY_CHARS ? `${redacted.slice(0, MAX_SUMMARY_CHARS - 1)}…` : redacted;
}

function sanitizeOptional(value: string | null | undefined, maxLength: number): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  return requireText(value, "text", maxLength);
}

function normalizePaths(paths: readonly string[]): string[] {
  if (paths.length > 100) {
    throw new Error("claim contains too many paths");
  }
  return [...new Set(paths.map((path) => {
    const normalized = path.trim().replaceAll("\\", "/").replace(/^\.[/]/u, "");
    if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..")) {
      throw new Error(`claim path must be repository-relative: ${path}`);
    }
    return normalized;
  }))];
}

function normalizeJobResources(resources: readonly string[]): string[] {
  if (!Array.isArray(resources) || resources.length === 0) {
    throw new Error("a job needs at least one resource identity");
  }
  if (resources.length > 64) throw new Error("a job may reserve at most 64 resources");
  return [...new Set(resources.map((resource) => {
    if (typeof resource !== "string" || resource.includes("\0")) {
      throw new Error("job resource identities must be nonempty strings without NUL");
    }
    const normalized = resource.trim();
    if (!normalized) throw new Error("job resource identities must be nonempty");
    if (normalized.length > MAX_JOB_RESOURCE_CHARS) {
      throw new Error(`job resource exceeds ${MAX_JOB_RESOURCE_CHARS} characters`);
    }
    return normalized;
  }))];
}

function requireJobId(value: string): string {
  if (typeof value !== "string" || !/^job_[a-f0-9]{24}$/u.test(value)) {
    throw new Error("job_id must be a Watari job id");
  }
  return value;
}

export function pathsOverlap(left: readonly string[], right: readonly string[]): boolean {
  return left.some((leftPath) => right.some((rightPath) => pathOverlaps(leftPath, rightPath)));
}

function pathOverlaps(left: string, right: string): boolean {
  const leftRoot = left.replace(/\/\*\*.*$/u, "").replace(/\/\*.*$/u, "").replace(/\/$/u, "");
  const rightRoot = right.replace(/\/\*\*.*$/u, "").replace(/\/\*.*$/u, "").replace(/\/$/u, "");
  return leftRoot === rightRoot || leftRoot.startsWith(`${rightRoot}/`) || rightRoot.startsWith(`${leftRoot}/`);
}

function isOpenClaim(state: ClaimState): boolean {
  return state === "proposed" || state === "active" || state === "contested";
}

function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
}

function asString(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("invalid persisted string value");
  }
  return value;
}

function asNullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : asString(value);
}

function asNumber(value: unknown): number {
  if (typeof value !== "number" && typeof value !== "bigint") {
    throw new Error("invalid persisted numeric value");
  }
  return Number(value);
}

function asNullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : asNumber(value);
}

function required<T>(value: T | null, message: string): T {
  if (value === null) {
    throw new Error(message);
  }
  return value;
}

function isActiveJob(state: TeamJobState): boolean {
  return state === "pending" || state === "running" || state === "unknown";
}
