import type { AgentRuntimeState, MessagePriority, TeamMessage } from "../state/types.ts";

/**
 * Where a peer is when Watari considers handing it mail.
 *
 * `tool` is inside a turn, just after a tool call finished, where the harness
 * folds new input into the turn it is already running. `idle` is between
 * turns, where any delivery starts a new model turn and so costs a paid turn.
 */
export type DeliveryBoundary = "idle" | "tool";

export interface DeliveryContext {
  readonly boundary: DeliveryBoundary;
  /** The peer asked not to be steered. */
  readonly dnd: boolean;
}

/**
 * Chooses what one peer receives at one boundary.
 *
 * Stop is never held. Do-not-disturb suspends steering inside a turn entirely,
 * and between turns lets through only urgent mail and the peer's own wakeups
 * and reply reminders. Passive notices never pay for a turn on their own. They
 * wait for a boundary the peer reaches anyway, or ride along with mail that
 * does start one. Everything that remains goes as one batch, stop first, then
 * urgent, then the rest in arrival order, so a turn is steered once per
 * boundary however much mail piled up.
 */
export function selectDeliverable(
  pending: readonly TeamMessage[],
  context: DeliveryContext,
): TeamMessage[] {
  const allowed = pending.filter((message) => {
    if (message.priority === "stop") return true;
    if (!context.dnd) return true;
    if (context.boundary === "tool") return false;
    return message.priority === "urgent" || message.delivery === "direct";
  });
  if (context.boundary === "idle" && allowed.every((message) => message.delivery === "passive")) {
    return [];
  }
  return [
    ...allowed.filter((message) => message.priority === "stop"),
    ...allowed.filter((message) => message.priority === "urgent"),
    ...allowed.filter((message) => message.priority === "normal"),
  ];
}

/**
 * What a sender is told about when its message will be read.
 *
 * A sender that cannot see whether its peer received anything re-sends, raises
 * the priority, or waits on silence. The observed failure was a peer nudging
 * with urgent mail while the recipient was already working on the first
 * request.
 */
export type DeliveryForecast =
  /** The peer is idle and the message starts its turn now. */
  | "now"
  /** The peer is working and takes mail inside its turn. */
  | "next_boundary"
  /** The peer is working and only takes mail between turns. */
  | "after_turn"
  /** The peer is in do-not-disturb, and normal mail waits until that ends. */
  | "held_dnd"
  /** An external MCP peer reads its inbox itself. */
  | "inbox"
  | "offline";

export interface ForecastInput {
  readonly external: boolean;
  readonly state: AgentRuntimeState;
  /** The harness can take mail inside a turn. */
  readonly midTurn: boolean;
  readonly dnd: boolean;
  readonly priority: MessagePriority;
}

export function forecastDelivery(input: ForecastInput): DeliveryForecast {
  if (input.external) return "inbox";
  if (input.state === "failed" || input.state === "stopped" || input.state === "starting") {
    return "offline";
  }
  const working = input.state === "busy" || input.state === "waiting";
  // Stop interrupts first and is then handed over at the next boundary.
  if (input.priority === "stop") return working ? "next_boundary" : "now";
  if (input.dnd && input.priority === "normal") return "held_dnd";
  if (!working) return "now";
  if (input.dnd) return "after_turn";
  return input.midTurn ? "next_boundary" : "after_turn";
}
