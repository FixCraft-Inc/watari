import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { Database } from "bun:sqlite";

import { ClaudeAdapter } from "./agents/claude.ts";
import { CodexAdapter } from "./agents/codex.ts";
import { AcpAdapter } from "./agents/acp.ts";
import { OpenCodeAdapter } from "./agents/opencode.ts";
import { QwenAdapter } from "./agents/qwen.ts";
import type { CheckResult, DoctorReport, ProjectContext } from "./models.ts";
import { resolveExecutable } from "./project/checkout.ts";
import { redactSecrets } from "./security/redaction.ts";
import { TESTED_BUN_VERSION, TESTED_CODEX_VERSION, TESTED_CLAUDE_VERSION, TESTED_QWEN_VERSION } from "./compatibility.ts";

export async function runDoctor(project: ProjectContext): Promise<DoctorReport> {
  const checks: CheckResult[] = [];
  checks.push(checkGit(project));
  checks.push(checkBun());

  const codexExecutable = resolveExecutable(
    "codex",
    process.env.WATARI_CODEX_BIN,
  );
  if (!codexExecutable) {
    checks.push(fail("codex.binary", "Codex executable was not found"));
  } else {
    checks.push(checkVersion("codex.version", codexExecutable, TESTED_CODEX_VERSION));
    checks.push(checkCodexAuthentication(codexExecutable));
    checks.push(await checkCodexHandshake(codexExecutable, project));
  }

  const claudeExecutable = resolveExecutable(
    "claude",
    process.env.WATARI_CLAUDE_BIN,
  );
  if (!claudeExecutable) {
    checks.push(fail("claude.binary", "Claude executable was not found"));
  } else {
    checks.push(
      checkVersion("claude.version", claudeExecutable, TESTED_CLAUDE_VERSION),
    );
    checks.push(checkClaudeAuthentication(claudeExecutable));
    checks.push(checkClaudeFallbackFlags(claudeExecutable));
    checks.push(await checkClaudeHandshake(claudeExecutable, project));
  }

  const openCodeExecutable = resolveExecutable(
    "opencode",
    process.env.WATARI_OPENCODE_BIN,
  );
  if (!openCodeExecutable) {
    checks.push(warn("opencode.binary", "OpenCode is optional and was not found"));
  } else {
    checks.push(checkDetectedVersion("opencode.version", openCodeExecutable));
    checks.push(await checkAcpHandshake("opencode", "OpenCode", new OpenCodeAdapter({ executable: openCodeExecutable, readOnlyProbe: true }), project));
  }

  const qwenExecutable = resolveExecutable("qwen", process.env.WATARI_QWEN_BIN);
  if (!qwenExecutable) {
    checks.push(warn("qwen.binary", "Qwen Code is optional and was not found"));
  } else {
    checks.push(checkVersion("qwen.version", qwenExecutable, TESTED_QWEN_VERSION));
    checks.push(await checkAcpHandshake("qwen", "Qwen Code", new QwenAdapter({ executable: qwenExecutable, readOnlyProbe: true }), project));
  }

  checks.push(checkStateStorage());
  return {
    schemaVersion: 1,
    command: "doctor",
    project,
    checks,
    ok: checks.every((check) => check.status !== "fail"),
  };
}

function checkGit(project: ProjectContext): CheckResult {
  const git = Bun.which("git");
  if (!git) {
    return fail("git", "Git executable was not found");
  }
  if (!project.repositoryRoot) {
    return fail("project.git", "Project is not inside a Git repository");
  }
  return pass("project.git", "Git repository discovered", project.repositoryRoot);
}

function checkBun(): CheckResult {
  const executable = resolveExecutable("bun");
  if (!executable) {
    return fail("bun.version", "Bun executable was not found");
  }
  return checkVersion("bun.version", executable, TESTED_BUN_VERSION);
}

