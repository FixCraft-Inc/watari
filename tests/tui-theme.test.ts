import { describe, expect, test } from "bun:test";

import {
  createAccents,
  identityAccent,
  modelProviderOf,
  providerAccent,
  providerOf,
  selectTheme,
  type Theme,
} from "../src/watari/tui/theme.ts";
import type { TeamAgent } from "../src/watari/state/types.ts";

function agent(id: string, provider: string | undefined, backend: string, model?: string): TeamAgent {
  return {
    id,
    backend,
    displayName: id,
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    sessionId: null,
    state: "ready",
    currentGoalId: null,
    updatedAt: 0,
    detail: null,
  };
}

const roster: TeamAgent[] = [
  agent("codex", "codex", "codex-app-server"),
  agent("reviewer", "claude", "claude-agent-sdk"),
  agent("second-opinion", "claude", "claude-agent-sdk"),
  agent("oc", "opencode", "opencode-acp"),
  agent("oc-sonnet", "opencode", "opencode-acp", "anthropic/claude-sonnet-4-5"),
  agent("oc-qwen", "opencode", "opencode-acp", "openrouter/qwen/qwen3-coder"),
  agent("oc-gemini", "opencode", "opencode-acp", "google/gemini-2.5-pro"),
  // Written before providers were recorded: the backend still names the harness.
  agent("legacy", undefined, "claude-agent-sdk"),
];

const palettes: readonly (readonly [string, Theme])[] = [
  ["dark", selectTheme("dark", true)],
  ["light", selectTheme("light", true)],
  ["dark xterm-256", selectTheme("dark", false)],
  ["light xterm-256", selectTheme("light", false)],
];

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16) / 255);
  const linear = channels.map((value) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
}

function distance(left: string, right: string): number {
  return Math.sqrt(
    [1, 3, 5].reduce(
      (total, index) =>
        total + (parseInt(left.slice(index, index + 2), 16) - parseInt(right.slice(index, index + 2), 16)) ** 2,
      0,
    ),
  );
}

function contrast(left: string, right: string): number {
  const [bright, dim] = [luminance(left), luminance(right)].sort((a, b) => b - a);
  return (bright! + 0.05) / (dim! + 0.05);
}

describe("identity accents", () => {
  test("colour comes from the harness, not from the name on the tab", () => {
    for (const [, theme] of palettes) {
      const accent = createAccents(theme, roster);
      expect(accent("reviewer")).toBe(theme.claude);
      expect(accent("second-opinion")).toBe(theme.claude);
      expect(accent("legacy")).toBe(theme.claude);
      expect(accent("codex")).toBe(theme.codex);
      expect(accent("oc")).toBe(theme.opencode);
      expect(providerAccent(theme, "qwen")).toBe(theme.qwen);
    }
  });

  test("the person, and Watari itself, are never a provider colour", () => {
    for (const [, theme] of palettes) {
      const accent = createAccents(theme, roster);
      expect(accent("user")).toBe(theme.user);
      expect(accent("you")).toBe(theme.user);
      expect(accent("watari")).toBe(theme.muted);
      for (const provider of ["codex", "claude", "opencode", "qwen"] as const) {
        expect(providerAccent(theme, provider)).not.toBe(theme.user);
      }
    }
  });

  test("a harness with no accent yet still gets one, and always the same one", () => {
    const theme = selectTheme("dark", true);
    const first = providerAccent(theme, "some-future-harness");
    expect(first).toBe(providerAccent(theme, "some-future-harness"));
    expect(first).not.toBe(providerAccent(theme, "another-harness"));
    expect(providerAccent(theme, null)).toBe(theme.peer);
  });

  test("a provider is read from the record, then from the backend that wrote it", () => {
    const byId = (id: string): TeamAgent => roster.find((entry) => entry.id === id)!;
    expect(providerOf(byId("reviewer"))).toBe("claude");
    expect(providerOf(byId("legacy"))).toBe("claude");
    expect(providerOf({ id: "x", backend: "opencode-external-mcp" })).toBe("opencode");
    expect(providerOf(null)).toBeNull();
  });
});

