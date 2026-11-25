import type { AgentId } from "../models.ts";
import { z } from "zod";
import type { RequestPermissionRequest, RequestPermissionResponse } from "@agentclientprotocol/sdk";
import { QuestionFieldSchema, type QuestionResponse } from "../questions.ts";
import { TEAM_INSTRUCTIONS } from "../team/instructions.ts";
import {
  AcpAdapter,
  type AcpAdapterOptions,
  type AcpHarness,
  type AcpLaunch,
  type AcpPosture,
} from "./acp.ts";

export type QwenAdapterOptions = AcpAdapterOptions;

/**
 * The client request Qwen Code sends after each tool run, and when its todo
 * guard would keep a turn going, to collect messages queued while it works.
 * It waits two seconds for the answer, stops asking after three late ones, and
 * never asks again in that session a client that does not know the method.
 */
export const QWEN_MID_TURN_INBOX = "craft/drainMidTurnQueue";

/**
 * Asks a working Qwen Code to collect queued user input now. Mid-response it
 * stops the response and continues with the input; during a tool run it takes
 * the input when the run ends.
 */
export const QWEN_MID_TURN_SEND_NOW = "craft/midTurnSendNow";

/**
 * Qwen Code over its ACP stdio server (`qwen --acp`).
 *
 * Qwen builds every ACP session from its own command line, so the team
 * instructions go in as `--append-system-prompt` and survive compaction and
 * resume, and the permission posture is chosen with `--approval-mode`. Its
 * default mode, `auto`, asks a model classifier about each tool call, which
 * costs a model call per tool and blocks calls with nobody there to unblock
 * them. A team session is either `yolo` (unrestricted) or `default`, where
 * Watari's approval strip answers. Resuming a saved session restores the
 * approval mode that session last ran in over the command line, so the same
 * mode is also set on the session itself. Read-only probes use `plan` and
 * record no chat, so discovering the catalog leaves nothing in Qwen's session
 * history.
 */
export const QWEN_HARNESS: AcpHarness = {
  permissionQuestion: qwenPermissionQuestion,
  name: "Qwen Code",
  defaultAgent: "qwen" as AgentId,
  midTurnInbox: QWEN_MID_TURN_INBOX,
  midTurnSendNow: QWEN_MID_TURN_SEND_NOW,
  launch(_project, posture): AcpLaunch {
    const mode = qwenApprovalMode(posture);
    const args = ["--acp", "--approval-mode", mode];
    if (posture.readOnlyProbe) args.push("--chat-recording=false");
    if (posture.team) args.push("--append-system-prompt", TEAM_INSTRUCTIONS);
    return { args, env: {}, systemInstructions: posture.team, sessionMode: mode };
  },
};

/** Qwen Code 0.27's native AskUserQuestion contract, including its legacy identity. */
export function qwenPermissionQuestion(request: RequestPermissionRequest) {
  const tool = request.toolCall;
  const meta = tool._meta;
  const canonical = meta?.qwenInteractionKind === "user_question";
  const legacy = meta?.toolName === "ask_user_question" || String(tool.kind) === "ask_user_question";
  if (!canonical && !legacy) return null;
  const rawInput = z.object({ questions: z.unknown() }).safeParse(tool.rawInput);
  const raw = canonical ? meta?.qwenQuestions : rawInput.success ? rawInput.data.questions : undefined;
  const questions = z.array(z.object({
    header: z.string().min(1).max(256), question: z.string().min(1).max(8_000),
    options: z.array(z.object({ label: z.string().min(1).max(512), description: z.string().max(2_000).default("") })).min(2).max(4),
    multiSelect: z.boolean().default(false),
  })).min(1).max(4).parse(raw);
  const allowed = request.options.find((option) => option.kind === "allow_once");
  if (!allowed) throw new Error("Qwen offered no single-use question response");
  return {
    fields: questions.map((question, index) => QuestionFieldSchema.parse({ ...question, id: String(index), allowOther: true })),
    respond(response: QuestionResponse): RequestPermissionResponse & { answers?: Record<string, string> } {
      if (response.action === "cancel") return { outcome: { outcome: "cancelled" } };
      return {
        outcome: { outcome: "selected", optionId: allowed.optionId },
        // Qwen consumes answers on the response root, keyed by question index.
        answers: Object.fromEntries(Object.entries(response.answers).map(([key, values]) => [key, values.join(", ")])),
      };
    },
  };
}

export function qwenApprovalMode(posture: AcpPosture): "plan" | "yolo" | "default" {
  if (posture.readOnlyProbe) return "plan";
  return posture.unrestricted ? "yolo" : "default";
}

/** A contained Qwen Code client. Its model catalog is the session's own. */
export class QwenAdapter extends AcpAdapter {
  constructor(options: QwenAdapterOptions) {
    super(QWEN_HARNESS, options);
  }
}
