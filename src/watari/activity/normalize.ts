import { createHash } from "node:crypto";

import type { AgentEvent } from "../models.ts";
import { redactSummary } from "../security/redaction.ts";
import {
  MAX_ACTIVITY_COMMAND_BYTES,
  MAX_ACTIVITY_DETAIL_BYTES,
  combineRetention,
  retainActivityText,
} from "./retention.ts";
import type {
  ActivityRecord,
  ActivityState,
  ChangedFileDetail,
  CommandActivityDetail,
  ContentRetention,
  FileChangeKind,
} from "./types.ts";

const MAX_ACTIVITY_PREVIEW_CHARS = 512;
const MAX_ACTIVITY_FILES = 512;

interface RawChangedFile {
  readonly path: string;
  readonly kind: FileChangeKind;
  readonly diff: string;
}

export function normalizeActivityEvent(
  event: AgentEvent,
  previous: ActivityRecord | null,
): ActivityRecord | null {
  const providerEventId = event.providerEventId;
  if (!providerEventId) return null;
  // ACP harnesses (OpenCode, Qwen Code) describe work in their own shape, and
  // reading it as Claude/Codex detail produced empty cards.
  if (event.rawType?.startsWith("session/update/")) {
    return event.rawType === "session/update/tool_call" || event.rawType === "session/update/tool_call_update"
      ? acpActivity(event, providerEventId, previous)
      : null;
  }

  const payload = asRecord(event.payload);
  if (isCommandEvent(event, payload, previous)) {
    return commandRecord(event, providerEventId, payload, previous);
  }
  if (isFileChangeEvent(event, payload, previous)) {
    return fileChangeRecord(event, providerEventId, payload, previous);
  }
  return null;
}

export function deterministicActivityId(agent: string, providerEventId: string): string {
  const digest = createHash("sha256")
    .update(agent)
    .update("\0")
    .update(providerEventId)
    .digest("hex")
    .slice(0, 24);
  return `act_${digest}`;
}

/**
 * One ACP tool call. The start names the kind, the input, and the files it
 * touches. Later updates may carry only a status and content, so whatever the
 * start said is kept from the previous record.
 */
function acpActivity(
  event: AgentEvent,
  providerEventId: string,
  previous: ActivityRecord | null,
): ActivityRecord | null {
  const update = asRecord(asRecord(event.payload).update);
  const kind = stringValue(update.kind);
  const content = Array.isArray(update.content) ? update.content.map(asRecord) : [];
  const diffs = content.filter((entry) => entry.type === "diff");
  const status = acpState(update.status);
  if (previous?.detail.kind === "command" || (!previous && kind === "execute")) {
    return acpCommand(event, providerEventId, update, content, status, previous);
  }
  if (
    previous?.detail.kind === "file_change" ||
    kind === "edit" || kind === "delete" || kind === "move" || diffs.length > 0
  ) {
    return acpFileChange(event, providerEventId, update, kind, diffs, status, previous);
  }
  return null;
}

function acpState(value: unknown): ActivityState | null {
  if (value === "completed") return "completed";
  if (value === "failed") return "failed";
  if (value === "pending" || value === "in_progress") return "running";
  return null;
}

