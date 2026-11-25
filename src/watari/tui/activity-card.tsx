import type { MouseEvent, ScrollBoxRenderable } from "@opentui/core";
import { For, Show } from "solid-js";

import type {
  ActivityDetail,
  ActivitySummary,
  ChangedFileDetail,
  CommandActivityDetail,
} from "../activity/types.ts";
import { cellWidth, truncate } from "./format.ts";
import { GLYPHS, type Accents, type Theme } from "./theme.ts";

export interface ActivityCardProps {
  readonly summary: ActivitySummary;
  readonly detail: ActivityDetail | null;
  readonly expanded: boolean;
  readonly focused: boolean;
  readonly loading: boolean;
  readonly selectedFile: number;
  readonly paneRows: number;
  readonly width: number;
  readonly theme: Theme;
  readonly accents: Accents;
  readonly onToggle: () => void;
  readonly onSelectFile: (index: number) => void;
  readonly onPaneRef: (renderable: ScrollBoxRenderable) => void;
}

export function ActivityCard(props: ActivityCardProps) {
  const accent = () => props.accents(props.summary.agent);
  const state = () => activityState(props.summary, props.theme);
  const detail = () => props.detail;
  const selectedFile = (): ChangedFileDetail | null => {
    const current = detail();
    if (current?.kind !== "file_change") return null;
    return current.files[Math.min(props.selectedFile, Math.max(0, current.files.length - 1))] ?? null;
  };
  const click = (event: MouseEvent): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    props.onToggle();
  };
  const stopNestedWheel = (event: MouseEvent): void => event.stopPropagation();

  return (
    <box
      id={`activity-${props.summary.id}`}
      style={{
        flexDirection: "column",
        width: "100%",
        flexShrink: 0,
        backgroundColor: props.focused ? props.theme.raised : props.theme.base,
        paddingRight: 1,
      }}
    >
      <box
        style={{ flexDirection: "row", height: 1, width: "100%", flexShrink: 0 }}
        onMouseDown={click}
      >
        <text fg={props.focused ? props.theme.brand : props.theme.faint}>
          {` ${props.expanded ? "▾" : "▸"} `}
        </text>
        <text fg={state().color}>{`${state().glyph} `}</text>
        <text fg={accent()}>{`${props.summary.agent}  `}</text>
        <text fg={props.summary.state === "failed" ? props.theme.danger : props.theme.muted}>
          {`${props.summary.title}  `}
        </text>
        <text fg={props.theme.faint} selectable style={{ flexShrink: 1 }}>
          {truncate(props.summary.preview, summaryRoom(props))}
        </text>
        <box style={{ flexGrow: 1, minWidth: 1 }} />
        <text fg={state().color}>{state().label}</text>
      </box>

      <Show when={props.expanded}>
        <Show when={!props.loading} fallback={<text fg={props.theme.faint}>{"   loading detail…"}</text>}>
          <Show when={detail()} fallback={<text fg={props.theme.warn}>{"   detail unavailable"}</text>}>
            {(loaded: () => ActivityDetail) => (
              <Show
                when={loaded().kind === "command" ? loaded() as CommandActivityDetail : null}
                fallback={
                  <FileChangeBody
                    activityId={props.summary.id}
                    detail={loaded() as Extract<ActivityDetail, { readonly kind: "file_change" }>}
                    file={selectedFile()}
                    selectedFile={props.selectedFile}
                    paneRows={props.paneRows}
                    width={props.width}
                    theme={props.theme}
                    onSelectFile={props.onSelectFile}
                    onPaneRef={props.onPaneRef}
                    onMouseScroll={stopNestedWheel}
                  />
                }
              >
                {(command: () => CommandActivityDetail) => (
                  <CommandBody
                    activityId={props.summary.id}
                    detail={command()}
                    state={props.summary.state}
                    paneRows={props.paneRows}
                    theme={props.theme}
                    onPaneRef={props.onPaneRef}
                    onMouseScroll={stopNestedWheel}
                  />
                )}
              </Show>
            )}
          </Show>
        </Show>
      </Show>
    </box>
  );
}

