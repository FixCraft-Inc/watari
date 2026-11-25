import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RuntimeClient } from "../src/watari/service/client.ts";
import { WatariService } from "../src/watari/service/server.ts";
import { FakeAdapter } from "./fakes/fake-adapter.ts";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("a client that falls behind", () => {
  test("keeps its connection and gets the newest snapshot instead of a backlog", async () => {
    const directory = mkdtempSync(join(tmpdir(), "watari-backlog-"));
    const socketPath = join(directory, "runtime.sock");
    const service = new WatariService({
      project: { launchDirectory: directory, repositoryRoot: directory },
      databasePath: join(directory, "state.db"),
      socketPath,
      idleExitMs: false,
      adapters: { codex: new FakeAdapter("codex"), claude: new FakeAdapter("claude") },
    });
    await service.start();
    cleanups.push(async () => {
      await service.stop();
      rmSync(directory, { recursive: true, force: true });
    });

    // A UI busy redrawing, in its own process so it cannot slow the service.
    const slow = Bun.spawn([process.execPath, join(import.meta.dir, "fakes", "slow-client.ts"), socketPath], {
      stdout: "pipe",
      stderr: "inherit",
    });
    cleanups.push(() => slow.kill());
    await Bun.sleep(300);

    // Large peer messages make every snapshot hundreds of kilobytes, and each
    // send publishes one, so the team outruns the slow reader.
    const driver = await RuntimeClient.connect(socketPath);
    cleanups.push(() => driver.close());
    await driver.send("all", "Stress the snapshot stream.");
    const body = "x".repeat(30_000);
    for (let index = 0; index < 60; index += 1) {
      await driver.callTeamTool(index % 2 === 0 ? "codex" : "claude", "team_send", {
        to: index % 2 === 0 ? "claude" : "codex",
        message: `${index} ${body}`,
      });
      await Bun.sleep(15);
    }
    await driver.callTeamTool("codex", "team_send", { to: "claude", message: "final marker" });

    const report = JSON.parse((await new Response(slow.stdout).text()).trim()) as {
      closed: boolean;
      sawMarker: boolean;
    };
    expect(report).toEqual({ closed: false, sawMarker: true });
  }, 30_000);
});
