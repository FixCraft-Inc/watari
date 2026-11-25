import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  codexLbRoutingController,
  fileRoutingStore,
  loopbackJsonWrite,
  persistentDashboardToken,
  teamClaudeRoutingController,
} from "../src/watari/provider-control-clients.ts";
import { handleDashboardRequest } from "../src/watari/provider-dashboard/server.ts";
import {
  ProviderRouter,
  codexLbController,
  teamClaudeController,
  type RoutingChange,
} from "../src/watari/provider-routing-control.ts";
import { ProviderStatusService, type ProviderStatusDocument } from "../src/watari/provider-status-api.ts";
import { readCodexLbStatus, readTeamClaudeStatus } from "../src/watari/provider-status.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

function codexRow(id: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Date.now();
  return {
    accountId: id,
    displayName: id,
    planType: "plus",
    status: "active",
    eligible: true,
    routingPolicy: "normal",
    usageSampledAt: new Date(now - 60_000).toISOString(),
    primary: { remainingPercent: 60, resetAt: new Date(now + 2 * HOUR).toISOString(), windowMinutes: 300 },
    secondary: { remainingPercent: 70, resetAt: new Date(now + 4 * DAY).toISOString(), windowMinutes: 10080 },
    ...fields,
  };
}

function claudeRow(name: string, used5h: number, resetIn: number, priority = 0): Record<string, unknown> {
  const now = Date.now();
  return {
    name,
    provider: "anthropic",
    status: "active",
    unavailable: null,
    priority,
    quota: { unified5h: used5h, unified5hReset: now + resetIn, unified5hSeenAt: now - 1_000, unified7d: 0.2, unified7dReset: now + 5 * DAY, unified7dSeenAt: now - 1_000 },
  };
}

function service(codex: () => Record<string, unknown>[], claude: () => Record<string, unknown>[]): ProviderStatusService {
  return new ProviderStatusService([
    { provider: "codex", source: "codexlb", read: (signal) => readCodexLbStatus("http://127.0.0.1:2455", async () => ({ accounts: codex() }), { signal }) },
    { provider: "claude", source: "teamclaude", read: (signal) => readTeamClaudeStatus("http://127.0.0.1:3456", async () => ({ accounts: claude() }), { signal }) },
  ], { retries: 0 });
}

function recorder() {
  const applied: RoutingChange[] = [];
  return {
    applied,
    codex: codexLbController(async (change) => void applied.push(change)),
    claude: teamClaudeController(async (change) => void applied.push(change)),
  };
}

