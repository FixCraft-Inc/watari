import { timingSafeEqual } from "node:crypto";
import { PoolConfigSchema, PoolStateSchema, type PoolConfig, type PoolState, type QuotaFailure } from "./store.ts";

const GOOGLE_API = "https://generativelanguage.googleapis.com";
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const MAX_ERROR_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 5 * 60_000;
const pacific = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" });

export function pacificDay(time: number): string {
  const parts = pacific.formatToParts(time);
  const part = (name: string) => parts.find((item) => item.type === name)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/** Locate the next calendar midnight across both Pacific DST transitions. */
export function nextPacificMidnight(time: number): number {
  const day = pacificDay(time);
  let low = Math.floor(time);
  let high = low + 27 * 60 * 60_000;
  while (high - low > 1) {
    const middle = Math.floor((high + low) / 2);
    if (pacificDay(middle) === day) low = middle;
    else high = middle;
  }
  return high;
}

function failure(status: number, message: string, retrySeconds?: number): Response {
  return Response.json({ error: { code: status, message, status: status === 429 ? "RESOURCE_EXHAUSTED" : "UNAVAILABLE" } }, {
    status,
    headers: { "Cache-Control": "no-store", ...(retrySeconds === undefined ? {} : { "Retry-After": String(retrySeconds) }) },
  });
}

async function boundedBytes(body: ReadableStream<Uint8Array> | null, limit: number, signal?: AbortSignal): Promise<Uint8Array> {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    for (;;) {
      if (signal?.aborted) throw new Error("read interrupted");
      const result = await reader.read();
      if (signal?.aborted) throw new Error("read interrupted");
      if (result.done) break;
      total += result.value.byteLength;
      if (total > limit) throw new Error("body too large");
      chunks.push(result.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally { signal?.removeEventListener("abort", abort); reader.releaseLock(); }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
  return output;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

const DAILY_FREE_QUOTA = "GenerateRequestsPerDayPerProjectPerModel-FreeTier";
const MINUTE_FREE_QUOTAS = new Set([
  "GenerateRequestsPerMinutePerProjectPerModel-FreeTier",
  "GenerateContentRequestsPerMinutePerProjectPerModel-FreeTier",
  "GenerateContentInputTokensPerModelPerMinute-FreeTier",
  "GenerateContentOutputTokensPerModelPerMinute-FreeTier",
]);

/** Keep bounded provider IDs and numeric limits, never raw error text or keys. */
function quotaEvidence(value: unknown, model: string, secrets: readonly string[] = []): Pick<QuotaFailure, "kind" | "violations"> {
  const details = record(record(value)?.["error"])?.["details"];
  const violations: QuotaFailure["violations"] = [];
  let daily = false;
  let allMinute = true;
  let count = 0;
  if (!Array.isArray(details)) return { kind: "unknown", violations };
  for (const detail of details) {
    const entry = record(detail);
    if (entry?.["@type"] !== "type.googleapis.com/google.rpc.QuotaFailure" || !Array.isArray(entry["violations"])) continue;
    for (const item of entry["violations"]) {
      count += 1;
      const violation = record(item);
      const dimension = record(violation?.["quotaDimensions"])?.["model"];
      const id = violation?.["quotaId"];
      const matchingModel = dimension === undefined || dimension === model;
      daily ||= matchingModel && id === DAILY_FREE_QUOTA;
      allMinute &&= matchingModel && typeof id === "string" && MINUTE_FREE_QUOTAS.has(id);
      if (typeof id !== "string" || !/^[A-Za-z0-9_.-]{1,200}$/u.test(id)
        || secrets.some((key) => id.includes(key)) || violations.length >= 32) continue;
      const rawLimit = violation?.["quotaValue"];
      const limit = secrets.some((key) => String(rawLimit).includes(key)) ? null : typeof rawLimit === "number" ? rawLimit
        : typeof rawLimit === "string" && /^\d{1,16}$/u.test(rawLimit) ? Number(rawLimit) : null;
      violations.push({ quotaId: id, limit: limit !== null && Number.isSafeInteger(limit) && limit >= 0 ? limit : null });
    }
  }
  return { kind: daily ? "daily" : count > 0 && allMinute ? "minute" : "unknown", violations };
}

/** Unknown/paid quota IDs never authorize rotating a free-project credential. */
export function isDailyFreeQuota(value: unknown, model: string): boolean {
  return quotaEvidence(value, model).kind === "daily";
}

function retrySeconds(response: Response, value: unknown): number {
  const header = response.headers.get("retry-after");
  if (header && /^\d{1,5}$/u.test(header)) return Math.max(1, Math.min(3600, Number(header)));
  const details = record(record(value)?.["error"])?.["details"];
  if (Array.isArray(details)) for (const detail of details) {
    const entry = record(detail);
    const delay = entry?.["@type"] === "type.googleapis.com/google.rpc.RetryInfo" ? entry["retryDelay"] : null;
    if (typeof delay === "string" && /^\d{1,5}(?:\.\d+)?s$/u.test(delay)) return Math.max(1, Math.min(3600, Math.ceil(Number(delay.slice(0, -1)))));
  }
  return 60;
}

interface PoolOptions {
  readonly config: PoolConfig;
  readonly keys: ReadonlyMap<string, string>;
  readonly state?: PoolState;
  readonly save: (state: PoolState) => void;
  readonly fetch?: (url: string, init: RequestInit) => Promise<Response>;
  readonly now?: () => number;
}

/** One in-flight generation prevents overlapping quota reservations and replay. */
export class GeminiPool {
  readonly #config: PoolConfig;
  readonly #keys: ReadonlyMap<string, string>;
  readonly #state: PoolState;
  readonly #save: PoolOptions["save"];
  readonly #fetch: NonNullable<PoolOptions["fetch"]>;
  readonly #now: () => number;
  #busy = false;
  readonly #shutdown = new AbortController();

  constructor(options: PoolOptions) {
    this.#config = PoolConfigSchema.parse(options.config);
    this.#keys = new Map(options.keys);
    this.#state = PoolStateSchema.parse(options.state ?? { schemaVersion: 1, buckets: {} });
    const activeBuckets = new Set(this.#config.projects.flatMap((entry) => this.#config.models.map((model) => `${entry.projectId}/${model}`)));
    for (const id of Object.keys(this.#state.buckets)) if (!activeBuckets.has(id)) delete this.#state.buckets[id];
    this.#save = options.save;
    this.#fetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.#now = options.now ?? Date.now;
    const values = this.#config.projects.map((entry) => this.#keys.get(entry.projectId));
    if (values.some((key) => !key) || new Set(values).size !== values.length) throw new Error("missing or duplicate Google project credentials");
  }

  status(): unknown {
    const now = this.#now();
    return { schemaVersion: 1, busy: this.#busy, models: this.#config.models,
      billingVerification: "owner-attested billing disabled; API keys cannot verify billing",
      projects: this.#config.projects.map((entry) => ({ label: entry.label, projectId: entry.projectId,
        models: this.#config.models.map((model) => {
          const bucket = this.#state.buckets[`${entry.projectId}/${model}`];
          return { model, attemptsToday: bucket?.day === pacificDay(now) ? bucket.attempts : 0,
            exhaustedUntil: bucket?.exhaustedUntil ?? 0, cooldownUntil: bucket?.cooldownUntil ?? 0,
            availability: (bucket?.exhaustedUntil ?? 0) > now ? "daily_exhausted"
              : (bucket?.cooldownUntil ?? 0) > now ? "cooldown" : "ready",
            lastQuotaFailure: bucket?.lastQuotaFailure ?? null };
        }),
      })),
    };
  }

  close(): void { this.#shutdown.abort(); }

  async generate(request: Request, model: string, method: string): Promise<Response> {
    if (!this.#config.models.includes(model)) return failure(403, "model is not allowed by this pool");
    if (method !== "generateContent" && method !== "streamGenerateContent") return failure(404, "unsupported generation method");
    if (this.#config.projects.length === 0) return failure(503, "no free projects are enrolled");
    if (this.#busy) return failure(429, "Gemini pool already has an active request", 1);
    this.#busy = true;
    let transferred = false;
    try {
      const signal = AbortSignal.any([request.signal, this.#shutdown.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
      let bytes: Uint8Array;
      try { bytes = await boundedBytes(request.body, MAX_REQUEST_BYTES, AbortSignal.any([signal, AbortSignal.timeout(30_000)])); }
      catch { return failure(signal.aborted ? 499 : 413, "request body exceeds pool limit or was interrupted"); }
      try { if (!record(JSON.parse(new TextDecoder().decode(bytes)))) throw new Error(); }
      catch { return failure(400, "send a JSON object"); }
      const selectionTime = this.#now();
      const selectionDay = pacificDay(selectionTime);
      const bucketFor = (project: PoolConfig["projects"][number]) => this.#state.buckets[`${project.projectId}/${model}`];
      // An unknown limit could apply to the whole pool. Balancing must not
      // bypass its cooldown just because another project has fewer attempts.
      const unclassifiedRetryAt = this.#config.projects.reduce((latest, project) => {
        const bucket = bucketFor(project);
        return bucket && bucket.exhaustedUntil <= selectionTime && bucket.cooldownUntil > selectionTime
          && bucket.lastQuotaFailure?.kind !== "minute" ? Math.max(latest, bucket.cooldownUntil) : latest;
      }, 0);
      if (unclassifiedRetryAt > selectionTime) return failure(429,
        "project has an unclassified cooldown; credential rotation is not justified", Math.ceil((unclassifiedRetryAt - selectionTime) / 1000));
      const attemptsToday = (project: PoolConfig["projects"][number]) => {
        const bucket = bucketFor(project);
        return bucket?.day === selectionDay ? bucket.attempts : 0;
      };
      // Stable ties preserve configured order. Attempts measure local use,
      // including failures, rather than an estimate of Google's remaining quota.
      const projects = [...this.#config.projects].sort((a, b) => attemptsToday(a) - attemptsToday(b));
      let retryAt: number | null = null;
      for (const project of projects) {
        if (signal.aborted) return failure(499, "request cancelled");
        const now = this.#now();
        const id = `${project.projectId}/${model}`;
        let bucket = this.#state.buckets[id];
        if (!bucket || bucket.day !== pacificDay(now)) {
          bucket = { day: pacificDay(now), attempts: 0,
            exhaustedUntil: bucket?.exhaustedUntil ?? 0, cooldownUntil: bucket?.cooldownUntil ?? 0,
            ...(bucket?.lastQuotaFailure ? { lastQuotaFailure: bucket.lastQuotaFailure } : {}) };
          this.#state.buckets[id] = bucket;
        }
        if (bucket.exhaustedUntil > now) {
          retryAt = Math.min(retryAt ?? Infinity, bucket.exhaustedUntil);
          continue;
        }
        if (bucket.cooldownUntil > now) {
          // Old and unclassified evidence might describe an account-wide or
          // service-wide limit. Only confirmed project limits permit rotation.
          if (bucket.lastQuotaFailure?.kind !== "minute") return failure(429,
            "project has an unclassified cooldown; credential rotation is not justified", Math.ceil((bucket.cooldownUntil - now) / 1000));
          retryAt = Math.min(retryAt ?? Infinity, bucket.cooldownUntil);
          continue;
        }
        if (bucket.attempts >= Number.MAX_SAFE_INTEGER) return failure(503, "attempt counter is full");
        bucket.attempts += 1;
        // Persist the reservation before contacting Google. A failed save sends nothing.
        this.#save(structuredClone(this.#state));
        let upstream: Response;
        try {
          upstream = await this.#fetch(`${GOOGLE_API}/v1beta/models/${model}:${method}${method === "streamGenerateContent" ? "?alt=sse" : ""}`, {
            method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": this.#keys.get(project.projectId)! },
            body: bytes, signal, redirect: "manual", credentials: "omit",
          });
        } catch { return failure(signal.aborted ? 499 : 502, "Google request interrupted; it was not replayed"); }
        if (!upstream.ok) {
          let error: unknown = null;
          try { error = JSON.parse(new TextDecoder().decode(await boundedBytes(upstream.body, MAX_ERROR_BYTES, signal))); }
          catch { /* An unreadable error never authorizes credential rotation. */ }
          if (upstream.status === 429) {
            const observedAt = this.#now();
            const evidence = quotaEvidence(error, model, [...this.#keys.values()]);
            if (evidence.kind === "daily") {
              bucket.exhaustedUntil = nextPacificMidnight(observedAt);
              bucket.lastQuotaFailure = { ...evidence, observedAt, retryAt: bucket.exhaustedUntil };
              retryAt = Math.min(retryAt ?? Infinity, bucket.exhaustedUntil);
              this.#save(structuredClone(this.#state));
              continue;
            }
            const seconds = retrySeconds(upstream, error);
            bucket.cooldownUntil = observedAt + seconds * 1000;
            bucket.lastQuotaFailure = { ...evidence, observedAt, retryAt: bucket.cooldownUntil };
            this.#save(structuredClone(this.#state));
            if (evidence.kind === "minute") {
              retryAt = Math.min(retryAt ?? Infinity, bucket.cooldownUntil);
              continue;
            }
            return failure(429, "Google rate limited this project; daily free quota exhaustion was not confirmed", seconds);
          }
          return failure(502, `Google refused the request (HTTP ${upstream.status}); it was not replayed`);
        }
        if (!upstream.body) return failure(502, "Google returned an empty response");
        const reader = upstream.body.getReader();
        let settled = false;
        let received = 0;
        let output: ReadableStreamDefaultController<Uint8Array>;
        const settle = () => {
          if (!settled) {
            settled = true;
            signal.removeEventListener("abort", abort);
            this.#busy = false;
            reader.releaseLock();
          }
        };
        const abort = () => {
          void reader.cancel().catch(() => undefined).finally(() => {
            settle();
            output.error(new Error("Google response stream interrupted"));
          });
        };
        const stream = new ReadableStream<Uint8Array>({
          start: (controller) => {
            output = controller;
            signal.addEventListener("abort", abort, { once: true });
            if (signal.aborted) abort();
          },
          pull: async (controller) => {
            try {
              const result = await reader.read();
              if (settled || signal.aborted) return;
              if (result.done) { settle(); controller.close(); }
              else {
                received += result.value.byteLength;
                if (received > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new Error(); }
                controller.enqueue(result.value);
              }
            } catch { settle(); controller.error(new Error("Google response stream interrupted")); }
          },
          cancel: async () => { try { await reader.cancel(); } finally { settle(); } },
        });
        transferred = true;
        return new Response(stream, { status: upstream.status, headers: {
          "Content-Type": method === "streamGenerateContent" ? "text/event-stream" : "application/json",
          "Cache-Control": "no-store", "X-Watari-Project": project.label,
        } });
      }
      return failure(429, "all configured free projects are daily exhausted or temporarily cooling down",
        Math.max(1, Math.ceil(((retryAt ?? nextPacificMidnight(this.#now())) - this.#now()) / 1000)));
    } catch { return failure(503, "pool state could not be maintained; no further request was sent"); }
    finally { if (!transferred) this.#busy = false; }
  }
}

export async function handlePoolRequest(request: Request, pool: GeminiPool, token: string, port: number): Promise<Response> {
  if (request.headers.get("host") !== `127.0.0.1:${port}` || request.headers.has("origin")
    || ![null, "none"].includes(request.headers.get("sec-fetch-site"))) return failure(403, "only local non-browser clients are allowed");
  const supplied = request.headers.get("x-goog-api-key") ?? request.headers.get("authorization")?.replace(/^Bearer /u, "") ?? "";
  const actual = Buffer.from(supplied);
  const expected = Buffer.from(token);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return failure(401, "local pool authentication required");
  const url = new URL(request.url);
  if (url.pathname === "/status" && request.method === "GET" && !url.search) return Response.json(pool.status(), { headers: { "Cache-Control": "no-store" } });
  const match = /^\/v1beta\/models\/(gemini-[a-z0-9.-]{1,100}):(generateContent|streamGenerateContent)$/u.exec(url.pathname);
  if (!match) return failure(404, "unsupported pool route");
  if (request.method !== "POST") return failure(405, "generation requires POST");
  const params = [...url.searchParams];
  if (params.length && !(params.length === 1 && params[0]![0] === "alt" && params[0]![1] === "sse" && match[2] === "streamGenerateContent")) return failure(400, "unsupported query parameters");
  if (!/^application\/json\b/iu.test(request.headers.get("content-type") ?? "")) return failure(415, "send JSON");
  return await pool.generate(request, match[1]!, match[2]!);
}
