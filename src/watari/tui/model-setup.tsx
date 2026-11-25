import { For, Show } from "solid-js";

import type { AgentModelOption } from "../models.ts";
import type { TeamAgent } from "../state/types.ts";
import { isAgentAlias } from "../team/identity.ts";
import {
  isReasoningEffort,
  type ReasoningEffort,
  type SupportedProviderId,
} from "../team/roster.ts";
import { truncate } from "./format.ts";
import { GLYPHS, providerAccent, type Theme } from "./theme.ts";

const BOLD = 1;

export interface ProviderChoice {
  readonly id: SupportedProviderId;
  readonly title: string;
  readonly description: string;
}

export type EffortChoice = ReasoningEffort | null;

/** A provider default is a real choice, not a guessed model id. */
export const PROVIDER_DEFAULT_MODEL: AgentModelOption = {
  id: "",
  displayName: "Provider default",
  description: "Let the native harness choose its current default model.",
  efforts: [],
  isDefault: true,
};

export function modelChoices(models: readonly AgentModelOption[]): readonly AgentModelOption[] {
  return [PROVIDER_DEFAULT_MODEL, ...models];
}

/**
 * One vendor inside a harness's catalog.
 *
 * Codex and Claude serve their own few models, so their catalog is a list.
 * OpenCode is a harness over other people's models and answers with hundreds of
 * `vendor/model` identifiers, which is a directory, not a list: it gets a step
 * that separates the vendors first, and a search that ignores that separation
 * when the reader already knows the name they want.
 */
export interface CatalogVendor {
  readonly id: string;
  readonly models: readonly AgentModelOption[];
}

/** True when this catalog is a directory of other providers' models. */
export function isVendorCatalog(models: readonly AgentModelOption[]): boolean {
  const named = models.filter((model) => model.id !== "");
  return named.length > 0 && named.every((model) => model.id.includes("/"));
}

