import type { InputRenderable, MouseEvent, ScrollBoxRenderable } from "@opentui/core";
import { render, useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid";
import { join } from "node:path";

import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";

import type { AgentId, AgentModelOption, ProjectContext } from "../models.ts";
import type { ActivitySummary } from "../activity/types.ts";
import type { ProviderStatusDocument } from "../provider-status-api.ts";
import type { RuntimeClient } from "../service/client.ts";
import type { ChatListEntry } from "../state/chat-library.ts";
import type { PersistedEvent, TeamAgent, TeamSnapshot } from "../state/types.ts";
import { findingsReport } from "../team/review.ts";
import { COMPOSER_MAX_CHARS, PasteStore, decodePaste } from "./paste.ts";
import { ComposerHistory } from "./history.ts";
import { QuestionOverlay } from "./questions.tsx";
import {
  SUPPORTED_PROVIDERS,
  defaultDisplayName,
  isProviderId,
  isSupportedProvider,
  type SupportedProviderId,
} from "../team/roster.ts";
import { copyToClipboard, describeCopy } from "./clipboard.ts";
import { ActivityCard } from "./activity-card.tsx";
import { createActivityController } from "./activity-controller.ts";
import {
  commandSuggestions,
  completeCommand,
  parseCommand,
  targetForTab,
  usageFor,
} from "./commands.ts";
import { DETACH_ARM_MS, isCancelChord, isCopyChord, resolveCtrlC } from "./keys.ts";
import {
  AliasOverlay,
  CatalogVendorOverlay,
  EffortOverlay,
  ModelCatalogOverlay,
  ProviderOverlay,
  aliasProblem,
  catalogVendors,
  effortChoices,
  filterModels,
  isVendorCatalog,
  modelChoices,
  nextAgentAlias,
  type CatalogVendor,
  type EffortChoice,
  type ProviderChoice,
} from "./model-setup.tsx";
import {
  ApprovalStrip,
  AgentOverlay,
  ChatsOverlay,
  CommandPalette,
  GoalStrip,
  Header,
  HelpOverlay,
  ProviderStatusOverlay,
  Row,
  Rule,
  SidePanel,
  TabStrip,
  type TabDescriptor,
} from "./components.tsx";
import { cellWidth, displayPath, joinMeta, truncate } from "./format.ts";
import type { RowSpan } from "./transcript.ts";
import {
  buildEntries,
  entryToMarkdown,
  lastCodeBlock,
  lastSpokenEntry,
  plainSelection,
  layoutTranscript,
  pendingApprovals,
  transcriptToMarkdown,
  transcriptView,
  welcomeRows,
} from "./transcript.ts";
import {
  GLYPHS,
  hasTrueColor,
  readThemePreference,
  selectTheme,
  stateStyle,
  type Theme,
} from "./theme.ts";

/**
 * The side panel takes a share of the terminal rather than a fixed 30 columns:
 * at 30 it was truncating a peer's own status line on every row, and at 160 it
 * was leaving the transcript wider than anybody reads comfortably.
 */
const SIDE_PANEL_MIN = 30;
const SIDE_PANEL_MAX = 40;
const SIDE_PANEL_MIN_TERMINAL = 96;
/** Below this the goal keeps its text but loses its second, quieter line. */
const COMPACT_HEIGHT = 22;
/** Below this even the status line goes, leaving chat, composer, and nothing. */
const TINY_HEIGHT = 15;
const SPINNER_MS = 140;
const CLOCK_MS = 5_000;

interface AppOptions {
  readonly client: Pick<
    RuntimeClient,
    | "snapshot"
    | "subscribe"
    | "send"
    | "interrupt"
    | "approve"
    | "completeGoal"
    | "newChat"
    | "shutdown"
    | "checkBridges"
    | "configureAgent"
    | "removeAgent"
    | "restartAgent"
    | "availableModels"
    | "availableProviderModels"
    | "getActivityDetail"
    | "clearAgent"
    | "listChats"
    | "resumeChat"
    | "saveChat"
    | "exportChat"
  > & {
    /** Older embedded clients may omit the optional provider status seam. */
    readonly providerStatus?: (force?: boolean) => Promise<ProviderStatusDocument>;
    readonly answerQuestion?: RuntimeClient["answerQuestion"];
  };
  readonly project: ProjectContext;
  readonly stateDirectory: string;
  /** Captures a terminal service failure after the alternate screen closes. */
  readonly onFatal?: (message: string) => void;
  /** Shown in the status line on open instead of the default hint. */
  readonly initialNotice?: string;
}

type NoticeTone = "info" | "good" | "warn" | "bad";

/** The most often service updates are applied to the screen. */
const SNAPSHOT_APPLY_MS = 50;

/**
 * Where the guided setup is.
 *
 * `vendor` exists only for a harness whose catalog is other people's models:
 * OpenCode answers with hundreds of `vendor/model` ids, so the vendors are
 * separated first and the model step gains a search. Codex and Claude serve
 * their own handful and skip the step entirely.
 */
type ModelSetupState =
  | { readonly step: "provider" }
  | {
      readonly step: "vendor";
      readonly provider: SupportedProviderId;
      readonly agent: TeamAgent | null;
      readonly options: readonly AgentModelOption[];
      readonly vendors: readonly CatalogVendor[];
    }
  | {
      readonly step: "model";
      readonly provider: SupportedProviderId;
      readonly agent: TeamAgent | null;
      readonly options: readonly AgentModelOption[];
      readonly vendors: readonly CatalogVendor[];
      /** Null means the whole catalog, which is what search is for. */
      readonly vendor: string | null;
    }
  | {
      readonly step: "effort";
      readonly provider: SupportedProviderId;
      readonly agent: TeamAgent | null;
      readonly options: readonly AgentModelOption[];
      readonly vendors: readonly CatalogVendor[];
      readonly vendor: string | null;
      readonly model: AgentModelOption;
      readonly efforts: readonly EffortChoice[];
    }
  | {
      readonly step: "alias";
      readonly provider: SupportedProviderId;
      readonly options: readonly AgentModelOption[];
      readonly vendors: readonly CatalogVendor[];
      readonly vendor: string | null;
      readonly model: AgentModelOption;
      readonly efforts: readonly EffortChoice[];
      readonly effort: EffortChoice;
    };

/**
 * Every harness Watari can launch itself, described in one line each.
 *
 * Built from `SUPPORTED_PROVIDERS` rather than listed by hand, so a provider
 * that reaches the runtime cannot quietly stay missing from the picker.
 */
const PROVIDER_NOTES: Record<SupportedProviderId, { readonly title: string; readonly description: string }> = {
  codex: {
    title: "Codex",
    description: "OpenAI Codex app-server · managed, contained, native model catalog.",
  },
  claude: {
    title: "Claude",
    description: "Claude Agent SDK with external Claude Code · managed, contained, native model catalog.",
  },
  opencode: {
    title: "OpenCode",
    description: "OpenCode over ACP · managed, contained. A harness over many providers' models; input queues until each turn ends.",
  },
  qwen: {
    title: "Qwen Code",
    description: "Qwen Code over ACP · managed, contained, models from its own settings; input queues until each turn ends.",
  },
};

const PROVIDER_CHOICES: readonly ProviderChoice[] = SUPPORTED_PROVIDERS.map((id) => ({
  id,
  ...PROVIDER_NOTES[id],
}));

/** OSC 112: give the cursor its colour back, whatever the terminal's own is. */
export const CURSOR_COLOR_RESET = "\u001b]112\u0007";

/**
 * Puts the terminal's cursor colour back.
 *
 * The renderer paints the cursor with an OSC escape, and an escape is a setting
 * on the terminal, not on the process: without the matching reset the shell the
 * user returns to keeps Watari's cursor colour for the rest of its life.
 */
export function restoreCursorColor(
  stream: { readonly isTTY?: boolean; write(chunk: string): unknown } = process.stdout,
): void {
  if (!stream.isTTY) return;
  try {
    stream.write(CURSOR_COLOR_RESET);
  } catch {
    // A closed or redirected stdout is not a reason to fail on the way out.
  }
}

export async function runTui(options: AppOptions): Promise<void> {
  // Registered for the whole run, so an exit Watari did not choose — a signal,
  // a crash — still hands the terminal back the way it was found.
  const reset = (): void => restoreCursorColor();
  process.once("exit", reset);
  let fatalMessage: string | null = null;
  try {
    await renderTui({
      ...options,
      onFatal: (message) => {
        fatalMessage ??= message;
      },
    });
  } finally {
    process.off("exit", reset);
    restoreCursorColor();
  }
  if (fatalMessage !== null) {
    throw new Error(fatalMessage);
  }
}

async function renderTui(options: AppOptions): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    render(() => <WatariApp {...options} />, {
      targetFps: 30,
      // Ctrl+C is a Watari binding with its own progression, so the renderer
      // must not tear the process down before the app has seen it.
      exitOnCtrlC: false,
      screenMode: "alternate-screen",
      // Mouse tracking is what makes drag-to-select work inside the app. It
      // takes the terminal's own selection away, which is why Watari owns copy
      // end to end; holding shift while dragging still reaches the terminal.
      useMouse: true,
      // Without this the terminal cannot tell Ctrl+Shift+C from Ctrl+C, and
      // copy and cancel would collapse onto one chord.
      useKittyKeyboard: { disambiguate: true, alternateKeys: true },
      onDestroy: resolve,
    }).catch(reject);
  });
}