function CommandBody(props: {
  readonly activityId: string;
  readonly detail: CommandActivityDetail;
  readonly state: ActivitySummary["state"];
  readonly paneRows: number;
  readonly theme: Theme;
  readonly onPaneRef: (renderable: ScrollBoxRenderable) => void;
  readonly onMouseScroll: (event: MouseEvent) => void;
}) {
  const output = () => commandPane(props.detail, props.state);
  return (
    <box style={{ flexDirection: "column", width: "100%", flexShrink: 0 }}>
      <scrollbox
        id={`activity-${props.activityId}-pane`}
        ref={props.onPaneRef}
        focused={false}
        style={{
          height: props.paneRows,
          width: "100%",
          flexShrink: 0,
          backgroundColor: props.theme.surface,
          paddingLeft: 3,
          paddingRight: 1,
        }}
        scrollbarOptions={{
          showArrows: false,
          trackOptions: { backgroundColor: props.theme.ruleSoft, foregroundColor: props.theme.muted },
        }}
        horizontalScrollbarOptions={{ visible: false }}
        onMouseScroll={props.onMouseScroll}
      >
        <For each={output()}>
          {(line) => (
            <text
              fg={line.error ? props.theme.danger : line.muted ? props.theme.faint : props.theme.text}
              selectable
            >
              {line.text || " "}
            </text>
          )}
        </For>
      </scrollbox>
      <Show when={props.detail.retention.truncated}>
        <text fg={props.theme.warn}>{`   ${retentionLabel(props.detail.retention)}`}</text>
      </Show>
    </box>
  );
}

function FileChangeBody(props: {
  readonly activityId: string;
  readonly detail: Extract<ActivityDetail, { readonly kind: "file_change" }>;
  readonly file: ChangedFileDetail | null;
  readonly selectedFile: number;
  readonly paneRows: number;
  readonly width: number;
  readonly theme: Theme;
  readonly onSelectFile: (index: number) => void;
  readonly onPaneRef: (renderable: ScrollBoxRenderable) => void;
  readonly onMouseScroll: (event: MouseEvent) => void;
}) {
  const lines = () => diffLines(props.file?.diff ?? "");
  const fileCount = () => props.detail.files.length;
  const selectedIndex = () => Math.min(props.selectedFile, Math.max(0, fileCount() - 1));
  const select = (direction: -1 | 1): void => {
    const count = fileCount();
    if (count > 1) props.onSelectFile((selectedIndex() + count + direction) % count);
  };
  return (
    <box style={{ flexDirection: "column", width: "100%", flexShrink: 0 }}>
      <box style={{ flexDirection: "row", height: 1, width: "100%" }}>
        <text fg={props.theme.faint}>{"   "}</text>
        <text fg={props.theme.muted} onMouseDown={(event: MouseEvent) => {
          event.stopPropagation();
          select(-1);
        }}>{fileCount() > 1 ? "‹ " : ""}</text>
        <text fg={props.theme.text} selectable style={{ flexShrink: 1 }}>
          {truncate(props.file?.path ?? "no file detail", Math.max(8, props.width - 32))}
        </text>
        <text fg={props.theme.muted} onMouseDown={(event: MouseEvent) => {
          event.stopPropagation();
          select(1);
        }}>{fileCount() > 1 ? " ›" : ""}</text>
        <text fg={props.theme.faint}>
          {`  ${selectedIndex() + 1}/${Math.max(1, fileCount())}  `}
        </text>
        <text fg={props.theme.ok}>{`+${props.file?.additions ?? 0}`}</text>
        <text fg={props.theme.danger}>{` -${props.file?.deletions ?? 0}`}</text>
      </box>
      <scrollbox
        id={`activity-${props.activityId}-pane`}
        ref={props.onPaneRef}
        focused={false}
        style={{
          height: props.paneRows,
          width: "100%",
          flexShrink: 0,
          backgroundColor: props.theme.surface,
          paddingLeft: 3,
          paddingRight: 1,
        }}
        scrollbarOptions={{
          showArrows: false,
          trackOptions: { backgroundColor: props.theme.ruleSoft, foregroundColor: props.theme.muted },
        }}
        horizontalScrollbarOptions={{ visible: false }}
        onMouseScroll={props.onMouseScroll}
      >
        <For each={lines()}>
          {(line) => (
            <box style={{ flexDirection: "row", height: 1, width: "100%", flexShrink: 0 }}>
              <text fg={props.theme.faint} selectable>{`${line.oldLine.padStart(5)} ${line.newLine.padStart(5)} `}</text>
              <text fg={diffColor(line.kind, props.theme)} selectable>{truncate(line.text, Math.max(8, props.width - 15))}</text>
            </box>
          )}
        </For>
      </scrollbox>
      <Show when={props.file?.retention.truncated}>
        <text fg={props.theme.warn}>{`   ${retentionLabel(props.file!.retention)}`}</text>
      </Show>
    </box>
  );
}

