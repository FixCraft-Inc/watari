import { describe, expect, test } from "bun:test";

import {
  redactSecrets,
  redactSummary,
  redactUnknown,
  sensitiveEnvironmentValues,
} from "../src/watari/security/redaction.ts";

describe("secret redaction", () => {
  test("redacts bearer tokens, API keys, and supplied environment secrets", () => {
    const environment = { API_KEY: "environment-secret-value" };
    const values = sensitiveEnvironmentValues(environment);
    const output = redactSecrets(
      "Bearer abc.def.ghi sk-ant-abcdefghijklmnop environment-secret-value",
      values,
    );
    expect(output).not.toContain("abc.def.ghi");
    expect(output).not.toContain("sk-ant-");
    expect(output).not.toContain("environment-secret-value");
  });

  test("redacts nested credential-shaped fields", () => {
    expect(
      redactUnknown({ nested: { accessToken: "top-secret", safe: "hello" } }),
    ).toEqual({ nested: { accessToken: "[REDACTED]", safe: "hello" } });
  });

  test("bounds very large provider strings", () => {
    const redacted = redactUnknown("x".repeat(300_000));
    expect(typeof redacted).toBe("string");
    expect((redacted as string).length).toBeLessThan(300_000);
    expect(redacted).toContain("[TRUNCATED");
  });
});

describe("terminal control sequences", () => {
  const ESC = String.fromCharCode(27);

  test("a provider's coloured log line is stored as plain text", () => {
    const line = `${ESC}[2m2026-08-24T01:13:17Z${ESC}[0m ${ESC}[31mERROR${ESC}[0m phase2: no changes`;
    expect(redactSummary(line)).toBe("2026-08-24T01:13:17Z ERROR phase2: no changes");
  });

  test("cursor moves, screen clears, and title writes cannot reach the terminal", () => {
    const hostile = `before${ESC}[2J${ESC}[H${ESC}]0;pwned${ESC}\\${ESC}[1;1Hafter`;
    const summary = redactSummary(hostile);
    expect(summary).toBe("beforeafter");
    expect(summary).not.toContain(ESC);
  });

  test("ordinary text and newlines survive", () => {
    expect(redactSummary("first line\nsecond line\ttabbed")).toBe("first line\nsecond line\ttabbed");
  });
});
