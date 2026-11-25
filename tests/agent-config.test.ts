import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadProjectConfig,
  removeAgent,
  saveProjectConfig,
  upsertAgent,
} from "../src/watari/team/config.ts";
import { parseAgentDefinition } from "../src/watari/team/roster.ts";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("project agent configuration", () => {
  test("a missing file preserves the compatible Codex and Claude roster", () => {
    const directory = mkdtempSync(join(tmpdir(), "watari-config-"));
    directories.push(directory);
    expect(loadProjectConfig(join(directory, "agents.json")).agents.map((agent) => agent.alias)).toEqual([
      "codex",
      "claude",
    ]);
  });

  test("profiles round trip without confusing aliases and providers", () => {
    const directory = mkdtempSync(join(tmpdir(), "watari-config-"));
    directories.push(directory);
    const path = join(directory, "agents.json");
    const reviewer = parseAgentDefinition({
      alias: "reviewer",
      provider: "claude",
      model: "sonnet",
      effort: "high",
      unrestricted: false,
    });
    saveProjectConfig(path, { agents: [reviewer] });

    expect(loadProjectConfig(path).agents).toEqual([reviewer]);
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ schemaVersion: 1 });
  });

  test("upsert replaces an identity and removal refuses an empty team", () => {
    const first = parseAgentDefinition({ alias: "reviewer", provider: "claude" });
    const changed = parseAgentDefinition({ alias: "reviewer", provider: "codex" });
    expect(upsertAgent([first], changed)).toEqual([changed]);
    expect(() => removeAgent([first], "reviewer")).toThrow("at least one");
  });

  test("project policies survive provider replacement and peer removal without leaking to another project", () => {
    const directory = mkdtempSync(join(tmpdir(), "watari-config-"));
    directories.push(directory);
    const path = join(directory, "agents.json");
    const taskPolicy = {
      classes: { design: { agents: ["reviewer", "worker"] } },
      agents: { reviewer: { role: "Review", guidance: "Delegate builds." } },
    };
    saveProjectConfig(path, { agents: [
      parseAgentDefinition({ alias: "reviewer", provider: "claude" }),
      parseAgentDefinition({ alias: "worker", provider: "codex" }),
    ], taskPolicy });
    const config = loadProjectConfig(path);
    saveProjectConfig(path, { ...config, agents: upsertAgent(config.agents,
      parseAgentDefinition({ alias: "reviewer", provider: "codex", model: "replacement-model" })) });
    expect(loadProjectConfig(path).taskPolicy).toEqual(taskPolicy);
    saveProjectConfig(path, { ...config, agents: removeAgent(config.agents, "reviewer") });
    expect(loadProjectConfig(path).taskPolicy).toEqual(taskPolicy);
    expect(loadProjectConfig(join(directory, "other-project.json")).taskPolicy).toBeUndefined();
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("a malformed persisted policy fails closed", () => {
    const directory = mkdtempSync(join(tmpdir(), "watari-config-"));
    directories.push(directory);
    const path = join(directory, "agents.json");
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, agents: [{ alias: "codex" }], taskPolicy: { classes: {} } }));
    expect(() => loadProjectConfig(path)).toThrow();
  });
});