interface OutputLine {
  readonly text: string;
  readonly error: boolean;
  readonly muted?: boolean;
}

function commandPane(
  detail: CommandActivityDetail,
  state: ActivitySummary["state"],
): OutputLine[] {
  const command = detail.command === "" ? ["(command unavailable)"] : detail.command.split("\n");
  const lines: OutputLine[] = command.map((text, index) => ({
    text: `${index === 0 ? "$ " : "  "}${text}`,
    error: false,
  }));
  lines.push({ text: commandMeta(detail, state), error: false, muted: true });
  lines.push({ text: "", error: false });
  if (detail.stdout) {
    if (detail.outputMode === "split" && detail.stderr) {
      lines.push({ text: "stdout", error: false, muted: true });
    }
    lines.push(...detail.stdout.split("\n").map((text) => ({ text, error: false })));
  }
  if (detail.stderr) {
    if (detail.outputMode === "split") lines.push({ text: "stderr", error: true, muted: true });
    lines.push(...detail.stderr.split("\n").map((text) => ({ text, error: true })));
  }
  if (!detail.stdout && !detail.stderr) lines.push({ text: "(no output)", error: false, muted: true });
  return lines;
}

function commandMeta(detail: CommandActivityDetail, state: ActivitySummary["state"]): string {
  const values = [detail.cwd ? `cwd ${detail.cwd}` : null, state];
  if (detail.exitCode !== null) values.push(`exit ${detail.exitCode}`);
  if (detail.durationMs !== null) values.push(duration(detail.durationMs));
  if (detail.interrupted) values.push("interrupted");
  return values.filter((value): value is string => value !== null).join(`  ${GLYPHS.bullet}  `);
}

function duration(milliseconds: number): string {
  return milliseconds < 1_000 ? `${Math.round(milliseconds)}ms` : `${(milliseconds / 1_000).toFixed(1)}s`;
}

interface DiffLine {
  readonly oldLine: string;
  readonly newLine: string;
  readonly kind: "add" | "delete" | "context" | "meta";
  readonly text: string;
}

export function diffLines(diff: string): DiffLine[] {
  if (diff === "") return [{ oldLine: "", newLine: "", kind: "meta", text: "(diff unavailable)" }];
  const result: DiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;
  for (const text of diff.split("\n")) {
    const hunk = /^@@ -(?<old>\d+)(?:,\d+)? \+(?<next>\d+)(?:,\d+)? @@/u.exec(text);
    if (hunk?.groups) {
      oldLine = Number(hunk.groups.old);
      newLine = Number(hunk.groups.next);
      result.push({ oldLine: "", newLine: "", kind: "meta", text });
    } else if (text.startsWith("+") && !text.startsWith("+++")) {
      result.push({ oldLine: "", newLine: String(newLine), kind: "add", text });
      newLine += 1;
    } else if (text.startsWith("-") && !text.startsWith("---")) {
      result.push({ oldLine: String(oldLine), newLine: "", kind: "delete", text });
      oldLine += 1;
    } else if (text.startsWith(" ")) {
      result.push({ oldLine: String(oldLine), newLine: String(newLine), kind: "context", text });
      oldLine += 1;
      newLine += 1;
    } else {
      result.push({ oldLine: "", newLine: "", kind: "meta", text });
    }
  }
  return result;
}

function activityState(summary: ActivitySummary, theme: Theme): {
  readonly glyph: string;
  readonly label: string;
  readonly color: string;
} {
  if (summary.state === "running") return { glyph: GLYPHS.workRunning, label: "running", color: theme.warn };
  if (summary.state === "failed") return { glyph: GLYPHS.workFailed, label: "failed", color: theme.danger };
  if (summary.state === "interrupted") return { glyph: GLYPHS.workFailed, label: "interrupted", color: theme.warn };
  return { glyph: GLYPHS.workDone, label: "done", color: theme.ok };
}

function diffColor(kind: DiffLine["kind"], theme: Theme): string {
  if (kind === "add") return theme.ok;
  if (kind === "delete") return theme.danger;
  return kind === "meta" ? theme.muted : theme.text;
}

function retentionLabel(retention: CommandActivityDetail["retention"]): string {
  return `${retention.omittedBytes} bytes / ${retention.omittedLines} lines omitted`;
}

function summaryRoom(props: ActivityCardProps): number {
  const fixed = 16 + cellWidth(props.summary.agent) + cellWidth(props.summary.title);
  return Math.max(8, props.width - fixed);
}
