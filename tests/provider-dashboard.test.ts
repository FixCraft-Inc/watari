import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseArguments } from "../src/watari/cli.ts";
import { DASHBOARD_HTML, dashboardScript } from "../src/watari/provider-dashboard/assets.ts";
import { dashboardRuntime, type DashboardRuntime } from "../src/watari/provider-dashboard/client.ts";
import { renderProviderStatus } from "../src/watari/provider-dashboard/command.ts";
import {
  handleDashboardRequest,
  startProviderDashboard,
  type DashboardRequestContext,
  type ProviderDashboard,
} from "../src/watari/provider-dashboard/server.ts";
import { ProviderStatusService, type ProviderStatusDocument } from "../src/watari/provider-status-api.ts";
import {
  codexProviderBaseUrl,
  isLoopbackHost,
  loopbackJsonReader,
  providerStatusEndpoints,
  providerStatusReaders,
  routedCapacityProviders,
} from "../src/watari/provider-status-readers.ts";

const TOKEN = "t".repeat(43);
const PORT = 41_234;
const HOST = `127.0.0.1:${PORT}`;

function context(service = new ProviderStatusService([])): DashboardRequestContext {
  return { token: TOKEN, port: PORT, service };
}

function request(path: string, init: { method?: string; headers?: Record<string, string> } = {}): Request {
  return new Request(`http://${HOST}${path}`, {
    method: init.method ?? "GET",
    headers: { host: HOST, ...init.headers },
  });
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

interface FakeProvider {
  readonly url: string;
  readonly seen: Headers[];
}

/** A loopback stand-in for CodexLB or TeamClaude. It records request headers. */
function fakeProvider(route: string, answer: () => Response): FakeProvider {
  const seen: Headers[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (incoming) => {
      seen.push(incoming.headers);
      return new URL(incoming.url).pathname === route ? answer() : new Response("not found", { status: 404 });
    },
  });
  cleanups.push(() => server.stop(true));
  return { url: `http://127.0.0.1:${server.port}`, seen };
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });

describe("dashboard boundary", () => {
  test("serves the page and assets with a strict policy and no data", async () => {
    for (const path of ["/", "/app.js", "/app.css"]) {
      const response = await handleDashboardRequest(request(path), context());
      expect(response.status).toBe(200);
      expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
      expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
      expect(response.headers.get("x-frame-options")).toBe("DENY");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
      expect(await response.text()).not.toContain(TOKEN);
    }
    expect(DASHBOARD_HTML).not.toMatch(/<script>|\sstyle=|\son[a-z]+=/u);
  });

  test("the status API needs this run's bearer token", async () => {
    const missing = await handleDashboardRequest(request("/api/provider-status"), context());
    expect(missing.status).toBe(401);
    const wrong = await handleDashboardRequest(
      request("/api/provider-status", { headers: { authorization: `Bearer ${"x".repeat(43)}` } }),
      context(),
    );
    expect(wrong.status).toBe(401);
    const short = await handleDashboardRequest(
      request("/api/provider-status", { headers: { authorization: "Bearer abc" } }),
      context(),
    );
    expect(short.status).toBe(401);
    const ok = await handleDashboardRequest(
      request("/api/provider-status", { headers: { authorization: `Bearer ${TOKEN}` } }),
      context(),
    );
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    expect(ok.headers.get("set-cookie")).toContain("watari_dashboard_token=");
    const cookie = await handleDashboardRequest(
      request("/api/provider-status", { headers: { cookie: `watari_dashboard_token=${TOKEN}` } }),
      context(),
    );
    expect(cookie.status).toBe(200);
    const conflicting = await handleDashboardRequest(
      request("/api/provider-status", { headers: { authorization: "Bearer wrong", cookie: `watari_dashboard_token=${TOKEN}` } }),
      context(),
    );
    expect(conflicting.status).toBe(401);
    expect(await ok.json()).toMatchObject({ schemaVersion: 1, providers: [] });
  });

  test("an explicit malformed Authorization header cannot use the browser cookie", async () => {
    for (const path of ["/api/provider-status", "/api/routing"]) {
      for (const authorization of ["", "Basic invalid", "Bearer", "Bearer invalid!"]) {
        const response = await handleDashboardRequest(
          request(path, { headers: { authorization, cookie: `watari_dashboard_token=${TOKEN}` } }),
          context(),
        );
        expect(response.status).toBe(401);
        expect(response.headers.get("set-cookie")).toBeNull();
      }
    }
  });

  test("refuses a foreign Host, a cross-origin caller, and a cross-site fetch", async () => {
    const authorization = `Bearer ${TOKEN}`;
    const rebinding = await handleDashboardRequest(
      request("/api/provider-status", { headers: { host: `evil.example:${PORT}`, authorization } }),
      context(),
    );
    expect(rebinding.status).toBe(403);
    const otherPort = await handleDashboardRequest(request("/", { headers: { host: "127.0.0.1:1" } }), context());
    expect(otherPort.status).toBe(403);
    const crossOrigin = await handleDashboardRequest(
      request("/api/provider-status", { headers: { origin: "https://evil.example", authorization } }),
      context(),
    );
    expect(crossOrigin.status).toBe(403);
    const crossSite = await handleDashboardRequest(
      request("/api/provider-status", { headers: { "sec-fetch-site": "cross-site", authorization } }),
      context(),
    );
    expect(crossSite.status).toBe(403);
    const sameOrigin = await handleDashboardRequest(
      request("/api/provider-status", { headers: { origin: `http://${HOST}`, "sec-fetch-site": "same-origin", authorization } }),
      context(),
    );
    expect(sameOrigin.status).toBe(200);
  });

  test("has no mutation route", async () => {
    const post = await handleDashboardRequest(
      request("/api/provider-status", { method: "POST", headers: { authorization: `Bearer ${TOKEN}` } }),
      context(),
    );
    expect(post.status).toBe(405);
    expect((await handleDashboardRequest(request("/", { method: "POST" }), context())).status).toBe(405);
    expect((await handleDashboardRequest(request("/api/accounts"), context())).status).toBe(404);
    expect((await handleDashboardRequest(request("/teamclaude/switch", { method: "POST" }), context())).status).toBe(404);
  });

  test("binds 127.0.0.1 and puts the token only in the link fragment", async () => {
    const service = new ProviderStatusService([]);
    const dashboard: ProviderDashboard = startProviderDashboard({ service, token: TOKEN });
    cleanups.push(() => dashboard.stop());
    expect(dashboard.origin).toBe(`http://127.0.0.1:${dashboard.port}`);
    expect(dashboard.port).toBeGreaterThan(0);
    expect(dashboard.launchUrl).toBe(`${dashboard.origin}/#token=${TOKEN}`);
    const page = await fetch(`${dashboard.origin}/`);
    expect(page.status).toBe(200);
    const api = await fetch(`${dashboard.origin}/api/provider-status`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(api.status).toBe(200);
    expect(() => startProviderDashboard({ service, token: "short" })).toThrow("token");
  });
});

describe("dashboard with fake providers", () => {
  test("reads both providers over loopback without sending credentials", async () => {
    const now = Date.now();
    const codexlb = fakeProvider("/api/accounts", () => json({ detail: "Authentication is required" }, 401));
    const teamclaude = fakeProvider("/teamclaude/status", () => json({
      defaultTargets: { anthropic: "claude-a" },
      sessionPins: [{ session: "abcd1234", account: "claude-a", since: now - 60_000, lastUsed: now - 1_000 }],
      accounts: [
        { name: "claude-a", provider: "anthropic", status: "active", unavailable: null, sessions: 2, onExtraUsage: false,
          quota: { unified5h: 0.9, unified5hSeenAt: now - 5_000, unified5hReset: now + 3_600_000 } },
        { name: "claude-b", provider: "anthropic", status: "active", unavailable: null,
          quota: { unified5h: 0.2, unified5hSeenAt: now - 5_000, unified5hReset: now + 3_600_000 } },
      ],
    }));
    const service = new ProviderStatusService(
      providerStatusReaders({ codexlb: codexlb.url, teamclaude: teamclaude.url }),
      { retries: 0 },
    );
    cleanups.push(() => service.close());
    const dashboard = startProviderDashboard({ service, token: TOKEN });
    cleanups.push(() => dashboard.stop());

    const response = await fetch(`${dashboard.origin}/api/provider-status`, { headers: { authorization: `Bearer ${TOKEN}` } });
    const document = await response.json() as ProviderStatusDocument;
    const [codex, claude] = document.providers;
    expect(codex).toMatchObject({ label: "ChatGPT / Codex", reachable: false, capacity: "unknown", allEligibleUnavailable: null, notice: null });
    expect(codex?.error).toContain("requires authentication");
    expect(codex?.error).toContain("sends no provider credential");
    // claude-a is at 90%, but claude-b has room, so the pool raises no notice.
    expect(claude).toMatchObject({ label: "Claude / TeamClaude", reachable: true, capacity: "healthy", noticeKind: null, notice: null });
    expect(claude?.snapshot.currentRoute?.accountAlias).toBe("claude-a");
    expect(claude?.snapshot.sessionPins[0]?.accountAlias).toBe("claude-a");

    for (const headers of [...codexlb.seen, ...teamclaude.seen]) {
      expect(headers.get("authorization")).toBeNull();
      expect(headers.get("cookie")).toBeNull();
      expect(headers.get("x-api-key")).toBeNull();
      expect(headers.get("origin")).toBeNull();
    }
  });

  test("an unreachable provider renders as unknown, not exhausted", async () => {
    const closed = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
    const url = `http://127.0.0.1:${closed.port}`;
    await closed.stop(true);
    const service = new ProviderStatusService(providerStatusReaders({ codexlb: null, teamclaude: url }), { retries: 0 });
    const [claude] = (await service.refresh()).providers;
    expect(claude).toMatchObject({ reachable: false, freshness: "unknown", capacity: "unknown", allEligibleUnavailable: null, notice: null });
  });
});

describe("routing detection", () => {
  test("finds Codex's selected provider URL and ignores other sections", () => {
    const toml = [
      'model_provider = "codex-lb"',
      "",
      "[model_providers.openai]",
      'base_url = "https://api.openai.com/v1"',
      "",
      "[model_providers.codex-lb]",
      'name = "CodexLB"',
      'base_url = "http://127.0.0.1:2455/backend-api/codex"',
      "",
      "[profiles.x]",
      'base_url = "http://wrong"',
    ].join("\n");
    expect(codexProviderBaseUrl(toml)).toBe("http://127.0.0.1:2455/backend-api/codex");
    expect(codexProviderBaseUrl('model = "x"')).toBeNull();
  });

  test("notifies only providers whose harness routes through the pool", () => {
    const home = mkdtempSync(join(tmpdir(), "watari-routing-"));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    mkdirSync(join(home, ".codex"));
    mkdirSync(join(home, ".claude"));
    writeFileSync(join(home, ".codex", "config.toml"), 'model_provider = "lb"\n[model_providers.lb]\nbase_url = "http://localhost:2455/backend-api/codex"\n');
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ env: { OTHER: "1" } }));
    expect([...routedCapacityProviders({}, providerStatusEndpoints({}), home)]).toEqual(["codex"]);
    expect([...routedCapacityProviders({ ANTHROPIC_BASE_URL: "http://127.0.0.1:3456" }, providerStatusEndpoints({}), home)])
      .toEqual(["codex", "claude"]);
    expect([...routedCapacityProviders({ ANTHROPIC_BASE_URL: "http://127.0.0.1:9999" }, providerStatusEndpoints({}), home)])
      .toEqual(["codex"]);
    expect([...routedCapacityProviders({ WATARI_CAPACITY_NOTIFY: "none" }, providerStatusEndpoints({}), home)]).toEqual([]);
    expect([...routedCapacityProviders({ WATARI_CAPACITY_NOTIFY: "claude" }, providerStatusEndpoints({}), home)]).toEqual(["claude"]);
  });

  test("detects project-local Claude routing without changing other projects", () => {
    const home = mkdtempSync(join(tmpdir(), "watari-project-routing-"));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    const project = join(home, "project");
    mkdirSync(join(home, ".claude"), { recursive: true });
    mkdirSync(join(project, ".claude"), { recursive: true });
    const globalSettings = join(home, ".claude", "settings.json");
    const projectSettings = join(project, ".claude", "settings.json");
    const localSettings = join(project, ".claude", "settings.local.json");
    writeFileSync(globalSettings, JSON.stringify({ env: { OTHER: "1" } }));
    writeFileSync(localSettings, JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:3456" } }));
    const routed = (directory?: string) => [...routedCapacityProviders({}, providerStatusEndpoints({}), home, directory)];
    expect(routed(project)).toEqual(["claude"]);
    expect(routed(join(home, "other-project"))).toEqual([]);
    writeFileSync(projectSettings, JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:9999" } }));
    expect(routed(project)).toEqual(["claude"]);
    writeFileSync(globalSettings, JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:3456" } }));
    writeFileSync(localSettings, JSON.stringify({ env: { ANTHROPIC_BASE_URL: "" } }));
    expect(routed(project)).toEqual([]);
    writeFileSync(localSettings, "invalid json");
    expect(routed(project)).toEqual([]);
  });
});

describe("loopback status transport", () => {
  test("accepts loopback hosts only", () => {
    expect(["127.0.0.1", "127.1.2.3", "localhost", "[::1]", "::1"].every(isLoopbackHost)).toBe(true);
    expect(["10.0.0.1", "example.com", "127.0.0.1.example.com", "0.0.0.0", "128.0.0.1"].some(isLoopbackHost)).toBe(false);
    expect(() => providerStatusEndpoints({ WATARI_CODEXLB_URL: "http://192.168.1.5:2455" })).toThrow("loopback");
    expect(() => providerStatusEndpoints({ WATARI_TEAMCLAUDE_URL: "http://user:pass@127.0.0.1:3456" })).toThrow("credentials");
    expect(providerStatusEndpoints({})).toEqual({ codexlb: "http://127.0.0.1:2455/", teamclaude: "http://127.0.0.1:3456/" });
    expect(providerStatusEndpoints({ WATARI_CODEXLB_URL: "off" }).codexlb).toBeNull();
  });

  test("refuses redirects, non-JSON, and oversized bodies", async () => {
    const redirect = fakeProvider("/x", () => new Response(null, { status: 302, headers: { location: "http://example.com/" } }));
    const html = fakeProvider("/x", () => new Response("<html>", { headers: { "Content-Type": "text/html" } }));
    const large = fakeProvider("/x", () => json({ padding: "x".repeat(2_048) }));
    const read = loopbackJsonReader({ maxBytes: 1_024 });
    await expect(read(`${redirect.url}/x`)).rejects.toThrow("redirected");
    await expect(read(`${html.url}/x`)).rejects.toThrow("not JSON");
    await expect(read(`${large.url}/x`)).rejects.toThrow("exceeds");
    await expect(read("http://example.com/x")).rejects.toThrow("loopback");
  });
});

function servedRuntime(): DashboardRuntime {
  const body = dashboardScript()
    .replace(/^"use strict";\n\(/u, "return (")
    .replace(/\)\(\)\.mount\(globalThis\);\n$/u, ")();");
  return new Function(body)() as DashboardRuntime;
}

describe("dashboard view", () => {
  const now = 1_800_000_000_000;
  const DAY = 86_400_000;
  type Row = Record<string, unknown>;

  function window(remainingPercent: number | null, minutes: number | null, extra: Row = {}): Row {
    return {
      usedPercent: remainingPercent === null ? null : 100 - remainingPercent,
      remainingPercent,
      resetAt: now + 3 * 3_600_000,
      windowMinutes: minutes,
      observedAt: now - 60_000,
      freshness: "fresh",
      confidence: "observed",
      ...extra,
    };
  }

  function account(alias: string, extra: Row = {}): Row {
    return {
      accountAlias: alias,
      displayName: null,
      plan: null,
      tier: null,
      eligible: true,
      status: "active",
      preferred: null,
      preference: null,
      priority: null,
      eligibilityReason: null,
      remedy: null,
      primary: window(80, 300),
      secondary: window(60, 10080),
      billing: null,
      lastObservedAt: now,
      freshness: "fresh",
      activeSessions: null,
      source: "codexlb",
      confidence: "observed",
      ...extra,
    };
  }

  function doc(accounts: Row[], group: Row = {}): Row {
    return {
      schemaVersion: 1,
      generatedAt: now,
      providers: [{
        provider: "codex",
        label: "ChatGPT / Codex",
        theme: "codex-light-blue",
        source: "codexlb",
        reachable: true,
        freshness: "fresh",
        capacity: "healthy",
        allEligibleUnavailable: false,
        observedAt: now,
        confidence: "observed",
        noticeKind: null,
        notice: null,
        error: null,
        useOrder: [],
        snapshot: { currentRoute: null, sessionPins: [], accounts },
        ...group,
      }],
    };
  }

  function billing(fields: Row): Row {
    return {
      nextBillingAt: null, renewalAt: null, detail: null, paidThroughAt: null, periodStartAt: null,
      paidThroughCheckedAt: null, creditBalance: null, creditsUnlimited: null, extraUsageActive: null, ...fields,
    };
  }

  const runtimes = () => [dashboardRuntime(), servedRuntime()];

  test("renders absent fields as absent and invents nothing", () => {
    for (const runtime of runtimes()) {
      const [group] = runtime.view(doc([account("acc_1", { eligible: null, primary: window(60, null, { confidence: "derived" }), secondary: null })]), now).groups;
      expect(group!.theme).toBe("codex-light-blue");
      expect(group!.state).toMatchObject({ text: "Live", tone: "good" });
      const row = group!.rows[0]!;
      expect(row.status).toMatchObject({ kind: "unknown", label: "Unknown" });
      expect(row).toMatchObject({ plan: null, paid: null, ends: null, use: null });
      expect(row.short).toMatchObject({ text: "60% left", detail: "resets in 3h", absent: false });
      expect(row.short.title).toContain("did not say when it sampled");
      // The 5-hour window is reported, so a missing weekly one is no limit, not missing data.
      expect(row.long).toMatchObject({ text: "No limit", absent: true, percentLeft: null });
      const labels = row.details.map((fact) => fact.label);
      expect(labels).not.toContain("Ends");
      expect(row.details.find((fact) => fact.label === "Plan")?.value).toBe("Not reported");
    }
  });

  test("names statuses with a glyph and a word", () => {
    const rows = dashboardRuntime().view(doc([
      account("ok"),
      account("near", { primary: window(6, 300) }),
      account("spent", { eligible: false, eligibilityReason: "quota_exceeded", status: "quota_exceeded" }),
      account("login", { eligible: false, eligibilityReason: "refresh rejected", remedy: "teamclaude login" }),
      account("off", { eligible: false, eligibilityReason: "disabled" }),
      account("old", { freshness: "stale" }),
    ]), now).groups[0]!.rows;
    expect(rows.map((row) => [row.status.kind, row.status.glyph, row.status.label])).toEqual([
      ["serve", "✓", "Can serve"],
      ["near", "▲", "Near limit"],
      ["out", "■", "Out of quota"],
      ["login", "!", "Needs login"],
      ["off", "–", "Unavailable"],
      ["unknown", "?", "Unknown"],
    ]);
    expect(rows[3]!.details[0]).toMatchObject({ label: "Why", value: "refresh rejected" });
    expect(rows[3]!.details[1]).toMatchObject({ label: "Fix", value: "teamclaude login", tone: "warn" });
  });

  test("labels window columns by the provider's window length", () => {
    const group = dashboardRuntime().view(doc([account("a"), account("b", { primary: null })]), now).groups[0]!;
    expect([group.shortLabel, group.longLabel]).toEqual(["5-hour", "Weekly"]);
    const mixed = dashboardRuntime().view(doc([account("a", { primary: window(50, null) })]), now).groups[0]!;
    expect(mixed.shortLabel).toBe("Primary");
  });

  test("shows the paid date and an end date that does not renew by itself", () => {
    const rows = dashboardRuntime().view(doc([
      account("soon", { billing: billing({ periodStartAt: now - 21 * DAY, paidThroughAt: now + 9 * DAY, paidThroughCheckedAt: now - 21 * DAY }) }),
      account("ended", { billing: billing({ periodStartAt: now - 40 * DAY, paidThroughAt: now - 10 * DAY, paidThroughCheckedAt: now - 38 * DAY }) }),
      account("none"),
    ]), now).groups[0]!.rows;
    expect(rows[0]).toMatchObject({ endsDetail: "in 9 days", endsTone: null });
    expect(rows[0]!.paid).not.toBeNull();
    expect(rows[0]!.endsTitle).toContain("does not renew by itself");
    expect(rows[1]!.ends).toMatch(/^Ended /u);
    expect(rows[1]).toMatchObject({ endsDetail: "10 days ago", endsTone: "muted" });
    expect(rows[1]!.endsTitle).toContain("last checked it on");
    expect(rows[2]).toMatchObject({ ends: null, paid: null });
    const group = dashboardRuntime().view(doc([
      account("soon", { billing: billing({ paidThroughAt: now + 3 * DAY }) }),
    ]), now).groups[0]!;
    expect(group.facts.find((fact) => fact.label === "Next plan end")?.tone).toBe("warn");
  });

  test("drops the plan and billing columns when the provider reports none of it", () => {
    const silent = dashboardRuntime().view(doc([account("a"), account("b")], { source: "teamclaude" }), now).groups[0]!;
    expect(silent.billingColumns).toBe(false);
    expect(silent.facts.find((fact) => fact.label === "Plans and billing")?.value).toBe("Not reported by TeamClaude");
    const reported = dashboardRuntime().view(doc([account("a", { plan: "plus" })]), now).groups[0]!;
    expect(reported.billingColumns).toBe(true);
  });

  test("summarizes the pool and marks unavailable accounts in the strip", () => {
    const group = dashboardRuntime().view(doc([
      account("a"),
      account("b", { eligible: false, eligibilityReason: "quota_exceeded" }),
      account("c", { freshness: "stale" }),
    ], { useOrder: [{ accountAlias: "a", rank: 1, tier: "short", reason: "Its 5-hour window resets in 3h with 80% left" }] }), now).groups[0]!;
    expect(group.headline).toBe("1 of 3 accounts can serve");
    expect(group.cells.map((cell) => [cell.kind, cell.fill])).toEqual([["serve", 60], ["out", 0], ["unknown", null]]);
    expect(group.facts[0]).toMatchObject({ label: "Use next", value: "a" });
    expect(group.rows[0]!.use).toEqual({ rank: 1, reason: "Its 5-hour window resets in 3h with 80% left" });
    expect(group.rows[1]!.use).toBeNull();
  });

  test("sorts by use order by default and filters and searches rows", () => {
    const runtime = dashboardRuntime();
    const rows = runtime.view(doc([
      account("zeta"),
      account("alpha"),
      account("spent", { eligible: false, eligibilityReason: "quota_exceeded" }),
    ], { useOrder: [
      { accountAlias: "zeta", rank: 1, tier: "short", reason: "first" },
      { accountAlias: "alpha", rank: 2, tier: "reserve", reason: "second" },
    ] }), now).groups[0]!.rows;
    const base = { sort: "use" as const, descending: false, filter: "all" as const, query: "" };
    expect(runtime.arrange(rows, base).map((row) => row.name)).toEqual(["zeta", "alpha", "spent"]);
    expect(runtime.arrange(rows, { ...base, sort: "name" }).map((row) => row.name)).toEqual(["alpha", "spent", "zeta"]);
    expect(runtime.arrange(rows, { ...base, filter: "unavailable" }).map((row) => row.name)).toEqual(["spent"]);
    expect(runtime.arrange(rows, { ...base, filter: "serve", query: "ALP" }).map((row) => row.name)).toEqual(["alpha"]);
  });

  test("the served script mounts without touching anything when the page is missing", () => {
    expect(() => servedRuntime().mount({ document: { getElementById: () => null } })).not.toThrow();
  });
});

describe("dashboard page startup", () => {
  type Child = FakeNode | string;
  class FakeNode {
    textContent: string | null = null;
    className = "";
    value = "";
    disabled = false;
    children: Child[] = [];
    readonly attributes = new Map<string, string>();
    readonly listeners = new Map<string, ((event: unknown) => void)[]>();
    readonly style = { setProperty: (_name: string, _value: string) => undefined };
    constructor(readonly tag: string) {}
    append(...nodes: Child[]) { this.children.push(...nodes); }
    replaceChildren(...nodes: Child[]) { this.children = [...nodes]; }
    setAttribute(name: string, value: string) { this.attributes.set(name, value); }
    getAttribute(name: string) { return this.attributes.get(name) ?? null; }
    removeAttribute(name: string) { this.attributes.delete(name); }
    addEventListener(type: string, handler: (event: unknown) => void) {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), handler]);
    }
    focus() {}
    text(): string {
      return [this.textContent ?? "", ...this.children.map((child) => (typeof child === "string" ? child : child.text()))].join(" ");
    }
    count(tag: string): number {
      return (this.tag === tag ? 1 : 0) + this.children.reduce((sum, child) => sum + (typeof child === "string" ? 0 : child.count(tag)), 0);
    }
  }

  const memory = () => {
    const values = new Map<string, string>();
    return {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
      removeItem: (key: string) => void values.delete(key),
    };
  };

  function page(
    hash: string,
    fetchImpl: (url: string) => Promise<{ status: number; ok: boolean; json(): Promise<unknown> }>,
    localStorage = memory(),
    sessionStorage = memory(),
  ) {
    const ids: Record<string, FakeNode> = Object.fromEntries(["main", "jump", "status", "refresh", "auto"].map((id) => [id, new FakeNode(id)]));
    const globals = {
      document: { createElement: (tag: string) => new FakeNode(tag), getElementById: (id: string) => ids[id] ?? null, querySelector: () => null, activeElement: null },
      location: { hash, pathname: "/" },
      history: { replaceState: () => undefined },
      sessionStorage,
      localStorage,
      fetch: (url: string) => fetchImpl(url),
      setTimeout: () => 1,
      clearTimeout: () => undefined,
    };
    return { ids, globals };
  }

  const settle = async () => {
    for (let pass = 0; pass < 10; pass += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  };

  const statusDocument = {
    schemaVersion: 1,
    generatedAt: Date.now(),
    providers: [{
      provider: "codex", label: "ChatGPT / Codex", theme: "codex-light-blue", source: "codexlb", reachable: true,
      freshness: "fresh", capacity: "healthy", allEligibleUnavailable: false, observedAt: Date.now(), confidence: "observed",
      noticeKind: null, notice: null, error: null, useOrder: [],
      snapshot: { currentRoute: null, sessionPins: [], accounts: [{ accountAlias: "a", eligible: true, freshness: "fresh", primary: null, secondary: null, preference: "normal" }] },
    }],
  };
  const routing = { providers: { codex: { mode: "suggest", planned: [], idle: "Routing already matches the use order.", lastAppliedAt: null, lastError: null } }, log: [] };
  const ok = (value: unknown) => Promise.resolve({ status: 200, ok: true, json: async () => value });

  for (const [name, make] of [["module", () => dashboardRuntime()], ["served script", () => servedRuntime()]] as const) {
    test(`renders providers and routing from the ${name}`, async () => {
      const { ids, globals } = page(`#token=${TOKEN}`, (url) => ok(url.startsWith("/api/routing") ? routing : statusDocument));
      make().mount(globals);
      await settle();
      const main = ids["main"]!.text();
      expect(main).toContain("ChatGPT / Codex");
      expect(main).toContain("Watari routing");
      expect(main).toContain("Routing already matches the use order.");
      expect(ids["auto"]!.count("option")).toBe(4);
      expect(ids["status"]!.text()).toContain("Updated");
    });
  }

  test("says plainly when the link has no token or the server is down", async () => {
    const missing = page("", () => Promise.resolve({ status: 401, ok: false, json: async () => ({}) }));
    servedRuntime().mount(missing.globals);
    await settle();
    expect(missing.ids["main"]!.text()).toContain("This link has no access token");

    const down = page(`#token=${TOKEN}`, () => Promise.reject(new Error("connection refused")));
    servedRuntime().mount(down.globals);
    await settle();
    expect(down.ids["main"]!.text()).toContain("The dashboard is not answering");

    const expired = page(`#token=${TOKEN}`, () => Promise.resolve({ status: 401, ok: false, json: async () => ({}) }));
    servedRuntime().mount(expired.globals);
    await settle();
    expect(expired.ids["main"]!.text()).toContain("This link does not work");
  });

  test("keeps the link after the browser session ends", async () => {
    const first = page(`#token=${TOKEN}`, () => ok(statusDocument));
    servedRuntime().mount(first.globals);
    await settle();

    const reopened = page("", () => ok(statusDocument), first.globals.localStorage);
    servedRuntime().mount(reopened.globals);
    await settle();
    expect(reopened.ids["main"]!.text()).toContain("ChatGPT / Codex");
  });
});

