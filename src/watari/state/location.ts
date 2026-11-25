import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import type { ProjectContext } from "../models.ts";

export interface StateLocation {
  readonly projectId: string;
  readonly directory: string;
  readonly databasePath: string;
  readonly configPath: string;
  readonly socketPath: string;
  readonly lockPath: string;
  readonly logPath: string;
  readonly chatsDirectory: string;
  readonly exportsDirectory: string;
}

export function resolveStateLocation(project: ProjectContext): StateLocation {
  const identity = project.repositoryRoot ?? project.launchDirectory;
  const digest = createHash("sha256").update(identity).digest("hex").slice(0, 16);
  const label = sanitizeLabel(basename(identity));
  const projectId = `${label}-${digest}`;
  const stateRoot = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
  const directory = join(stateRoot, "watari", projectId);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  return {
    projectId,
    directory,
    databasePath: join(directory, "state.db"),
    configPath: join(directory, "agents.json"),
    socketPath: join(directory, "runtime.sock"),
    lockPath: join(directory, "runtime.lock"),
    logPath: join(directory, "service.log"),
    chatsDirectory: join(directory, "chats"),
    exportsDirectory: join(directory, "exports"),
  };
}

function sanitizeLabel(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9_-]+/gu, "-").replace(/^-+|-+$/gu, "");
  return (normalized || "project").slice(0, 32);
}