function acpCommand(
  event: AgentEvent,
  providerEventId: string,
  update: Record<string, unknown>,
  content: readonly Record<string, unknown>[],
  status: ActivityState | null,
  previous: ActivityRecord | null,
): ActivityRecord {
  const prior = previous?.detail.kind === "command" ? previous.detail : null;
  const input = asRecord(update.rawInput);
  const rawOutput = update.rawOutput;
  const output = asRecord(rawOutput);
  const metadata = asRecord(output.metadata);
  const command = retainedCommand(
    stringValue(input.command) ?? stringValue(input.cmd) ?? prior?.command ?? stringValue(update.title) ?? summaryDetail(event.summary),
  );
  const cwdValue = stringValue(input.cwd) ?? stringValue(input.workdir) ?? stringValue(input.directory) ?? prior?.cwd ?? null;
  // Harnesses resend the whole output so far rather than a delta, and put the
  // final text either in `rawOutput` or in the content blocks.
  const text = content
    .map((entry) => asRecord(entry.content))
    .filter((block) => block.type === "text")
    .map((block) => stringValue(block.text) ?? "")
    .join("\n");
  const stdout = (typeof rawOutput === "string" ? rawOutput : null)
    ?? stringValue(output.output)
    ?? stringValue(metadata.output)
    ?? (text || prior?.stdout || "");
  const retainedOutput = retainCommandOutput(stdout, prior?.stderr ?? "");
  const exitCode = numberValue(metadata.exit) ?? numberValue(metadata.exitCode) ?? numberValue(output.exitCode)
    ?? numberValue(output.exit_code) ?? prior?.exitCode ?? null;
  const state = status === "completed" && exitCode !== null && exitCode !== 0
    ? "failed"
    : status ?? previous?.summary.state ?? "running";
  const updatedAt = event.timestamp;
  return {
    summary: {
      id: previous?.summary.id ?? deterministicActivityId(event.agent, providerEventId),
      agent: event.agent,
      kind: "command",
      state,
      title: "bash",
      preview: activityPreview(command.replace(/\s+/gu, " ").trim()),
      providerEventId,
      revision: (previous?.summary.revision ?? 0) + 1,
      startedAt: previous?.summary.startedAt ?? updatedAt,
      updatedAt,
      hasDetail: true,
    },
    detail: {
      kind: "command",
      command,
      cwd: cwdValue === null ? null : retainActivityText(cwdValue, 16 * 1024).text,
      outputMode: "combined",
      stdout: retainedOutput.stdout,
      stderr: retainedOutput.stderr,
      exitCode,
      durationMs: prior?.durationMs ?? (state === "running" ? null : updatedAt - (previous?.summary.startedAt ?? updatedAt)),
      interrupted: false,
      retention: retainedOutput.retention,
    },
  };
}

function acpFileChange(
  event: AgentEvent,
  providerEventId: string,
  update: Record<string, unknown>,
  kind: string | null,
  diffs: readonly Record<string, unknown>[],
  status: ActivityState | null,
  previous: ActivityRecord | null,
): ActivityRecord {
  const prior = previous?.detail.kind === "file_change" ? previous.detail : null;
  const locations = (Array.isArray(update.locations) ? update.locations : [])
    .map((location) => stringValue(asRecord(location).path))
    .filter((path): path is string => path !== null);
  const changeKind: FileChangeKind = kind === "delete" ? "delete" : kind === "move" ? "move" : "update";
  let normalized: { readonly files: readonly ChangedFileDetail[]; readonly retention: ContentRetention };
  if (diffs.length > 0) {
    normalized = boundFiles(diffs.map((diff) => acpDiffFile(diff, locations, prior?.files ?? [], changeKind)));
  } else if (locations.length > 0 && (prior?.files.length ?? 0) === 0) {
    normalized = boundFiles(locations.map((path) => ({ path, kind: changeKind, diff: "" })));
  } else {
    normalized = { files: prior?.files ?? [], retention: combineRetention((prior?.files ?? []).map((file) => file.retention)) };
  }
  const files = normalized.files;
  const state = status ?? previous?.summary.state ?? "running";
  const updatedAt = event.timestamp;
  const preview = files.map((file) => file.path).filter(Boolean).slice(0, 2).join("  ") || summaryDetail(event.summary);
  return {
    summary: {
      id: previous?.summary.id ?? deterministicActivityId(event.agent, providerEventId),
      agent: event.agent,
      kind: "file_change",
      state,
      title: "edit",
      preview: activityPreview(preview),
      providerEventId,
      revision: (previous?.summary.revision ?? 0) + 1,
      startedAt: previous?.summary.startedAt ?? updatedAt,
      updatedAt,
      hasDetail: true,
    },
    detail: { kind: "file_change", files, retention: normalized.retention },
  };
}

/**
 * A harness may name a diff by its base name while the start event gave the
 * full path in `locations`. The full path is the one edit overlap compares.
 */
function acpDiffFile(
  diff: Record<string, unknown>,
  locations: readonly string[],
  known: readonly ChangedFileDetail[],
  fallbackKind: FileChangeKind,
): RawChangedFile {
  const named = stringValue(diff.path) ?? "";
  const candidates = [...locations, ...known.map((file) => file.path)];
  const path = candidates.find((candidate) => candidate === named)
    ?? candidates.find((candidate) => named !== "" && !named.includes("/") && candidate.endsWith(`/${named}`))
    ?? (named || candidates[0] || "");
  const oldText = typeof diff.oldText === "string" ? diff.oldText : null;
  const newText = typeof diff.newText === "string" ? diff.newText : "";
  const kind: FileChangeKind = oldText === null || (oldText === "" && newText !== "") ? "add" : fallbackKind;
  return { path, kind, diff: lineDiff(oldText ?? "", newText) };
}

