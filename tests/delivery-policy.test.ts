import { describe, expect, test } from "bun:test";

import {
  forecastDelivery,
  selectDeliverable,
  type DeliveryBoundary,
} from "../src/watari/service/delivery-policy.ts";
import type { TeamMessage } from "../src/watari/state/types.ts";

function message(id: number, overrides: Partial<TeamMessage> = {}): TeamMessage {
  return {
    id,
    goalId: null,
    sender: "codex",
    recipients: ["claude"],
    kind: "peer",
    priority: "normal",
    priorityReason: null,
    body: `message ${id}`,
    createdAt: id,
    ...overrides,
  };
}

function ids(pending: readonly TeamMessage[], boundary: DeliveryBoundary, dnd: boolean): number[] {
  return selectDeliverable(pending, { boundary, dnd }).map((entry) => entry.id);
}

const urgent = { priority: "urgent", priorityReason: "must go first" } as const;
const stop = { priority: "stop", priorityReason: "continuing is unsafe" } as const;

describe("choosing what a peer receives", () => {
  test("everything waiting goes as one batch when nothing outranks it", () => {
    expect(ids([message(1), message(2)], "tool", false)).toEqual([1, 2]);
    expect(ids([message(1), message(2)], "idle", false)).toEqual([1, 2]);
  });

  test("a pile of mail goes as one batch, stop first, then urgent, then the rest", () => {
    const pending = [message(1), message(2, urgent), message(3, stop), message(4, urgent), message(5)];
    expect(ids(pending, "tool", false)).toEqual([3, 2, 4, 1, 5]);
    expect(ids(pending.slice(0, 2), "tool", false)).toEqual([2, 1]);
  });

  test("a passive notice never starts a turn by itself but rides along with mail that does", () => {
    const notice = message(1, { sender: "watari", delivery: "passive" });
    expect(ids([notice], "idle", false)).toEqual([]);
    expect(ids([notice], "tool", false)).toEqual([1]);
    expect(ids([notice, message(2)], "idle", false)).toEqual([1, 2]);
  });

  test("inside a turn, do-not-disturb holds everything except stop", () => {
    const pending = [message(1), message(2, urgent), message(3, { sender: "watari", delivery: "direct" })];
    expect(ids(pending, "tool", true)).toEqual([]);
    expect(ids([...pending, message(4, stop)], "tool", true)).toEqual([4]);
  });

  test("between turns, do-not-disturb lets through urgent mail and the peer's own notices only", () => {
    expect(ids([message(1)], "idle", true)).toEqual([]);
    expect(ids([message(1), message(2, { sender: "watari", delivery: "direct" })], "idle", true)).toEqual([2]);
    expect(ids([message(1), message(2, urgent)], "idle", true)).toEqual([2]);
  });
});

describe("telling a sender when its message will be read", () => {
  const base = {
    external: false,
    state: "ready",
    midTurn: true,
    dnd: false,
    priority: "normal",
  } as const;

  test("follows the recipient's state and how its harness takes mail", () => {
    expect(forecastDelivery(base)).toBe("now");
    expect(forecastDelivery({ ...base, state: "busy" })).toBe("next_boundary");
    expect(forecastDelivery({ ...base, state: "busy", midTurn: false })).toBe("after_turn");
    expect(forecastDelivery({ ...base, external: true })).toBe("inbox");
    expect(forecastDelivery({ ...base, state: "failed" })).toBe("offline");
  });

  test("names do-not-disturb, and does not let it hold stop", () => {
    expect(forecastDelivery({ ...base, dnd: true })).toBe("held_dnd");
    expect(forecastDelivery({ ...base, dnd: true, state: "busy", priority: "urgent" })).toBe("after_turn");
    expect(forecastDelivery({ ...base, dnd: true, priority: "urgent" })).toBe("now");
    expect(forecastDelivery({ ...base, dnd: true, state: "busy", priority: "stop" })).toBe("next_boundary");
  });
});