function checkVersion(
  id: string,
  executable: string,
  expectedVersion: string,
): CheckResult {
  const result = Bun.spawnSync([executable, "--version"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    return fail(id, "Version command failed");
  }
  const output = redactSecrets(result.stdout.toString().trim());
  const installed = /(?<version>\d+\.\d+\.\d+)/u.exec(output)?.groups?.version;
  if (installed !== expectedVersion) {
    return warn(
      id,
      `Installed version ${installed ?? "unknown"}; tested version is ${expectedVersion}`,
      output,
    );
  }
  return pass(id, `Version ${installed}`, executable);
}

function checkDetectedVersion(id: string, executable: string): CheckResult {
  const result = Bun.spawnSync([executable, "--version"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) return fail(id, "Version command failed");
  const output = redactSecrets(result.stdout.toString().trim());
  const installed = /(?<version>\d+\.\d+\.\d+)/u.exec(output)?.groups?.version;
  return installed
    ? pass(id, `Version ${installed}`, executable)
    : warn(id, "Version could not be parsed", output);
}

function checkCodexAuthentication(executable: string): CheckResult {
  const result = Bun.spawnSync([executable, "login", "status"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return result.exitCode === 0
    ? pass("codex.auth", "Codex authentication is available")
    : warn("codex.auth", "Codex authentication could not be confirmed");
}

function checkClaudeAuthentication(executable: string): CheckResult {
  const result = Bun.spawnSync([executable, "auth", "status", "--json"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    return warn("claude.auth", "Claude authentication could not be confirmed");
  }
  try {
    const status = JSON.parse(result.stdout.toString()) as unknown;
    const authenticated =
      typeof status === "object" &&
      status !== null &&
      "loggedIn" in status &&
      status.loggedIn === true;
    return authenticated
      ? pass("claude.auth", "Claude authentication is available")
      : warn("claude.auth", "Claude reports that authentication is unavailable");
  } catch {
    return warn("claude.auth", "Claude authentication status was not valid JSON");
  }
}

async function checkCodexHandshake(
  executable: string,
  project: ProjectContext,
): Promise<CheckResult> {
  const adapter = new CodexAdapter({ executable });
  try {
    await adapter.start(project);
    return pass("codex.handshake", "Codex app-server handshake succeeded");
  } catch (error) {
    return fail("codex.handshake", "Codex app-server handshake failed", errorMessage(error));
  } finally {
    await adapter.stop().catch(() => undefined);
  }
}

async function checkClaudeHandshake(
  executable: string,
  project: ProjectContext,
): Promise<CheckResult> {
  const adapter = new ClaudeAdapter({ executable });
  try {
    await adapter.start(project);
    return pass("claude.handshake", "Claude Agent SDK handshake succeeded");
  } catch (error) {
    return fail("claude.handshake", "Claude Agent SDK handshake failed", errorMessage(error));
  } finally {
    await adapter.stop().catch(() => undefined);
  }
}

async function checkAcpHandshake(
  id: string,
  name: string,
  adapter: AcpAdapter,
  project: ProjectContext,
): Promise<CheckResult> {
  try {
    await adapter.start(project);
    return pass(`${id}.handshake`, `${name} ACP handshake succeeded`);
  } catch (error) {
    return fail(`${id}.handshake`, `${name} ACP handshake failed`, errorMessage(error));
  } finally {
    await adapter.stop().catch(() => undefined);
  }
}

function checkClaudeFallbackFlags(executable: string): CheckResult {
  const result = Bun.spawnSync([executable, "--help"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = `${result.stdout.toString()}\n${result.stderr.toString()}`;
  const requiredFlags = [
    "--input-format",
    "--output-format",
    "--include-partial-messages",
    "--resume",
  ];
  const missing = requiredFlags.filter((flag) => !output.includes(flag));
  return result.exitCode === 0 && missing.length === 0
    ? pass("claude.stream-json", "Claude structured CLI fallback is available")
    : fail(
        "claude.stream-json",
        "Claude structured CLI fallback is unavailable",
        missing.join(", "),
      );
}

function checkStateStorage(): CheckResult {
  const stateRoot =
    process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
  const watariRoot = join(stateRoot, "watari");
  let testDirectory: string | null = null;
  try {
    mkdirSync(watariRoot, { recursive: true, mode: 0o700 });
    chmodSync(watariRoot, 0o700);
    testDirectory = mkdtempSync(join(watariRoot, ".doctor-"));
    const database = new Database(join(testDirectory, "state.db"), {
      create: true,
      strict: true,
    });
    database.exec("CREATE TABLE healthcheck (value INTEGER NOT NULL)");
    database.exec("INSERT INTO healthcheck VALUES (1)");
    database.close();
    return pass("state.sqlite", "SQLite state storage is writable", watariRoot);
  } catch (error) {
    return fail("state.sqlite", "SQLite state storage is not writable", errorMessage(error));
  } finally {
    if (testDirectory?.startsWith(`${watariRoot}/`)) {
      rmSync(testDirectory, { recursive: true, force: true });
    }
  }
}

function pass(id: string, summary: string, detail?: string): CheckResult {
  return { id, status: "pass", summary, ...(detail ? { detail } : {}) };
}

function warn(id: string, summary: string, detail?: string): CheckResult {
  return { id, status: "warn", summary, ...(detail ? { detail } : {}) };
}

function fail(id: string, summary: string, detail?: string): CheckResult {
  return { id, status: "fail", summary, ...(detail ? { detail } : {}) };
}

function errorMessage(error: unknown): string {
  return redactSecrets(error instanceof Error ? error.message : String(error));
}