/**
 * A unified hunk for a whole-file before and after. Only the changed middle is
 * kept, with up to three lines of context, so a one-line edit to a long file
 * reads as one line rather than as the file twice.
 */
export function lineDiff(before: string, after: string): string {
  if (before === after) return "";
  const oldLines = before === "" ? [] : before.split("\n");
  const newLines = after === "" ? [] : after.split("\n");
  let head = 0;
  while (head < oldLines.length && head < newLines.length && oldLines[head] === newLines[head]) head += 1;
  let tail = 0;
  while (
    tail < oldLines.length - head &&
    tail < newLines.length - head &&
    oldLines[oldLines.length - 1 - tail] === newLines[newLines.length - 1 - tail]
  ) tail += 1;
  const context = 3;
  const start = Math.max(0, head - context);
  const oldEnd = Math.min(oldLines.length, oldLines.length - tail + context);
  const newEnd = Math.min(newLines.length, newLines.length - tail + context);
  const lines = [`@@ -${start + 1},${oldEnd - start} +${start + 1},${newEnd - start} @@`];
  for (let index = start; index < head; index += 1) lines.push(` ${oldLines[index]}`);
  for (let index = head; index < oldLines.length - tail; index += 1) lines.push(`-${oldLines[index]}`);
  for (let index = head; index < newLines.length - tail; index += 1) lines.push(`+${newLines[index]}`);
  for (let index = oldLines.length - tail; index < oldEnd; index += 1) lines.push(` ${oldLines[index]}`);
  return lines.join("\n");
}

function commandRecord(
  event: AgentEvent,
  providerEventId: string,
  payload: Record<string, unknown>,
  previous: ActivityRecord | null,
): ActivityRecord {
  const prior = previous?.detail.kind === "command" ? previous.detail : null;
  const nativeItem = payload.type === "commandExecution";
  const delta = outputDelta(payload);
  const command = retainedCommand(
    stringValue(payload.command) ?? stringValue(payload.cmd) ?? inputCommand(payload) ?? prior?.command ?? summaryDetail(event.summary),
  );
  const cwdValue = stringValue(payload.cwd) ?? prior?.cwd ?? null;
  const cwd = cwdValue === null
    ? null
    : retainActivityText(cwdValue, 16 * 1024).text;
  const nativeOutput = nativeItem ? nullableString(payload.aggregatedOutput) : null;
  const stdout = stringValue(payload.stdout) ?? nativeOutput ?? appendDelta(prior?.stdout, delta);
  const stderr = stringValue(payload.stderr) ?? prior?.stderr ?? "";
  const retainedOutput = retainCommandOutput(stdout, stderr);
  const state = commandState(event, payload, prior);
  const updatedAt = event.timestamp;
  const startedAt = previous?.summary.startedAt ?? updatedAt;
  const detail: CommandActivityDetail = {
    kind: "command",
    command,
    cwd,
    outputMode: nativeOutput !== null ? "combined" : "split",
    stdout: retainedOutput.stdout,
    stderr: retainedOutput.stderr,
    exitCode: numberValue(payload.exitCode) ?? numberValue(payload.exit_code) ?? prior?.exitCode ?? null,
    durationMs: numberValue(payload.durationMs) ?? numberValue(payload.duration_ms) ?? prior?.durationMs ?? null,
    interrupted: payload.interrupted === true || state === "interrupted",
    retention: retainedOutput.retention,
  };
  return {
    summary: {
      id: previous?.summary.id ?? deterministicActivityId(event.agent, providerEventId),
      agent: event.agent,
      kind: "command",
      state,
      title: "bash",
      preview: activityPreview(command.replace(/\s+/gu, " ").trim()),
      providerEventId,
      revision: (previous?.summary.revision ?? 0) + 1,
      startedAt,
      updatedAt,
      hasDetail: true,
    },
    detail,
  };
}

function fileChangeRecord(
  event: AgentEvent,
  providerEventId: string,
  payload: Record<string, unknown>,
  previous: ActivityRecord | null,
): ActivityRecord {
  const prior = previous?.detail.kind === "file_change" ? previous.detail : null;
  const normalized = normalizedFiles(payload, prior?.files ?? []);
  const files = normalized.files;
  const state = fileState(event, payload);
  const updatedAt = event.timestamp;
  const preview = files.map((file) => file.path).filter(Boolean).slice(0, 2).join("  ") || summaryDetail(event.summary);
  return {
    summary: {
      id: previous?.summary.id ?? deterministicActivityId(event.agent, providerEventId),
      agent: event.agent,
      kind: "file_change",
      state,
      title: "edit",
      preview: activityPreview(preview),
      providerEventId,
      revision: (previous?.summary.revision ?? 0) + 1,
      startedAt: previous?.summary.startedAt ?? updatedAt,
      updatedAt,
      hasDetail: true,
    },
    detail: {
      kind: "file_change",
      files,
      retention: normalized.retention,
    },
  };
}

