/**
 * The authenticated loopback boundary for the provider dashboard.
 *
 * The listener binds 127.0.0.1 only. The CLI supplies a persistent private
 * token, or a standalone listener creates one. The printed link carries it
 * in its fragment, so it never reaches a server log or a
 * Referer header. The page script sends it as a bearer header on first use,
 * then may use a same-origin HttpOnly cookie. A cross-site page cannot use
 * either path because no CORS grant is given and locality checks still apply.
 * Requests must also name this listener in `Host` (DNS rebinding) and must not
 * come from another origin. Provider endpoints are never exposed to the
 * browser. Status reads and routing controls share this authentication boundary.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";

import { BodyTooLargeError, readBoundedText } from "../http-body.ts";
import { DASHBOARD_CSS, DASHBOARD_HTML, dashboardScript } from "./assets.ts";
import {
  PROVIDER_STATUS_PATH,
  handleProviderStatusRequest,
  type ProviderStatusService,
} from "../provider-status-api.ts";
import { ROUTING_MODES, type ProviderRouter, type RoutingMode } from "../provider-routing-control.ts";

export const ROUTING_PATH = "/api/routing";
const MAX_CONTROL_BODY = 4 * 1024;
const DASHBOARD_COOKIE = "watari_dashboard_token";
const DASHBOARD_COOKIE_MAX_AGE = 365 * 24 * 60 * 60;

export const DASHBOARD_HOST = "127.0.0.1";

const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "img-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Content-Security-Policy": CONTENT_SECURITY_POLICY,
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), interest-cohort=()",
  "Cache-Control": "no-store",
};

export function createDashboardToken(): string {
  return randomBytes(32).toString("base64url");
}

function tokenMatches(presented: string, expected: string): boolean {
  const left = Buffer.from(presented);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function bearer(request: Request): string | null {
  const header = request.headers.get("authorization");
  const match = header ? /^Bearer\s+([A-Za-z0-9_-]+)$/u.exec(header.trim()) : null;
  return match?.[1] ?? null;
}

function cookie(request: Request): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === DASHBOARD_COOKIE) {
      const candidate = value.join("=");
      return /^[A-Za-z0-9_-]{16,128}$/u.test(candidate) ? candidate : null;
    }
  }
  return null;
}

function presentedToken(request: Request): string | null {
  // An explicit bearer token wins. A bad bearer must not fall through to a
  // valid cookie supplied by a different page or client.
  return request.headers.has("authorization") ? bearer(request) : cookie(request);
}

function authCookie(token: string): string {
  return `${DASHBOARD_COOKIE}=${token}; Max-Age=${DASHBOARD_COOKIE_MAX_AGE}; Path=/; HttpOnly; SameSite=Strict`;
}

function respond(status: number, body: string, contentType: string, extra: Readonly<Record<string, string>> = {}): Response {
  return new Response(body, {
    status,
    headers: { ...SECURITY_HEADERS, "Content-Type": contentType, ...extra },
  });
}

function refuse(status: number, error: string, extra: Readonly<Record<string, string>> = {}): Response {
  return respond(status, JSON.stringify({ error }), "application/json; charset=utf-8", extra);
}

export interface DashboardRequestContext {
  readonly token: string;
  /** The port the listener is bound to. */
  readonly port: number;
  readonly service: ProviderStatusService;
  /** When present, the page can see and change Watari's routing. */
  readonly router?: ProviderRouter;
}

function json(status: number, value: unknown, extra: Readonly<Record<string, string>> = {}): Response {
  return respond(status, JSON.stringify(value), "application/json; charset=utf-8", extra);
}

/**
 * `GET /api/routing` returns the routing state. `POST /api/routing` with
 * `{ provider, mode }` sets a mode, and `{ provider, action: "apply" }` reads
 * fresh status and applies that provider's plan now. Both need this run's
 * token or its session cookie, and a change also needs a JSON body.
 */
