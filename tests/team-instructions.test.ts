import { describe, expect, test } from "bun:test";

import { contextRefreshNotice, startupRoleInstruction } from "../src/watari/team/instructions.ts";

const roster = [
  { id: "lead", provider: "claude", model: "any-model", role: "Reviewer", guidance: "Delegate routine execution to worker." },
  { id: "worker", provider: "codex", model: "other-model", role: "Implementer" },
  { id: "helper", provider: "qwen", resource: "gpu:test", requireTaskClass: true, guidance: "Only execute bounded commands and report results." },
];
const taskPolicy = "Project delegation policy: execute goes to helper.";

describe("project role guidance", () => {
  test("startup uses project roles regardless of provider or model names", () => {
    const text = startupRoleInstruction({ recipient: "lead", roster, role: "intake_lead", position: 1, taskPolicy });
    expect(text).toContain("Your project role: Reviewer");
    expect(text).toContain("Delegate routine execution to worker.");
    expect(text).toContain(taskPolicy);
  });

  test("compaction restates the project's policy and recipient guidance", () => {
    const text = contextRefreshNotice({ recipient: "helper", goal: null, roster, claims: [], todos: [], owed: [], awaiting: 0, taskPolicy });
    expect(text).toContain("Only execute bounded commands and report results.");
    expect(text).toContain("exclusive project resource gpu:test");
    expect(text).toContain("must declare a permitted project task_class");
    expect(text).toContain(taskPolicy);
    expect(text).not.toContain("Delegate routine execution to worker.");
  });

  test("solo peers retain their project restrictions", () => {
    const text = startupRoleInstruction({ recipient: "helper", roster: [roster[2]!], role: "intake_lead", position: 1, taskPolicy });
    expect(text).toContain("working alone");
    expect(text).toContain("Only execute bounded commands");
    expect(text).toContain(taskPolicy);
  });

  test("unconfigured projects have no inferred model hierarchy", () => {
    const text = startupRoleInstruction({ recipient: "lead", roster: [{ id: "lead", provider: "claude", model: "test-model" }], role: "intake_lead", position: 1 });
    expect(text).not.toContain("Budget guard");
    expect(text).not.toContain("Project delegation policy");
  });
});