function isCommandEvent(
  event: AgentEvent,
  payload: Record<string, unknown>,
  previous: ActivityRecord | null,
): boolean {
  if (previous?.detail.kind === "command") return true;
  if (payload.type === "commandExecution") return true;
  if (event.kind === "tool_output" && outputDelta(payload) !== null) return true;
  return /^(?:bash|shell|command)(?:\s{2,}|$)/iu.test(event.summary);
}

function isFileChangeEvent(
  event: AgentEvent,
  payload: Record<string, unknown>,
  previous: ActivityRecord | null,
): boolean {
  if (previous?.detail.kind === "file_change") return true;
  if (payload.type === "fileChange") return true;
  if (event.kind === "edit") return true;
  if (hasFileResult(payload)) return true;
  return /^(?:edit|write)(?:\s{2,}|$)/iu.test(event.summary);
}

function commandState(
  event: AgentEvent,
  payload: Record<string, unknown>,
  prior: CommandActivityDetail | null,
): ActivityState {
  if (payload.interrupted === true) return "interrupted";
  const status = stringValue(payload.status);
  if (status === "interrupted" || status === "cancelled") return "interrupted";
  if (status === "failed" || status === "declined") return "failed";
  if (status === "inProgress" || status === "running") return "running";
  const exitCode = numberValue(payload.exitCode) ?? numberValue(payload.exit_code) ?? prior?.exitCode;
  if (exitCode !== undefined && exitCode !== null && exitCode !== 0) return "failed";
  if (/\s+failed$/iu.test(event.summary)) return "failed";
  if (event.kind === "tool_start" || event.kind === "tool_output" || event.rawType === "item/started") return "running";
  return "completed";
}

function fileState(event: AgentEvent, payload: Record<string, unknown>): ActivityState {
  const status = stringValue(payload.status);
  if (status === "interrupted" || status === "cancelled") return "interrupted";
  if (status === "failed" || status === "declined") return "failed";
  if (/\s+failed$/iu.test(event.summary)) return "failed";
  if (
    event.rawType === "item/started" ||
    event.kind === "tool_start" ||
    event.kind === "tool_output"
  ) return "running";
  return "completed";
}

function normalizedFiles(
  payload: Record<string, unknown>,
  fallback: readonly ChangedFileDetail[],
): { readonly files: readonly ChangedFileDetail[]; readonly retention: ContentRetention } {
  const changes = Array.isArray(payload.changes) ? payload.changes : null;
  if (changes) {
    return boundFiles(changes.map((change) => codexFile(change)).filter(isRawChangedFile));
  }
  const claude = claudeFile(payload);
  return claude
    ? boundFiles([claude])
    : { files: fallback, retention: combineRetention(fallback.map((file) => file.retention)) };
}

function codexFile(value: unknown): RawChangedFile | null {
  const change = asRecord(value);
  const path = stringValue(change.path);
  if (!path) return null;
  return { path, kind: changeKind(change.kind), diff: stringValue(change.diff) ?? "" };
}

function claudeFile(payload: Record<string, unknown>): RawChangedFile | null {
  const path = stringValue(payload.filePath) ?? stringValue(payload.file_path);
  if (!path) return null;
  const gitDiff = asRecord(payload.gitDiff);
  const patch = stringValue(gitDiff.patch) ?? structuredPatch(payload.structuredPatch) ?? inputPatch(payload);
  const kind: FileChangeKind = payload.type === "create" || gitDiff.status === "added" ? "add" : "update";
  return { path, kind, diff: patch };
}

