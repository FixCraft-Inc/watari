import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openCodePoolProfile, parsePoolCommand } from "../src/watari/gemini-pool/command.ts";
import { GeminiPool, handlePoolRequest, isDailyFreeQuota, nextPacificMidnight, pacificDay } from "../src/watari/gemini-pool/pool.ts";
import { enrollProject, initializePool, loadPoolConfig, loadPoolState, lockPool, PoolConfigSchema, readPoolKey, readPrivate, writePrivate, type PoolConfig, type PoolState } from "../src/watari/gemini-pool/store.ts";

const MODEL = "gemini-4-hydrogen";
const TOKEN = "local_test_token_not_a_real_google_credential";
const KEY_A = "fake_google_key_for_project_alpha";
const KEY_B = "fake_google_key_for_project_bravo";
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });

const config: PoolConfig = { schemaVersion: 1, models: [MODEL], projects: [
  { label: "alpha", projectId: "alpha-project", keyFile: `${"a".repeat(32)}.key`, billingDisabledConfirmed: true },
  { label: "bravo", projectId: "bravo-project", keyFile: `${"b".repeat(32)}.key`, billingDisabledConfirmed: true },
] };

function quota(id = "GenerateRequestsPerDayPerProjectPerModel-FreeTier", model = MODEL): unknown {
  return { error: { code: 429, details: [{ "@type": "type.googleapis.com/google.rpc.QuotaFailure",
    violations: [{ quotaId: id, quotaDimensions: { model } }] }] } };
}

function request(path = `/v1beta/models/${MODEL}:generateContent`, init: RequestInit = {}): Request {
  return new Request(`http://127.0.0.1:4466${path}`, { method: "POST", body: JSON.stringify({ contents: [{ parts: [{ text: "synthetic fixture" }] }] }),
    ...init, headers: { host: "127.0.0.1:4466", "x-goog-api-key": TOKEN, "content-type": "application/json", ...init.headers },
  });
}

function setup(handler: (index: number, url: string, init: RequestInit) => Response | Promise<Response>, initial?: PoolState) {
  let now = Date.parse("2026-11-15T12:00:00Z");
  const seen: RequestInit[] = [];
  const states: PoolState[] = [];
  const pool = new GeminiPool({ config, keys: new Map([["alpha-project", KEY_A], ["bravo-project", KEY_B]]),
    ...(initial ? { state: initial } : {}), now: () => now,
    save: (value) => { states.push(structuredClone(value)); },
    fetch: async (url, init) => { seen.push(init); return await handler(seen.length, url, init); },
  });
  return { pool, seen, states, advance: (ms: number) => { now += ms; },
    send: (req = request()) => handlePoolRequest(req, pool, TOKEN, 4466),
  };
}

