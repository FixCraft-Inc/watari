/**
 * Provider-owned status readers, composed for the dashboard and CLI.
 *
 * Watari reads each provider's own status endpoint over loopback and sends no
 * credential. CodexLB owns Codex account routing, TeamClaude owns Claude
 * account routing, and each decides who may read its status. A provider that
 * requires authentication shows up as an honest auth-required error here, not
 * as a credential Watari asks for or stores.
 *
 * Everything is injectable: tests and future providers pass their own
 * `JsonReader` or `ProviderStatusReader`, so an upstream update to CodexLB or
 * TeamClaude only changes the normalizer, never a patched dependency.
 */

import { readGeminiWebStatus } from "./gemini-web-status.ts";

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { readBoundedText } from "./http-body.ts";
import {
  StatusHttpError,
  readCodexLbStatus,
  readTeamClaudeStatus,
  type JsonReader,
} from "./provider-status.ts";
import { ProviderStatusService, type ProviderStatusReader } from "./provider-status-api.ts";

export const DEFAULT_CODEXLB_URL = "http://127.0.0.1:2455";
export const DEFAULT_TEAMCLAUDE_URL = "http://127.0.0.1:3456";
export const CODEXLB_URL_ENV = "WATARI_CODEXLB_URL";
/** `off` stops the service from polling provider status for agent notices. */
export const PROVIDER_STATUS_ENV = "WATARI_PROVIDER_STATUS";
export const TEAMCLAUDE_URL_ENV = "WATARI_TEAMCLAUDE_URL";

const DEFAULT_MAX_STATUS_BYTES = 4 * 1024 * 1024;

export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  if (host === "localhost" || host === "::1") return true;
  const octets = host.split(".");
  return octets.length === 4
    && octets[0] === "127"
    && octets.every((octet) => /^\d{1,3}$/u.test(octet) && Number(octet) <= 255);
}

/** Parses a provider base URL, refusing anything but plain loopback HTTP(S). */
export function loopbackUrl(value: string, name: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} is not a valid URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`${name} must be an http(s) URL`);
  if (!isLoopbackHost(url.hostname)) throw new Error(`${name} must point at a loopback address`);
  if (url.username || url.password) throw new Error(`${name} must not carry credentials`);
  if (url.search || url.hash) throw new Error(`${name} must be a base URL without a query or fragment`);
  return url;
}

export interface LoopbackJsonReaderOptions {
  readonly fetch?: (input: URL, init: RequestInit) => Promise<Response>;
  readonly maxBytes?: number;
}

/**
 * A credential-free JSON GET for loopback status endpoints.
 *
 * It sends no cookie, authorization, or browser origin header, refuses
 * redirects (a redirect could leave loopback), and bounds the body size.
 */
export function loopbackJsonReader(options: LoopbackJsonReaderOptions = {}): JsonReader {
  const fetchImpl = options.fetch ?? ((input: URL, init: RequestInit) => fetch(input, init));
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_STATUS_BYTES;
  return async (value, signal) => {
    const url = loopbackUrl(value, "provider status URL");
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        headers: { Accept: "application/json" },
        redirect: "manual",
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new Error(`nothing answered on ${url.host}. Is the provider running there?`);
    }
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel().catch(() => undefined);
      throw new StatusHttpError(
        response.status,
        `${url.host} requires authentication to read status (HTTP ${response.status}). ` +
          "Watari sends no provider credential. Grant read access in the provider itself.",
      );
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      throw new StatusHttpError(response.status, `${url.host} redirected the status request (HTTP ${response.status}), which is refused`);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new StatusHttpError(response.status, `${url.host} status request failed with HTTP ${response.status}`);
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!/\bjson\b/iu.test(contentType)) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`${url.host} status response is not JSON`);
    }
    const body = await readBoundedText(response, maxBytes);
    try {
      return JSON.parse(body) as unknown;
    } catch {
      throw new Error(`${url.host} status response is not valid JSON`);
    }
  };
}

export interface ProviderStatusEndpoints {
  /** null when the reader is turned off. */
  readonly codexlb: string | null;
  readonly teamclaude: string | null;
  readonly geminiWeb?: string | null;
}

function endpoint(environment: NodeJS.ProcessEnv, name: string, fallback: string): string | null {
  const raw = environment[name]?.trim();
  if (raw === "off" || raw === "none") return null;
  return loopbackUrl(raw || fallback, name).toString();
}

/**
 * Status endpoints from the environment. Each defaults to the provider's
 * documented loopback listener and accepts `off` to skip that provider.
 */
export function providerStatusEndpoints(environment: NodeJS.ProcessEnv = process.env): ProviderStatusEndpoints {
  return {
    codexlb: endpoint(environment, CODEXLB_URL_ENV, DEFAULT_CODEXLB_URL),
    teamclaude: endpoint(environment, TEAMCLAUDE_URL_ENV, DEFAULT_TEAMCLAUDE_URL),
    ...(environment.WATARI_GEMINI_WEB_URL?.trim() ? { geminiWeb: endpoint(environment, "WATARI_GEMINI_WEB_URL", "http://127.0.0.1:14981") } : {}),
  };
}

export interface ProviderReaderOptions {
  readonly readJson?: JsonReader;
  readonly now?: () => number;
  readonly staleAfterMs?: number;
}