async function handleRouting(request: Request, context: DashboardRequestContext): Promise<Response> {
  const presented = presentedToken(request);
  if (presented === null || !tokenMatches(presented, context.token)) return refuse(401, "authentication required");
  const authenticated = { "Set-Cookie": authCookie(context.token) };
  const router = context.router;
  if (!router) return refuse(404, "routing control is not enabled for this dashboard");
  if (request.method === "GET") return json(200, router.state(), authenticated);
  if (request.method !== "POST") return refuse(405, "method not allowed", { Allow: "GET, POST" });
  if (!/^application\/json\b/iu.test(request.headers.get("content-type") ?? "")) return refuse(415, "send JSON");
  let text: string;
  try {
    text = await readBoundedText(request, MAX_CONTROL_BODY);
  } catch (error) {
    if (error instanceof BodyTooLargeError) return refuse(413, "request too large");
    throw error;
  }
  let body: Record<string, unknown>;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
    body = parsed as Record<string, unknown>;
  } catch {
    return refuse(400, "invalid JSON body");
  }
  const provider = typeof body["provider"] === "string" ? body["provider"] : "";
  if (!(provider in router.state().providers)) return refuse(400, "unknown provider");
  if (typeof body["mode"] === "string") {
    if (!(ROUTING_MODES as readonly string[]).includes(body["mode"])) return refuse(400, "unknown routing mode");
    router.setMode(provider, body["mode"] as RoutingMode);
    await router.evaluate(await context.service.refresh(), null);
    return json(200, router.state(), authenticated);
  }
  if (body["action"] === "apply") {
    await router.evaluate(await context.service.refresh({ force: true }), provider);
    return json(200, router.state(), authenticated);
  }
  return refuse(400, "send a mode or an action");
}

function allowedHosts(port: number): ReadonlySet<string> {
  return new Set([`${DASHBOARD_HOST}:${port}`, `localhost:${port}`]);
}

function allowedOrigins(port: number): ReadonlySet<string> {
  return new Set([`http://${DASHBOARD_HOST}:${port}`, `http://localhost:${port}`]);
}

/** Handle one dashboard request. Exported so tests can drive it without a socket. */
export async function handleDashboardRequest(request: Request, context: DashboardRequestContext): Promise<Response> {
  const host = request.headers.get("host")?.toLowerCase() ?? "";
  if (!allowedHosts(context.port).has(host)) {
    return refuse(403, "the Host header does not name this dashboard");
  }
  const origin = request.headers.get("origin");
  if (origin !== null && !allowedOrigins(context.port).has(origin.toLowerCase())) {
    return refuse(403, "cross-origin requests are refused");
  }
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin" && site !== "none") {
    return refuse(403, "cross-site requests are refused");
  }

  const url = new URL(request.url);
  if (url.pathname === ROUTING_PATH) return await handleRouting(request, context);
  if (url.pathname === PROVIDER_STATUS_PATH) {
    const result = await handleProviderStatusRequest(
      { method: request.method, url: `${url.pathname}${url.search}` },
      context.service,
      () => {
        const presented = presentedToken(request);
        return presented !== null && tokenMatches(presented, context.token);
      },
    );
    if (!result) return refuse(404, "not found");
    const headers = { ...SECURITY_HEADERS, ...result.headers };
    if (result.status === 200) headers["Set-Cookie"] = authCookie(context.token);
    return new Response(result.body, { status: result.status, headers });
  }

  const asset = url.pathname === "/" || url.pathname === "/index.html"
    ? { body: DASHBOARD_HTML, type: "text/html; charset=utf-8" }
    : url.pathname === "/app.js"
      ? { body: dashboardScript(), type: "text/javascript; charset=utf-8" }
      : url.pathname === "/app.css"
        ? { body: DASHBOARD_CSS, type: "text/css; charset=utf-8" }
        : null;
  if (!asset) return refuse(404, "not found");
  if (request.method !== "GET") return refuse(405, "method not allowed", { Allow: "GET" });
  return respond(200, asset.body, asset.type);
}

export interface ProviderDashboardOptions {
  readonly service: ProviderStatusService;
  readonly router?: ProviderRouter;
  /** 0 picks a free port. */
  readonly port?: number;
  readonly token?: string;
}

export interface ProviderDashboard {
  readonly port: number;
  readonly origin: string;
  /** The link to open. Its fragment carries the access token. */
  readonly launchUrl: string;
  stop(): Promise<void>;
}

/** Start the dashboard on 127.0.0.1. The caller owns `service` and closes it. */
export function startProviderDashboard(options: ProviderDashboardOptions): ProviderDashboard {
  const token = options.token ?? createDashboardToken();
  if (!/^[A-Za-z0-9_-]{32,128}$/u.test(token)) throw new Error("dashboard token must be 32 to 128 URL-safe characters");
  const requestedPort = options.port ?? 0;
  if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65_535) {
    throw new Error("dashboard port must be an integer from 0 to 65535");
  }
  let boundPort = requestedPort;
  const server = Bun.serve({
    hostname: DASHBOARD_HOST,
    port: requestedPort,
    fetch: (request) => handleDashboardRequest(request, {
      token,
      port: boundPort,
      service: options.service,
      ...(options.router ? { router: options.router } : {}),
    }),
    error: () => refuse(500, "dashboard error"),
  });
  boundPort = server.port ?? requestedPort;
  const origin = `http://${DASHBOARD_HOST}:${boundPort}`;
  return {
    port: boundPort,
    origin,
    launchUrl: `${origin}/#token=${token}`,
    stop: async () => {
      await server.stop(true);
    },
  };
}
