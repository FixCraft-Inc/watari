/**
 * End-to-end smoke test for the extension's half of the Watari local API.
 *
 * Runs the real executable and the real service, then drives them through the
 * compiled `out/` modules the extension host would load. It is not part of the
 * Watari test suite because it starts a service and its provider children; run
 * it by hand against a scratch checkout:
 *
 *   node smoke.mjs /path/to/some/git/checkout [/path/to/watari]
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { discover, startService, status } from "./out/discovery.js";
import { WatariClient } from "./out/client.js";

const project = process.argv[2] ?? process.cwd();
const executable = process.argv[3] ?? join(process.cwd(), "..", "dist", "watari");

// A scratch state root so this never touches the caller's real projects.
const stateRoot = mkdtempSync(join(tmpdir(), "watari-smoke-"));
process.env.XDG_STATE_HOME = stateRoot;

let failures = 0;
let client = null;
let serviceStateDirectory = null;
let stopped = false;
function check(label, condition, detail) {
  const mark = condition ? "ok  " : "FAIL";
  if (!condition) failures += 1;
  console.log(`${mark} ${label}${detail ? `  (${detail})` : ""}`);
}

try {
  const before = await status(executable, project);
  check("status reports a socket path", typeof before.service.socketPath === "string", before.service.socketPath);
  check(
    "status reports expected api v2",
    before.service.apiVersion === null && before.service.expectedApiVersion === 2,
    `running ${String(before.service.apiVersion)}, expected ${before.service.expectedApiVersion}`,
  );
  check("no service yet in a scratch state root", before.service.state === "stopped");

  console.log("\nstarting a service...");
  const found = await startService(executable, project, new AbortController().signal);
  serviceStateDirectory = found.stateDirectory;
  check("serve started a service", found.running, `pid ${found.pid}`);

  const events = [];
  client = await WatariClient.connect(found.socketPath, {
    onEvent: (event) => events.push(event.type),
    onClose: (reason) => console.log(`   connection closed: ${reason}`),
  });
  check("negotiated api v2 over node:net", true);

  await client.attach(false);
  const snapshot = await client.refresh();
  check("snapshot has schemaVersion 2", snapshot.schemaVersion === 2);
  check("snapshot carries a roster", Array.isArray(snapshot.agents), `${snapshot.agents.length} agents`);
  check("snapshot carries activities", Array.isArray(snapshot.activities));
  check(
    "an unsolicited snapshot event arrived after negotiation",
    events.includes("snapshot"),
    events.join(", ") || "none",
  );

  const detail = await client.activityDetail("act_000000000000000000000000");
  check("an unknown activity id answers null rather than throwing", detail === null);

  console.log("\nstopping the service...");
  await client.shutdown();
  client.close();
  client = null;
  await waitForServiceStop(serviceStateDirectory);
  stopped = true;
} catch (error) {
  failures += 1;
  console.error(`\nFAIL  ${error instanceof Error ? error.stack : String(error)}`);
} finally {
  if (client) {
    await client.shutdown().catch(() => undefined);
    client.close();
  }
  if (serviceStateDirectory && !stopped) {
    await waitForServiceStop(serviceStateDirectory).catch((error) => {
      failures += 1;
      console.error(`FAIL  ${error instanceof Error ? error.message : String(error)}`);
    });
  }
  rmSync(stateRoot, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);

async function waitForServiceStop(stateDirectory) {
  const socketPath = join(stateDirectory, "runtime.sock");
  const lockPath = join(stateDirectory, "runtime.lock");
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (!existsSync(socketPath) && !existsSync(lockPath)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`scratch Watari service did not remove ${socketPath} and ${lockPath}`);
}
