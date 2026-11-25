import type { AgentId } from "../models.ts";
import type { TeamStore } from "../state/store.ts";
import type { ReplyObligation } from "../state/types.ts";
import {
  offlineQuestionNotice,
  replyReminderPrompt,
  unansweredNotice,
} from "../team/instructions.ts";

export interface TurnEndOutcome {
  /** A reminder was queued for the peer whose turn ended. */
  readonly reminded: boolean;
  /** One or more askers were told their question went unanswered. */
  readonly escalated: boolean;
}

/**
 * Keeps peers from going silent on each other's questions.
 *
 * A `team_send` with `expects_reply` puts an obligation on each recipient once
 * it is handed over. A peer that ends a turn still owing an answer is reminded
 * once. If it ends another turn still silent, or goes offline, the asker is
 * told so it stops waiting. Everything here is durable store state, so the
 * policy can be exercised without a live harness.
 */
export class ReplyTracker {
  readonly #store: TeamStore;
  readonly #isRostered: (id: string) => boolean;

  constructor(store: TeamStore, isRostered: (id: string) => boolean) {
    this.#store = store;
    this.#isRostered = isRostered;
  }

  /**
   * The one reminder a peer gets inside its turn, for a harness that can be
   * kept going before it ends one. Null when nothing is owed or it was already
   * reminded.
   */
  remindInTurn(agent: AgentId): string | null {
    const owed = this.#store.replyObligations(agent).filter((entry) => entry.nudgedAt === null);
    if (owed.length === 0) return null;
    this.#store.markNudged(agent, owed.map((entry) => entry.messageId));
    return replyReminderPrompt(owed);
  }

  /**
   * Settles what a finished turn leaves behind.
   *
   * Questions that were already reminded are escalated to their askers. The
   * rest get one reminder as a direct notice, unless the turn was interrupted,
   * because starting it again would undo the interrupt.
   */
  settleTurnEnd(agent: AgentId, options: { readonly interrupted: boolean }): TurnEndOutcome {
    const owed = this.#store.replyObligations(agent);
    if (owed.length === 0) return { reminded: false, escalated: false };
    const reminded = owed.filter((entry) => entry.nudgedAt !== null);
    const escalated = reminded.length > 0 && this.#escalate(agent, reminded);
    const unreminded = owed.filter((entry) => entry.nudgedAt === null);
    if (unreminded.length === 0 || options.interrupted) return { reminded: false, escalated };
    this.#store.addMessage({
      goalId: this.#goalId(),
      sender: "watari",
      recipients: [agent],
      kind: "system",
      delivery: "direct",
      body: replyReminderPrompt(unreminded),
    });
    this.#store.markNudged(agent, unreminded.map((entry) => entry.messageId));
    return { reminded: true, escalated };
  }

  /**
   * Tells every live asker that the peer it is waiting on went offline.
   *
   * An asker that ended its turn to wait would otherwise never learn that the
   * answer is not coming.
   */
  notifyOffline(agent: AgentId, detail: string, liveAskers: readonly AgentId[]): void {
    const unsettled = this.#store.unsettledQuestionsTo(agent);
    if (unsettled.length === 0) return;
    const goalId = this.#goalId();
    for (const [sender, entries] of groupBySender(unsettled)) {
      if (!liveAskers.includes(sender as AgentId)) continue;
      this.#store.addMessage({
        goalId,
        sender: "watari",
        recipients: [sender as AgentId],
        kind: "system",
        body: offlineQuestionNotice(agent, detail, entries.map((entry) => entry.messageId)),
      });
    }
    this.#store.markEscalated(agent, unsettled.map((entry) => entry.messageId));
  }

  #escalate(agent: AgentId, reminded: readonly ReplyObligation[]): boolean {
    const goalId = this.#goalId();
    let notified = false;
    for (const [sender, entries] of groupBySender(reminded)) {
      if (!this.#isRostered(sender)) continue;
      this.#store.addMessage({
        goalId,
        sender: "watari",
        recipients: [sender as AgentId],
        kind: "system",
        body: unansweredNotice(agent, entries.map((entry) => entry.messageId)),
      });
      notified = true;
    }
    this.#store.markEscalated(agent, reminded.map((entry) => entry.messageId));
    return notified;
  }

  #goalId(): string | null {
    return this.#store.activeGoal()?.id ?? null;
  }
}

function groupBySender(entries: readonly ReplyObligation[]): Map<string, ReplyObligation[]> {
  const groups = new Map<string, ReplyObligation[]>();
  for (const entry of entries) {
    const list = groups.get(entry.sender);
    if (list) list.push(entry);
    else groups.set(entry.sender, [entry]);
  }
  return groups;
}