describe("routing plan", () => {
  test("burns the first-ranked Codex account, preserves weekly-only ones, and ranks Claude priority", async () => {
    const statuses = service(
      () => [
        codexRow("soon", { primary: { remainingPercent: 40, resetAt: new Date(Date.now() + HOUR).toISOString(), windowMinutes: 300 } }),
        codexRow("later", { routingPolicy: "burn_first" }),
        codexRow("weekly", { primary: null }),
      ],
      () => [claudeRow("claude-b", 0.5, 4 * HOUR, 0), claudeRow("claude-a", 0.2, HOUR, 0)],
    );
    const record = recorder();
    const router = new ProviderRouter({ controllers: [record.codex, record.claude], defaultMode: "suggest" });
    await router.evaluate(await statuses.refresh());
    const state = router.state();
    expect(record.applied).toEqual([]);
    expect(state.providers["codex"]!.planned.map((change) => [change.accountId, change.from, change.to])).toEqual([
      ["soon", "normal", "burn_first"],
      ["later", "burn_first", "normal"],
      ["weekly", "normal", "preserve"],
    ]);
    expect(state.providers["claude"]!.planned.map((change) => [change.accountId, change.to])).toEqual([["claude-b", "1"]]);
  });

  test("burns a free account first and never a weekly-only one", async () => {
    const statuses = service(
      () => [codexRow("weekly", { primary: null, routingPolicy: "preserve" }), codexRow("free", { planType: "free", primary: null, secondary: null })],
      () => [],
    );
    const record = recorder();
    const router = new ProviderRouter({ controllers: [record.codex], defaultMode: "suggest" });
    await router.evaluate(await statuses.refresh());
    expect(router.state().providers["codex"]!.planned.map((change) => [change.accountId, change.to])).toEqual([["free", "burn_first"]]);
  });

  test("automatic mode applies only differences, once per interval, and manual apply skips the wait", async () => {
    let policy = "normal";
    const statuses = service(() => [codexRow("a", { routingPolicy: policy }), codexRow("b", { primary: null })], () => []);
    let time = Date.now();
    const applied: RoutingChange[] = [];
    const router = new ProviderRouter({
      controllers: [codexLbController(async (change) => {
        applied.push(change);
        if (change.accountId === "a") policy = change.to;
      })],
      defaultMode: "auto",
      now: () => time,
      minIntervalMs: 5 * 60_000,
    });
    await router.evaluate(await statuses.refresh());
    expect(applied.map((change) => [change.accountId, change.to])).toEqual([["a", "burn_first"], ["b", "preserve"]]);
    expect(router.state().log).toHaveLength(2);

    // The fake never records "b", so it still differs. Inside the interval
    // automatic mode leaves it alone. A manual apply does not wait.
    time += 60_000;
    await router.evaluate(await statuses.refresh({ force: true }));
    expect(applied).toHaveLength(2);
    await router.evaluate(await statuses.refresh({ force: true }), "codex");
    expect(applied).toHaveLength(3);
    expect(applied[2]).toMatchObject({ accountId: "b", to: "preserve" });
    time += 5 * 60_000;
    await router.evaluate(await statuses.refresh({ force: true }));
    expect(applied).toHaveLength(4);
  });

  test("leaves a provider alone when its data is stale, unreachable, or off", async () => {
    const record = recorder();
    const router = new ProviderRouter({ controllers: [record.codex], defaultMode: "auto" });
    const failing = new ProviderStatusService([
      { provider: "codex", source: "codexlb", read: (signal) => readCodexLbStatus("http://127.0.0.1:2455", async () => { throw new Error("down"); }, { signal }) },
    ], { retries: 0 });
    await router.evaluate(await failing.refresh());
    expect(record.applied).toEqual([]);
    expect(router.state().providers["codex"]!.idle).toContain("could not be read");

    router.setMode("codex", "off");
    await router.evaluate(await service(() => [codexRow("a")], () => []).refresh());
    expect(record.applied).toEqual([]);
    expect(router.state().providers["codex"]).toMatchObject({ mode: "off", planned: [] });
  });

  test("a refused change is logged and stops the rest of that provider's changes", async () => {
    const router = new ProviderRouter({
      controllers: [codexLbController(async () => { throw new Error("CodexLB refused the change (HTTP 403)"); })],
      defaultMode: "auto",
    });
    await router.evaluate(await service(() => [codexRow("a"), codexRow("b", { primary: null })], () => []).refresh());
    const state = router.state();
    expect(state.log).toHaveLength(1);
    expect(state.log[0]).toMatchObject({ ok: false, error: "CodexLB refused the change (HTTP 403)" });
    expect(state.providers["codex"]!.lastError).toContain("HTTP 403");
  });

  test("remembers modes and the log in a private file", () => {
    const directory = mkdtempSync(join(tmpdir(), "watari-routing-"));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const store = fileRoutingStore(join(directory, "routing.json"));
    const record = recorder();
    new ProviderRouter({ controllers: [record.codex], store }).setMode("codex", "auto");
    expect(statSync(join(directory, "routing.json")).mode & 0o777).toBe(0o600);
    expect(new ProviderRouter({ controllers: [record.codex], store }).mode("codex")).toBe("auto");
    const token = persistentDashboardToken(directory, () => "k".repeat(43));
    expect(persistentDashboardToken(directory, () => "other".repeat(10))).toBe(token);
    expect(statSync(join(directory, "token")).mode & 0o777).toBe(0o600);
  });
});

describe("provider control clients", () => {
  function fake(handler: (request: Request) => Response | Promise<Response>) {
    const seen: { method: string; path: string; body: unknown; headers: Headers }[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const text = await request.clone().text();
        seen.push({ method: request.method, path: new URL(request.url).pathname, body: text ? JSON.parse(text) : null, headers: request.headers });
        return await handler(request);
      },
    });
    cleanups.push(() => server.stop(true));
    return { url: `http://127.0.0.1:${server.port}`, seen };
  }
  const change = (provider: string, accountId: string, to: string): RoutingChange =>
    ({ provider, accountId, account: accountId, setting: provider === "codex" ? "routing policy" : "priority", from: null, to, reason: "" });

  test("CodexLB gets a PUT of one account's routing policy, with no credential", async () => {
    const codex = fake(() => Response.json({ accountId: "acc 1", routingPolicy: "burn_first", changed: true }));
    await codexLbRoutingController(codex.url).apply(change("codex", "acc 1", "burn_first"), new AbortController().signal);
    expect(codex.seen[0]).toMatchObject({ method: "PUT", path: "/api/provider-status/accounts/acc%201/routing-policy", body: { routingPolicy: "burn_first" } });
    expect(codex.seen[0]!.headers.get("authorization")).toBeNull();
    expect(codex.seen[0]!.headers.get("origin")).toBeNull();

    const old = fake(() => Response.json({ detail: "Not Found" }, { status: 404 }));
    await expect(codexLbRoutingController(old.url).apply(change("codex", "a", "normal"), new AbortController().signal))
      .rejects.toThrow("Update and restart CodexLB");

    const stale = fake(() => Response.json({ code: "http_405", message: "Method Not Allowed" }, { status: 405 }));
    await expect(codexLbRoutingController(stale.url).apply(change("codex", "a", "normal"), new AbortController().signal))
      .rejects.toThrow("Restart codex-lb.service");
  });

  test("oversized provider answers are cancelled without replaying the write", async () => {
    for (const declared of [false, true]) {
      let reads = 0;
      let cancelled = false;
      let calls = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          reads += 1;
          controller.enqueue(new Uint8Array(40 * 1024));
          if (reads === 4) controller.close();
        },
        cancel() { cancelled = true; },
      }, { highWaterMark: 0 });
      const response = new Response(stream, {
        headers: { "content-type": "application/json", ...(declared ? { "content-length": String(160 * 1024) } : {}) },
      });
      await expect(loopbackJsonWrite("PUT", "http://127.0.0.1:2455/control", {}, new AbortController().signal, {
        fetch: async () => { calls += 1; return response; },
      })).rejects.toThrow("exceeds");
      expect(calls).toBe(1);
      expect(reads).toBe(declared ? 0 : 2);
      expect(cancelled).toBe(true);
      expect(stream.locked).toBe(false);
    }
  });

  test("TeamClaude gets its own priority request and a refusal is reported", async () => {
    const team = fake(() => Response.json({ ok: true, name: "claude-a", priority: 1 }));
    await teamClaudeRoutingController(team.url).apply(change("claude", "claude-a", "1"), new AbortController().signal);
    expect(team.seen[0]).toMatchObject({ method: "POST", path: "/teamclaude/priority", body: { account: "claude-a", priority: 1 } });

    const refusing = fake(() => Response.json({ ok: false, error: "unknown account" }, { status: 400 }));
    await expect(teamClaudeRoutingController(refusing.url).apply(change("claude", "x", "0"), new AbortController().signal))
      .rejects.toThrow("HTTP 400");
  });
});

