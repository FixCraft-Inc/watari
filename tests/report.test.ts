import { describe, expect, test } from "bun:test";

import type { DoctorReport, ProbeReport, StatusReport } from "../src/watari/models.ts";
import { renderDoctor, renderProbe, renderStatus, renderUsage, resolveStyle } from "../src/watari/report.ts";

const ESC = String.fromCharCode(27);
const project = { launchDirectory: "/work/watari", repositoryRoot: "/work/watari" };

const doctor: DoctorReport = {
  schemaVersion: 1,
  command: "doctor",
  project,
  ok: false,
  checks: [
    { id: "codex.executable", status: "pass", summary: "codex found on PATH" },
    { id: "claude.handshake", status: "warn", summary: "handshake was slow", detail: "3.4s" },
    { id: "state.sqlite", status: "fail", summary: "state storage is not writable" },
  ],
};

const probe: ProbeReport = {
  schemaVersion: 1,
  command: "probe",
  adapter: "codex",
  mode: "handshake",
  project,
  ok: true,
  sessionId: "thr_1",
  capabilities: {
    structuredReasoningEvents: true,
    toolEvents: true,
    diffEvents: true,
    approvals: true,
    interrupt: true,
    bidirectionalInput: true,
    safeSteer: true,
    resume: true,
    mcp: true,
    skills: true,
    nativeSession: true,
    usageMetadata: true,
  },
  events: [{ agent: "codex", kind: "session", timestamp: 0, summary: "handshake completed" }],
  limitation: "no model turn was started",
};

const status: StatusReport = {
  schemaVersion: 1,
  command: "status",
  project,
  stateDirectory: "/state/watari",
  service: {
    state: "running",
    pid: 1234,
    connectedClients: 2,
    socketPath: "/state/watari/runtime.sock",
    apiVersion: 2,
    expectedApiVersion: 2,
    detail: null,
  },
  agents: [
    {
      id: "codex",
      state: "ready",
      backend: "codex-app-server",
      teamBridge: "identity-bound stdio MCP",
      sessionId: "thr_1",
      detail: "native harness ready",
    },
    {
      id: "claude",
      state: "ready",
      backend: "claude-agent-sdk",
      teamBridge: "identity-bound stdio MCP",
      sessionId: "ses_1",
      detail: "native harness ready",
    },
  ],
  ok: true,
};

describe("cli styling", () => {
  test("colour is used only for a terminal", () => {
    expect(resolveStyle({ isTTY: true }, {}).ok("x")).toContain(ESC);
    expect(resolveStyle({ isTTY: false }, {}).ok("x")).toBe("x");
    expect(resolveStyle({}, {}).ok("x")).toBe("x");
  });

  test("NO_COLOR and dumb terminals disable colour on a tty", () => {
    expect(resolveStyle({ isTTY: true }, { NO_COLOR: "1" }).bad("x")).toBe("x");
    expect(resolveStyle({ isTTY: true }, { NO_COLOR: "" }).bad("x")).toBe("x");
    expect(resolveStyle({ isTTY: true }, { TERM: "dumb" }).bad("x")).toBe("x");
  });
});

describe("doctor output", () => {
  const plain = renderDoctor(doctor, resolveStyle({ isTTY: false }, {}));

  test("aligns check ids into one column", () => {
    const rows = plain.split("\n").filter((line) => line.includes("  codex.executable  ") || line.includes("  claude.handshake  "));
    expect(rows).toHaveLength(2);
    expect(rows[0]?.indexOf("codex found")).toBe(rows[1]?.indexOf("handshake was slow") ?? -1);
  });

  test("marks status with a glyph, not colour alone", () => {
    expect(plain).toContain("✓");
    expect(plain).toContain("!");
    expect(plain).toContain("✗");
  });

  test("hangs a detail under its check and tallies the run", () => {
    expect(plain).toContain("└ 3.4s");
    expect(plain).toContain("1 ok");
    expect(plain).toContain("1 warning");
    expect(plain).toContain("1 failed");
  });

  test("emits no escape sequences when colour is off", () => {
    expect(plain).not.toContain(ESC);
  });
});

describe("probe and usage output", () => {
  test("states the verdict and the quota limitation", () => {
    const plain = renderProbe(probe, resolveStyle({ isTTY: false }, {}));
    expect(plain).toContain("watari probe codex");
    expect(plain).toContain("pass");
    expect(plain).toContain("handshake completed");
    expect(plain).toContain("no model turn was started");
    expect(plain).toContain("thr_1");
  });

  test("usage lists every command and warns that --live spends quota", () => {
    const plain = renderUsage(resolveStyle({ isTTY: false }, {}));
    expect(plain).toContain("watari [path]");
    expect(plain).toContain("watari doctor [path]");
    expect(plain).toContain("watari attach [path]");
    expect(plain).toContain("watari status [path]");
    expect(plain).toContain("watari mcp --agent <alias> [--provider <id>] [path]");
    expect(plain).toContain("watari probe <codex|claude|opencode|qwen> [path]");
    expect(plain).toContain("spends provider quota");
  });

  test("status makes the single-service and provider bridge topology visible", () => {
    const plain = renderStatus(status, resolveStyle({ isTTY: false }, {}));
    expect(plain).toContain("running as pid 1234");
    expect(plain).toContain("2 local client connections");
    expect(plain).toContain("identity-bound stdio MCP");
  });
});
