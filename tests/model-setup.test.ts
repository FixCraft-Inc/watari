import { describe, expect, test } from "bun:test";

import type { AgentModelOption } from "../src/watari/models.ts";
import type { TeamAgent } from "../src/watari/state/types.ts";
import {
  PROVIDER_DEFAULT_MODEL,
  aliasProblem,
  catalogVendors,
  effortChoices,
  filterModels,
  isVendorCatalog,
  modelChoices,
  nextAgentAlias,
} from "../src/watari/tui/model-setup.tsx";

const agents: TeamAgent[] = [
  {
    id: "codex",
    backend: "codex-app-server",
    displayName: "Codex",
    sessionId: null,
    state: "ready",
    currentGoalId: null,
    updatedAt: 1,
    detail: null,
  },
  {
    id: "codex-2",
    backend: "codex-app-server",
    displayName: "Codex 2",
    sessionId: null,
    state: "ready",
    currentGoalId: null,
    updatedAt: 1,
    detail: null,
  },
];

describe("guided model setup", () => {
  test("keeps model and effort availability provider-owned", () => {
    const native: AgentModelOption = {
      id: "future-model",
      displayName: "Future Model",
      description: "native response",
      efforts: ["provider-next", "turbo_2"],
    };

    expect(modelChoices([native])).toEqual([PROVIDER_DEFAULT_MODEL, native]);
    expect(effortChoices(native)).toEqual([null, "provider-next", "turbo_2"]);
    expect(effortChoices(PROVIDER_DEFAULT_MODEL)).toEqual([null]);
  });

  test("suggests a free alias and never overwrites an existing chat", () => {
    expect(nextAgentAlias("codex", agents)).toBe("codex-3");
    expect(nextAgentAlias("claude", agents)).toBe("claude");
    expect(aliasProblem("CODEX", agents)).toContain("already exists");
    expect(aliasProblem("reviewer", agents)).toBeNull();
    expect(aliasProblem("bad alias", agents)).toContain("letters");
  });
});

describe("multi-provider catalogs", () => {
  const openCode: AgentModelOption[] = [
    { id: "anthropic/claude-sonnet-4-5", displayName: "Claude Sonnet 4.5", description: "", efforts: ["low", "high"] },
    { id: "anthropic/claude-opus-4-1", displayName: "Claude Opus 4.1", description: "", efforts: [] },
    { id: "openai/gpt-5", displayName: "GPT-5", description: "", efforts: [] },
    { id: "qwen/qwen3-coder", displayName: "Qwen3 Coder", description: "", efforts: [] },
    { id: "openrouter/anthropic/claude-sonnet-4-5", displayName: "Claude Sonnet 4.5 (OpenRouter)", description: "", efforts: [] },
  ];
  const own: AgentModelOption[] = [
    { id: "gpt-5-codex", displayName: "GPT-5 Codex", description: "", efforts: ["low"] },
    { id: "gpt-5", displayName: "GPT-5", description: "", efforts: [] },
  ];

  test("a harness that serves other people's models is recognised as a directory", () => {
    expect(isVendorCatalog(openCode)).toBe(true);
    expect(isVendorCatalog(own)).toBe(false);
    // The provider-default row is Watari's, not the harness's, and never counts.
    expect(isVendorCatalog(modelChoices(openCode))).toBe(true);
    expect(isVendorCatalog([])).toBe(false);
  });

  test("vendors are separated, counted, and ordered predictably", () => {
    expect(catalogVendors(modelChoices(openCode)).map((vendor) => [vendor.id, vendor.models.length])).toEqual([
      ["anthropic", 2],
      ["openai", 1],
      ["openrouter", 1],
      ["qwen", 1],
    ]);
  });

  test("search matches an id or a name, best match first, and never reshuffles ties", () => {
    expect(filterModels(openCode, "sonnet").map((model) => model.id)).toEqual([
      "anthropic/claude-sonnet-4-5",
      "openrouter/anthropic/claude-sonnet-4-5",
    ]);
    // A prefix beats a word start beats scattered letters.
    expect(filterModels(openCode, "qwen")[0]?.id).toBe("qwen/qwen3-coder");
    expect(filterModels(openCode, "gpt5").map((model) => model.id)).toEqual(["openai/gpt-5"]);
    expect(filterModels(openCode, "")).toEqual(openCode);
    expect(filterModels(openCode, "nothing-like-this")).toEqual([]);
  });
});
