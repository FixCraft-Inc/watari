import { z } from "zod";

import { AGENT_ALIAS_PATTERN } from "../team/identity.ts";

const AgentAliasSchema = z.string().regex(AGENT_ALIAS_PATTERN);
const RetentionSchema = z.object({
  truncated: z.boolean(),
  originalBytes: z.number().int().nonnegative(),
  retainedBytes: z.number().int().nonnegative(),
  omittedBytes: z.number().int().nonnegative(),
  originalLines: z.number().int().nonnegative(),
  retainedLines: z.number().int().nonnegative(),
  omittedLines: z.number().int().nonnegative(),
});

export const ActivitySummarySchema = z.object({
  id: z.string().regex(/^act_[a-f0-9]{24}$/u),
  agent: AgentAliasSchema,
  kind: z.enum(["command", "file_change"]),
  state: z.enum(["running", "completed", "failed", "interrupted"]),
  title: z.string().max(128),
  preview: z.string().max(512),
  providerEventId: z.string().min(1).max(512),
  revision: z.number().int().positive(),
  startedAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  hasDetail: z.boolean(),
});

const CommandActivityDetailSchema = z.object({
  kind: z.literal("command"),
  command: z.string().max(64 * 1024),
  cwd: z.string().max(16 * 1024).nullable(),
  outputMode: z.enum(["split", "combined"]),
  stdout: z.string().max(256 * 1024),
  stderr: z.string().max(256 * 1024),
  exitCode: z.number().int().nullable(),
  durationMs: z.number().nonnegative().nullable(),
  interrupted: z.boolean(),
  retention: RetentionSchema,
});

const ChangedFileDetailSchema = z.object({
  path: z.string().min(1).max(16 * 1024),
  kind: z.enum(["add", "update", "delete", "move", "unknown"]),
  diff: z.string().max(256 * 1024),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  retention: RetentionSchema,
});

const FileChangeActivityDetailSchema = z.object({
  kind: z.literal("file_change"),
  files: z.array(ChangedFileDetailSchema).max(512),
  retention: RetentionSchema,
});

export const ActivityDetailSchema = z.discriminatedUnion("kind", [
  CommandActivityDetailSchema,
  FileChangeActivityDetailSchema,
]);

export const ActivityRecordSchema = z.object({
  summary: ActivitySummarySchema,
  detail: ActivityDetailSchema,
});
