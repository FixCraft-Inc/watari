import type { AgentEvent, AgentId } from "../models.ts";
import { AsyncQueue } from "./async-queue.ts";

export function createAgentEventQueue(agent: AgentId): AsyncQueue<AgentEvent> {
  return new AsyncQueue<AgentEvent>({
    capacity: 4_096,
    overflowValue: (droppedCount) => ({
      agent,
      kind: "warning",
      timestamp: Date.now(),
      summary: `Event queue overflow; at least ${droppedCount} older events were dropped`,
      rawType: "queue_overflow",
    }),
  });
}
