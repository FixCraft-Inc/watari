import { useKeyboard } from "@opentui/solid";
import { For, Show, createEffect, createMemo, createSignal } from "solid-js";

import type { PendingQuestion, QuestionField, QuestionResponse } from "../questions.ts";
import type { Theme } from "./theme.ts";

export function questionValues(field: QuestionField, text: string): string[] {
  const value = text.trim();
  if (!value && !field.required) return [];
  if (!value) throw new Error("Enter an answer first");
  if (field.options.length && /^\d+(\s*,\s*\d+)*$/u.test(value)) {
    const indices = value.split(",").map((index) => Number(index.trim()) - 1);
    if ((!field.multiSelect && indices.length > 1) || indices.some((index) => !field.options[index])) throw new Error("Choose a listed option number");
    return indices.map((index) => field.options[index]!.label);
  }
  if (!field.allowOther && !field.options.some((option) => option.label === value)) throw new Error("Choose a listed option number");
  return [value];
}

/** Mounted while the app lives so hiding the panel preserves its answer draft. */
export function QuestionOverlay(props: {
  readonly open: boolean;
  readonly questions: readonly PendingQuestion[];
  readonly theme: Theme;
  readonly width: number;
  readonly height: number;
  readonly close: () => void;
  readonly answer: (question: PendingQuestion, response: QuestionResponse) => Promise<void>;
}) {
  const [selected, setSelected] = createSignal(0);
  const [drafts, setDrafts] = createSignal<Record<string, { index: number; values: Record<string, string> }>>({});
  const [problem, setProblem] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  createEffect(() => {
    const ids = new Set(props.questions.map((question) => question.id));
    setDrafts((all) => Object.fromEntries(Object.entries(all).filter(([id]) => ids.has(id))));
  });
  const question = createMemo(() => props.questions[selected() % Math.max(1, props.questions.length)]);
  const draft = () => drafts()[question()?.id ?? ""] ?? { index: 0, values: {} };
  const field = () => question()?.fields[draft().index];
  const update = (text: string) => {
    const current = question();
    const active = field();
    if (!current || !active) return;
    setDrafts((all) => ({ ...all, [current.id]: { ...draft(), values: { ...draft().values, [active.id]: text } } }));
    setProblem("");
  };
  const send = async (response: QuestionResponse) => {
    const current = question();
    if (!current || busy()) return;
    setBusy(true);
    try {
      await props.answer(current, response);
      setDrafts((all) => { const copy = { ...all }; delete copy[current.id]; return copy; });
      setProblem("");
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "Could not send the answer");
    } finally { setBusy(false); }
  };
  const submit = (text: string) => {
    const current = question();
    const active = field();
    if (!current || !active || busy()) return;
    try {
      questionValues(active, text);
      update(text);
      if (draft().index < current.fields.length - 1) {
        setDrafts((all) => ({ ...all, [current.id]: { ...draft(), index: draft().index + 1 } }));
      } else {
        const answers = Object.fromEntries(current.fields.map((item) => [item.id, questionValues(item, draft().values[item.id] ?? "")]));
        void send({ action: "answer", answers });
      }
    } catch (error) { setProblem(error instanceof Error ? error.message : "Invalid answer"); }
  };
  useKeyboard((key) => {
    if (!props.open) return;
    if (key.name === "escape" || (key.ctrl && ["c", "q"].includes(key.name))) {
      key.preventDefault(); key.stopPropagation(); props.close(); return;
    }
    if (key.ctrl && ["x", "n", "b"].includes(key.name)) {
      key.preventDefault(); key.stopPropagation();
      if (busy()) return;
      setProblem("");
      if (key.name === "x") void send({ action: "cancel" });
      else if (key.name === "n") setSelected((index) => (index + 1) % Math.max(1, props.questions.length));
      else {
        const current = question();
        if (current) setDrafts((all) => ({ ...all, [current.id]: { ...draft(), index: Math.max(0, draft().index - 1) } }));
      }
    }
  });
  const panelWidth = () => Math.max(20, Math.min(90, props.width - 2));
  return (
    <Show when={props.open}>
      <box border title={` questions · ${question()?.agent ?? "none"} · ${props.questions.length} waiting `}
        style={{ position: "absolute", left: Math.max(0, Math.floor((props.width - panelWidth()) / 2)), top: 1,
          width: panelWidth(), height: Math.max(8, props.height - 2), flexDirection: "column",
          backgroundColor: props.theme.surface, borderStyle: "rounded", borderColor: props.theme.brand,
          paddingLeft: 1, paddingRight: 1, zIndex: 20 }}>
        <Show when={question() && field()} fallback={<text fg={props.theme.muted}>No questions waiting. Esc closes this panel.</text>}>
          <scrollbox style={{ flexGrow: 1, minHeight: 1 }}>
            <text fg={props.theme.brand}>{`${draft().index + 1}/${question()!.fields.length} · ${field()!.header}`}</text>
            <text fg={props.theme.text}>{field()!.question}</text>
            <For each={field()!.options}>{(option, index) => (
              <text fg={props.theme.muted}>{`${index() + 1}. ${option.label}${option.description ? ` — ${option.description}` : ""}`}</text>
            )}</For>
          </scrollbox>
          <text fg={props.theme.faint}>{field()!.options.length ? field()!.multiSelect ? "Option numbers separated by commas" : "Option number" : "Type your answer"}{field()!.options.length && field()!.allowOther ? " or your own text" : ""}{!field()!.required ? " · blank skips" : ""}</text>
          <input focused={!busy()} value={draft().values[field()!.id] ?? ""} onInput={update}
            onSubmit={(value) => { if (typeof value === "string") submit(value); }} maxLength={8_000}
            placeholder="Your answer" style={{ textColor: props.theme.text, backgroundColor: props.theme.raised, focusedBackgroundColor: props.theme.raised, cursorColor: props.theme.text }} />
          <text fg={props.theme.danger}>{problem() || " "}</text>
          <text fg={props.theme.faint}>{busy() ? "Sending response…" : `enter ${draft().index === question()!.fields.length - 1 ? "send" : "next field"} · ctrl+b back · ctrl+n next request`}</text>
          <text fg={props.theme.faint}>ctrl+x cancels question · esc closes panel</text>
        </Show>
      </box>
    </Show>
  );
}