describe("Gemini free-project routing", () => {
  test("rotates once on confirmed daily free exhaustion and preserves body and signatures", async () => {
    const fixture = setup((index, url, init) => {
      expect(url.startsWith("https://generativelanguage.googleapis.com/v1beta/models/" + MODEL)).toBe(true);
      expect(init.redirect).toBe("manual");
      expect(init.credentials).toBe("omit");
      return index === 1 ? Response.json(quota(), { status: 429 }) : Response.json({ modelVersion: MODEL, thoughtSignature: "opaque-fixture" });
    });
    const response = await fixture.send();
    expect(response.status).toBe(200);
    expect(response.headers.get("x-watari-project")).toBe("bravo");
    expect(await response.json()).toEqual({ modelVersion: MODEL, thoughtSignature: "opaque-fixture" });
    expect(fixture.seen.map((init) => new Headers(init.headers).get("x-goog-api-key"))).toEqual([KEY_A, KEY_B]);
    expect(fixture.seen[0]!.body).toEqual(fixture.seen[1]!.body);
    const next = await fixture.send();
    await next.text();
    expect(new Headers(fixture.seen[2]!.headers).get("x-goog-api-key")).toBe(KEY_B);
    expect(JSON.stringify(fixture.pool.status())).not.toContain(KEY_A);
  });

  test("reserves and persists an attempt before any network operation", async () => {
    const fixture = setup(() => {
      expect(fixture.states[0]!.buckets["alpha-project/" + MODEL]!.attempts).toBe(1);
      return Response.json({ ok: true });
    });
    await (await fixture.send()).text();
  });

  test("independent requests balance ready projects and preserve that history across restart", async () => {
    const fixture = setup(() => Response.json({ ok: true }));
    await (await fixture.send()).text();
    const restored = setup(() => Response.json({ ok: true }), fixture.states.at(-1)!);
    const next = await restored.send();
    expect(next.headers.get("x-watari-project")).toBe("bravo");
    await next.text();
    const tied = await restored.send();
    expect(tied.headers.get("x-watari-project")).toBe("alpha");
    await tied.text();
  });

  test("balancing reaches an unused project before another request to its previously used sibling", async () => {
    const time = Date.parse("2026-11-15T12:00:00Z");
    const fixture = setup(() => Response.json({ ok: true }), { schemaVersion: 1, buckets: {
      ["alpha-project/" + MODEL]: { day: pacificDay(time), attempts: 29, exhaustedUntil: 0, cooldownUntil: 0 },
    } });
    const response = await fixture.send();
    expect(response.headers.get("x-watari-project")).toBe("bravo");
    await response.text();
    expect(fixture.seen).toHaveLength(1);
  });

  test("a failed state write sends no request", async () => {
    let calls = 0;
    const pool = new GeminiPool({ config, keys: new Map([["alpha-project", KEY_A], ["bravo-project", KEY_B]]),
      save: () => { throw new Error("disk failure"); }, fetch: async () => { calls += 1; return Response.json({}); },
    });
    expect((await pool.generate(request(), MODEL, "generateContent")).status).toBe(503);
    expect(calls).toBe(0);
  });

  test("exhausted buckets survive restart and reset on the next Pacific day", async () => {
    const fixture = setup(() => Response.json(quota(), { status: 429 }));
    expect((await fixture.send()).status).toBe(429);
    expect(fixture.seen).toHaveLength(2);
    expect((await fixture.send()).status).toBe(429);
    expect(fixture.seen).toHaveLength(2);
    const restored = setup(() => Response.json({ ok: true }), fixture.states.at(-1)!);
    expect((await restored.send()).status).toBe(429);
    expect(restored.seen).toHaveLength(0);
    restored.advance(24 * 60 * 60_000);
    expect((await restored.send()).status).toBe(200);
    restored.pool.close();
  });

  test.each([
    "GenerateRequestsPerMinutePerProjectPerModel-FreeTier",
    "GenerateContentInputTokensPerModelPerMinute-FreeTier",
  ])("rotates on confirmed project minute limit %s and preserves the request", async (id) => {
    const fixture = setup((index) => index === 1
      ? Response.json(quota(id), { status: 429, headers: { "Retry-After": "90" } })
      : Response.json({ ok: true }));
    const response = await fixture.send();
    expect(response.status).toBe(200);
    expect(response.headers.get("x-watari-project")).toBe("bravo");
    await response.text();
    expect(fixture.seen).toHaveLength(2);
    expect(fixture.seen[0]!.body).toEqual(fixture.seen[1]!.body);
    expect(fixture.states.at(-1)?.buckets["alpha-project/" + MODEL]).toMatchObject({
      exhaustedUntil: 0, lastQuotaFailure: { kind: "minute", violations: [{ quotaId: id, limit: null }] },
    });
    await (await fixture.send()).text();
    expect(fixture.seen).toHaveLength(3);
    expect(new Headers(fixture.seen[2]!.headers).get("x-goog-api-key")).toBe(KEY_B);
  });

  test.each([
    "GenerateRequestsPerDayPerProjectPerModel",
    "unknown-quota",
  ])("does not rotate for %s", async (id) => {
    const fixture = setup(() => Response.json(quota(id), { status: 429, headers: { "Retry-After": "90" } }));
    const answer = await fixture.send();
    expect(answer.status).toBe(429);
    expect(answer.headers.get("retry-after")).toBe("90");
    expect(fixture.seen).toHaveLength(1);
    expect((await fixture.send()).status).toBe(429);
    expect(fixture.seen).toHaveLength(1);
    fixture.advance(91_000);
    await fixture.send();
    expect(fixture.seen).toHaveLength(2);
    expect(new Headers(fixture.seen[1]!.headers).get("x-goog-api-key")).toBe(KEY_B);
  });

  test("each project is tried once, and an all-minute limit uses the first retry instead of midnight", async () => {
    const fixture = setup((index) => Response.json(quota("GenerateRequestsPerMinutePerProjectPerModel-FreeTier"), {
      status: 429, headers: { "Retry-After": index === 1 ? "90" : "30" },
    }));
    const response = await fixture.send();
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("30");
    expect(await response.text()).toContain("temporarily cooling down");
    expect(fixture.seen).toHaveLength(2);
    await fixture.send();
    expect(fixture.seen).toHaveLength(2);
    fixture.advance(31_000);
    await fixture.send();
    expect(fixture.seen).toHaveLength(3);
    expect(new Headers(fixture.seen[2]!.headers).get("x-goog-api-key")).toBe(KEY_B);
  });

  test("daily exhaustion on early projects and a minute cap on the next do not hide an unused sibling", async () => {
    let calls = 0;
    const projects = ["alpha", "bravo", "charlie", "delta"].map((name, index) => ({
      label: name, projectId: `${name}-project`, keyFile: `${String(index).repeat(32)}.key`, billingDisabledConfirmed: true as const,
    }));
    const pool = new GeminiPool({ config: { ...config, projects },
      keys: new Map(projects.map((project) => [project.projectId, `synthetic_${project.label}_private_key`])),
      save: () => undefined, fetch: async () => {
        calls += 1;
        if (calls <= 2) return Response.json(quota(), { status: 429 });
        if (calls === 3) return Response.json(quota("GenerateContentInputTokensPerModelPerMinute-FreeTier"), { status: 429 });
        return Response.json({ ok: true });
      },
    });
    const response = await pool.generate(request(), MODEL, "generateContent");
    expect(response.status).toBe(200);
    expect(response.headers.get("x-watari-project")).toBe("delta");
    await response.text();
    expect(calls).toBe(4);
  });

  test("safe quota IDs and numeric limits survive restart without storing error messages or credentials", async () => {
    const fixture = setup(() => Response.json({ error: { message: KEY_A, details: [{
      "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [
        { quotaId: "GenerateContentInputTokensPerModelPerMinute-FreeTier", quotaDimensions: { model: MODEL }, quotaValue: "250000" },
      ],
    }] } }, { status: 429 }));
    await fixture.send();
    const saved = fixture.states.at(-1)!;
    expect(saved.buckets["alpha-project/" + MODEL]?.lastQuotaFailure).toMatchObject({
      kind: "minute", violations: [{ quotaId: "GenerateContentInputTokensPerModelPerMinute-FreeTier", limit: 250000 }],
    });
    const restored = setup(() => Response.json({}), saved);
    expect(JSON.stringify(restored.pool.status())).toContain("250000");
    expect(JSON.stringify(restored.pool.status())).not.toContain(KEY_A);
    const malicious = setup(() => Response.json({ error: { details: [{
      "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaId: KEY_A }],
    }] } }, { status: 429 }));
    await malicious.send();
    expect(JSON.stringify(malicious.states)).not.toContain(KEY_A);
    expect(JSON.stringify(malicious.pool.status())).not.toContain(KEY_A);
  });

  test("mixed unknown limits and model mismatches never authorize minute rotation", async () => {
    for (const detail of [
      quota("GenerateRequestsPerMinutePerProjectPerModel-FreeTier", "gemini-other"),
      { error: { details: [{ "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [
        { quotaId: "GenerateRequestsPerMinutePerProjectPerModel-FreeTier" }, { quotaId: "GlobalRequestsPerMinute" },
      ] }] } },
    ]) {
      const fixture = setup(() => Response.json(detail, { status: 429 }));
      expect((await fixture.send()).status).toBe(429);
      expect(fixture.seen).toHaveLength(1);
    }
  });

  test.each(["alpha-project", "bravo-project"])("old unclassified cooldown on %s blocks balancing until expiry", async (projectId) => {
    const time = Date.parse("2026-11-15T12:00:00Z");
    const fixture = setup(() => Response.json({}), { schemaVersion: 1, buckets: {
      [projectId + "/" + MODEL]: { day: pacificDay(time), attempts: 2, exhaustedUntil: 0, cooldownUntil: time + 60_000 },
    } });
    expect((await fixture.send()).status).toBe(429);
    expect(fixture.seen).toHaveLength(0);
    fixture.advance(61_000);
    await (await fixture.send()).text();
    expect(fixture.seen).toHaveLength(1);
  });

  test("a different model's quota or an unstructured error cannot authorize rotation", async () => {
    expect(isDailyFreeQuota(quota(undefined, "gemini-other"), MODEL)).toBe(false);
    const fixture = setup(() => new Response(`private upstream detail ${KEY_A}`, { status: 429 }));
    const answer = await fixture.send();
    expect(await answer.text()).not.toContain(KEY_A);
    expect(fixture.seen).toHaveLength(1);
  });

  test.each([400, 401, 403, 500, 503, 307])("HTTP %s is redacted and never replayed", async (status) => {
    const fixture = setup(() => new Response(KEY_A, { status, headers: { location: "https://elsewhere.invalid", "Set-Cookie": "private" } }));
    const answer = await fixture.send();
    expect(answer.status).toBe(502);
    expect(await answer.text()).not.toContain(KEY_A);
    expect(answer.headers.has("location")).toBe(false);
    expect(answer.headers.has("set-cookie")).toBe(false);
    expect(fixture.seen).toHaveLength(1);
  });

  test("an ambiguous transport failure is not retried with another key", async () => {
    const fixture = setup(() => { throw new Error(KEY_A); });
    const answer = await fixture.send();
    expect(answer.status).toBe(502);
    expect(await answer.text()).not.toContain(KEY_A);
    expect(fixture.seen).toHaveLength(1);
  });

  test("serialization lasts through streaming and cancellation releases it", async () => {
    let cancelled = false;
    const fixture = setup(() => new Response(new ReadableStream<Uint8Array>({
      start: (controller) => controller.enqueue(new TextEncoder().encode("data: synthetic\n\n")),
      cancel: () => { cancelled = true; },
    })));
    const streamed = await fixture.send(request(`/v1beta/models/${MODEL}:streamGenerateContent?alt=sse`));
    expect(streamed.headers.get("content-type")).toBe("text/event-stream");
    expect((await fixture.send()).status).toBe(429);
    const reader = streamed.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: synthetic\n\n");
    await reader.cancel();
    expect(cancelled).toBe(true);
    const next = await fixture.send();
    expect(next.status).toBe(200);
    await next.body!.cancel();
  });

  test("shutdown aborts an unread upstream stream and releases ownership", async () => {
    let cancelled = false;
    const fixture = setup(() => new Response(new ReadableStream<Uint8Array>({ cancel: () => { cancelled = true; } })));
    const response = await fixture.send();
    fixture.pool.close();
    await expect(response.text()).rejects.toThrow("interrupted");
    expect(cancelled).toBe(true);
    expect((fixture.pool.status() as { busy: boolean }).busy).toBe(false);
  });

  test("cancelled requests never reach Google", async () => {
    const fixture = setup(() => Response.json({}));
    const controller = new AbortController();
    controller.abort();
    expect((await fixture.send(request(undefined, { signal: controller.signal }))).status).toBe(499);
    expect(fixture.seen).toHaveLength(0);
  });

  test("shutdown cancels a stalled request body without sending a model request", async () => {
    let cancelled = false;
    const fixture = setup(() => Response.json({}));
    const body = new ReadableStream<Uint8Array>({ cancel: () => { cancelled = true; } });
    const pending = fixture.send(request(undefined, { body }));
    fixture.pool.close();
    expect((await pending).status).toBe(499);
    expect(cancelled).toBe(true);
    expect(fixture.seen).toHaveLength(0);
  });

  test("a RetryInfo cooldown survives a calendar-day change", async () => {
    const boundary = nextPacificMidnight(Date.parse("2026-11-15T12:00:00Z"));
    let now = boundary - 1_000;
    let calls = 0;
    const pool = new GeminiPool({ config, keys: new Map([["alpha-project", KEY_A], ["bravo-project", KEY_B]]),
      save: () => undefined, now: () => now,
      fetch: async () => { calls += 1; return Response.json({ error: { details: [
        { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "90s" },
      ] } }, { status: 429 }); },
    });
    await pool.generate(request(), MODEL, "generateContent");
    now = boundary + 1_000;
    expect((await pool.generate(request(), MODEL, "generateContent")).status).toBe(429);
    expect(calls).toBe(1);
  });

  test("no project can silently select a different model or operation", async () => {
    const fixture = setup(() => Response.json({}));
    for (const path of ["/v1beta/models/gemini-paid:generateContent", `/v1beta/models/${MODEL}:countTokens`, "/v1beta/interactions"]) {
      expect((await fixture.send(request(path))).status).toBeGreaterThanOrEqual(400);
    }
    expect(fixture.seen).toHaveLength(0);
  });
});

