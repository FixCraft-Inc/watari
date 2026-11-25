import { describe, expect, test } from "bun:test";
import type { Options, WarmQuery } from "@anthropic-ai/claude-agent-sdk";

import { QuestionQueue, type PendingQuestion } from "../src/watari/questions.ts";
import { compileQuestionForm } from "../src/watari/question-form.ts";
import { ClaudeAdapter } from "../src/watari/agents/claude.ts";
import { CodexAdapter } from "../src/watari/agents/codex.ts";
import { OpenCodeAdapter } from "../src/watari/agents/opencode.ts";
import { QwenAdapter } from "../src/watari/agents/qwen.ts";
import { resolveProjectContext } from "../src/watari/project/checkout.ts";
import type { AgentEvent } from "../src/watari/models.ts";

const field = { id: "scope", header: "Scope", question: "Which scope?", options: [{ label: "Core", description: "Core only" }], multiSelect: false, allowOther: true };
const project = resolveProjectContext(".");
async function until(predicate: () => boolean) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await Bun.sleep(5); }
  throw new Error("fixture did not reach expected state");
}

describe("native questions (simulated providers only)", () => {
  test("invalid answers do not settle a request, aborts do, and stale answers are refused", async () => {
    const events: AgentEvent[] = [];
    const queue = new QuestionQueue("astra", (event) => events.push(event));
    const abort = new AbortController();
    const first = queue.ask([field], abort.signal);
    const id = events[0]!.providerEventId!;
    expect(() => queue.respond(id, { action: "answer", answers: {} })).toThrow("answer every question");
    const second = queue.ask([field]);
    const secondId = events.at(-1)!.providerEventId!;
    abort.abort();
    expect(await first).toEqual({ action: "cancel" });
    expect(() => queue.respond(id, { action: "answer", answers: { scope: ["All"] } })).toThrow("no longer waiting");
    queue.respond(secondId, { action: "answer", answers: { scope: ["unlogged private answer"] } });
    expect(await second).toEqual({ action: "answer", answers: { scope: ["unlogged private answer"] } });
    expect(JSON.stringify(events)).not.toContain("unlogged private answer");
  });

  test("flat forms preserve scalar types and optional fields, enforce bounds, and reject secret/pattern inputs", () => {
    const form = compileQuestionForm({ type: "object", properties: {
      count: { type: "integer", minimum: 1, maximum: 4 }, flag: { type: "boolean" }, note: { type: "string" },
    }, required: ["count", "flag"] }, "Confirm limits");
    expect(form.decode({ count: ["2"], flag: ["false"], note: [] })).toEqual({ count: 2, flag: false });
    expect(() => form.decode({ count: ["9"], flag: ["false"] })).toThrow("bounds");
    expect(() => compileQuestionForm({ type: "object", properties: { api_key: { type: "string" } } }, "")).toThrow("secure input");
    expect(() => compileQuestionForm({ type: "object", properties: { value: { type: "string", pattern: "(a+)+" } } }, "")).toThrow();
    expect(() => compileQuestionForm({ type: "object", properties: { value: { type: "integer", multipleOf: 2 } } }, "")).toThrow();
  });

  test("question display strips terminal controls and credentials without changing native answer identities", async () => {
    const events: AgentEvent[] = [];
    const queue = new QuestionQueue("astra", (event) => events.push(event));
    const pending = queue.ask([{ ...field, question: "\u001b[2J api_key=synthetic-sensitive-value" }]);
    const question = events[0]!.payload as PendingQuestion;
    expect(question.fields[0]!.question).not.toContain("\u001b");
    expect(question.fields[0]!.question).not.toContain("synthetic-sensitive-value");
    expect(() => queue.ask([{ ...field, options: [{ label: "\u001b[2J unsafe", description: "" }] }])).toThrow("unsafe question");
    queue.cancelAll();
    expect(await pending).toEqual({ action: "cancel" });
  });

  test("Claude bypass permissions still renders AskUserQuestion and maps answers to updatedInput", async () => {
    let sdkOptions: Options | undefined;
    const adapter = new ClaudeAdapter({ executable: "/fake/never-spawned", unrestricted: true,
      sdkStartup: async (args) => {
        sdkOptions = args?.options;
        return { close() {}, async [Symbol.asyncDispose]() {}, query() { throw new Error("no model turns allowed"); } } as WarmQuery;
      },
    });
    const events: AgentEvent[] = [];
    const collector = (async () => { for await (const event of adapter.events()) events.push(event); })();
    try {
      await adapter.start(project);
      expect(sdkOptions?.permissionMode).toBe("bypassPermissions");
      expect(sdkOptions?.allowDangerouslySkipPermissions).toBe(true);
      const signal = new AbortController();
      const nativeInput = { questions: [{ question: "Which scope?", header: "Scope", options: field.options, multiSelect: true }] };
      expect(sdkOptions!.canUseTool).toBeUndefined();
      const matcher = sdkOptions!.hooks!.PreToolUse![0]!;
      expect(matcher).toMatchObject({ matcher: "AskUserQuestion", onFailure: "block" });
      const hook = matcher.hooks[0]!;
      const hookInput = {
        hook_event_name: "PreToolUse" as const, session_id: "fixture", transcript_path: "/tmp/fixture",
        cwd: "/tmp", tool_name: "AskUserQuestion", tool_input: nativeInput, tool_use_id: "tool-question",
      };
      const pending = hook(hookInput, "tool-question", { signal: signal.signal });
      await until(() => events.some((event) => event.kind === "question"));
      const question = events.find((event) => event.kind === "question")!.payload as PendingQuestion;
      expect(events.some((event) => event.kind === "approval")).toBe(false);
      await adapter.send({ kind: "question_response", requestId: question.id, response: { action: "answer", answers: { q0: ["Core", "Custom"] } } });
      expect(await pending).toEqual({ hookSpecificOutput: {
        hookEventName: "PreToolUse", permissionDecision: "allow",
        updatedInput: { ...nativeInput, answers: { "Which scope?": "Core, Custom" } },
      } });
      expect(await hook({ ...hookInput, tool_name: "Bash", tool_input: { command: "true" } }, "ordinary-tool", { signal: signal.signal })).toEqual({});
      const cancelled = hook(hookInput, "aborted-question", { signal: signal.signal });
      signal.abort();
      expect(await cancelled).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
      expect(await hook({ ...hookInput, tool_input: null }, "malformed-question", { signal: signal.signal }))
        .toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
    } finally { await adapter.stop(); await collector; }
  });

  for (const mode of ["question", "question-resolved", "question-secret"]) {
    test(`Codex ${mode} preserves numeric ID zero and never invents a choice`, async () => {
      const previous = process.env.WATARI_FAKE_MODE;
      process.env.WATARI_FAKE_MODE = mode;
      const adapter = new CodexAdapter({ executable: process.execPath, commandPrefix: [process.execPath, `${import.meta.dir}/fakes/fake-codex.ts`], unrestricted: true });
      const events: AgentEvent[] = [];
      const collector = (async () => { for await (const event of adapter.events()) events.push(event); })();
      try {
        await adapter.start(project);
        await adapter.send({ kind: "message", text: "fixture only" });
        if (mode === "question-secret") {
          await until(() => events.some((event) => event.rawType === "watari/test/question-response"));
          expect(events.some((event) => event.kind === "question")).toBe(false);
          expect(events.some((event) => event.kind === "warning" && event.rawType === "question_unsupported")).toBe(true);
        } else {
          await until(() => events.some((event) => event.kind === "question"));
          const question = events.find((event) => event.kind === "question")!.payload as PendingQuestion;
          expect(events.some((event) => event.rawType === "watari/test/question-response")).toBe(false);
          if (mode === "question-resolved") {
            await until(() => events.some((event) => event.kind === "question_resolved"));
            await expect(adapter.send({ kind: "question_response", requestId: question.id, response: { action: "cancel" } })).rejects.toThrow("no longer waiting");
          } else {
            await adapter.send({ kind: "question_response", requestId: question.id, response: { action: "answer", answers: { scope: ["All"] } } });
            await until(() => events.some((event) => event.rawType === "watari/test/question-response"));
            expect(events.find((event) => event.rawType === "watari/test/question-response")!.payload).toEqual({ nativeId: 0, result: { answers: { scope: { answers: ["All"] } } } });
          }
        }
      } finally { await adapter.stop(); await collector; if (previous === undefined) delete process.env.WATARI_FAKE_MODE; else process.env.WATARI_FAKE_MODE = previous; }
    });
  }

  for (const Adapter of [OpenCodeAdapter, QwenAdapter]) {
    test(`${Adapter.name} ACP forms wait for a user answer even under full access`, async () => {
      const previous = process.env.WATARI_FAKE_MODE;
      process.env.WATARI_FAKE_MODE = "question";
      const adapter = new Adapter({ executable: process.execPath, commandPrefix: [process.execPath, `${import.meta.dir}/fakes/fake-opencode.ts`], unrestricted: true });
      const events: AgentEvent[] = [];
      const collector = (async () => { for await (const event of adapter.events()) events.push(event); })();
      try {
        await adapter.start(project);
        await adapter.send({ kind: "message", text: "fixture only" });
        await until(() => events.some((event) => event.kind === "question"));
        expect(events.some((event) => event.kind === "approval")).toBe(false);
        const question = events.find((event) => event.kind === "question")!.payload as PendingQuestion;
        await adapter.send({ kind: "question_response", requestId: question.id, response: { action: "answer", answers: { scope: ["Core"] } } });
        await until(() => events.some((event) => event.summary.includes("questionResult")));
        expect(events.find((event) => event.summary.includes("questionResult"))!.summary).toContain('"content":{"scope":"Core"}');
      } finally { await adapter.stop(); await collector; if (previous === undefined) delete process.env.WATARI_FAKE_MODE; else process.env.WATARI_FAKE_MODE = previous; }
    });
  }

  for (const mode of ["qwen-question", "qwen-question-malformed"]) {
    test(`Qwen ${mode} uses its real question metadata instead of full-access auto-allow`, async () => {
      const previous = process.env.WATARI_FAKE_MODE;
      process.env.WATARI_FAKE_MODE = mode;
      const adapter = new QwenAdapter({ executable: process.execPath, commandPrefix: [process.execPath, `${import.meta.dir}/fakes/fake-opencode.ts`], unrestricted: true });
      const events: AgentEvent[] = [];
      const collector = (async () => { for await (const event of adapter.events()) events.push(event); })();
      try {
        await adapter.start(project);
        await adapter.send({ kind: "message", text: "fixture only" });
        if (mode === "qwen-question") {
          await until(() => events.some((event) => event.kind === "question"));
          expect(events.some((event) => event.summary.includes("questionResult"))).toBe(false);
          const question = events.find((event) => event.kind === "question")!.payload as PendingQuestion;
          await adapter.send({ kind: "question_response", requestId: question.id, response: { action: "answer", answers: { "0": ["Core", "Tests"] } } });
          await until(() => events.some((event) => event.summary.includes("questionResult")));
          expect(events.find((event) => event.summary.includes("questionResult"))!.summary).toContain('"optionId":"proceed_once"');
          expect(events.find((event) => event.summary.includes("questionResult"))!.summary).toContain('"answers":{"0":"Core, Tests"}');
        } else {
          await until(() => events.some((event) => event.summary.includes("questionResult")));
          expect(events.some((event) => event.kind === "question")).toBe(false);
          expect(events.find((event) => event.summary.includes("questionResult"))!.summary).toContain('"outcome":"cancelled"');
        }
        expect(events.some((event) => event.kind === "approval")).toBe(false);
      } finally { await adapter.stop(); await collector; if (previous === undefined) delete process.env.WATARI_FAKE_MODE; else process.env.WATARI_FAKE_MODE = previous; }
    });
  }
});
