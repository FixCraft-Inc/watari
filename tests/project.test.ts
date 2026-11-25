import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveProjectContext } from "../src/watari/project/checkout.ts";
import { ensureService } from "../src/watari/launch.ts";
import { SERVICE_API_VERSION } from "../src/watari/service/protocol.ts";
import { resolveStateLocation } from "../src/watari/state/location.ts";
import { runStatus } from "../src/watari/status.ts";

describe("project checkout", () => {
  test("preserves the exact launch directory and discovers the repository root", () => {
    const context = resolveProjectContext(".");
    expect(context.launchDirectory).toBe(realpathSync("."));
    expect(context.repositoryRoot).toBe(realpathSync("."));
  });
});

describe("service discovery", () => {
  // A frontend outside this repository — a VSCode extension, say — has to find
  // the running service before it can speak the local API. It should read the
  // socket path and the API version out of `watari status --json` rather than
  // re-deriving Watari's private state layout and hoping the two stay in step.
  test("status reports where to connect and which API version is spoken", async () => {
    const directory = mkdtempSync(join(tmpdir(), "watari-status-"));
    const previous = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = join(directory, "state");
    try {
      const report = await runStatus(resolveProjectContext(directory));
      expect(report.service.state).toBe("stopped");
      expect(report.service.apiVersion).toBeNull();
      expect(report.service.expectedApiVersion).toBe(SERVICE_API_VERSION);
      expect(report.service.socketPath).toBe(join(report.stateDirectory, "runtime.sock"));
      expect(report.service.socketPath.startsWith(process.env.XDG_STATE_HOME)).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("a live incompatible endpoint is not mistaken for a stopped service", async () => {
    const directory = mkdtempSync(join(tmpdir(), "watari-status-legacy-"));
    const previous = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = join(directory, "state");
    const project = resolveProjectContext(directory);
    const location = resolveStateLocation(project);
    let accepted = 0;
    const listener = Bun.listen<{ buffer: string }>({
      unix: location.socketPath,
      socket: {
        open(socket) {
          accepted += 1;
          socket.data = { buffer: "" };
        },
        data(socket, chunk) {
          socket.data.buffer += chunk.toString("utf8");
          if (!socket.data.buffer.includes("\n")) return;
          const request = JSON.parse(socket.data.buffer.slice(0, socket.data.buffer.indexOf("\n"))) as {
            readonly id: string;
          };
          socket.write(`${JSON.stringify({
            type: "response",
            id: request.id,
            ok: false,
            error: "legacy Watari requires local API version 1",
          })}\n`);
        },
      },
    });
    writeFileSync(location.lockPath, `${process.pid}\n`, { mode: 0o600 });
    try {
      const report = await runStatus(project);
      expect(report.service).toMatchObject({
        state: "incompatible",
        pid: process.pid,
        apiVersion: null,
        expectedApiVersion: SERVICE_API_VERSION,
      });
      expect(report.service.detail).toContain("requires local API version 1");
      expect(report.ok).toBe(false);

      const beforeEnsure = accepted;
      await expect(ensureService(project, location)).rejects.toThrow("negotiation failed");
      expect(accepted).toBe(beforeEnsure + 1);
    } finally {
      listener.stop(true);
      if (previous === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
