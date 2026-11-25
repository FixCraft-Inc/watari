import { describe, expect, test } from "bun:test";

import {
  RosterError,
  defaultRoster,
  isProviderId,
  isReasoningEffort,
  isSupportedProvider,
  parseAgentDefinition,
  parseRoster,
} from "../src/watari/team/roster.ts";

describe("agent definitions", () => {
  test("an alias that names a provider needs nothing else", () => {
    expect(parseAgentDefinition({ alias: "codex" })).toEqual({
      alias: "codex",
      provider: "codex",
      displayName: "Codex",
      mode: "managed",
      unrestricted: false,
    });
  });

  test("an alias is separate from the harness behind it", () => {
    expect(parseAgentDefinition({ alias: "sonnet-2", provider: "claude" })).toEqual({
      alias: "sonnet-2",
      provider: "claude",
      displayName: "Sonnet-2",
      mode: "managed",
      unrestricted: false,
    });
  });

  test("two agents can share one harness", () => {
    const roster = parseRoster([
      { alias: "reviewer", provider: "claude" },
      { alias: "builder", provider: "claude" },
    ]);
    expect(roster.map((agent) => agent.provider)).toEqual(["claude", "claude"]);
    expect(roster.map((agent) => agent.alias)).toEqual(["reviewer", "builder"]);
  });

  test("model and effort are carried through when given", () => {
    expect(
      parseAgentDefinition({
        alias: "deep",
        provider: "claude",
        model: "claude-opus-5",
        effort: "high",
        displayName: "Deep Thinker",
        unrestricted: false,
      }),
    ).toEqual({
      alias: "deep",
      provider: "claude",
      displayName: "Deep Thinker",
      model: "claude-opus-5",
      effort: "high",
      mode: "managed",
      unrestricted: false,
    });
  });

  test("skipping approval prompts is the default, since nobody is watching one", () => {
    expect(parseAgentDefinition({ alias: "codex" }).unrestricted).toBe(false);
    expect(parseAgentDefinition({ alias: "codex", unrestricted: true }).unrestricted).toBe(true);
  });

  test("a bad field is named rather than silently dropped", () => {
    expect(() => parseAgentDefinition({ alias: "sonnet-2" })).toThrow(RosterError);
    expect(() => parseAgentDefinition({ alias: "a", provider: "gemini" })).toThrow("provider");
    expect(() => parseAgentDefinition({ alias: "a", provider: "claude", effort: "not valid" })).toThrow(
      "effort",
    );
    expect(() => parseAgentDefinition({ alias: "a", provider: "claude", model: "" })).toThrow("model");
    expect(() => parseAgentDefinition({ alias: "user" })).toThrow("alias");
    expect(() => parseAgentDefinition({ alias: "bad alias" })).toThrow("alias");
    expect(() => parseAgentDefinition("codex")).toThrow(RosterError);
  });
});

describe("rosters", () => {
  test("the default roster is the previous fixed pair, so old projects still resolve", () => {
    expect(defaultRoster().map((agent) => agent.alias)).toEqual(["codex", "claude"]);
    expect(defaultRoster().every((agent) => agent.alias === agent.provider)).toBe(true);
  });

  test("a duplicate identity is refused, case-insensitively", () => {
    expect(() =>
      parseRoster([{ alias: "codex" }, { alias: "Codex", provider: "codex" }]),
    ).toThrow("more than once");
  });

  test("an empty roster is refused", () => {
    expect(() => parseRoster([])).toThrow("at least one agent");
    expect(() => parseRoster({})).toThrow("array");
  });
});

describe("provider vocabulary", () => {
  test("known providers are recognised and unknown ones are not", () => {
    expect(isProviderId("codex")).toBe(true);
    expect(isProviderId("claude")).toBe(true);
    expect(isProviderId("opencode")).toBe(true);
    expect(isProviderId("gemini")).toBe(false);
  });

  test("all known providers have managed adapters", () => {
    expect(isProviderId("opencode")).toBe(true);
    expect(isSupportedProvider("opencode")).toBe(true);
    expect(isSupportedProvider("codex")).toBe(true);
    expect(isSupportedProvider("claude")).toBe(true);
  });

  test("effort identifiers are provider-owned but safe to persist", () => {
    expect(isReasoningEffort("high")).toBe(true);
    expect(isReasoningEffort("provider-next")).toBe(true);
    expect(isReasoningEffort("not an effort")).toBe(false);
  });
});
