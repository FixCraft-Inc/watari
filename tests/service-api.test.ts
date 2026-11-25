import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RuntimeClient } from "../src/watari/service/client.ts";
import {
  SERVICE_API_VERSION,
  ServiceCommandSchema,
  ServiceEnvelopeSchema,
  TeamSnapshotSchema,
} from "../src/watari/service/protocol.ts";
import { WatariService } from "../src/watari/service/server.ts";
import type { RuntimeEvent } from "../src/watari/state/types.ts";
import { FakeAdapter } from "./fakes/fake-adapter.ts";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("local API v2", () => {
  test("requires version negotiation and rejects unsupported versions", async () => {
    const fixture = await serviceFixture("negotiate");
    const raw = await RawJsonlClient.connect(fixture.socketPath);
    cleanups.push(async () => raw.close());

    raw.send({ id: "before", type: "snapshot" });
    expect(await raw.next()).toMatchObject({
      type: "response",
      id: "before",
      ok: false,
      error: "API version negotiation is required first",
    });

    raw.send({ id: "wrong", type: "negotiate", versions: [1] });
    expect(await raw.next()).toMatchObject({ type: "response", id: "wrong", ok: false });

    raw.send({ id: "right", type: "negotiate", versions: [1, 2] });
    expect(await raw.next()).toEqual({ type: "response", id: "right", ok: true, value: { apiVersion: 2 } });
    expect(await raw.next()).toMatchObject({ type: "snapshot", snapshot: { schemaVersion: 2, activities: [] } });
  });

  test("validates commands and public envelopes with shared schemas", () => {
    expect(ServiceCommandSchema.safeParse({ id: "1", type: "activity_detail", activityId: "bad" }).success)
      .toBe(false);
    expect(ServiceCommandSchema.safeParse({ id: "1", type: "send", target: "bad alias", text: "hello" }).success)
      .toBe(false);
    expect(ServiceEnvelopeSchema.safeParse({ type: "activity_detail_changed", activityId: "bad", revision: 0 }).success)
      .toBe(false);
    expect(ServiceEnvelopeSchema.safeParse({ type: "raw_provider_event", payload: { secret: true } }).success)
      .toBe(false);
  });

  test("retrieves details lazily and deltas do not broadcast full state", async () => {
    const fixture = await serviceFixture("activity");
    const client = await RuntimeClient.connect(fixture.socketPath);
    cleanups.push(async () => client.close());
    await waitUntil(async () => (await client.refresh()).agents.every((agent) => agent.state === "ready"));
    const events: RuntimeEvent[] = [];
    client.subscribe((event) => events.push(event));
    await delay(80);
    events.length = 0;

    fixture.codex.emit("tool_start", "bash  printf output", {
      rawType: "item/started",
      providerEventId: "cmd-api",
      payload: { type: "commandExecution", command: "printf output", cwd: "/work", status: "running" },
    });
    await waitUntil(async () => events.some((event) => event.type === "activity_upsert"));
    const baselineStates = events.filter((event) => event.type === "state_changed").length;

    fixture.codex.emit("tool_output", "Codex command output", {
      rawType: "item/commandExecution/outputDelta",
      providerEventId: "cmd-api",
      payload: { itemId: "cmd-api", delta: "streamed output" },
    });
    await delay(140);

    const snapshot = client.snapshot!;
    const summary = snapshot.activities.find((activity) => activity.providerEventId === "cmd-api");
    expect(summary).toMatchObject({ kind: "command", state: "running", hasDetail: true });
    expect(JSON.stringify(summary)).not.toContain("streamed output");
    expect(events.filter((event) => event.type === "state_changed")).toHaveLength(baselineStates);
    expect(events.some((event) => event.type === "activity_detail_changed")).toBe(true);
    expect(await client.getActivityDetail(summary!.id)).toMatchObject({
      kind: "command",
      command: "printf output",
      stdout: "streamed output",
    });

    fixture.codex.emit("tool_end", "bash  printf output", {
      rawType: "item/completed",
      providerEventId: "cmd-api",
      payload: {
        type: "commandExecution",
        command: "printf output",
        cwd: "/work",
        status: "completed",
        aggregatedOutput: "final output",
        exitCode: 0,
      },
    });
    await waitUntil(async () => client.snapshot?.activities.find(
      (activity) => activity.providerEventId === "cmd-api",
    )?.state === "completed");
    expect(await client.getActivityDetail(summary!.id)).toMatchObject({ stdout: "final output", exitCode: 0 });
    expect(events.filter((event) => event.type === "state_changed")).toHaveLength(baselineStates);
  });
});