export function WatariApp(options: AppOptions) {
  const renderer = useRenderer();
  const dimensions = useTerminalDimensions();
  const initial = options.client.snapshot;
  if (!initial) {
    throw new Error("Watari service did not provide an initial snapshot");
  }

  const [snapshot, setSnapshot] = createSignal<TeamSnapshot>(initial);
  // Open on one conversation, not broadcast. Global remains an explicit team
  // room via ctrl+t or /all, preventing the easiest accidental multi-turn.
  const initiallyVisible = initial.agents.filter((agent) => agent.mode !== "external" || agent.state !== "stopped");
  const [activeTab, setActiveTab] = createSignal(initiallyVisible.length > 0 ? 1 : 0);
  const [composer, setComposer] = createSignal("");
  /** Multi-line and long pastes, shown in the one-line composer as markers. */
  const pastes = new PasteStore();
  const [commandIndex, setCommandIndex] = createSignal(0);
  const [notice, setNotice] = createSignal<{ text: string; tone: NoticeTone }>(
    options.initialNotice
      ? { text: options.initialNotice, tone: "info" }
      : {
          text: initiallyVisible[0]
            ? `message ${initiallyVisible[0].id}; ctrl+t opens the team room`
            : "configure or connect an agent to begin",
          tone: "info",
        },
  );
  const [sending, setSending] = createSignal(false);
  const [helpOpen, setHelpOpen] = createSignal(false);
  const [questionsOpen, setQuestionsOpen] = createSignal(false);
  const waitingQuestions = () => snapshot().questions ?? [];
  /** Archived chats, for /chats and /resume completion. Refreshed when they change. */
  const [chats, setChats] = createSignal<readonly ChatListEntry[]>([]);
  /** The chat picker's selected row, or null when the picker is closed. */
  const [chatPicker, setChatPicker] = createSignal<number | null>(null);
  const history = new ComposerHistory(join(options.stateDirectory, "composer-history.json"));
  const refreshChats = async (): Promise<readonly ChatListEntry[]> => {
    try {
      const list = await options.client.listChats();
      setChats(list);
      return list;
    } catch {
      return chats();
    }
  };
  void refreshChats();
  const [agentsOpen, setAgentsOpen] = createSignal(false);
  const [providersOpen, setProvidersOpen] = createSignal(false);
  const [providerStatus, setProviderStatus] = createSignal<ProviderStatusDocument | null>(null);
  const [providerStatusBusy, setProviderStatusBusy] = createSignal(false);
  const [modelSetup, setModelSetup] = createSignal<ModelSetupState | null>(null);
  const [setupIndex, setSetupIndex] = createSignal(0);
  const [aliasDraft, setAliasDraft] = createSignal("");
  /** Live search over a vendor catalog too long to page through. */
  const [modelQuery, setModelQuery] = createSignal("");
  const [setupBusy, setSetupBusy] = createSignal(false);
  const [panelOpen, setPanelOpen] = createSignal(true);
  const [spinnerFrame, setSpinnerFrame] = createSignal(0);
  const [now, setNow] = createSignal(Date.now());
  const [themeMode, setThemeMode] = createSignal<"dark" | "light">(initialThemeMode(renderer.themeMode));
  /** Ctrl+C armed detach and is waiting for the confirming second press. */
  const [armed, setArmed] = createSignal(false);
  let armTimer: ReturnType<typeof setTimeout> | undefined;
  const arm = (): void => {
    setArmed(true);
    if (armTimer) clearTimeout(armTimer);
    armTimer = setTimeout(() => setArmed(false), DETACH_ARM_MS);
    armTimer.unref?.();
  };
  onCleanup(() => {
    if (armTimer) clearTimeout(armTimer);
  });

  let transcriptRef: ScrollBoxRenderable | undefined;
  let composerRef: InputRenderable | undefined;

  const spinnerTimer = setInterval(() => setSpinnerFrame((frame) => (frame + 1) % GLYPHS.spinner.length), SPINNER_MS);
  const clockTimer = setInterval(() => setNow(Date.now()), CLOCK_MS);
  onCleanup(() => {
    clearInterval(spinnerTimer);
    clearInterval(clockTimer);
  });

  const onThemeMode = (mode: "dark" | "light"): void => {
    if (readThemePreference(process.env) === "auto") setThemeMode(mode);
  };
  renderer.on("theme_mode", onThemeMode);
  onCleanup(() => renderer.off("theme_mode", onThemeMode));

  const applySnapshot = (next: TeamSnapshot): void => {
    setSnapshot(next);
    const visible = next.agents.filter((agent) => agent.mode !== "external" || agent.state !== "stopped");
    setActiveTab((tab) => Math.min(tab, visible.length));
  };
  // Every transcript line and activity update used to re-apply the whole
  // snapshot and redraw the screen. A busy team sends dozens a second, which
  // left the UI too far behind the service and got it disconnected. Updates
  // now land at most once per frame interval, newest state wins.
  let pendingSnapshot: TeamSnapshot | null = null;
  let applyTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleSnapshot = (next: TeamSnapshot): void => {
    pendingSnapshot = next;
    if (applyTimer) return;
    applyTimer = setTimeout(() => {
      applyTimer = null;
      const latest = pendingSnapshot;
      pendingSnapshot = null;
      if (latest) applySnapshot(latest);
    }, SNAPSHOT_APPLY_MS);
  };
  const unsubscribe = options.client.subscribe((event) => {
    if (event.type === "snapshot") {
      applySnapshot(event.snapshot);
      return;
    }
    if (event.type === "state_changed") {
      scheduleSnapshot(event.snapshot);
      return;
    }
    if (
      event.type === "transcript_upsert" ||
      event.type === "activity_upsert" ||
      event.type === "activity_detail_changed"
    ) {
      const current = options.client.snapshot;
      if (current) scheduleSnapshot(current);
      if (event.type === "activity_detail_changed") activityUi.detailChanged(event.activityId);
      return;
    }
    if (event.type === "fatal") {
      options.onFatal?.(event.message);
      renderer.destroy();
    }
  });
  onCleanup(() => {
    unsubscribe();
    if (applyTimer) clearTimeout(applyTimer);
  });

  const theme = createMemo<Theme>(() => selectTheme(themeMode(), hasTrueColor(process.env)));
  /** Names and identity colours for everyone who can speak, from the live
   * roster: colour follows the provider, never the alias. */
  const view = createMemo(() => transcriptView(theme(), snapshot().agents));
  const accent = (who: string | null | undefined): string => view().accent(who);
  const compact = () => dimensions().height < COMPACT_HEIGHT;
  /**
   * The status line is the only place a copy result, a usage hint, or a failed
   * send is ever shown, so it survives compact and goes only when the terminal
   * is too short for a conversation at all.
   */
  const showStatus = () => dimensions().height >= TINY_HEIGHT;
  const showPanel = () => panelOpen() && dimensions().width >= SIDE_PANEL_MIN_TERMINAL;
  const panelWidth = () =>
    Math.max(SIDE_PANEL_MIN, Math.min(SIDE_PANEL_MAX, Math.round(dimensions().width * 0.28)));
  /** Terminal width minus the side panel, its divider, and the transcript's own
   * horizontal padding. Rows are laid out to exactly this, so nothing overflows
   * and gets silently shrunk by the flex pass. */
  const transcriptWidth = () =>
    Math.max(24, dimensions().width - (showPanel() ? panelWidth() + 1 : 0) - 4);

  /** Rows the transcript and side panel actually get, once the fixed chrome
   * above and below them has taken its own. */
  /**
   * The composer is an outlined input while there is room for its two border
   * rows. A compact terminal keeps the single ruled row, since there every row
   * is one less line of the conversation.
   */
  const boxedComposer = () => !compact();
  const composerRows = () => (boxedComposer() ? 3 : 2);
  const paneHeight = () => {
    const chrome = 1 + 2 + (compact() ? 1 : 2) + (approval() ? 2 : 0) + (waitingQuestions().length ? 1 : 0) + composerRows() + (showStatus() ? 1 : 0);
    return Math.max(3, dimensions().height - chrome);
  };

  const tabAgents = createMemo(() => snapshot().agents.filter(
    (agent) => agent.mode !== "external" || agent.state !== "stopped",
  ));
  const agentIds = createMemo(() => tabAgents().map((agent) => agent.id));
  const filter = (): AgentId | null => activeTab() === 0 ? null : agentIds()[activeTab() - 1] ?? null;
  const spinner = () => GLYPHS.spinner[spinnerFrame()] ?? GLYPHS.spinner[0]!;

  const rows = createMemo(() => {
    const current = snapshot();
    const entries = buildEntries(current, filter());
    if (entries.length === 0 && !current.activeGoal) {
      return welcomeRows(view(), transcriptWidth());
    }
    return layoutTranscript(entries, view(), transcriptWidth());
  });

  const visibleActivities = createMemo(() => rows()
    .flatMap((row) => row.activity ? [row.activity] : []));
  const activityPaneRows = () => compact()
    ? Math.max(4, Math.min(9, paneHeight() - 5))
    : Math.max(10, Math.min(16, paneHeight() - 8));
  const activityUi = createActivityController({
    getDetail: (activityId) => options.client.getActivityDetail(activityId),
    activities: () => snapshot().activities,
    visibleActivities,
    onError: (text) => setNotice({ text, tone: "bad" }),
    onReturnToComposer: () => {
      composerRef?.focus();
      queueMicrotask(() => composerRef?.focus());
    },
    onScrollIntoView: (activityId) => transcriptRef?.scrollChildIntoView(`activity-${activityId}`),
  });

  const openApprovals = createMemo(() => {
    const wanted = filter();
    return pendingApprovals(snapshot()).filter((event) => !wanted || event.agent === wanted);
  });
  const approval = createMemo(() => openApprovals().at(-1) ?? null);

  const tabs = createMemo<TabDescriptor[]>(() =>
    [null, ...tabAgents()].map((entry, index) => {
      if (index === 0) {
        return { label: "global", agent: null, accent: theme().brand, marker: "", markerColor: theme().faint };
      }
      const agent = entry!;
      const style = stateStyle(agent.state);
      return {
        label: agent.id,
        agent: agent.id,
        accent: accent(agent.id),
        marker: style.animated ? spinner() : style.glyph,
        markerColor: style.color(theme(), accent(agent.id)),
      };
    }),
  );

  const counters = createMemo<RowSpan[]>(() => {
    const current = snapshot();
    const open = current.claims.filter((claim) => claim.state !== "released");
    const contested = open.filter((claim) => claim.state === "contested").length;
    const findings = current.findings.filter((finding) => finding.disposition === "open").length;
    const spans: RowSpan[] = [
      { text: `${open.length} claims`, color: open.length > 0 ? theme().muted : theme().faint },
    ];
    if (contested > 0) {
      spans.push({ text: `  ${contested} contested`, color: theme().danger });
    }
    spans.push({
      text: `  ${findings} findings`,
      color: findings > 0 ? theme().warn : theme().faint,
    });
    const todos = (current.todos ?? []).filter((todo) =>
      todo.state === "todo" || todo.state === "doing" || todo.state === "blocked"
    ).length;
    if (todos > 0) {
      spans.push({ text: `  ${todos} todo`, color: theme().muted });
    }
    return spans;
  });

  const destination = createMemo(() => targetForTab(activeTab(), agentIds()));
  const suggestions = createMemo(() =>
    commandSuggestions(
      composer(),
      snapshot().agents.map((agent) => ({
        id: agent.id,
        description: [
          agent.displayName,
          agent.model ?? "provider default",
          agent.provider ?? agent.backend,
        ].join(" · "),
      })),
      chats(),
    )
  );

  const scrollBy = (direction: 1 | -1): void => {
    const box = transcriptRef;
    if (!box) return;
    box.scrollTop = Math.max(0, box.scrollTop + direction * Math.max(3, dimensions().height - 10));
  };

  /** The renderer's own selection, as plain text, or "" when nothing is held. */
  const selectionText = (): string => {
    try {
      return renderer.getSelection()?.getSelectedText() ?? "";
    } catch {
      return "";
    }
  };

  const copy = async (text: string, what: string): Promise<void> => {
    const outcome = await copyToClipboard(text);
    setNotice({ text: describeCopy(outcome, what), tone: outcome.copied ? "good" : "warn" });
  };

  /**
   * Copies the selection when there is one, and otherwise the newest reply.
   *
   * Reaching for copy with nothing selected almost always means "that answer",
   * and making the common case need a drag first is the kind of friction that
   * sends people back to scrolling their terminal buffer.
   */
  const copyCurrent = async (): Promise<void> => {
    const selected = plainSelection(selectionText());
    if (selected.trim() !== "") {
      renderer.clearSelection();
      await copy(selected, "selection");
      return;
    }
    const entry = lastSpokenEntry(buildEntries(snapshot(), filter()));
    if (!entry) {
      setNotice({ text: "nothing to copy yet", tone: "warn" });
      return;
    }
    await copy(entryToMarkdown(entry, view()), "the last reply");
  };

  // Mouse tracking prevents the terminal emulator from opening its normal
  // context menu. Keep the common terminal gesture useful by copying the
  // current selection (or the latest reply when no selection exists).
  const onMouseDown = (event: MouseEvent): void => {
    if (event.button !== 2) return;
    event.preventDefault();
    event.stopPropagation();
    void copyCurrent();
  };

  const openProviderSetup = (): void => {
    setModelSetup({ step: "provider" });
    setSetupIndex(0);
    setHelpOpen(false);
    setAgentsOpen(false);
    setProvidersOpen(false);
    setNotice({ text: "choose a provider; discovery makes no model turn", tone: "info" });
  };

  const loadModels = async (
    provider: SupportedProviderId,
    agent: TeamAgent | null,
  ): Promise<void> => {
    if (setupBusy()) return;
    setSetupBusy(true);
    setNotice({
      text: `reading ${provider}'s native model catalog (no prompt, no model turn)`,
      tone: "info",
    });
    try {
      const native = agent
        ? await options.client.availableModels(agent.id)
        : await options.client.availableProviderModels(provider);
      const models = modelChoices(native);
      const vendors = isVendorCatalog(native) ? catalogVendors(native) : [];
      setModelQuery("");
      setHelpOpen(false);
      setAgentsOpen(false);
      if (vendors.length > 1) {
        // A directory of other providers' models: separate the vendors first.
        const current = agent?.model ? agent.model.split("/")[0] ?? null : null;
        const at = vendors.findIndex((vendor) => vendor.id === current);
        setSetupIndex(at >= 0 ? at + 1 : 0);
        setModelSetup({ step: "vendor", provider, agent, options: models, vendors });
        return;
      }
      const currentIndex = agent?.model
        ? models.findIndex((option) => option.id === agent.model)
        : 0;
      setSetupIndex(Math.max(0, currentIndex));
      setModelSetup({ step: "model", provider, agent, options: models, vendors, vendor: null });
    } finally {
      setSetupBusy(false);
    }
  };

  const openProviderStatus = async (force = false): Promise<void> => {
    setProvidersOpen(true);
    setProviderStatusBusy(true);
    try {
      if (!options.client.providerStatus) throw new Error("provider status is unavailable from this Watari service");
      setProviderStatus(await options.client.providerStatus(force));
      setNotice({ text: "provider status refreshed; no model turn was started", tone: "good" });
    } catch (error) {
      setNotice({ text: error instanceof Error ? error.message : String(error), tone: "bad" });
    } finally {
      setProviderStatusBusy(false);
    }
  };

  const openModels = async (agentId: AgentId): Promise<void> => {
    const agent = snapshot().agents.find((entry) => entry.id === agentId);
    if (!agent || !isProviderId(agent.provider) || !isSupportedProvider(agent.provider)) {
      throw new Error(`${agentId} does not have a managed native model catalog`);
    }
    await loadModels(agent.provider, agent);
  };

  const openEffort = async (agentId: AgentId): Promise<void> => {
    const agent = snapshot().agents.find((entry) => entry.id === agentId);
    if (!agent || !isProviderId(agent.provider) || !isSupportedProvider(agent.provider)) {
      throw new Error(`${agentId} does not have a managed native effort catalog`);
    }
    if (setupBusy()) return;
    setSetupBusy(true);
    try {
      const native = await options.client.availableModels(agent.id);
      const selected = agent.model
        ? native.find((model) => model.id === agent.model)
        : native.find((model) => model.isDefault);
      if (!selected) {
        throw new Error(
          agent.model
            ? `${agent.provider} no longer reports model ${agent.model}`
            : `${agent.provider} did not report effort levels for its default model; choose /model first`,
        );
      }
      const model = agent.model ? selected : { ...selected, id: "", displayName: "Provider default" };
      const efforts = effortChoices(model);
      setSetupIndex(Math.max(0, agent.effort ? efforts.findIndex((effort) => effort === agent.effort) : 0));
      setModelSetup({
        step: "effort",
        provider: agent.provider,
        agent,
        options: modelChoices(native),
        vendors: isVendorCatalog(native) ? catalogVendors(native) : [],
        vendor: agent.model?.includes("/") ? agent.model.split("/")[0] ?? null : null,
        model,
        efforts,
      });
      setHelpOpen(false);
      setAgentsOpen(false);
    } finally {
      setSetupBusy(false);
    }
  };

  const applyModelSetup = async (
    state: Extract<ModelSetupState, { readonly step: "effort" | "alias" }>,
    effort: EffortChoice,
    alias?: string,
  ): Promise<void> => {
    if (setupBusy()) return;
    const chosenAlias = alias?.trim() ?? (state.step === "effort" ? state.agent?.id : undefined);
    if (!chosenAlias) throw new Error("agent name is required");
    if (state.step === "alias") {
      const problem = aliasProblem(chosenAlias, snapshot().agents);
      if (problem) {
        setNotice({ text: problem, tone: "bad" });
        return;
      }
    }
    const existing = state.step === "effort" ? state.agent : null;
    setSetupBusy(true);
    try {
      await options.client.configureAgent({
        alias: chosenAlias,
        provider: state.provider,
        displayName: existing?.displayName ?? defaultDisplayName(chosenAlias),
        ...(state.model.id ? { model: state.model.id } : {}),
        ...(effort ? { effort } : {}),
        mode: existing?.mode ?? "managed",
      });
      setModelSetup(null);
      setNotice({
        text: `${chosenAlias} added · ${state.model.displayName} · ${effort ?? "default effort"}`,
        tone: "good",
      });
    } catch (error) {
      // The profile is written before the harness is launched, so an agent that
      // fails here exists and is on the roster. Saying only "error" sends the
      // reader looking for something that is already there.
      setModelSetup(null);
      setNotice({
        text: `${chosenAlias} was saved but did not start: ${error instanceof Error ? error.message : String(error)}`,
        tone: "bad",
      });
    } finally {
      setSetupBusy(false);
    }
  };

  /**
   * The models the model step is showing: the chosen vendor's, or the whole
   * catalog, narrowed by whatever has been typed into the search.
   */
  const visibleModels = (
    state: Extract<ModelSetupState, { readonly step: "model" }>,
  ): readonly AgentModelOption[] => {
    const scoped = state.vendor
      ? state.options.filter((option) => option.id.startsWith(`${state.vendor}/`))
      : state.options;
    return filterModels(scoped, modelQuery());
  };

  /** A vendor catalog is a directory, so its model step is searched, not paged. */
  const searchable = (state: ModelSetupState): boolean =>
    state.step === "model" && state.vendors.length > 1;

  const advanceModelSetup = async (): Promise<void> => {
    const state = modelSetup();
    if (!state || setupBusy()) return;
    if (state.step === "provider") {
      const provider = PROVIDER_CHOICES[setupIndex()]?.id;
      if (provider) await loadModels(provider, null);
      return;
    }
    if (state.step === "vendor") {
      // Index zero is "all providers", which is the search over everything.
      const vendor = setupIndex() === 0 ? null : state.vendors[setupIndex() - 1]?.id ?? null;
      setModelQuery("");
      setSetupIndex(0);
      setModelSetup({ ...state, step: "model", vendor });
      return;
    }
    if (state.step === "model") {
      const model = visibleModels(state)[setupIndex()];
      if (!model) return;
      const efforts = effortChoices(model);
      const currentIndex = state.agent?.effort
        ? efforts.findIndex((effort) => effort === state.agent?.effort)
        : 0;
      setSetupIndex(Math.max(0, currentIndex));
      setModelSetup({ ...state, step: "effort", model, efforts });
      return;
    }
    if (state.step === "effort") {
      const effort = state.efforts[setupIndex()] ?? null;
      if (state.agent) {
        await applyModelSetup(state, effort);
        return;
      }
      setAliasDraft(nextAgentAlias(state.provider, snapshot().agents));
      setModelSetup({ ...state, step: "alias", effort });
    }
  };

  const retreatModelSetup = (): void => {
    const state = modelSetup();
    if (!state || setupBusy()) return;
    // A search in progress is what escape means first; the step is second.
    if (state.step === "model" && modelQuery() !== "") {
      setModelQuery("");
      setSetupIndex(0);
      return;
    }
    if (state.step === "provider" || (state.step === "model" && state.agent && state.vendors.length <= 1)) {
      setModelSetup(null);
      return;
    }
    if (state.step === "vendor") {
      if (state.agent) {
        setModelSetup(null);
        return;
      }
      setModelSetup({ step: "provider" });
      setSetupIndex(PROVIDER_CHOICES.findIndex((choice) => choice.id === state.provider));
      return;
    }
    if (state.step === "model") {
      if (state.vendors.length > 1) {
        const at = state.vendors.findIndex((vendor) => vendor.id === state.vendor);
        setSetupIndex(at >= 0 ? at + 1 : 0);
        setModelSetup({ step: "vendor", provider: state.provider, agent: state.agent, options: state.options, vendors: state.vendors });
        return;
      }
      setModelSetup({ step: "provider" });
      setSetupIndex(PROVIDER_CHOICES.findIndex((choice) => choice.id === state.provider));
      return;
    }
    if (state.step === "effort") {
      setModelQuery("");
      setModelSetup({
        step: "model",
        provider: state.provider,
        agent: state.agent,
        options: state.options,
        vendors: state.vendors,
        vendor: state.vendor,
      });
      const scoped = state.vendor
        ? state.options.filter((option) => option.id.startsWith(`${state.vendor}/`))
        : state.options;
      setSetupIndex(Math.max(0, scoped.findIndex((option) => option.id === state.model.id)));
      return;
    }
    setModelSetup({
      step: "effort",
      provider: state.provider,
      agent: null,
      options: state.options,
      vendors: state.vendors,
      vendor: state.vendor,
      model: state.model,
      efforts: state.efforts,
    });
    setSetupIndex(Math.max(0, state.efforts.findIndex((effort) => effort === state.effort)));
  };

  const setupChoiceCount = (state: ModelSetupState): number => {
    if (state.step === "provider") return PROVIDER_CHOICES.length;
    if (state.step === "vendor") return state.vendors.length + 1;
    if (state.step === "model") return visibleModels(state).length;
    if (state.step === "effort") return state.efforts.length;
    return 0;
  };

  useKeyboard((key) => {
    if (questionsOpen()) return; // The question panel owns its input and close keys.
    if (key.ctrl && key.name === "q") {
      key.preventDefault(); key.stopPropagation();
      setQuestionsOpen(true);
      return;
    }
    if (isCopyChord(key)) {
      key.preventDefault();
      key.stopPropagation();
      void copyCurrent();
      return;
    }
    const picked = chatPicker();
    if (picked !== null) {
      const list = chats();
      key.preventDefault();
      key.stopPropagation();
      if (key.name === "escape" || isCancelChord(key)) {
        setChatPicker(null);
        return;
      }
      if ((key.name === "up" || key.name === "down") && list.length > 0) {
        const direction = key.name === "up" ? -1 : 1;
        setChatPicker((index) => ((index ?? 0) + list.length + direction) % list.length);
        return;
      }
      if (key.name === "return" || key.name === "enter") {
        const chosen = list[picked];
        if (!chosen || chosen.current) {
          setNotice({ text: chosen ? "that chat is already open" : "no chat chosen", tone: "info" });
          return;
        }
        void resumeChat(chosen.id).catch((error: unknown) => {
          setNotice({ text: error instanceof Error ? error.message : String(error), tone: "bad" });
        });
      }
      return;
    }
    if (providersOpen()) {
      if (key.name === "escape" || isCancelChord(key)) {
        key.preventDefault();
        key.stopPropagation();
        setProvidersOpen(false);
        return;
      }
      if (key.name === "r" || key.name === "return" || key.name === "enter") {
        key.preventDefault();
        key.stopPropagation();
        void openProviderStatus(true);
      }
      return;
    }
    const setup = modelSetup();
    if (setup) {
      if (key.name === "escape" || isCancelChord(key)) {
        key.preventDefault();
        key.stopPropagation();
        retreatModelSetup();
        return;
      }
      // The focused input owns ordinary keys and Enter on the naming step.
      if (setup.step === "alias") return;
      if (key.name === "up" || key.name === "down") {
        key.preventDefault();
        key.stopPropagation();
        const direction = key.name === "up" ? -1 : 1;
        const count = setupChoiceCount(setup);
        if (count > 0) setSetupIndex((index) => (index + count + direction) % count);
        return;
      }
      if (key.name === "return" || key.name === "enter") {
        // Advancing mounts the next focused control in this same render pass.
        // Consume the key so that control cannot receive the old Enter and
        // accidentally skip a step or submit the suggested alias immediately.
        key.preventDefault();
        key.stopPropagation();
        void advanceModelSetup().catch((error) => {
          setNotice({ text: error instanceof Error ? error.message : String(error), tone: "bad" });
        });
        return;
      }
      return;
    }
    const availableCommands = suggestions();
    if (availableCommands.length > 0 && (key.name === "up" || key.name === "down")) {
      key.preventDefault();
      key.stopPropagation();
      const count = Math.min(8, availableCommands.length);
      const direction = key.name === "up" ? -1 : 1;
      setCommandIndex((index) => (index + count + direction) % count);
      return;
    }
    if (availableCommands.length > 0 && key.name === "tab") {
      key.preventDefault();
      key.stopPropagation();
      const selected = availableCommands[commandIndex()];
      if (selected) {
        setComposer(completeCommand(selected));
        activityUi.clearFocus();
        setCommandIndex(0);
      }
      return;
    }
    // Shell-style recall, only from an empty composer or while already recalling,
    // so Up never discards what is being written.
    if (
      availableCommands.length === 0 &&
      (key.name === "up" || key.name === "down") &&
      !key.ctrl && !key.option &&
      (composer() === "" || history.recalling)
    ) {
      const recalled = key.name === "up" ? history.previous() : history.next();
      if (recalled !== null) {
        key.preventDefault();
        key.stopPropagation();
        setComposer(recalled);
        composerRef?.gotoLineEnd?.();
        return;
      }
    }
    if (availableCommands.length === 0 && key.name === "tab" && visibleActivities().length > 0) {
      key.preventDefault();
      key.stopPropagation();
      activityUi.traverse(key.shift ? -1 : 1);
      return;
    }
    if (activityUi.handleKey(key)) return;
    if (isCancelChord(key)) {
      switch (resolveCtrlC({ hasSelection: selectionText() !== "", composer: composer(), armed: armed() })) {
        case "clear-selection":
          renderer.clearSelection();
          setNotice({ text: "selection cleared", tone: "info" });
          return;
        case "clear-composer":
          setComposer("");
          pastes.clear();
          setNotice({ text: "composer cleared", tone: "info" });
          return;
        case "arm-detach":
          arm();
          setNotice({
            text: "press ctrl+c again to detach; active work continues",
            tone: "warn",
          });
          return;
        default:
          renderer.destroy();
          return;
      }
    }
    // Ctrl+D on an empty composer is the other conventional way out.
    if (key.ctrl && key.name === "d" && composer() === "") {
      renderer.destroy();
      return;
    }
    if (key.name === "escape") {
      if (selectionText() !== "") {
        renderer.clearSelection();
        return;
      }
      setHelpOpen(false);
      setAgentsOpen(false);
      setProvidersOpen(false);
      return;
    }
    if (key.ctrl && key.name === "g") {
      setHelpOpen((open) => !open);
      return;
    }
    if (key.ctrl && key.name === "p") {
      openProviderSetup();
      return;
    }
    if (key.ctrl && key.name === "m") {
      const agent = filter();
      if (!agent) {
        openProviderSetup();
        return;
      }
      void openModels(agent).catch((error) => setNotice({ text: error instanceof Error ? error.message : String(error), tone: "bad" }));
      return;
    }
    if (key.ctrl && key.name === "b") {
      setPanelOpen((open) => !open);
      return;
    }
    if (key.name === "pageup" || key.name === "pagedown") {
      scrollBy(key.name === "pageup" ? -1 : 1);
      return;
    }
    // Only alt claims the arrows. Ctrl+arrow and meta+arrow stay with the
    // composer, where the native harness of a text field expects them to jump
    // by word.
    if (key.option && (key.name === "left" || key.name === "right")) {
      step(key.name === "left" ? -1 : 1);
      return;
    }
    if (composer() === "" && (key.name === "left" || key.name === "right")) {
      step(key.name === "left" ? -1 : 1);
      return;
    }
    if (key.ctrl && /^[1-9]$/u.test(key.name)) {
      setActiveTab(Math.min(Number(key.name) - 1, agentIds().length));
      return;
    }
    if (key.ctrl && key.name === "t") {
      setActiveTab(0);
    }
  });

  const step = (direction: 1 | -1): void => {
    const count = agentIds().length + 1;
    setActiveTab((value) => (value + count + direction) % count);
  };

  onMount(() => {
    setNotice({
      text: `attached  ${GLYPHS.bullet}  ${options.stateDirectory}`,
      tone: "info",
    });
  });

  const submit = async (value: string): Promise<void> => {
    const typed = value.trim();
    if (!typed || sending()) return;
    const text = pastes.expand(typed).trim();
    if (text.length > COMPOSER_MAX_CHARS) {
      setNotice({
        text: `message is ${text.length} characters, one message holds at most ${COMPOSER_MAX_CHARS}`,
        tone: "bad",
      });
      return;
    }
    setComposer("");
    history.push(text);
    setSending(true);
    // A send that failed, or a command typed wrong, gives the text back rather
    // than discarding what may be a long pasted prompt.
    let keep = false;
    try {
      const shown = approval();
      const action = parseCommand(
        text,
        activeTab(),
        agentIds(),
        shown?.agent && shown.providerEventId
          ? { agent: shown.agent, requestId: shown.providerEventId }
          : null,
      );
      switch (action.type) {
        case "detach":
          renderer.destroy();
          return;
        case "quit":
          setNotice({ text: "stopping the service and both native harnesses", tone: "warn" });
          await options.client.shutdown();
          renderer.destroy();
          return;
        case "help":
          setHelpOpen(true);
          setAgentsOpen(false);
          setNotice({ text: "ctrl+g or esc closes this panel", tone: "info" });
          return;
        case "agents":
          setAgentsOpen(true);
          setHelpOpen(false);
          setProvidersOpen(false);
          setNotice({ text: "agent setup: aliases are tabs; providers are native harnesses", tone: "info" });
          return;
        case "questions":
          setQuestionsOpen(true);
          return;
        case "providers":
          await openProviderStatus();
          return;
        case "models":
          if (action.agent) await openModels(action.agent);
          else openProviderSetup();
          return;
        case "effort":
          await openEffort(action.agent);
          return;
        case "new_chat":
          await options.client.newChat();
          void refreshChats();
          setNotice({ text: "new chat ready; the previous chat was archived if it had a message", tone: "good" });
          return;
        case "agent_configure":
          await options.client.configureAgent(action.definition);
          setNotice({
            text: `${action.definition.alias} now uses ${action.definition.provider}` +
              (action.definition.model ? ` / ${action.definition.model}` : " / provider default"),
            tone: "good",
          });
          return;
        case "agent_remove":
          await options.client.removeAgent(action.agent);
          setNotice({ text: `${action.agent} removed from this project`, tone: "warn" });
          return;
        case "status":
          setNotice({ text: statusText(snapshot()), tone: "info" });
          return;
        case "complete":
          await options.client.completeGoal();
          setNotice({ text: "goal closed, your next message opens a new one", tone: "good" });
          return;
        case "interrupt":
          await options.client.interrupt(action.agent);
          setNotice({ text: `interrupt sent to ${action.agent}`, tone: "warn" });
          return;
        case "stop": {
          const targets = stopTargets(action.agent);
          if (targets.length === 0) {
            setNotice({ text: "nothing is working right now", tone: "info" });
            return;
          }
          await Promise.all(targets.map((agent) => options.client.interrupt(agent)));
          setNotice({ text: `stopped ${targets.join(", ")}; the conversation and files stay as they are`, tone: "warn" });
          return;
        }
        case "clear": {
          const targets = action.agent === "all"
            ? snapshot().agents.filter((agent) => agent.mode !== "external").map((agent) => agent.id)
            : [action.agent];
          for (const agent of targets) await options.client.clearAgent(agent);
          setNotice({
            text: `cleared ${targets.join(", ")}'s context; the chat stays and the other agents were told`,
            tone: "warn",
          });
          return;
        }
        case "save": {
          const saved = await options.client.saveChat();
          void refreshChats();
          setNotice({ text: `chat saved to ${displayPath(saved.path, process.env["HOME"], 80)}`, tone: "good" });
          return;
        }
        case "export":
          startExport(action.handoff, action.path);
          return;
        case "chats": {
          const list = await refreshChats();
          setChatPicker(list.length > 0 ? 0 : null);
          setNotice({
            text: list.length > 0 ? "enter resumes the chosen chat; esc closes" : "no archived chats yet",
            tone: "info",
          });
          return;
        }
        case "resume":
          await resumeChat(action.chat);
          return;
        case "restart":
          setNotice({ text: `restarting ${action.agent}'s native harness`, tone: "info" });
          await options.client.restartAgent(action.agent);
          setNotice({ text: `${action.agent} restarted; its next input includes the active goal`, tone: "good" });
          return;
        case "approval":
          await options.client.approve(action.agent, action.requestId, action.decision);
          setNotice({
            text: `${action.decision} sent to ${action.agent} for ${action.requestId}`,
            tone: "good",
          });
          return;
        case "copy": {
          const entries = buildEntries(snapshot(), filter());
          if (action.scope === "goal") {
            const goal = snapshot().activeGoal;
            await (goal
              ? copy(goal.instruction, "the goal")
              : Promise.resolve(setNotice({ text: "there is no active goal", tone: "warn" })));
            return;
          }
          if (action.scope === "all") {
            await copy(transcriptToMarkdown(entries, view()), "the conversation");
            return;
          }
          if (action.scope === "findings") {
            const findings = snapshot().findings;
            await (findings.length > 0
              ? copy(findingsReport(findings, snapshot().activeGoal), "the findings")
              : Promise.resolve(setNotice({ text: "no findings recorded yet", tone: "warn" })));
            return;
          }
          if (action.scope === "code") {
            const code = lastCodeBlock(entries);
            await (code
              ? copy(code, "the last code block")
              : Promise.resolve(setNotice({ text: "no code block in this chat yet", tone: "warn" })));
            return;
          }
          const entry = lastSpokenEntry(entries);
          if (!entry) {
            setNotice({ text: "nothing to copy yet", tone: "warn" });
            return;
          }
          await copy(entryToMarkdown(entry, view()), "the last reply");
          return;
        }
        case "check": {
          setNotice({ text: "checking configured team bridges (no model turn)", tone: "info" });
          const statuses = await options.client.checkBridges();
          const broken = statuses.filter((status) => status.state !== "ready");
          setNotice({
            text:
              statuses.length === 0
                ? "no managed team bridges are configured"
                : broken.length === 0
                ? `team bridge ok for ${statuses.map((status) => status.agent).join(" and ")}`
                : broken.map((status) => `${status.agent}: ${status.detail}`).join("   "),
            tone: broken.length === 0 ? "good" : "bad",
          });
          return;
        }
        case "unknown": {
          // A known command typed the wrong way is the common case, and naming
          // its shape is more use than saying the whole thing is unknown.
          keep = true;
          const usage = usageFor(action.input);
          setNotice({
            text: usage
              ? `usage: ${usage}`
              : `unknown command ${action.input.split(/\s/u)[0] ?? ""}, ctrl+g for help`,
            tone: "warn",
          });
          return;
        }
        default:
          await options.client.send(action.target, action.text);
          setNotice({
            text: action.target === "all" ? "sent to every ready peer" : `sent to ${action.target}`,
            tone: "good",
          });
      }
    } catch (error) {
      keep = true;
      setNotice({ text: error instanceof Error ? error.message : String(error), tone: "bad" });
    } finally {
      setSending(false);
      if (!keep) pastes.clear();
      else if (composer() === "") setComposer(typed);
    }
  };

  /**
   * The keys worth naming, shrinking before the notice does: what just happened
   * matters more than a reminder of a key the help panel also lists.
   */
  const hints = (): string => {
    if (armed()) return "ctrl+c again to detach";
    const room = dimensions().width - 2;
    // While the peer this tab talks to is working, the one key worth knowing
    // is how to stop it.
    const working = stopTargets(null).length > 0;
    if (room >= 76) return joinMeta([working ? "/stop interrupts" : null, "ctrl+g help", "ctrl+shift+c copy"]);
    if (room >= 44) return working ? "/stop interrupts" : "ctrl+g help";
    return "";
  };
  const noticeRoom = (): number =>
    Math.max(10, dimensions().width - 2 - (hints() === "" ? 0 : cellWidth(hints()) + 2));

  /** `/stop` with no peer means the focused tab's peer, or every working peer from Global. */
  const stopTargets = (agent: AgentId | "all" | null): AgentId[] => {
    const working = snapshot().agents
      .filter((candidate) => candidate.state === "busy" || candidate.state === "waiting")
      .map((candidate) => candidate.id);
    if (agent === "all") return working;
    if (agent) return [agent];
    const focused = filter();
    return focused ? working.filter((id) => id === focused) : working;
  };

  /**
   * Writes an export without holding the composer. A handoff asks every agent
   * and can take minutes, and the reader should be able to keep working.
   */
  const startExport = (handoff: boolean, path: string | null): void => {
    setNotice({
      text: handoff ? "asking each agent for a handoff; the file is written when they answer" : "exporting the chat",
      tone: "info",
    });
    void options.client.exportChat({ handoff, ...(path ? { path } : {}) }).then(
      (result) => {
        const missing = result.handoffs.filter((entry) => entry.source === "none").map((entry) => entry.agent);
        setNotice({
          text: `${handoff ? "handoff" : "chat"} exported to ${displayPath(result.path, process.env["HOME"], 80)}` +
            (missing.length > 0 ? `; no answer from ${missing.join(", ")}` : ""),
          tone: missing.length > 0 ? "warn" : "good",
        });
      },
      (error: unknown) => {
        setNotice({ text: error instanceof Error ? error.message : String(error), tone: "bad" });
      },
    );
  };

  const resumeChat = async (chat: string): Promise<void> => {
    setChatPicker(null);
    setNotice({ text: "resuming that chat; the open one is archived first", tone: "info" });
    const resumed = await options.client.resumeChat(chat);
    void refreshChats();
    setNotice({ text: `resumed "${truncate(resumed.title, 60)}" with ${resumed.messages} messages`, tone: "good" });
  };

  /** Where the next message goes, in its colour, unless the composer is not the
   * thing taking keys right now. */
  const composerBorder = (): string => {
    if (sending()) return theme().warn;
    if (questionsOpen() || helpOpen() || agentsOpen() || providersOpen() || modelSetup() || chatPicker() !== null || activityUi.focusedId()) {
      return theme().rule;
    }
    return destination() === "all" ? theme().brand : accent(destination());
  };

  const noticeColor = (): string => {
    const tone = notice().tone;
    if (tone === "bad") return theme().danger;
    if (tone === "warn") return theme().warn;
    if (tone === "good") return theme().ok;
    return theme().faint;
  };

  /** The target and the input, drawn inside whichever composer frame fits. */
  const composerLine = () => (
    <>
      <text fg={sending() ? theme().warn : theme().brand}>{`${GLYPHS.chevron} `}</text>
      <text fg={destination() === "all" ? theme().text : accent(destination())} attributes={1}>
        {destination()}
      </text>
      <text fg={theme().rule}>{` ${GLYPHS.divider} `}</text>
      <input
        ref={(element: InputRenderable) => {
          composerRef = element;
        }}
        focused={!questionsOpen() && !providersOpen() && !helpOpen() && !agentsOpen() && !modelSetup() && chatPicker() === null && !activityUi.focusedId()}
        value={composer()}
        placeholder={
          snapshot().activeGoal
            ? `message ${destination()}, or / for a command`
            : destination() === "all"
            ? "describe a shared goal for every connected agent"
            : `start a shared goal with ${destination()}`
        }
        onInput={(value) => {
          setComposer(value);
          activityUi.clearFocus();
          setCommandIndex(0);
        }}
        onSubmit={(value) => {
          if (typeof value === "string") void submit(value);
        }}
        maxLength={COMPOSER_MAX_CHARS}
        onPaste={(event) => {
          const text = decodePaste(event.bytes);
          if (!PasteStore.holds(text)) return;
          event.preventDefault();
          composerRef?.insertText(pastes.hold(text));
          setNotice({ text: "pasted text is kept whole and sent as written", tone: "info" });
        }}
        style={{
          flexGrow: 1,
          textColor: theme().text,
          cursorColor: theme().text,
          placeholderColor: theme().faint,
          backgroundColor: boxedComposer() ? theme().base : theme().surface,
          focusedBackgroundColor: boxedComposer() ? theme().base : theme().surface,
        }}
      />
    </>
  );

  const setupOverlay = () => {
    const state = modelSetup();
    // Nothing at all, not an empty text: an empty text node is a real row in
    // the column and pushes a fixed strip off the bottom of the screen.
    if (!state) return null;
    if (state.step === "provider") {
      return <ProviderOverlay theme={theme()} choices={PROVIDER_CHOICES} selected={setupIndex()} width={dimensions().width} height={dimensions().height} />;
    }
    if (state.step === "vendor") {
      return (
        <CatalogVendorOverlay
          theme={theme()}
          provider={state.provider}
          agent={state.agent?.id ?? null}
          vendors={state.vendors}
          current={state.agent?.model?.split("/")[0] ?? null}
          selected={setupIndex()}
          width={dimensions().width}
          height={dimensions().height}
        />
      );
    }
    if (state.step === "model") {
      const shown = visibleModels(state);
      return (
        <ModelCatalogOverlay
          theme={theme()}
          provider={state.provider}
          agent={state.agent?.id ?? null}
          current={state.agent?.model ?? null}
          vendor={state.vendor}
          options={shown}
          matches={shown.length}
          total={state.vendor
            ? state.options.filter((option) => option.id.startsWith(`${state.vendor}/`)).length
            : state.options.filter((option) => option.id !== "").length}
          {...(searchable(state)
            ? {
                search: {
                  query: modelQuery(),
                  onInput: (value: string) => {
                    setModelQuery(value);
                    setSetupIndex(0);
                  },
                },
              }
            : {})}
          selected={setupIndex()}
          width={dimensions().width}
          height={dimensions().height}
        />
      );
    }
    if (state.step === "effort") {
      return (
        <EffortOverlay
          theme={theme()}
          provider={state.provider}
          model={state.model}
          choices={state.efforts}
          current={state.agent?.effort ?? null}
          selected={setupIndex()}
          adding={!state.agent}
          width={dimensions().width}
          height={dimensions().height}
        />
      );
    }
    return (
      <AliasOverlay
        theme={theme()}
        provider={state.provider}
        model={state.model}
        effort={state.effort}
        alias={aliasDraft()}
        problem={aliasProblem(aliasDraft(), snapshot().agents)}
        width={dimensions().width}
        height={dimensions().height}
        onInput={setAliasDraft}
        onSubmit={(value) => {
          void applyModelSetup(state, state.effort, value).catch((error) => {
            setNotice({ text: error instanceof Error ? error.message : String(error), tone: "bad" });
          });
        }}
      />
    );
  };

  return (
    <box
      onMouseDown={onMouseDown}
      style={{
        width: "100%",
        height: "100%",
        flexDirection: "column",
        backgroundColor: theme().base,
      }}
    >
      <Header
        theme={theme()}
        project={displayPath(options.project.launchDirectory, process.env["HOME"], 40)}
        agents={snapshot().agents}
        accents={view().accent}
        spinner={spinner()}
        width={dimensions().width}
      />

      <TabStrip
        theme={theme()}
        tabs={tabs()}
        active={activeTab()}
        width={dimensions().width}
        counters={counters()}
        onTabClick={setActiveTab}
      />

      <GoalStrip
        theme={theme()}
        snapshot={snapshot()}
        width={dimensions().width}
        now={now()}
        compact={compact()}
      />

      <box style={{ flexDirection: "row", flexGrow: 1, flexShrink: 1, minHeight: 0, width: "100%" }}>
        <scrollbox
          id="transcript-scroll"
          ref={(element: ScrollBoxRenderable) => {
            transcriptRef = element;
          }}
          focused={false}
          stickyScroll
          stickyStart="bottom"
          style={{
            flexGrow: 1,
            flexShrink: 1,
            minHeight: 0,
            backgroundColor: theme().base,
            paddingLeft: 1,
            paddingRight: 1,
          }}
          scrollbarOptions={{
            showArrows: false,
            trackOptions: { backgroundColor: theme().ruleSoft, foregroundColor: theme().muted },
          }}
          horizontalScrollbarOptions={{ visible: false }}
        >
          <For each={rows()}>
            {(row) => (
              <Show when={row.activity} fallback={<Row row={row} />}>
                {(activity: () => ActivitySummary) => (
                  <ActivityCard
                    summary={activity()}
                    detail={activityUi.detail(activity().id)}
                    expanded={activityUi.expanded(activity().id)}
                    focused={activityUi.focusedId() === activity().id}
                    loading={activityUi.loading(activity().id)}
                    selectedFile={activityUi.selectedFile(activity().id)}
                    paneRows={activityPaneRows()}
                    width={transcriptWidth()}
                    theme={theme()}
                    accents={view().accent}
                    onToggle={() => activityUi.toggle(activity())}
                    onSelectFile={(index) => activityUi.selectFile(activity().id, index)}
                    onPaneRef={(renderable) => activityUi.setPane(activity().id, renderable)}
                  />
                )}
              </Show>
            )}
          </For>
        </scrollbox>

        <Show when={showPanel()}>
          <box style={{ width: 1, height: "100%", backgroundColor: theme().ruleSoft }} />
          <SidePanel
            theme={theme()}
            snapshot={snapshot()}
            accents={view().accent}
            width={panelWidth()}
            height={paneHeight()}
            now={now()}
          />
        </Show>
      </box>

      <Show when={approval()}>
        {(pending: () => PersistedEvent) => (
          <ApprovalStrip
            theme={theme()}
            approval={pending()}
            accents={view().accent}
            waiting={openApprovals().length}
            width={dimensions().width}
          />
        )}
      </Show>

      <Show when={waitingQuestions().length > 0}>
        <text fg={theme().warn} style={{ height: 1, flexShrink: 0 }}>{truncate(` ${waitingQuestions().length} question(s) waiting from ${[...new Set(waitingQuestions().map((question) => question.agent))].join(", ")} · ctrl+q to answer`, dimensions().width)}</text>
      </Show>

      <Show
        when={boxedComposer()}
        fallback={
          <>
            <Rule theme={theme()} width={dimensions().width} />
            <box
              style={{
                height: 1,
                width: "100%",
                flexShrink: 0,
                flexDirection: "row",
                backgroundColor: theme().surface,
                paddingLeft: 1,
                paddingRight: 1,
              }}
            >
              {composerLine()}
            </box>
          </>
        }
      >
        <box
          border
          style={{
            height: 3,
            width: "100%",
            flexShrink: 0,
            flexDirection: "row",
            backgroundColor: theme().base,
            borderStyle: "rounded",
            borderColor: composerBorder(),
            paddingLeft: 1,
            paddingRight: 1,
          }}
        >
          {composerLine()}
        </box>
      </Show>

      <For each={suggestions().length > 0 && !questionsOpen() && !helpOpen() && !agentsOpen() && !modelSetup() ? [true] : []}>
        {() => (
          <CommandPalette
            theme={theme()}
            entries={suggestions()}
            selected={commandIndex()}
            width={dimensions().width}
            height={dimensions().height}
            below={composerRows() + (showStatus() ? 1 : 0)}
          />
        )}
      </For>

      <Show when={showStatus()}>
        <box style={{ height: 1, width: "100%", flexShrink: 0, flexDirection: "row", paddingLeft: 1, paddingRight: 1 }}>
          <text fg={noticeColor()} style={{ flexShrink: 1 }}>{truncate(notice().text, noticeRoom())}</text>
          <box style={{ flexGrow: 1, minWidth: 2 }} />
          <text fg={armed() ? theme().warn : theme().faint} style={{ flexShrink: 0 }}>{hints()}</text>
        </box>
      </Show>

      <Show when={helpOpen()}>
        <HelpOverlay theme={theme()} width={dimensions().width} height={dimensions().height} />
      </Show>
      <Show when={agentsOpen()}>
        <AgentOverlay
          theme={theme()}
          agents={snapshot().agents}
          accents={view().accent}
          focused={filter()}
          {...(snapshot().bridges ? { bridges: snapshot().bridges } : {})}
          width={dimensions().width}
          height={dimensions().height}
        />
      </Show>
      <Show when={providersOpen()}>
        <ProviderStatusOverlay
          theme={theme()}
          document={providerStatus()}
          busy={providerStatusBusy()}
          width={dimensions().width}
          height={dimensions().height}
        />
      </Show>
      <Show when={chatPicker() !== null}>
        <ChatsOverlay
          theme={theme()}
          chats={chats()}
          selected={chatPicker() ?? 0}
          now={now()}
          width={dimensions().width}
          height={dimensions().height}
        />
      </Show>
      {setupOverlay}
      <QuestionOverlay open={questionsOpen()} questions={waitingQuestions()} theme={theme()} width={dimensions().width} height={dimensions().height}
        close={() => setQuestionsOpen(false)} answer={async (question, response) => {
          if (!options.client.answerQuestion) throw new Error("This client cannot answer questions; reopen with the updated Watari executable");
          await options.client.answerQuestion(question.agent, question.id, response);
        }} />
    </box>
  );
}

function initialThemeMode(detected: "dark" | "light" | null): "dark" | "light" {
  const preference = readThemePreference(process.env);
  if (preference !== "auto") return preference;
  return detected ?? "dark";
}

function statusText(snapshot: TeamSnapshot): string {
  const peers = snapshot.agents.map((agent) =>
    `${agent.id} ${stateStyle(agent.state).label}${agent.availability === "dnd" ? " dnd" : ""}`
  );
  const goal = snapshot.activeGoal;
  const wakes = (snapshot.wakes ?? []).filter((wake) => wake.state === "pending").length;
  return joinMeta([
    ...peers,
    goal ? `goal ${goal.id.replace(/^goal-/u, "").slice(0, 8)}` : "no goal",
    wakes > 0 ? `${wakes} pending ${wakes === 1 ? "wake" : "wakes"}` : null,
  ]);
}