describe("local credential boundary", () => {
  test("rejects browsers, forged hosts, missing tokens and key-bearing queries before network", async () => {
    const fixture = setup(() => Response.json({}));
    for (const headers of [{ origin: "https://attacker.invalid" }, { host: "attacker.invalid:4466" }, { "x-goog-api-key": "wrong" }, { "sec-fetch-site": "cross-site" }]) {
      expect((await fixture.send(request(undefined, { headers }))).status).toBeGreaterThanOrEqual(400);
    }
    expect((await fixture.send(request(`/v1beta/models/${MODEL}:generateContent?key=private`))).status).toBe(400);
    expect(fixture.seen).toHaveLength(0);
  });

  test("HTTP loopback integration strips client credentials and preserves exact JSON", async () => {
    const fixture = setup((_index, _url, init) => {
      expect(new Headers(init.headers).has("authorization")).toBe(false);
      expect(new Headers(init.headers).has("cookie")).toBe(false);
      return Response.json({ ok: true });
    });
    const server: ReturnType<typeof Bun.serve> = Bun.serve({ hostname: "127.0.0.1", port: 0,
      fetch: (req): Promise<Response> => handlePoolRequest(req, fixture.pool, TOKEN, server.port!),
    });
    cleanup.push(() => server.stop(true));
    const response = await fetch(`http://127.0.0.1:${server.port}/v1beta/models/${MODEL}:generateContent`, {
      method: "POST", headers: { authorization: `Bearer ${TOKEN}`, cookie: "unrelated=private", "content-type": "application/json" },
      body: JSON.stringify({ contents: [] }),
    });
    expect(await response.json()).toEqual({ ok: true });
  });

  test("malformed and oversized JSON requests are refused without a Google call", async () => {
    const fixture = setup(() => Response.json({}));
    expect((await fixture.send(request(undefined, { body: "[1,2]" }))).status).toBe(400);
    expect((await fixture.send(request(undefined, { body: "x".repeat(8 * 1024 * 1024 + 1) }))).status).toBe(413);
    expect(fixture.seen).toHaveLength(0);
  });

  function directory(): string {
    const dir = mkdtempSync(join(tmpdir(), "watari-gemini-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
  }

  test("initialization and enrollment are private, exclusive and preserve existing credentials", () => {
    const dir = directory();
    initializePool(dir);
    const token = readPrivate(join(dir, "token"));
    expect(() => initializePool(dir)).toThrow("already initialized");
    expect(readPrivate(join(dir, "token"))).toBe(token);
    expect(statSync(join(dir, "config.json")).mode & 0o777).toBe(0o600);
    const source = join(dir, "source.key");
    writeFileSync(source, KEY_A, { mode: 0o600 });
    enrollProject(dir, "alpha", "alpha-project", source);
    expect(loadPoolConfig(dir).projects).toHaveLength(1);
    expect(readFileSync(join(dir, "config.json"), "utf8")).not.toContain(KEY_A);
    expect(() => enrollProject(dir, "another", "another-project", source)).toThrow("already enrolled");
    const unlock = lockPool(dir);
    expect(() => enrollProject(dir, "another", "another-project", source)).toThrow("locked");
    unlock();
    expect(existsSync(join(dir, "owner.lock"))).toBe(false);
  });

  test("opaque Google keys may contain dots but cannot contain header whitespace", () => {
    const dir = directory();
    initializePool(dir);
    const source = join(dir, "source.key");
    const dotted = "synthetic.dotted_google_key_fixture";
    writeFileSync(source, dotted, { mode: 0o600 });
    enrollProject(dir, "alpha", "alpha-project", source);
    const file = loadPoolConfig(dir).projects[0]!.keyFile;
    expect(readPoolKey(dir, file)).toBe(dotted);
    writeFileSync(source, "synthetic.\r\ninvalid_header_value", { mode: 0o600 });
    expect(() => enrollProject(dir, "bravo", "bravo-project", source)).toThrow("invalid private Google key file");
    writeFileSync(join(dir, "keys", file), "synthetic. invalid_header_value", { mode: 0o600 });
    expect(() => readPoolKey(dir, file)).toThrow("invalid private Google key file");
  });

  test("unsafe files and corrupt quota evidence fail closed", () => {
    const dir = directory();
    initializePool(dir);
    const path = join(dir, "source.key");
    writeFileSync(path, KEY_A, { mode: 0o644 });
    expect(() => readPrivate(path)).toThrow("mode 600");
    chmodSync(path, 0o600);
    const linked = join(dir, "linked.key");
    symlinkSync(path, linked);
    expect(() => readPrivate(linked)).toThrow();
    writeFileSync(join(dir, "state.json"), "not json", { mode: 0o600 });
    expect(() => loadPoolState(dir)).toThrow("refusing to reset");
  });

  test("full-capacity quota evidence remains readable after restart while oversized files fail closed", () => {
    const dir = directory();
    initializePool(dir);
    const state: PoolState = { schemaVersion: 1, buckets: {} };
    for (let index = 0; index < 256; index += 1) {
      state.buckets[`project-${index}/${MODEL}`] = {
        day: "2026-11-15", attempts: Number.MAX_SAFE_INTEGER, exhaustedUntil: 0, cooldownUntil: 1794783359377,
        lastQuotaFailure: {
          kind: "unknown", observedAt: 1794783299377, retryAt: 1794783359377,
          violations: Array.from({ length: 32 }, (_, quotaIndex) => ({
            quotaId: `quota-${quotaIndex}`.padEnd(200, "x"), limit: Number.MAX_SAFE_INTEGER,
          })),
        },
      };
    }
    writePrivate(dir, "state.json", JSON.stringify(state, null, 2) + "\n");
    expect(statSync(join(dir, "state.json")).size).toBeGreaterThan(128 * 1024);
    expect(loadPoolState(dir)).toEqual(state);
    writePrivate(dir, "state.json", " ".repeat(4 * 1024 * 1024 + 1));
    expect(() => loadPoolState(dir)).toThrow("refusing to reset");
  });

  test("one project cannot be enrolled as multiple independent quota buckets", () => {
    expect(PoolConfigSchema.safeParse({ ...config, projects: [config.projects[0], { ...config.projects[1], projectId: "alpha-project" }] }).success).toBe(false);
    expect(PoolConfigSchema.safeParse({ ...config, projects: [{ ...config.projects[0], billingDisabledConfirmed: false }] }).success).toBe(false);
  });

  test("OpenCode receives a token-file reference and the same model for small tasks", () => {
    const text = JSON.stringify(openCodePoolProfile("/private/test", 4466, MODEL));
    expect(text).toContain("{file:/private/test/token}");
    expect(text).not.toContain(KEY_A);
    expect(text).toContain(`"small_model":"google/${MODEL}"`);
    expect(text).toContain("http://127.0.0.1:4466/v1beta");
  });

  test("enrollment requires the billing-disabled attestation and a file instead of argv key text", () => {
    expect(() => parsePoolCommand(["add", "alpha", "alpha-project", "--key-file", "/private/key"])).toThrow();
    expect(() => parsePoolCommand(["add", "alpha", "alpha-project", "--api-key", KEY_A, "--billing-disabled"])).toThrow();
    expect(parsePoolCommand(["add", "alpha", "alpha-project", "--key-file", "/private/key", "--billing-disabled"]).action).toBe("add");
    expect(() => parsePoolCommand(["serve", "--port", "4466", "--port", "4467"])).toThrow();
  });
});

describe("Pacific quota reset", () => {
  test.each([
    ["2026-03-08T07:59:59Z", "2026-03-08T08:00:00Z"],
    ["2026-03-08T08:00:00Z", "2026-03-09T07:00:00Z"],
    ["2026-11-01T07:00:00Z", "2026-11-02T08:00:00Z"],
  ])("resets correctly across DST from %s", (before, after) => {
    const reset = nextPacificMidnight(Date.parse(before));
    expect(new Date(reset).toISOString()).toBe(new Date(after).toISOString());
    expect(pacificDay(reset - 1)).not.toBe(pacificDay(reset));
  });
});
