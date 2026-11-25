import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type { ProjectContext } from "../models.ts";

export function resolveProjectContext(inputPath: string): ProjectContext {
  const candidate = resolve(inputPath);
  if (!existsSync(candidate) || !statSync(candidate).isDirectory()) {
    throw new Error(`project path is not a directory: ${candidate}`);
  }
  const launchDirectory = realpathSync(candidate);
  const repositoryRoot = discoverRepositoryRoot(launchDirectory);
  return { launchDirectory, repositoryRoot };
}

function discoverRepositoryRoot(directory: string): string | null {
  const result = Bun.spawnSync(
    ["git", "-C", directory, "rev-parse", "--show-toplevel"],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (result.exitCode !== 0) {
    return null;
  }
  const root = result.stdout.toString().trim();
  return root ? realpathSync(root) : null;
}

export function resolveExecutable(
  name: "codex" | "claude" | "opencode" | "qwen" | "bun",
  override?: string,
): string | null {
  if (override) {
    const candidate = resolve(override);
    return existsSync(candidate) ? realpathSync(candidate) : null;
  }
  const fromPath = Bun.which(name);
  if (fromPath) {
    return realpathSync(fromPath);
  }
  const knownLocations: Record<typeof name, readonly string[]> = {
    bun: [join(homedir(), ".bun", "bin", "bun")],
    codex: [join(homedir(), ".local", "bin", "codex")],
    claude: [join(homedir(), ".local", "bin", "claude")],
    opencode: [join(homedir(), ".local", "bin", "opencode"), join(homedir(), ".opencode", "bin", "opencode")],
    qwen: [join(homedir(), ".local", "bin", "qwen")],
  };
  const candidate = knownLocations[name].find(existsSync);
  return candidate ? realpathSync(candidate) : null;
}
