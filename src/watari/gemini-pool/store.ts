import { randomBytes } from "node:crypto";
import {
  closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync,
  openSync, readSync, renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const label = z.string().regex(/^[a-z][a-z0-9_-]{0,47}$/u);
const project = z.string().regex(/^(?:[a-z][a-z0-9-]{4,61}[a-z0-9]|[0-9]{6,24})$/u);
// Keys are opaque header values. Dots are valid, whitespace and controls are not.
const googleKey = /^[A-Za-z0-9_.-]{16,256}$/u;
export const PoolConfigSchema = z.strictObject({
  schemaVersion: z.literal(1),
  models: z.array(z.string().regex(/^gemini-[a-z0-9.-]{1,100}$/u)).min(1).max(16),
  projects: z.array(z.strictObject({
    label,
    projectId: project,
    keyFile: z.string().regex(/^[a-f0-9]{32}\.key$/u),
    billingDisabledConfirmed: z.literal(true),
  })).max(16),
}).superRefine((value, context) => {
  for (const field of ["label", "projectId", "keyFile"] as const) {
    if (new Set(value.projects.map((entry) => entry[field])).size !== value.projects.length) {
      context.addIssue({ code: "custom", message: `duplicate ${field}` });
    }
  }
  if (new Set(value.models).size !== value.models.length) context.addIssue({ code: "custom", message: "duplicate model" });
});

export type PoolConfig = z.infer<typeof PoolConfigSchema>;
export const QuotaFailureSchema = z.strictObject({
  kind: z.enum(["daily", "minute", "unknown"]),
  observedAt: z.number().int().nonnegative(),
  retryAt: z.number().int().nonnegative(),
  violations: z.array(z.strictObject({
    quotaId: z.string().regex(/^[A-Za-z0-9_.-]{1,200}$/u),
    limit: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
  })).max(32),
});
export type QuotaFailure = z.infer<typeof QuotaFailureSchema>;
export const PoolStateSchema = z.strictObject({
  schemaVersion: z.literal(1),
  buckets: z.record(z.string().max(200), z.strictObject({
    day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
    attempts: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    exhaustedUntil: z.number().int().nonnegative(),
    cooldownUntil: z.number().int().nonnegative(),
    lastQuotaFailure: QuotaFailureSchema.optional(),
  })).refine((buckets) => Object.keys(buckets).length <= 256),
});
export type PoolState = z.infer<typeof PoolStateSchema>;

export function poolDirectory(environment: NodeJS.ProcessEnv = process.env): string {
  return join(environment["XDG_CONFIG_HOME"] || join(homedir(), ".config"), "watari", "gemini-pool");
}

/** Reject links, special files and group-readable credentials before reading. */
export function readPrivate(path: string, maximum = 128 * 1024): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.size > maximum) {
      throw new Error("pool files must be bounded regular files owned by you with mode 600");
    }
    const buffer = Buffer.alloc(maximum + 1);
    let size = 0;
    while (size < buffer.length) {
      const count = readSync(fd, buffer, size, buffer.length - size, null);
      if (!count) break;
      size += count;
    }
    if (size > maximum) throw new Error("pool file exceeds its size limit");
    return buffer.toString("utf8", 0, size);
  } finally {
    closeSync(fd);
  }
}

function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
    throw new Error("pool directories must be owned by you with mode 700, without symlinks");
  }
}

export function preparePoolDirectory(directory: string): void {
  privateDirectory(directory);
  privateDirectory(join(directory, "keys"));
}

export function writePrivate(directory: string, name: string, text: string): void {
  const temporary = join(directory, `.${randomBytes(16).toString("hex")}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    writeFileSync(fd, text);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, join(directory, name));
    const directoryFd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY);
    try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

/** A single owner covers serving and configuration changes. Stale locks fail closed. */
export function lockPool(directory: string): () => void {
  preparePoolDirectory(directory);
  const path = join(directory, "owner.lock");
  let fd: number;
  try { fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600); }
  catch { throw new Error("Gemini pool is locked. Stop its server before editing. Inspect a stale owner.lock before removing it."); }
  const identity = fstatSync(fd);
  try { writeFileSync(fd, `${process.pid}\n`); }
  catch (error) { closeSync(fd); unlinkSync(path); throw error; }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    closeSync(fd);
    if (existsSync(path)) {
      const current = lstatSync(path);
      if (current.ino === identity.ino && current.dev === identity.dev) unlinkSync(path);
    }
  };
}

export function loadPoolConfig(directory: string): PoolConfig {
  try { return PoolConfigSchema.parse(JSON.parse(readPrivate(join(directory, "config.json")))); }
  catch { throw new Error("invalid or unreadable private Gemini pool config.json"); }
}

export function loadPoolState(directory: string): PoolState {
  const path = join(directory, "state.json");
  if (!existsSync(path)) return { schemaVersion: 1, buckets: {} };
  // All 256 buckets can retain 32 bounded violations. Keep the read bound
  // large enough for that schema, including pretty-printed numeric evidence.
  try { return PoolStateSchema.parse(JSON.parse(readPrivate(path, 4 * 1024 * 1024))); }
  catch { throw new Error("invalid or unreadable private Gemini pool state.json; refusing to reset quota evidence"); }
}

export function readPoolKey(directory: string, file: string): string {
  const key = readPrivate(join(directory, "keys", file), 512).trim();
  if (!googleKey.test(key)) throw new Error("invalid private Google key file");
  return key;
}

export function initializePool(directory: string): void {
  const unlock = lockPool(directory);
  try {
    if (existsSync(join(directory, "config.json")) || existsSync(join(directory, "token"))) {
      throw new Error("Gemini pool is already initialized; existing files were preserved");
    }
    writePrivate(directory, "token", `${randomBytes(32).toString("base64url")}\n`);
    writePrivate(directory, "config.json", `${JSON.stringify({ schemaVersion: 1, models: ["gemini-4-hydrogen"], projects: [] }, null, 2)}\n`);
  } finally { unlock(); }
}

/** Enrollment is an owner attestation. An API key cannot prove billing status. */
export function enrollProject(directory: string, name: string, projectId: string, source: string): void {
  if (!label.safeParse(name).success || !project.safeParse(projectId).success) throw new Error("invalid project label or Google project ID");
  const key = readPrivate(source, 512).trim();
  if (!googleKey.test(key)) throw new Error("invalid private Google key file");
  const unlock = lockPool(directory);
  const file = `${randomBytes(16).toString("hex")}.key`;
  let written = false;
  try {
    const config = loadPoolConfig(directory);
    if (config.projects.some((entry) => readPoolKey(directory, entry.keyFile) === key)) throw new Error("this key is already enrolled");
    const parsed = PoolConfigSchema.safeParse({ ...config, projects: [...config.projects, { label: name, projectId, keyFile: file, billingDisabledConfirmed: true }] });
    if (!parsed.success) throw new Error("duplicate project/label or pool capacity exceeded");
    writePrivate(join(directory, "keys"), file, `${key}\n`);
    written = true;
    writePrivate(directory, "config.json", `${JSON.stringify(parsed.data, null, 2)}\n`);
  } catch (error) {
    // Keep a referenced key if a post-rename fsync failed.
    if (written && !loadPoolConfig(directory).projects.some((entry) => entry.keyFile === file)) unlinkSync(join(directory, "keys", file));
    throw error;
  } finally { unlock(); }
}