export function catalogVendors(models: readonly AgentModelOption[]): readonly CatalogVendor[] {
  const grouped = new Map<string, AgentModelOption[]>();
  for (const model of models) {
    if (model.id === "") continue;
    const vendor = model.id.split("/")[0] ?? "";
    if (!vendor) continue;
    const existing = grouped.get(vendor);
    if (existing) existing.push(model);
    else grouped.set(vendor, [model]);
  }
  return [...grouped.entries()]
    .map(([id, entries]) => ({ id, models: entries }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

/**
 * Search across a catalog the way a reader types it: the letters in order,
 * anywhere in the id or the name. A prefix beats a word start beats a scattered
 * match, and equal matches keep the catalog's own order, so the list never
 * reshuffles under the cursor for no reason.
 */
export function filterModels(
  models: readonly AgentModelOption[],
  query: string,
): readonly AgentModelOption[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return models;
  const scored: Array<{ readonly model: AgentModelOption; readonly rank: number; readonly index: number }> = [];
  for (const [index, model] of models.entries()) {
    const rank = matchRank(`${model.id} ${model.displayName}`.toLowerCase(), needle);
    if (rank !== null) scored.push({ model, rank, index });
  }
  return scored
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map((entry) => entry.model);
}

function matchRank(haystack: string, needle: string): number | null {
  const at = haystack.indexOf(needle);
  if (at === 0) return 0;
  if (at > 0) return /[\s/_-]/u.test(haystack[at - 1] ?? "") ? 1 : 2;
  // Scattered letters, in order: what a half-remembered model id looks like.
  let cursor = 0;
  for (const character of needle) {
    const found = haystack.indexOf(character, cursor);
    if (found === -1) return null;
    cursor = found + 1;
  }
  return 3;
}

/** Only offer effort values Watari can pass through both typed adapters. */
export function effortChoices(model: AgentModelOption): readonly EffortChoice[] {
  // The native catalog is authoritative. Validation here only excludes values
  // that cannot be represented safely in the project profile.
  const supported = model.efforts.filter(isReasoningEffort);
  const unique = [...new Set(supported)];
  return [null, ...unique];
}

/** Generates a useful name without ever overwriting an existing conversation. */
export function nextAgentAlias(provider: SupportedProviderId, agents: readonly TeamAgent[]): string {
  const taken = new Set(agents.map((agent) => agent.id.toLowerCase()));
  if (!taken.has(provider)) return provider;
  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const candidate = `${provider}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error(`could not allocate an alias for ${provider}`);
}

export function aliasProblem(alias: string, agents: readonly TeamAgent[]): string | null {
  if (!isAgentAlias(alias)) {
    return "Use letters, numbers, dots, underscores, or hyphens.";
  }
  if (agents.some((agent) => agent.id.toLowerCase() === alias.toLowerCase())) {
    return `${alias} already exists; choose another name.`;
  }
  return null;
}

/**
 * The path through the guided flow.
 *
 * "Provider" stays Watari's word for the harness, as it is in `/agent add` and
 * in the roster, and the extra step a multi-provider harness needs is spelled
 * out as the model provider, so one word never means two things at once.
 */
function breadcrumb(changing: boolean, vendors: boolean): string {
  if (changing) return vendors ? "model provider  →  model  →  effort" : "model  →  effort";
  return vendors
    ? "provider  →  model provider  →  model  →  effort  →  name"
    : "provider  →  model  →  effort  →  name";
}

function countLabel(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

interface ChoiceRow {
  readonly title: string;
  readonly description: string;
  readonly suffix?: string;
  /** Short marker for the choice already in effect, so a change is a change. */
  readonly badge?: string;
  /** Identity colour, shown as a dot, for a choice that is itself an identity. */
  readonly accent?: string;
}

function ChoiceOverlay(props: {
  readonly theme: Theme;
  readonly title: string;
  readonly breadcrumb: string;
  readonly note: string;
  readonly choices: readonly ChoiceRow[];
  readonly selected: number;
  readonly width: number;
  readonly height: number;
  readonly bottomTitle: string;
  /** Live query for a catalog too long to page through. */
  readonly search?: { readonly query: string; readonly onInput: (value: string) => void };
}) {
  const panelWidth = () => Math.min(88, Math.max(52, props.width - 8));
  const visibleCount = () => Math.max(3, Math.min(props.choices.length, props.height - (props.search ? 12 : 10)));
  const start = () => Math.max(
    0,
    Math.min(props.selected - Math.floor(visibleCount() / 2), props.choices.length - visibleCount()),
  );
  const visible = () => props.choices.slice(start(), start() + visibleCount());
  const selectedChoice = () => props.choices[props.selected];
  return (
    <box
      style={{
        position: "absolute",
        left: Math.max(0, Math.floor((props.width - panelWidth()) / 2)),
        top: Math.max(1, Math.floor((props.height - visibleCount() - 7) / 2)),
        width: panelWidth(),
        flexDirection: "column",
        backgroundColor: props.theme.surface,
        borderStyle: "rounded",
        borderColor: props.theme.rule,
        paddingLeft: 2,
        paddingRight: 2,
        zIndex: 12,
      }}
      title={` ${props.title} `}
      titleColor={props.theme.brand}
      bottomTitle={` ${props.bottomTitle} `}
    >
      <text fg={props.theme.muted}>{props.breadcrumb}</text>
      <text fg={props.theme.faint}>{props.note}</text>
      <text> </text>
      <For each={props.search ? [props.search] : []}>
        {(search) => (
          <box style={{ height: 1, flexDirection: "row", backgroundColor: props.theme.raised }}>
            <text fg={props.theme.brand}>{"search  "}</text>
            <input
              focused
              value={search.query}
              placeholder="type to filter, ↑ ↓ to choose"
              onInput={search.onInput}
              style={{
                flexGrow: 1,
                textColor: props.theme.text,
                cursorColor: props.theme.text,
                backgroundColor: props.theme.raised,
                focusedBackgroundColor: props.theme.raised,
                placeholderColor: props.theme.faint,
              }}
            />
          </box>
        )}
      </For>
      <For each={props.search ? [props.search] : []}>{() => <text> </text>}</For>
      <For each={visible()}>
        {(choice, index) => {
          const active = () => start() + index() === props.selected;
          return (
            <box
              style={{
                flexDirection: "row",
                height: 1,
                backgroundColor: active() ? props.theme.raised : props.theme.surface,
              }}
            >
              <text fg={active() ? props.theme.brand : props.theme.faint}>
                {active() ? `${GLYPHS.chevron} ` : "  "}
              </text>
              <Show when={choice.accent}>
                <text fg={choice.accent ?? props.theme.faint}>{`${GLYPHS.claim} `}</text>
              </Show>
              <text fg={active() ? props.theme.text : props.theme.muted} attributes={active() ? BOLD : 0} selectable>
                {truncate(choice.title, 34)}
              </text>
              <text fg={props.theme.ok}>{choice.badge ? `  ${choice.badge}` : ""}</text>
              <box style={{ flexGrow: 1 }} />
              <Show when={choice.suffix}>
                <text fg={props.theme.faint} selectable>{truncate(choice.suffix ?? "", 30)}</text>
              </Show>
            </box>
          );
        }}
      </For>
      <For each={props.choices.length === 0 ? [true] : []}>
        {() => <text fg={props.theme.warn}>{"  nothing matches that; backspace to widen the search"}</text>}
      </For>
      <text> </text>
      <text fg={props.theme.faint} selectable>
        {truncate(selectedChoice()?.description ?? "", panelWidth() - 6)}
      </text>
    </box>
  );
}

export function ProviderOverlay(props: {
  readonly theme: Theme;
  readonly choices: readonly ProviderChoice[];
  readonly selected: number;
  readonly width: number;
  readonly height: number;
}) {
  return (
    <ChoiceOverlay
      theme={props.theme}
      title={`${GLYPHS.mark} add agent · provider`}
      breadcrumb="provider  →  model  →  effort  →  name"
      note="Native catalogs are read without sending a prompt or starting a model turn."
      choices={props.choices.map((choice) => ({ ...choice, accent: providerAccent(props.theme, choice.id) }))}
      selected={props.selected}
      width={props.width}
      height={props.height}
      bottomTitle="↑ ↓ select · enter models · esc cancel"
    />
  );
}

/**
 * The vendors inside a multi-provider harness's catalog.
 *
 * Shown only for a harness that has them, which is why Codex and Claude never
 * see this step: one list of a handful of their own models is not a directory.
 */
export function CatalogVendorOverlay(props: {
  readonly theme: Theme;
  readonly provider: SupportedProviderId;
  readonly agent: string | null;
  readonly vendors: readonly CatalogVendor[];
  readonly current: string | null;
  readonly selected: number;
  readonly width: number;
  readonly height: number;
}) {
  const total = () => props.vendors.reduce((count, vendor) => count + vendor.models.length, 0);
  return (
    <ChoiceOverlay
      theme={props.theme}
      title={`${props.agent ?? "new agent"} · ${props.provider} model provider`}
      breadcrumb={breadcrumb(Boolean(props.agent), true)}
      note={`${props.provider} serves ${countLabel(total(), "model")} from ${countLabel(props.vendors.length, "provider")}. Pick one, or search them all.`}
      choices={[
        {
          title: "All providers",
          description: `Search every model ${props.provider} can reach, whoever serves it.`,
          suffix: countLabel(total(), "model"),
        },
        ...props.vendors.map((vendor) => ({
          title: vendor.id,
          description: `${countLabel(vendor.models.length, "model")} served through ${props.provider} by ${vendor.id}.`,
          suffix: countLabel(vendor.models.length, "model"),
          ...(props.current === vendor.id ? { badge: "current" } : {}),
        })),
      ]}
      selected={props.selected}
      width={props.width}
      height={props.height}
      bottomTitle="↑ ↓ select · enter models · esc back"
    />
  );
}

export function ModelCatalogOverlay(props: {
  readonly theme: Theme;
  readonly provider: SupportedProviderId;
  readonly agent: string | null;
  /** Model this agent runs today, so the list shows a change as a change. */
  readonly current?: string | null;
  readonly options: readonly AgentModelOption[];
  /** Vendor this list was narrowed to, when the harness has vendors. */
  readonly vendor?: string | null;
  readonly search?: { readonly query: string; readonly onInput: (value: string) => void };
  readonly matches?: number;
  readonly total?: number;
  readonly selected: number;
  readonly width: number;
  readonly height: number;
}) {
  const scope = () => (props.vendor ? `${props.provider} · ${props.vendor}` : props.provider);
  const searching = () => (props.search?.query ?? "") !== "";
  return (
    <ChoiceOverlay
      theme={props.theme}
      title={`${props.agent ?? "new agent"} · ${scope()} model`}
      breadcrumb={breadcrumb(Boolean(props.agent), Boolean(props.search))}
      note={
        props.search
          ? `${props.matches ?? props.options.length} of ${countLabel(props.total ?? props.options.length, "model")}. Names come from the harness; nothing here starts a turn.`
          : "Models come from the native provider. Provider default follows future CLI upgrades."
      }
      choices={props.options.map((option) => ({
        title: option.displayName,
        description: option.description,
        // In a catalog of other people's models the identifier is the thing
        // that disambiguates two models with the same friendly name.
        suffix: props.search
          ? option.id || "harness default"
          : option.efforts.length > 0
          ? option.efforts.join("/")
          : option.id || "native default",
        ...(props.agent && (props.current ?? "") === option.id ? { badge: "current" } : {}),
      }))}
      selected={props.selected}
      width={props.width}
      height={props.height}
      {...(props.search ? { search: props.search } : {})}
      bottomTitle={`↑ ↓ select · enter effort · esc ${searching() ? "clears the search" : "back"}`}
    />
  );
}

export function EffortOverlay(props: {
  readonly theme: Theme;
  readonly provider: SupportedProviderId;
  readonly model: AgentModelOption;
  readonly choices: readonly EffortChoice[];
  /** Effort this agent runs today, when one is being changed rather than added. */
  readonly current?: EffortChoice;
  readonly selected: number;
  readonly adding: boolean;
  readonly width: number;
  readonly height: number;
}) {
  return (
    <ChoiceOverlay
      theme={props.theme}
      title={`${props.model.displayName} · effort`}
      breadcrumb={props.adding ? "provider  →  model  →  effort  →  name" : "model  →  effort"}
      note={`Choose how much reasoning ${props.provider} may use. Default leaves provider policy unchanged.`}
      choices={props.choices.map((effort) => ({
        title: effort ?? "Provider default",
        description: effort
          ? `${effort} reasoning effort for this agent.`
          : "Do not override the native provider's reasoning setting.",
        ...(!props.adding && (props.current ?? null) === effort ? { badge: "current" } : {}),
      }))}
      selected={props.selected}
      width={props.width}
      height={props.height}
      bottomTitle={`↑ ↓ select · enter ${props.adding ? "name" : "apply"} · esc back`}
    />
  );
}

export function AliasOverlay(props: {
  readonly theme: Theme;
  readonly provider: SupportedProviderId;
  readonly model: AgentModelOption;
  readonly effort: EffortChoice;
  readonly alias: string;
  readonly problem: string | null;
  readonly width: number;
  readonly height: number;
  readonly onInput: (value: string) => void;
  readonly onSubmit: (value: string) => void;
}) {
  const panelWidth = () => Math.min(76, Math.max(48, props.width - 10));
  return (
    <box
      style={{
        position: "absolute",
        left: Math.max(0, Math.floor((props.width - panelWidth()) / 2)),
        top: Math.max(1, Math.floor((props.height - 11) / 2)),
        width: panelWidth(),
        flexDirection: "column",
        backgroundColor: props.theme.surface,
        borderStyle: "rounded",
        borderColor: props.problem ? props.theme.danger : props.theme.rule,
        paddingLeft: 2,
        paddingRight: 2,
        zIndex: 13,
      }}
      title=" new agent · name "
      titleColor={props.theme.brand}
      bottomTitle=" enter create · esc back "
    >
      <text fg={props.theme.muted}>provider  →  model  →  effort  →  name</text>
      <text fg={props.theme.faint}>The name becomes the stable chat tab and MCP identity.</text>
      <text> </text>
      <box style={{ height: 1, flexDirection: "row", backgroundColor: props.theme.raised }}>
        <text fg={props.theme.brand}>{`${GLYPHS.chevron} `}</text>
        <input
          focused
          value={props.alias}
          placeholder={`${props.provider}-2`}
          onInput={props.onInput}
          onSubmit={(value) => {
            if (typeof value === "string") props.onSubmit(value);
          }}
          style={{
            flexGrow: 1,
            textColor: props.theme.text,
            cursorColor: props.theme.text,
            backgroundColor: props.theme.raised,
            focusedBackgroundColor: props.theme.raised,
          }}
        />
      </box>
      <text> </text>
      <text fg={props.problem ? props.theme.danger : props.theme.muted}>
        {props.problem ?? `${props.provider} · ${props.model.displayName} · ${props.effort ?? "default effort"}`}
      </text>
      <text fg={props.theme.faint}>Permissions default to bypass for managed team sessions.</text>
    </box>
  );
}
