import { describe, expect, test } from "bun:test";

import {
  checkTaskAssignment,
  describeTaskPolicy,
  planTaskAssignment,
  ProjectTaskPolicySchema,
} from "../src/watari/task-policy.ts";

const policy = ProjectTaskPolicySchema.parse({
  classes: {
    design: { agents: ["lead", "worker"], description: "Substantive decisions" },
    execute: { agents: ["helper"] },
  },
  agents: {
    lead: { role: "reviewer", guidance: "Delegate routine execution." },
    helper: { requireTaskClass: true, resource: "gpu:test" },
  },
});

describe("project task policy", () => {
  test("uses only the project's preference order and available aliases", () => {
    const peers = [{ id: "helper", available: true }, { id: "worker", available: true }, { id: "lead", available: true }];
    expect(planTaskAssignment(policy, "design", peers).agent).toBe("lead");
    expect(planTaskAssignment(policy, "design", peers.filter((p) => p.id !== "lead")).agent).toBe("worker");
    expect(planTaskAssignment(policy, "design", peers.map((p) => ({ ...p, available: p.id === "helper" })))).toMatchObject({
      agent: null, blocked: expect.stringContaining("no permitted agent"),
    });
  });

  test("fails closed for missing policy, unknown classes, and disallowed recipients", () => {
    expect(planTaskAssignment(undefined, "design", []).agent).toBeNull();
    expect(planTaskAssignment(policy, "unknown", []).agent).toBeNull();
    expect(planTaskAssignment(policy, "constructor", []).agent).toBeNull();
    expect(() => checkTaskAssignment(policy, "design", "helper")).toThrow("cannot delegate");
    expect(() => checkTaskAssignment(policy, "design", "worker")).not.toThrow();
  });

  test("validates policy fields and bounds rather than guessing a hierarchy", () => {
    for (const bad of [
      { classes: {}, agents: {} },
      { classes: { design: { agents: [] } }, agents: {} },
      { classes: { design: { agents: ["lead", "LEAD"] } }, agents: {} },
      { classes: { design: { agents: ["user"] } }, agents: {} },
      { classes: { "bad class": { agents: ["lead"] } }, agents: {} },
      { ...policy, modelTiers: ["small", "large"] },
      { ...policy, agents: { helper: { resource: "" } } },
    ]) expect(() => ProjectTaskPolicySchema.parse(bad)).toThrow();
  });

  test("describes configured classes without inserting model rules", () => {
    expect(describeTaskPolicy(policy)).toContain("design: lead > worker");
    expect(describeTaskPolicy(undefined)).toBeNull();
  });
});
