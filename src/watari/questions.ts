import { z } from "zod";

import type { AgentEvent, AgentId } from "./models.ts";
import { redactSummary } from "./security/redaction.ts";

export const QuestionFieldSchema = z.object({
  id: z.string().min(1).max(256).refine((id) => !["__proto__", "prototype", "constructor"].includes(id)),
  header: z.string().max(256),
  question: z.string().min(1).max(8_000),
  options: z.array(z.object({
    label: z.string().min(1).max(512),
    description: z.string().max(2_000),
  })).max(16),
  multiSelect: z.boolean(),
  allowOther: z.boolean(),
  required: z.boolean().default(true),
});

export const PendingQuestionSchema = z.object({
  id: z.string().uuid(),
  agent: z.string().min(1).max(128),
  fields: z.array(QuestionFieldSchema).min(1).max(8),
  createdAt: z.number().nonnegative(),
  blocking: z.boolean().optional(),
});

export const QuestionResponseSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("cancel") }),
  z.object({
    action: z.literal("answer"),
    answers: z.record(z.string().min(1).max(256), z.array(z.string().min(1).max(8_000)).max(16)),
  }),
]);

export type QuestionField = z.infer<typeof QuestionFieldSchema>;
export type PendingQuestion = z.infer<typeof PendingQuestionSchema>;
export type QuestionResponse = z.infer<typeof QuestionResponseSchema>;

export function validateQuestionResponse(question: PendingQuestion, input: unknown): QuestionResponse {
  const response = QuestionResponseSchema.parse(input);
  if (JSON.stringify(response).length > 32_000) throw new Error("question answer is too long");
  if (response.action === "cancel") return response;
  if (Object.keys(response.answers).length !== question.fields.length) throw new Error("answer every question");
  for (const field of question.fields) {
    if (!Object.hasOwn(response.answers, field.id)) throw new Error("answer every question");
    const values = response.answers[field.id];
    if (!values || (field.required && !values.length) || values.some((value) => !value.trim())) throw new Error("answer every question");
    if (!field.multiSelect && values.length > 1) throw new Error("choose one answer for this question");
    if (new Set(values).size !== values.length) throw new Error("duplicate answer");
    if (!field.allowOther && values.some((value) => !field.options.some((option) => option.label === value))) {
      throw new Error("choose one of the listed options");
    }
  }
  return response;
}

/** Live native callbacks belong to the adapter. Answers never enter chat history. */
export class QuestionQueue {
  readonly #pending = new Map<string, {
    question: PendingQuestion;
    resolve: (answer: QuestionResponse) => void;
    cleanup: () => void;
    validate: ((answers: Record<string, string[]>) => unknown) | undefined;
  }>();

  constructor(
    readonly agent: AgentId,
    readonly emit: (event: AgentEvent) => void,
  ) {}

  ask(fields: readonly z.input<typeof QuestionFieldSchema>[], signal?: AbortSignal, validate?: (answers: Record<string, string[]>) => unknown, blocking = true): Promise<QuestionResponse> {
    if (signal?.aborted) return Promise.resolve({ action: "cancel" });
    if (this.#pending.size >= 16) throw new Error("too many pending questions");
    const question = PendingQuestionSchema.parse({ id: crypto.randomUUID(), agent: this.agent, fields, createdAt: Date.now(), blocking });
    if (JSON.stringify(question).length > 32_000) throw new Error("question is too long");
    if (new Set(question.fields.map((field) => field.id)).size !== fields.length) throw new Error("duplicate question id");
    for (const field of question.fields) {
      if (redactSummary(field.id) !== field.id || field.options.some((option) => redactSummary(option.label) !== option.label)) throw new Error("unsafe question identity or option value");
      if (new Set(field.options.map((option) => option.label)).size !== field.options.length) throw new Error("duplicate option label");
      field.header = redactSummary(field.header);
      field.question = redactSummary(field.question);
      for (const option of field.options) option.description = redactSummary(option.description);
    }
    return new Promise((resolve) => {
      const abort = () => this.cancel(question.id);
      this.#pending.set(question.id, {
        question, resolve, validate,
        cleanup: () => signal?.removeEventListener("abort", abort),
      });
      signal?.addEventListener("abort", abort, { once: true });
      this.emit({ agent: this.agent, kind: "question", timestamp: Date.now(), summary: "Waiting for your answer (ctrl+q)", providerEventId: question.id, payload: question });
    });
  }

  respond(id: string, input: QuestionResponse): void {
    const pending = this.#pending.get(id);
    if (!pending) throw new Error("question is no longer waiting");
    const response = validateQuestionResponse(pending.question, input);
    if (response.action === "answer") pending.validate?.(response.answers);
    this.#pending.delete(id);
    pending.cleanup();
    // Do not put answer content in events, logs, or the persisted transcript.
    this.emit({ agent: this.agent, kind: "question_resolved", timestamp: Date.now(), summary: response.action === "cancel" ? "Question cancelled" : "Question answered", providerEventId: id });
    pending.resolve(response);
  }

  cancel(id: string): void {
    if (this.#pending.has(id)) this.respond(id, { action: "cancel" });
  }

  cancelAll(): void {
    for (const id of this.#pending.keys()) this.cancel(id);
  }
}