async function serviceFixture(label: string): Promise<{
  readonly socketPath: string;
  readonly codex: FakeAdapter;
}> {
  const directory = mkdtempSync(join(tmpdir(), `watari-api-${label}-`));
  const socketPath = join(directory, "runtime.sock");
  const codex = new FakeAdapter("codex");
  const service = new WatariService({
    project: { launchDirectory: directory, repositoryRoot: directory },
    databasePath: join(directory, "state.db"),
    socketPath,
    idleExitMs: false,
    adapters: { codex, claude: new FakeAdapter("claude") },
  });
  await service.start();
  cleanups.push(async () => {
    await service.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  return { socketPath, codex };
}

/**
 * The exact path a frontend outside this repository takes.
 *
 * Watari's own clients are Bun programs, so every other test reaches the socket
 * through `Bun.connect` and proves nothing about a VSCode extension, which runs
 * on Node in the editor's extension host. This connects with `node:net` and
 * speaks the wire protocol by hand: if the local API ever grows a dependency on
 * a Bun-only socket behaviour, this is what notices.
 */
describe("local API from a non-Bun client", () => {
  test("an actual Node process handles fragmented commands and interleaved replies", async () => {
    const fixture = await serviceFixture("nodenet");
    const child = Bun.spawn(["node", "-e", NODE_SOCKET_CLIENT, fixture.socketPath], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exitCode, stderr).toBe(0);
    const result = JSON.parse(stdout) as {
      readonly negotiation: unknown;
      readonly unsolicited: unknown;
      readonly snapshot: unknown;
    };
    expect(result.negotiation).toMatchObject({
      type: "response",
      id: "n1",
      ok: true,
      value: { apiVersion: SERVICE_API_VERSION },
    });
    expect(result.unsolicited).toMatchObject({ type: "snapshot" });
    expect(TeamSnapshotSchema.safeParse(result.snapshot).success).toBe(true);
  });
});

/**
 * Kept dependency-free so this proves the wire from a real Node process rather
 * than Bun's Node compatibility layer. The negotiate command is fragmented;
 * its remainder and the next command are coalesced into one write. Replies are
 * selected by id because the unsolicited snapshot may be interleaved.
 */
const NODE_SOCKET_CLIENT = String.raw`
const { connect } = require("node:net");
const socketPath = process.argv[1];
const socket = connect(socketPath);
socket.setEncoding("utf8");
let buffer = "";
const lines = [];
const timer = setTimeout(() => {
  process.stderr.write("node:net API response timed out\n");
  socket.destroy();
  process.exitCode = 1;
}, 2000);
socket.once("connect", () => {
  const negotiate = JSON.stringify({ id: "n1", type: "negotiate", versions: [2] }) + "\n";
  const snapshot = JSON.stringify({ id: "n2", type: "snapshot" }) + "\n";
  socket.write(negotiate.slice(0, 9));
  socket.write(negotiate.slice(9) + snapshot);
});
socket.on("data", (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf("\n");
  while (newline >= 0) {
    lines.push(JSON.parse(buffer.slice(0, newline)));
    buffer = buffer.slice(newline + 1);
    newline = buffer.indexOf("\n");
  }
  const negotiation = lines.find((line) => line.id === "n1");
  const unsolicited = lines.find((line) => line.type === "snapshot");
  const reply = lines.find((line) => line.id === "n2");
  if (!negotiation || !unsolicited || !reply) return;
  clearTimeout(timer);
  process.stdout.write(JSON.stringify({ negotiation, unsolicited, snapshot: reply.value }));
  socket.end();
});
socket.once("error", (error) => {
  clearTimeout(timer);
  process.stderr.write(error.stack || String(error));
  process.exitCode = 1;
});
`;

interface RawState {
  buffer: string;
  readonly lines: unknown[];
  readonly waiters: Array<(value: unknown) => void>;
}

class RawJsonlClient {
  readonly #socket: Bun.Socket<RawState>;

  private constructor(socket: Bun.Socket<RawState>) {
    this.#socket = socket;
  }

  static async connect(socketPath: string): Promise<RawJsonlClient> {
    const socket = await Bun.connect<RawState>({
      unix: socketPath,
      data: { buffer: "", lines: [], waiters: [] },
      socket: {
        data: (opened, chunk) => {
          opened.data.buffer += chunk.toString("utf8");
          let newline = opened.data.buffer.indexOf("\n");
          while (newline >= 0) {
            const line = opened.data.buffer.slice(0, newline);
            opened.data.buffer = opened.data.buffer.slice(newline + 1);
            const value = JSON.parse(line) as unknown;
            const waiter = opened.data.waiters.shift();
            if (waiter) waiter(value);
            else opened.data.lines.push(value);
            newline = opened.data.buffer.indexOf("\n");
          }
        },
      },
    });
    return new RawJsonlClient(socket);
  }

  send(value: unknown): void {
    this.#socket.write(`${JSON.stringify(value)}\n`);
  }

  async next(): Promise<unknown> {
    const queued = this.#socket.data.lines.shift();
    if (queued !== undefined) return queued;
    return await Promise.race([
      new Promise<unknown>((resolve) => this.#socket.data.waiters.push(resolve)),
      delay(2_000).then(() => {
        throw new Error("raw API response timed out");
      }),
    ]);
  }

  close(): void {
    this.#socket.end();
  }
}

async function waitUntil(condition: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!(await condition())) {
    if (Date.now() >= deadline) throw new Error("condition timed out");
    await delay(10);
  }
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
