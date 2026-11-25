import { expect, test } from "bun:test";
import { readGeminiWebStatus } from "../src/watari/gemini-web-status.ts";
import { capacityNoticeKind } from "../src/watari/provider-status.ts";
import { providerStatusEndpoints, providerStatusReaders } from "../src/watari/provider-status-readers.ts";
import { ProviderStatusService } from "../src/watari/provider-status-api.ts";
import { dashboardRuntime } from "../src/watari/provider-dashboard/client.ts";

const now = 1_800_000_000_000;
const bucket = { model: "gemini-auto", kind: "video", attempts: 1, succeeded: 0, failed: 1,
  last_outcome: "quota", last_observed_at: now, retry_at: now + 60_000 };
const status = () => ({ schema: "gemini-web.status/1", observed_at: now, state: "connected", remaining: null,
  limit_scope: "unknown", models: ["gemini-auto"], observations: { schema: "gemini-web.observations/1", buckets: { "video:gemini-auto": bucket }, active: null } });

test("observed per-operation limits never become account quota or reset estimates", async () => {
  const result = await readGeminiWebStatus("http://127.0.0.1:14981", async () => status(), { now: () => now });
  expect(result.reachable).toBe(true);
  expect(result.accounts).toHaveLength(1);
  expect(result.allEligibleUnavailable).toBeNull();
  expect(result.capacity).toBe("unknown");
  expect(capacityNoticeKind(result, now)).toBeNull();
  const account = result.accounts[0]!;
  expect(account.primary).toBeNull();
  expect(account.secondary).toBeNull();
  expect(account.eligible).toBeNull();
  expect(account.models).toEqual(["gemini-auto"]);
  expect(account.observedUsage?.[0]).toMatchObject({ attempts: 1, failed: 1, lastOutcome: "quota", retryAt: now + 60_000 });
});

test("pending login exposes a remedy without inferring a subscription tier", async () => {
  const value = { ...status(), state: "sign_in_required", models: [] };
  const result = await readGeminiWebStatus("http://127.0.0.1:14981", async () => value, { now: () => now });
  expect(result.accounts[0]).toMatchObject({ eligible: false, plan: null, tier: null, remedy: "gemini-web-account login" });
  expect(capacityNoticeKind(result, now)).toBeNull();
});

test("an uncertain submission shows unavailable without claiming drained quota", async () => {
  const value = status() as Record<string, any>;
  value.observations.active = { id: "a".repeat(32), bucket: "video:gemini-auto", started_at: now };
  const result = await readGeminiWebStatus("http://127.0.0.1:14981", async () => value, { now: () => now });
  expect(result.accounts[0]?.eligible).toBe(false);
  expect(result.allEligibleUnavailable).toBeNull();
  expect(capacityNoticeKind(result, now)).toBeNull();
});

test("malformed, stale, and credential-bearing upstream data stay unavailable and sanitized", async () => {
  for (const value of [{ ...status(), observed_at: now - 400_000 }, { ...status(), remaining: 42 },
    { ...status(), models: ["https://example.invalid/?token=private-value"] },
    { ...status(), observations: { schema: "gemini-web.observations/1", buckets: { "video:gemini-auto": { ...bucket, failed: 3 } }, active: null } }]) {
    const result = await readGeminiWebStatus("http://127.0.0.1:14981", async () => value, { now: () => now });
    expect(result.reachable).toBe(false);
    expect(JSON.stringify(result)).not.toContain("private-value");
    expect(result.accounts).toEqual([]);
  }
});

test("Gemini status is explicitly enabled and polls only its credential-free endpoint", async () => {
  expect(providerStatusReaders(providerStatusEndpoints({})).map((item) => item.provider)).toEqual(["codex", "claude"]);
  const readers = providerStatusReaders(providerStatusEndpoints({ WATARI_CODEXLB_URL: "off", WATARI_TEAMCLAUDE_URL: "off", WATARI_GEMINI_WEB_URL: "http://127.0.0.1:14981" }), {
    now: () => now,
    readJson: async (url) => { expect(url).toBe("http://127.0.0.1:14981/local/status"); return status(); },
  });
  expect(readers).toHaveLength(1);
  expect((await readers[0]!.read(new AbortController().signal)).reachable).toBe(true);
});


test("dashboard details render observations and label retry time without showing a quota reset", async () => {
  const service = new ProviderStatusService([{ provider: "gemini-web", source: "gemini-web",
    read: () => readGeminiWebStatus("http://127.0.0.1:14981", async () => status(), { now: () => now }) }], { now: () => now });
  try {
    const view = dashboardRuntime().view(await service.refresh(), now);
    const row = view.groups[0]!.rows[0]!;
    expect(row.status.kind).toBe("unknown");
    const details = JSON.stringify(row.details);
    expect(details).toContain("gemini-auto / video");
    expect(details).toContain("1 submissions");
    expect(details).toContain("not a reset");
    expect(details).toContain("remaining quota and limit scope are unknown");
  } finally { service.close(); }
});
