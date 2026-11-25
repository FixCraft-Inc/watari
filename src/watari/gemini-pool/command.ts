import { join, resolve } from "node:path";

import { registerProcessCleanup } from "../process/shutdown.ts";
import { GeminiPool, handlePoolRequest } from "./pool.ts";
import {
  enrollProject, initializePool, loadPoolConfig, loadPoolState, lockPool,
  poolDirectory, readPoolKey, readPrivate, writePrivate,
} from "./store.ts";

export const GEMINI_POOL_PORT = 4466;
const HELP = `watari gemini-pool init [--directory PATH]
watari gemini-pool add LABEL PROJECT_ID --key-file PATH --billing-disabled [--directory PATH]
watari gemini-pool status [--directory PATH]
watari gemini-pool profile [--port N] [--directory PATH]
watari gemini-pool serve [--port N] [--directory PATH]

Only enroll projects whose billing you disabled in Google Cloud. This is your
attestation, not a billing check. Keys must be in private mode-600 files.
No command verifies credentials by making a model request.
`;

export interface PoolCommand {
  readonly action: "init" | "add" | "status" | "profile" | "serve" | "help";
  readonly directory: string;
  readonly port: number;
  readonly label?: string;
  readonly projectId?: string;
  readonly keyFile?: string;
}

export function parsePoolCommand(args: readonly string[]): PoolCommand {
  if (args.length === 0 || args[0] === "--help" || args[0] === "help") {
    if (args.length > 1) throw new Error(HELP);
    return { action: "help", directory: poolDirectory(), port: GEMINI_POOL_PORT };
  }
  const action = args[0];
  if (!["init", "add", "status", "profile", "serve"].includes(action!)) throw new Error(HELP);
  let directory = poolDirectory();
  let port = GEMINI_POOL_PORT;
  let keyFile: string | undefined;
  let billingDisabled = false;
  const positionals: string[] = [];
  const seen = new Set<string>();
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index]!;
    if (!argument.startsWith("--")) { positionals.push(argument); continue; }
    if (seen.has(argument)) throw new Error("duplicate Gemini pool option");
    seen.add(argument);
    if (argument === "--billing-disabled" && action === "add") { billingDisabled = true; continue; }
    if (!["--directory", "--port", "--key-file"].includes(argument)
      || (argument === "--port" && action !== "serve" && action !== "profile")
      || (argument === "--key-file" && action !== "add")) throw new Error("unsupported Gemini pool option");
    const value = args[++index];
    if (!value || value.startsWith("--")) throw new Error("Gemini pool option needs a value");
    if (argument === "--directory") directory = resolve(value);
    if (argument === "--key-file") keyFile = resolve(value);
    if (argument === "--port") {
      if (!/^\d+$/u.test(value) || Number(value) < 1024 || Number(value) > 65535) throw new Error("Gemini pool port must be 1024-65535");
      port = Number(value);
    }
  }
  if (action === "add") {
    if (positionals.length !== 2 || !keyFile || !billingDisabled) throw new Error(HELP);
    return { action, directory, port, label: positionals[0]!, projectId: positionals[1]!, keyFile };
  }
  if (positionals.length) throw new Error("unexpected Gemini pool argument");
  return { action: action as PoolCommand["action"], directory, port };
}

/** Native OpenCode v1 profile. It contains a local token file reference, never a Google key. */
export function openCodePoolProfile(directory: string, port: number, model: string): unknown {
  return {
    $schema: "https://opencode.ai/config.json",
    model: `google/${model}`,
    small_model: `google/${model}`,
    share: "disabled",
    autoupdate: false,
    provider: { google: { whitelist: [model], options: {
      baseURL: `http://127.0.0.1:${port}/v1beta`,
      apiKey: `{file:${join(directory, "token")}}`,
    } } },
  };
}

function loadEngine(directory: string): GeminiPool {
  const config = loadPoolConfig(directory);
  const keys = new Map(config.projects.map((entry) => [entry.projectId, readPoolKey(directory, entry.keyFile)]));
  return new GeminiPool({ config, keys, state: loadPoolState(directory),
    save: (state) => writePrivate(directory, "state.json", `${JSON.stringify(state, null, 2)}\n`),
  });
}

export async function runPoolCommand(args: readonly string[]): Promise<number> {
  const options = parsePoolCommand(args);
  const { directory, port } = options;
  if (options.action === "help") { process.stdout.write(HELP); return 0; }
  if (options.action === "init") {
    initializePool(directory);
    process.stdout.write(`Initialized empty private Gemini pool at ${directory}. No model calls made.\n`);
    return 0;
  }
  if (options.action === "add") {
    enrollProject(directory, options.label!, options.projectId!, options.keyFile!);
    process.stdout.write("Enrolled the project using your billing-disabled attestation. No model calls made.\n");
    return 0;
  }
  if (options.action === "profile") {
    const unlock = lockPool(directory);
    try {
      const config = loadPoolConfig(directory);
      readPrivate(join(directory, "token"), 256);
      writePrivate(directory, "opencode.json", `${JSON.stringify(openCodePoolProfile(directory, port, config.models[0]!), null, 2)}\n`);
    } finally { unlock(); }
    process.stdout.write(`OpenCode profile written to ${join(directory, "opencode.json")}. No Google key is in this file.\n`);
    return 0;
  }
  if (options.action === "status") {
    process.stdout.write(`${JSON.stringify(loadEngine(directory).status(), null, 2)}\n`);
    return 0;
  }
  const unlock = lockPool(directory);
  let engine: GeminiPool;
  let server: ReturnType<typeof Bun.serve>;
  try {
    engine = loadEngine(directory);
    const token = readPrivate(join(directory, "token"), 256).trim();
    if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) throw new Error("invalid private Gemini pool token");
    server = Bun.serve({ hostname: "127.0.0.1", port, idleTimeout: 255,
      maxRequestBodySize: 8 * 1024 * 1024,
      fetch: (request) => handlePoolRequest(request, engine, token, port),
      error: () => Response.json({ error: "Gemini pool request failed" }, { status: 500 }),
    });
  } catch (error) { unlock(); throw error; }
  process.stdout.write(`Gemini pool listening on http://127.0.0.1:${port}. Only configured billing-disabled projects are eligible.\n`);
  await new Promise<void>((done) => {
    registerProcessCleanup(async () => {
      engine.close();
      try { await server.stop(true); } finally { unlock(); done(); }
    });
  });
  return 0;
}
