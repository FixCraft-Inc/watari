import type { KeyEvent, ScrollBoxRenderable } from "@opentui/core";
import { createSignal } from "solid-js";

import type { ActivityDetail, ActivitySummary } from "../activity/types.ts";

export interface ActivityControllerOptions {
  readonly getDetail: (activityId: string) => Promise<ActivityDetail | null>;
  readonly activities: () => readonly ActivitySummary[];
  readonly visibleActivities: () => readonly ActivitySummary[];
  readonly onError: (message: string) => void;
  readonly onReturnToComposer: () => void;
  readonly onScrollIntoView: (activityId: string) => void;
}

/** Client-local activity presentation state shared by the TUI card instances. */
export function createActivityController(options: ActivityControllerOptions) {
  const [expandedIds, setExpandedIds] = createSignal<ReadonlySet<string>>(new Set());
  const [rawFocusedId, setFocusedId] = createSignal<string | null>(null);
  const [details, setDetails] = createSignal<ReadonlyMap<string, ActivityDetail>>(new Map());
  const [loadingIds, setLoadingIds] = createSignal<ReadonlySet<string>>(new Set());
  const [selectedFiles, setSelectedFiles] = createSignal<ReadonlyMap<string, number>>(new Map());
  const panes = new Map<string, ScrollBoxRenderable>();
  const pendingReloads = new Set<string>();

  const focusedId = (): string | null => {
    const id = rawFocusedId();
    return id && options.visibleActivities().some((activity) => activity.id === id) ? id : null;
  };

  const loadDetail = async (activity: ActivitySummary, force = false): Promise<void> => {
    if (loadingIds().has(activity.id)) {
      if (force) pendingReloads.add(activity.id);
      return;
    }
    if (!force && details().has(activity.id)) return;
    setLoadingIds((current) => new Set([...current, activity.id]));
    try {
      const detail = await options.getDetail(activity.id);
      if (detail) setDetails((current) => new Map(current).set(activity.id, detail));
    } catch (error) {
      options.onError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoadingIds((current) => {
        const next = new Set(current);
        next.delete(activity.id);
        return next;
      });
      if (pendingReloads.delete(activity.id)) {
        const latest = options.activities().find((entry) => entry.id === activity.id);
        if (latest) void loadDetail(latest, true);
      }
    }
  };

  const toggle = (activity: ActivitySummary): void => {
    setFocusedId(activity.id);
    const opening = !expandedIds().has(activity.id);
    setExpandedIds((current) => {
      const next = new Set(current);
      if (opening) next.add(activity.id);
      else next.delete(activity.id);
      return next;
    });
    if (opening) void loadDetail(activity);
  };

  const traverse = (direction: -1 | 1): void => {
    const activities = options.visibleActivities();
    if (activities.length === 0) return;
    const current = activities.findIndex((activity) => activity.id === focusedId());
    const index = current < 0
      ? (direction > 0 ? 0 : activities.length - 1)
      : (current + activities.length + direction) % activities.length;
    const activity = activities[index];
    if (!activity) return;
    setFocusedId(activity.id);
    queueMicrotask(() => options.onScrollIntoView(activity.id));
  };

  const handleKey = (key: KeyEvent): boolean => {
    const id = focusedId();
    const summary = id
      ? options.visibleActivities().find((activity) => activity.id === id) ?? null
      : null;
    if (!summary) return false;
    const activityId = summary.id;
    if (key.name === "escape") {
      consume(key);
      setFocusedId(null);
      options.onReturnToComposer();
      return true;
    }
    if (key.name === "return" || key.name === "enter" || key.name === "space") {
      consume(key);
      toggle(summary);
      return true;
    }
    if ((key.name === "up" || key.name === "down") && expandedIds().has(activityId)) {
      consume(key);
      const pane = panes.get(activityId);
      if (pane) pane.scrollTop = Math.max(0, pane.scrollTop + (key.name === "up" ? -1 : 1));
      return true;
    }
    if ((key.name === "left" || key.name === "right") && expandedIds().has(activityId)) {
      const detail = details().get(activityId);
      if (detail?.kind === "file_change" && detail.files.length > 1) {
        consume(key);
        const current = selectedFiles().get(activityId) ?? 0;
        const direction = key.name === "left" ? -1 : 1;
        selectFile(activityId, (current + detail.files.length + direction) % detail.files.length);
        panes.get(activityId)?.scrollTo(0);
        return true;
      }
    }
    return false;
  };

  const detailChanged = (activityId: string): void => {
    if (!expandedIds().has(activityId)) return;
    const summary = options.activities().find((activity) => activity.id === activityId);
    if (summary) void loadDetail(summary, true);
  };

  const selectFile = (activityId: string, index: number): void => {
    setSelectedFiles((current) => new Map(current).set(activityId, Math.max(0, index)));
  };

  return {
    clearFocus: () => setFocusedId(null),
    detail: (activityId: string) => details().get(activityId) ?? null,
    detailChanged,
    expanded: (activityId: string) => expandedIds().has(activityId),
    focusedId,
    handleKey,
    loading: (activityId: string) => loadingIds().has(activityId),
    selectFile,
    selectedFile: (activityId: string) => selectedFiles().get(activityId) ?? 0,
    setPane: (activityId: string, pane: ScrollBoxRenderable) => panes.set(activityId, pane),
    toggle,
    traverse,
  };
}

function consume(key: KeyEvent): void {
  key.preventDefault();
  key.stopPropagation();
}
