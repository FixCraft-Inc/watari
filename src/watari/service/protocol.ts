import { z } from "zod";
import { QuestionResponseSchema } from "../questions.ts";

import { ActivityDetailSchema } from "../activity/schemas.ts";
import { RuntimeEventSchema, TeamSnapshotSchema } from "../state/schemas.ts";
import type { RuntimeEvent } from "../state/types.ts";
import { AGENT_ALIAS_PATTERN, isAgentAlias } from "../team/identity.ts";
import { AGENT_MODES, SUPPORTED_PROVIDERS } from "../team/roster.ts";

export const SERVICE_API_VERSION = 2 as const;

export interface ServiceInfo {
  readonly schemaVersion: 2;
  readonly pid: number;
  readonly connectedClients: number;
  readonly bridges: Readonly<Record<string, "identity-bound stdio MCP">>;
}

const AgentAliasSchema = z.string().regex(AGENT_ALIAS_PATTERN).refine(isAgentAlias);
const RequestIdSchema = z.string().min(1).max(128);
const AgentDefinitionUpdateSchema = z.object({
  alias: AgentAliasSchema,
  provider: z.enum(SUPPORTED_PROVIDERS),
  displayName: z.string().min(1).max(256),
  model: z.string().min(1).max(512).optional(),
  effort: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/u).optional(),
  mode: z.enum(AGENT_MODES),
  unrestricted: z.boolean().optional(),
});

export const NegotiationResultSchema = z.object({ apiVersion: z.literal(SERVICE_API_VERSION) });
export const ServiceInfoSchema = z.object({
  schemaVersion: z.literal(SERVICE_API_VERSION),
  pid: z.number().int().positive(),
  connectedClients: z.number().int().nonnegative(),
  bridges: z.record(z.string(), z.literal("identity-bound stdio MCP")),
});

export const ServiceCommandSchema = z.discriminatedUnion("type", [
  z.object({
    id: RequestIdSchema,
    type: z.literal("question"),
    agent: AgentAliasSchema,
    requestId: z.string().uuid(),
    response: QuestionResponseSchema,
  }),
  z.object({
    id: RequestIdSchema,
    type: z.literal("negotiate"),
    versions: z.array(z.number().int().positive()).min(1).max(16),
  }),
  z.object({ id: RequestIdSchema, type: z.literal("snapshot") }),
  z.object({ id: RequestIdSchema, type: z.literal("info") }),
  z.object({ id: RequestIdSchema, type: z.literal("activity_detail"), activityId: z.string().regex(/^act_[a-f0-9]{24}$/u) }),
  z.object({ id: RequestIdSchema, type: z.literal("ui_attach"), fresh: z.boolean() }),
  z.object({
    id: RequestIdSchema,
    type: z.literal("team_tool"),
    agent: AgentAliasSchema,
    name: z.string().min(1).max(128),
    input: z.unknown(),
  }),
  z.object({
    id: RequestIdSchema,
    type: z.literal("send"),
    target: z.union([z.literal("all"), AgentAliasSchema]),
    text: z.string().min(1).max(32_000),
  }),
  z.object({
    id: RequestIdSchema,
    type: z.literal("interrupt"),
    agent: AgentAliasSchema,
  }),
  z.object({
    id: RequestIdSchema,
    type: z.literal("approval"),
    agent: AgentAliasSchema,
    requestId: z.union([z.string(), z.number()]),
    decision: z.enum(["accept", "decline", "cancel"]),
  }),
  z.object({ id: RequestIdSchema, type: z.literal("shutdown") }),
  z.object({ id: RequestIdSchema, type: z.literal("complete_goal") }),
  z.object({ id: RequestIdSchema, type: z.literal("new_chat") }),
  z.object({ id: RequestIdSchema, type: z.literal("check_bridges") }),
  z.object({ id: RequestIdSchema, type: z.literal("provider_status"), force: z.boolean().optional() }),
  z.object({ id: RequestIdSchema, type: z.literal("agent_configure"), definition: AgentDefinitionUpdateSchema }),
  z.object({ id: RequestIdSchema, type: z.literal("agent_remove"), agent: AgentAliasSchema }),
  z.object({ id: RequestIdSchema, type: z.literal("agent_restart"), agent: AgentAliasSchema }),
  z.object({ id: RequestIdSchema, type: z.literal("agent_clear"), agent: AgentAliasSchema }),
  z.object({ id: RequestIdSchema, type: z.literal("chat_list") }),
  z.object({ id: RequestIdSchema, type: z.literal("chat_resume"), chat: z.string().min(1).max(256) }),
  z.object({ id: RequestIdSchema, type: z.literal("chat_save") }),
  z.object({
    id: RequestIdSchema,
    type: z.literal("chat_export"),
    path: z.string().min(1).max(4_096).optional(),
    handoff: z.boolean(),
    timeoutMs: z.number().int().min(1_000).max(60 * 60_000).optional(),
  }),
  z.object({ id: RequestIdSchema, type: z.literal("model_list"), agent: AgentAliasSchema }),
  z.object({
    id: RequestIdSchema,
    type: z.literal("provider_model_list"),
    provider: z.enum(SUPPORTED_PROVIDERS),
  }),
  z.object({
    id: RequestIdSchema,
    type: z.literal("bridge_connected"),
    agent: AgentAliasSchema,
    provider: AgentAliasSchema,
    /** Present only on bridges the service launched for a managed alias. */
    token: z.string().min(1).max(256).optional(),
  }),
  z.object({ id: RequestIdSchema, type: z.literal("bridge_disconnected"), agent: AgentAliasSchema }),
]);

export type ServiceCommand = z.infer<typeof ServiceCommandSchema>;

const ResponseEnvelopeSchema = z.discriminatedUnion("ok", [
  z.object({ type: z.literal("response"), id: RequestIdSchema, ok: z.literal(true), value: z.unknown().optional() }),
  z.object({ type: z.literal("response"), id: RequestIdSchema, ok: z.literal(false), error: z.string().min(1).max(64 * 1024) }),
]);

export const ServiceEnvelopeSchema = z.union([RuntimeEventSchema, ResponseEnvelopeSchema]);
export type ServiceEnvelope =
  | RuntimeEvent
  | { readonly type: "response"; readonly id: string; readonly ok: true; readonly value?: unknown }
  | { readonly type: "response"; readonly id: string; readonly ok: false; readonly error: string };

export { ActivityDetailSchema, TeamSnapshotSchema };
