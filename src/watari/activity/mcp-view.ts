import { retainActivityText } from "./retention.ts";
import type { ActivityDetail, ChangedFileDetail, CommandActivityDetail } from "./types.ts";

export function boundedActivityDetail(detail: ActivityDetail, maximumBytes: number): ActivityDetail {
  return detail.kind === "command"
    ? boundedCommand(detail, maximumBytes)
    : boundedFileChange(detail, maximumBytes);
}

function boundedCommand(detail: CommandActivityDetail, maximumBytes: number): CommandActivityDetail {
  const commandBudget = Math.min(Math.floor(maximumBytes * 0.35), 8 * 1024);
  const command = retainActivityText(detail.command, commandBudget).text;
  const cwdBudget = Math.min(Math.floor(maximumBytes * 0.1), 2 * 1024);
  const cwd = detail.cwd === null ? null : retainActivityText(detail.cwd, cwdBudget).text;
  const metadataBytes = Buffer.byteLength(command, "utf8") + Buffer.byteLength(cwd ?? "", "utf8");
  const outputBudget = Math.max(0, maximumBytes - metadataBytes);
  const stdoutBudget = detail.stderr === "" ? outputBudget : Math.floor(outputBudget * 0.75);
  const stdout = retainActivityText(detail.stdout, stdoutBudget);
  const stderr = retainActivityText(
    detail.stderr,
    Math.max(0, outputBudget - stdout.retention.retainedBytes),
  );
  return {
    ...detail,
    command,
    cwd,
    stdout: stdout.text,
    stderr: stderr.text,
    retention: combineViewRetention(detail, stdout.retention, stderr.retention),
  };
}

function boundedFileChange(
  detail: Extract<ActivityDetail, { readonly kind: "file_change" }>,
  maximumBytes: number,
): ActivityDetail {
  let remaining = maximumBytes;
  const files: ChangedFileDetail[] = [];
  for (const file of detail.files) {
    if (remaining <= 0) break;
    const path = retainActivityText(file.path, Math.min(remaining, 2 * 1024)).text;
    remaining -= Buffer.byteLength(path, "utf8");
    if (remaining <= 0) break;
    const diff = retainActivityText(file.diff, remaining);
    files.push({
      ...file,
      path,
      diff: diff.text,
      retention: {
        ...diff.retention,
        originalBytes: file.retention.originalBytes,
        originalLines: file.retention.originalLines,
        omittedBytes: Math.max(file.retention.omittedBytes, diff.retention.omittedBytes),
        omittedLines: Math.max(file.retention.omittedLines, diff.retention.omittedLines),
        truncated: file.retention.truncated || diff.retention.truncated,
      },
    });
    remaining -= diff.retention.retainedBytes;
  }
  const originalBytes = detail.files.reduce((total, file) => total + file.retention.originalBytes, 0);
  const originalLines = detail.files.reduce((total, file) => total + file.retention.originalLines, 0);
  const retainedBytes = files.reduce((total, file) => total + file.retention.retainedBytes, 0);
  const retainedLines = files.reduce((total, file) => total + file.retention.retainedLines, 0);
  return {
    kind: "file_change",
    files,
    retention: {
      truncated: files.length < detail.files.length || detail.retention.truncated || retainedBytes < originalBytes,
      originalBytes,
      retainedBytes,
      omittedBytes: Math.max(0, originalBytes - retainedBytes),
      originalLines,
      retainedLines,
      omittedLines: Math.max(0, originalLines - retainedLines),
    },
  };
}

function combineViewRetention(
  original: CommandActivityDetail,
  stdout: CommandActivityDetail["retention"],
  stderr: CommandActivityDetail["retention"],
): CommandActivityDetail["retention"] {
  const retainedBytes = stdout.retainedBytes + stderr.retainedBytes;
  const retainedLines = stdout.retainedLines + stderr.retainedLines;
  return {
    truncated: original.retention.truncated || stdout.truncated || stderr.truncated,
    originalBytes: original.retention.originalBytes,
    retainedBytes,
    omittedBytes: Math.max(0, original.retention.originalBytes - retainedBytes),
    originalLines: original.retention.originalLines,
    retainedLines,
    omittedLines: Math.max(0, original.retention.originalLines - retainedLines),
  };
}
