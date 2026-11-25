import type { AgentId } from "../models.ts";

export type ActivityKind = "command" | "file_change";
export type ActivityState = "running" | "completed" | "failed" | "interrupted";

export interface ContentRetention {
  readonly truncated: boolean;
  readonly originalBytes: number;
  readonly retainedBytes: number;
  readonly omittedBytes: number;
  readonly originalLines: number;
  readonly retainedLines: number;
  readonly omittedLines: number;
}

export interface ActivitySummary {
  readonly id: string;
  readonly agent: AgentId;
  readonly kind: ActivityKind;
  readonly state: ActivityState;
  readonly title: string;
  readonly preview: string;
  readonly providerEventId: string;
  readonly revision: number;
  readonly startedAt: number;
  readonly updatedAt: number;
  readonly hasDetail: boolean;
}

export interface CommandActivityDetail {
  readonly kind: "command";
  readonly command: string;
  readonly cwd: string | null;
  readonly outputMode: "split" | "combined";
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly durationMs: number | null;
  readonly interrupted: boolean;
  readonly retention: ContentRetention;
}

export type FileChangeKind = "add" | "update" | "delete" | "move" | "unknown";

export interface ChangedFileDetail {
  readonly path: string;
  readonly kind: FileChangeKind;
  readonly diff: string;
  readonly additions: number;
  readonly deletions: number;
  readonly retention: ContentRetention;
}

export interface FileChangeActivityDetail {
  readonly kind: "file_change";
  readonly files: readonly ChangedFileDetail[];
  readonly retention: ContentRetention;
}

export type ActivityDetail = CommandActivityDetail | FileChangeActivityDetail;

export interface ActivityRecord {
  readonly summary: ActivitySummary;
  readonly detail: ActivityDetail;
}