function boundFiles(
  rawFiles: readonly RawChangedFile[],
): { readonly files: readonly ChangedFileDetail[]; readonly retention: ContentRetention } {
  let remaining = MAX_ACTIVITY_DETAIL_BYTES;
  const bounded: ChangedFileDetail[] = [];
  const retentions: ContentRetention[] = [];
  const candidates = rawFiles.slice(0, MAX_ACTIVITY_FILES);
  for (const file of candidates) {
    if (remaining <= 0) {
      retentions.push(retainActivityText(file.diff, 0).retention);
      continue;
    }
    const path = retainActivityText(file.path, Math.min(16 * 1024, remaining)).text;
    remaining -= Buffer.byteLength(path, "utf8");
    if (!path) {
      retentions.push(retainActivityText(file.diff, 0).retention);
      continue;
    }
    const retained = retainActivityText(file.diff, remaining);
    retentions.push(retained.retention);
    const counts = diffCounts(retainActivityText(file.diff, Number.MAX_SAFE_INTEGER).text);
    bounded.push({
      path,
      kind: file.kind,
      diff: retained.text,
      additions: counts.additions,
      deletions: counts.deletions,
      retention: retained.retention,
    });
    remaining -= retained.retention.retainedBytes;
  }
  for (const file of rawFiles.slice(MAX_ACTIVITY_FILES)) {
    retentions.push(retainActivityText(file.diff, 0).retention);
  }
  const retention = combineRetention(retentions);
  return {
    files: bounded,
    retention,
  };
}

function retainCommandOutput(stdout: string, stderr: string): {
  readonly stdout: string;
  readonly stderr: string;
  readonly retention: ContentRetention;
} {
  const stdoutBudget = stderr ? Math.floor(MAX_ACTIVITY_DETAIL_BYTES * 0.75) : MAX_ACTIVITY_DETAIL_BYTES;
  const retainedStdout = retainActivityText(stdout, stdoutBudget);
  const remaining = Math.max(0, MAX_ACTIVITY_DETAIL_BYTES - retainedStdout.retention.retainedBytes);
  const retainedStderr = retainActivityText(stderr, remaining);
  return {
    stdout: retainedStdout.text,
    stderr: retainedStderr.text,
    retention: combineRetention([retainedStdout.retention, retainedStderr.retention]),
  };
}

function retainedCommand(command: string): string {
  return retainActivityText(command, MAX_ACTIVITY_COMMAND_BYTES).text;
}

function outputDelta(payload: Record<string, unknown>): string | null {
  return stringValue(payload.delta) ?? stringValue(asRecord(payload.params).delta);
}

function appendDelta(previous: string | undefined, delta: string | null): string {
  return `${previous ?? ""}${delta ?? ""}`;
}

function inputCommand(payload: Record<string, unknown>): string | null {
  return stringValue(asRecord(payload.input).command);
}

function inputPatch(payload: Record<string, unknown>): string {
  const oldString = stringValue(payload.oldString) ?? stringValue(payload.old_string) ?? "";
  const newString = stringValue(payload.newString) ?? stringValue(payload.new_string) ?? stringValue(payload.content) ?? "";
  if (!oldString && !newString) return "";
  return ["@@ -1 +1 @@", ...oldString.split("\n").map((line) => `-${line}`), ...newString.split("\n").map((line) => `+${line}`)].join("\n");
}

function structuredPatch(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const hunks: string[] = [];
  for (const entry of value) {
    const hunk = asRecord(entry);
    const lines = Array.isArray(hunk.lines) ? hunk.lines.filter((line): line is string => typeof line === "string") : [];
    hunks.push(`@@ -${numberValue(hunk.oldStart) ?? 0},${numberValue(hunk.oldLines) ?? 0} +${numberValue(hunk.newStart) ?? 0},${numberValue(hunk.newLines) ?? 0} @@`);
    hunks.push(...lines);
  }
  return hunks.join("\n");
}

function changeKind(value: unknown): FileChangeKind {
  const direct = stringValue(value);
  const nested = stringValue(asRecord(value).type);
  const kind = direct ?? nested;
  if (kind === "add" || kind === "create") return "add";
  if (kind === "delete") return "delete";
  if (kind === "move" || kind === "rename") return "move";
  if (kind === "update" || kind === "modify") return "update";
  return "unknown";
}

function diffCounts(diff: string): { readonly additions: number; readonly deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
    if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
  }
  return { additions, deletions };
}

function summaryDetail(summary: string): string {
  const parts = summary.replace(/\s+failed$/iu, "").split(/\s{2,}/u);
  return parts.slice(1).join(" ");
}

function hasFileResult(payload: Record<string, unknown>): boolean {
  return typeof payload.filePath === "string" && (Array.isArray(payload.structuredPatch) || isRecord(payload.gitDiff));
}

function isRawChangedFile(value: RawChangedFile | null): value is RawChangedFile {
  return value !== null;
}

function activityPreview(value: string): string {
  return redactSummary(value).slice(0, MAX_ACTIVITY_PREVIEW_CHARS);
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