describe("CLI", () => {
  test("parses the dashboard and providers verbs", () => {
    expect(parseArguments(["dashboard"])).toEqual({ command: "dashboard", port: 4455, action: "serve", routing: null });
    expect(parseArguments(["dashboard", "--port", "8765", "--routing", "auto"]))
      .toEqual({ command: "dashboard", port: 8765, action: "serve", routing: "auto" });
    expect(parseArguments(["dashboard", "--install"])).toMatchObject({ action: "install" });
    expect(parseArguments(["dashboard", "--link"])).toMatchObject({ action: "link" });
    expect(() => parseArguments(["dashboard", "--install", "--link"])).toThrow("choose one");
    expect(() => parseArguments(["dashboard", "--routing", "always"])).toThrow("--routing");
    expect(() => parseArguments(["dashboard", "--port"])).toThrow("--port");
    expect(() => parseArguments(["dashboard", "--port", "70000"])).toThrow("--port");
    expect(() => parseArguments(["dashboard", "--host", "0.0.0.0"])).toThrow("unknown option");
    expect(parseArguments(["providers", "--json"])).toEqual({ command: "providers", json: true });
    expect(() => parseArguments(["providers", "extra"])).toThrow("no arguments");
  });

  test("the terminal summary keeps unknowns unknown", () => {
    const text = renderProviderStatus({
      schemaVersion: 1,
      generatedAt: 0,
      providers: [{
        provider: "codex", group: "codex", label: "ChatGPT / Codex", theme: "codex-light-blue", source: "codexlb",
        reachable: false, freshness: "unknown", capacity: "unknown", allEligibleUnavailable: null, observedAt: null,
        confidence: "unknown", noticeKind: null, notice: null, error: "127.0.0.1:2455 requires authentication", useOrder: [],
        snapshot: {
          provider: "codex", source: "codexlb", observedAt: null, freshness: "unknown", reachable: false, accounts: [],
          currentRoute: null, sessionPins: [], allEligibleUnavailable: null, capacity: "unknown", error: null,
        },
      }],
    });
    expect(text).toContain("not reachable, unknown, capacity unknown");
    expect(text).toContain("requires authentication");
    expect(text).toContain("no account data");
    expect(text).not.toMatch(/exhausted|drained/u);
  });
});