/** One reader per configured provider, each owned by that provider's endpoint. */
export function providerStatusReaders(
  endpoints: ProviderStatusEndpoints,
  options: ProviderReaderOptions = {},
): ProviderStatusReader[] {
  const readJson = options.readJson ?? loopbackJsonReader();
  const adapter = (signal: AbortSignal) => ({
    signal,
    ...(options.now ? { now: options.now } : {}),
    ...(options.staleAfterMs ? { staleAfterMs: options.staleAfterMs } : {}),
  });
  const readers: ProviderStatusReader[] = [];
  const codexlb = endpoints.codexlb;
  if (codexlb) {
    readers.push({
      provider: "codex",
      source: "codexlb",
      read: (signal) => readCodexLbStatus(codexlb, readJson, adapter(signal)),
    });
  }
  const teamclaude = endpoints.teamclaude;
  if (teamclaude) {
    readers.push({
      provider: "claude",
      source: "teamclaude",
      read: (signal) => readTeamClaudeStatus(teamclaude, readJson, adapter(signal)),
    });
  }
  if (endpoints.geminiWeb) {
    const baseUrl = endpoints.geminiWeb;
    readers.push({ provider: "gemini-web", source: "gemini-web", read: (signal) => readGeminiWebStatus(baseUrl, readJson, adapter(signal)) });
  }
  return readers;
}

/** Whether the Watari service should poll provider status for agent notices. */
export function providerStatusEnabled(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment[PROVIDER_STATUS_ENV]?.trim().toLowerCase() !== "off";
}

/** One status service over the providers configured in `environment`. */
export function providerStatusService(environment: NodeJS.ProcessEnv = process.env): ProviderStatusService {
  return new ProviderStatusService(providerStatusReaders(providerStatusEndpoints(environment)), {
    readTimeoutMs: 4_000,
    retries: 1,
    // A browser tab polling every few seconds must not hammer the providers.
    minRefreshIntervalMs: 5_000,
  });
}

/** Forces which providers' agents get capacity notices: `codex,claude`, or `none`. */
export const CAPACITY_NOTIFY_ENV = "WATARI_CAPACITY_NOTIFY";

function sameListener(raw: string | null | undefined, endpoint: string | null): boolean {
  if (!raw || !endpoint) return false;
  try {
    const url = new URL(raw);
    const target = new URL(endpoint);
    const port = (value: URL) => value.port || (value.protocol === "https:" ? "443" : "80");
    const host = (value: URL) => (isLoopbackHost(value.hostname) ? "loopback" : value.hostname.toLowerCase());
    return host(url) === host(target) && port(url) === port(target);
  } catch {
    return false;
  }
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** The base URL of Codex's selected model provider, from `config.toml`. */
export function codexProviderBaseUrl(configToml: string): string | null {
  const selected = /^\s*model_provider\s*=\s*"([^"]+)"/mu.exec(configToml)?.[1];
  if (!selected) return null;
  const escaped = selected.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const section = new RegExp(`^\\s*\\[model_providers\\.(?:"${escaped}"|${escaped})\\]\\s*$([\\s\\S]*?)(?=^\\s*\\[|(?![\\s\\S]))`, "mu").exec(configToml)?.[1];
  return section ? /^\s*base_url\s*=\s*"([^"]+)"/mu.exec(section)?.[1] ?? null : null;
}

/** Route from the environment, then merged user/project/local Claude settings. */
export function claudeBaseUrl(environment: NodeJS.ProcessEnv, ...settingsJson: readonly (string | null)[]): string | null {
  if (environment["ANTHROPIC_BASE_URL"]) return environment["ANTHROPIC_BASE_URL"];
  for (const json of [...settingsJson].reverse()) {
    if (!json) continue;
    try {
      const settings = JSON.parse(json) as { env?: Record<string, unknown> };
      const value = settings.env?.["ANTHROPIC_BASE_URL"];
      if (value !== undefined) return typeof value === "string" ? value : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * The providers whose pool the native harnesses actually route through, so a
 * capacity notice only reaches agents it is about. Codex counts when its
 * selected model provider points at CodexLB's listener. Claude counts when
 * Claude Code's `ANTHROPIC_BASE_URL` points at TeamClaude's. Only those lines
 * are read, never a credential.
 */
export function routedCapacityProviders(
  environment: NodeJS.ProcessEnv = process.env,
  endpoints: ProviderStatusEndpoints = providerStatusEndpoints(environment),
  home = homedir(),
  projectDirectory?: string,
): ReadonlySet<string> {
  const forced = environment[CAPACITY_NOTIFY_ENV]?.trim().toLowerCase();
  if (forced) {
    return new Set(forced === "none" ? [] : forced.split(",").map((value) => value.trim()).filter(Boolean));
  }
  const routed = new Set<string>();
  const codexHome = environment["CODEX_HOME"] || join(home, ".codex");
  const codexConfig = readText(join(codexHome, "config.toml"));
  if (codexConfig && sameListener(codexProviderBaseUrl(codexConfig), endpoints.codexlb)) routed.add("codex");
  const claudeHome = environment["CLAUDE_CONFIG_DIR"] || join(home, ".claude");
  const claudeRoute = claudeBaseUrl(environment,
    readText(join(claudeHome, "settings.json")),
    projectDirectory ? readText(join(projectDirectory, ".claude", "settings.json")) : null,
    projectDirectory ? readText(join(projectDirectory, ".claude", "settings.local.json")) : null,
  );
  if (sameListener(claudeRoute, endpoints.teamclaude)) {
    routed.add("claude");
  }
  return routed;
}