describe("readability", () => {
  test("every identity stays legible on every surface it is drawn on", () => {
    for (const [name, theme] of palettes) {
      // Truecolor palettes are chosen freely; the xterm-256 variants are pinned
      // to cube entries, where 3:1 is the honest floor for an accent.
      const floor = name.includes("256") ? 3 : 4;
      for (const key of [
        "user",
        "codex",
        "claude",
        "opencode",
        "qwen",
        "brand",
        "viaClaude",
        "viaCodex",
        "viaQwen",
      ] as const) {
        for (const surface of [theme.base, theme.surface, theme.raised] as const) {
          expect({ name, key, ratio: contrast(theme[key], surface) >= floor }).toEqual({
            name,
            key,
            ratio: true,
          });
        }
      }
    }
  });

  test("no two identities collapse into one colour", () => {
    for (const [, theme] of palettes) {
      const identities = [
        theme.user,
        theme.codex,
        theme.claude,
        theme.opencode,
        theme.qwen,
        theme.viaClaude,
        theme.viaCodex,
        theme.viaQwen,
      ];
      expect(new Set(identities).size).toBe(identities.length);
    }
  });
});

describe("a harness that runs other people's models", () => {
  test("the model provider is read out of the identifier, router prefix and all", () => {
    expect(modelProviderOf("anthropic/claude-sonnet-4-5")).toBe("anthropic");
    expect(modelProviderOf("openrouter/anthropic/claude-sonnet-4-5")).toBe("anthropic");
    expect(modelProviderOf("openrouter/meta-llama/llama-4")).toBe("openrouter");
    // A harness that serves its own models has no vendor in the id.
    expect(modelProviderOf("gpt-5-codex")).toBeNull();
    expect(modelProviderOf(null)).toBeNull();
  });

  test("OpenCode keeps its own identity and only leans towards the model's vendor", () => {
    for (const [, theme] of palettes) {
      const accent = createAccents(theme, roster);
      // Its own identity when Watari has no colour for the vendor, or no model.
      expect(accent("oc")).toBe(theme.opencode);
      expect(accent("oc-gemini")).toBe(theme.opencode);
      // A vendor Watari knows: near OpenCode, never the vendor's own colour.
      expect(accent("oc-sonnet")).toBe(theme.viaClaude);
      expect(accent("oc-qwen")).toBe(theme.viaQwen);
      expect(accent("oc-sonnet")).not.toBe(theme.claude);
      expect(accent("oc-sonnet")).not.toBe(theme.opencode);
      // A Claude agent on the Claude harness is still the undiluted colour.
      expect(accent("reviewer")).toBe(theme.claude);
      expect(identityAccent(theme, "codex", "anything")).toBe(theme.codex);
    }
  });

  test("each washed colour reads as its vendor's, not as something new", () => {
    for (const [name, theme] of palettes) {
      const pairs = [
        [theme.viaClaude, theme.claude],
        [theme.viaCodex, theme.codex],
        [theme.viaQwen, theme.qwen],
      ] as const;
      for (const [via, vendor] of pairs) {
        // Nearer its vendor than the vendor is to OpenCode: a variation on that
        // identity rather than a sixth colour nobody can place.
        const related = distance(via, vendor) < distance(vendor, theme.opencode);
        expect({ name, via, related }).toEqual({ name, via, related: true });
      }
    }
  });

  test("on a truecolor palette a washed colour is literally part way to OpenCode", () => {
    // The xterm-256 variants are pinned to cube entries, so they can only be as
    // close to the blend as the cube allows; the free palettes are exact.
    for (const [name, theme] of palettes.filter(([label]) => !label.includes("256"))) {
      for (const [via, vendor] of [
        [theme.viaClaude, theme.claude],
        [theme.viaCodex, theme.codex],
        [theme.viaQwen, theme.qwen],
      ] as const) {
        const low = Math.min(luminance(vendor), luminance(theme.opencode));
        const high = Math.max(luminance(vendor), luminance(theme.opencode));
        expect({ name, via, between: luminance(via) > low && luminance(via) < high }).toEqual({
          name,
          via,
          between: true,
        });
      }
    }
  });
});