describe("dashboard routing endpoint", () => {
  const TOKEN = "t".repeat(43);
  const PORT = 41_999;
  const HOST = `127.0.0.1:${PORT}`;

  function request(method: string, body?: unknown, headers: Record<string, string> = {}): Request {
    return new Request(`http://${HOST}/api/routing`, {
      method,
      headers: { host: HOST, authorization: `Bearer ${TOKEN}`, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  test("needs the token, takes JSON only, and sets a mode or applies now", async () => {
    let policy = "normal";
    const statuses = service(() => [codexRow("a", { routingPolicy: policy })], () => []);
    const applied: RoutingChange[] = [];
    const router = new ProviderRouter({
      controllers: [codexLbController(async (change) => {
        applied.push(change);
        policy = change.to;
      })],
      defaultMode: "suggest",
    });
    const context = { token: TOKEN, port: PORT, service: statuses, router };

    const anonymous = await handleDashboardRequest(new Request(`http://${HOST}/api/routing`, { headers: { host: HOST } }), context);
    expect(anonymous.status).toBe(401);
    const form = await handleDashboardRequest(new Request(`http://${HOST}/api/routing`, {
      method: "POST",
      headers: { host: HOST, authorization: `Bearer ${TOKEN}`, "content-type": "application/x-www-form-urlencoded" },
      body: "provider=codex&mode=auto",
    }), context);
    expect(form.status).toBe(415);
    const crossSite = await handleDashboardRequest(request("POST", { provider: "codex", mode: "auto" }, { "sec-fetch-site": "cross-site" }), context);
    expect(crossSite.status).toBe(403);
    expect((await handleDashboardRequest(request("POST", { provider: "nope", mode: "auto" }), context)).status).toBe(400);
    expect((await handleDashboardRequest(request("POST", { provider: "codex", mode: "always" }), context)).status).toBe(400);

    const suggest = await (await handleDashboardRequest(request("GET"), context)).json() as { providers: Record<string, { mode: string }> };
    expect(suggest.providers["codex"]!.mode).toBe("suggest");
    const planned = await (await handleDashboardRequest(request("POST", { provider: "codex", mode: "suggest" }), context)).json() as {
      providers: Record<string, { planned: unknown[] }>;
    };
    expect(planned.providers["codex"]!.planned).toHaveLength(1);
    expect(applied).toEqual([]);

    const afterApply = await (await handleDashboardRequest(request("POST", { provider: "codex", action: "apply" }), context)).json() as {
      log: { ok: boolean; to: string }[];
    };
    expect(applied.map((change) => change.to)).toEqual(["burn_first"]);
    expect(afterApply.log[0]).toMatchObject({ ok: true, to: "burn_first" });
    statuses.close();
  });

  test("rejects a streamed oversized control body before changing routing", async () => {
    const statuses = service(() => [], () => []);
    const record = recorder();
    const router = new ProviderRouter({ controllers: [record.codex], defaultMode: "suggest" });
    let reads = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        reads += 1;
        controller.enqueue(new Uint8Array(3 * 1024));
        if (reads === 4) controller.close();
      },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    const response = await handleDashboardRequest(new Request(`http://${HOST}/api/routing`, {
      method: "POST",
      headers: { host: HOST, authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body,
    }), { token: TOKEN, port: PORT, service: statuses, router });
    expect(response.status).toBe(413);
    expect(reads).toBe(2);
    expect(cancelled).toBe(true);
    expect(body.locked).toBe(false);
    expect(router.mode("codex")).toBe("suggest");
    expect(record.applied).toEqual([]);
    statuses.close();
  });

  test("is absent when the dashboard runs without routing", async () => {
    const response = await handleDashboardRequest(request("GET"), { token: TOKEN, port: PORT, service: new ProviderStatusService([]) });
    expect(response.status).toBe(404);
  });
});
