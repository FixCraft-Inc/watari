import assert from "node:assert/strict";
import { test } from "node:test";

import {
  parseActivityDetail,
  parseServiceEnvelope,
  parseStatusReport,
  parseTeamSnapshot,
} from "../out/validation.js";

const emptySnapshot = {
  schemaVersion: 2,
  agents: [],
  activeGoal: null,
  messages: [],
  claims: [],
  findings: [],
  events: [],
  activities: [],
  bridges: [],
};

test("local API envelopes reject malformed service input", () => {
  assert.throws(() => parseServiceEnvelope(null), /envelope must be an object/);
  assert.throws(
    () => parseServiceEnvelope({ type: "activity_upsert", activity: { id: "act_bad" } }),
    /must be a string/,
  );
  assert.throws(() => parseServiceEnvelope({ type: "mystery" }), /unknown envelope type/);
  assert.deepEqual(
    parseServiceEnvelope({ type: "snapshot", snapshot: emptySnapshot }),
    { type: "snapshot", snapshot: emptySnapshot },
  );
});

test("snapshots and lazy activity details are validated before display", () => {
  assert.deepEqual(parseTeamSnapshot(emptySnapshot), emptySnapshot);
  assert.throws(
    () => parseTeamSnapshot({ ...emptySnapshot, activities: [{ id: "act_bad" }] }),
    /activity.*must be a string|must be a string/,
  );
  assert.equal(parseActivityDetail(null), null);
  assert.throws(
    () => parseActivityDetail({
      kind: "command",
      command: "pwd",
      cwd: null,
      outputMode: "combined",
      stdout: [],
      stderr: "",
      exitCode: 0,
      durationMs: 1,
      interrupted: false,
      retention: { truncated: false, omittedBytes: 0, omittedLines: 0 },
    }),
    /stdout must be a string/,
  );
});

test("status validation preserves the incompatible-service state", () => {
  const report = parseStatusReport({
    command: "status",
    stateDirectory: "/state/project",
    service: {
      state: "incompatible",
      pid: 42,
      connectedClients: 0,
      socketPath: "/state/project/runtime.sock",
      apiVersion: null,
      expectedApiVersion: 2,
      detail: "upgrade the running service",
    },
    ok: false,
  });
  assert.equal(report.service.state, "incompatible");
  assert.equal(report.service.apiVersion, null);
  assert.equal(report.service.expectedApiVersion, 2);
  assert.match(report.service.detail, /upgrade/);
});
