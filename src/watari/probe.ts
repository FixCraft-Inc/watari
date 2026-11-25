import type { AgentAdapter, AgentEvent, ProbeReport, ProjectContext } from "./models.ts";
import { resolveExecutable } from "./project/checkout.ts";
import { createProviderAdapter, providerExecutableOverride } from "./service/provider-adapters.ts";
import type { SupportedProviderId } from "./team/roster.ts";

const LIVE_PROBE_PROMPT =
  "Reply with exactly WATARI_PROBE_OK. Do not use tools, inspect files, or modify anything.";
const LIVE_PROBE_TIMEOUT_MS = 90_000;

export async function runProbe(options: {
  readonly adapter: SupportedProviderId;
  readonly project: ProjectContext;
  readonly live: boolean;
}): Promise<ProbeReport> {
  const executable = resolveExecutable(
    options.adapter,
    providerExecutableOverride(options.adapter),
  );
  if (!executable) {
    throw new Error(`${options.adapter} executable was not found`);
  }
  // A live probe sends one prompt, so its harness gets the read-only posture.
  const adapter = createProviderAdapter(options.adapter, { executable, readOnlyProbe: options.live });
  const events: AgentEvent[] = [];
  let collector: Promise<void> | null = null;
  try {
    await adapter.start(options.project);
    if (options.live) {
      collector = collectUntilTurnComplete(adapter, events);
      await adapter.send({ kind: "message", text: LIVE_PROBE_PROMPT });
      await collector;
    }
  } finally {
    await adapter.stop().catch(() => undefined);
    if (!collector) {
      for await (const event of adapter.events()) {
        events.push(event);
      }
    }
  }
  const failed = events.some((event) => event.kind === "error");
  return {
    schemaVersion: 1,
    command: "probe",
    adapter: options.adapter,
    mode: options.live ? "live" : "handshake",
    project: options.project,
    capabilities: adapter.capabilities(),
    events,
    ...sessionId(adapter),
    ok: !failed,
    ...(!options.live
      ? { limitation: "No model turn was made; response generation is unverified." }
      : {}),
  };
}

async function collectUntilTurnComplete(
  adapter: AgentAdapter,
  events: AgentEvent[],
): Promise<void> {
  const timeoutAt = Date.now() + LIVE_PROBE_TIMEOUT_MS;
  const iterator = adapter.events()[Symbol.asyncIterator]();
  while (true) {
    const remainingMs = timeoutAt - Date.now();
    if (remainingMs <= 0) {
      throw new Error("Live probe timed out");
    }
    const next = await nextWithTimeout(iterator, remainingMs);
    if (next.done) {
      return;
    }
    const event = next.value;
    events.push(event);
    if (
      event.kind === "error" ||
      (event.kind === "status" && event.summary.includes("turn completed"))
    ) {
      return;
    }
  }
}

async function nextWithTimeout(
  iterator: AsyncIterator<AgentEvent>,
  timeoutMs: number,
): Promise<IteratorResult<AgentEvent>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Live probe timed out")), timeoutMs);
  });
  try {
    return await Promise.race([iterator.next(), timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function sessionId(adapter: AgentAdapter): { sessionId?: string } {
  return adapter.sessionId ? { sessionId: adapter.sessionId } : {};
}
