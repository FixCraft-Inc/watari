import {
  API_VERSION,
  type ActivityDetail,
  type ActivitySummary,
  type PersistedEvent,
  type ServiceEnvelope,
  type StatusReport,
  type TeamSnapshot,
} from "./protocol.js";

type RecordValue = Record<string, unknown>;

/** Invalid service data is a protocol failure, not partially trusted UI state. */
export class WireValidationError extends Error {
  constructor(detail: string) {
    super(`Watari sent invalid local API data: ${detail}`);
    this.name = "WireValidationError";
  }
}

export function parseServiceEnvelope(value: unknown): ServiceEnvelope {
  const envelope = record(value, "envelope");
  const type = string(envelope.type, "envelope.type");
  if (type === "response") {
    string(envelope.id, "response.id");
    if (typeof envelope.ok !== "boolean") fail("response.ok must be a boolean");
    if (!envelope.ok) string(envelope.error, "response.error");
    return envelope as unknown as ServiceEnvelope;
  }
  if (type === "snapshot" || type === "state_changed") {
    parseTeamSnapshot(envelope.snapshot);
  } else if (type === "transcript_upsert") {
    parsePersistedEvent(envelope.event);
  } else if (type === "activity_upsert") {
    parseActivitySummary(envelope.activity);
  } else if (type === "activity_detail_changed") {
    string(envelope.activityId, "activity detail id");
    nonnegativeInteger(envelope.revision, "activity revision");
  } else if (type === "fatal") {
    string(envelope.message, "fatal message");
  } else {
    fail(`unknown envelope type ${JSON.stringify(type)}`);
  }
  return envelope as unknown as ServiceEnvelope;
}

export function parseTeamSnapshot(value: unknown): TeamSnapshot {
  const snapshot = record(value, "snapshot");
  if (snapshot.schemaVersion !== API_VERSION) fail(`snapshot schemaVersion must be ${API_VERSION}`);
  array(snapshot.agents, "snapshot.agents").forEach((agent, index) => {
    const item = record(agent, `agent ${index}`);
    strings(item, ["id", "backend", "displayName"]);
    oneOf(item.state, ["starting", "ready", "busy", "waiting", "failed", "stopped"], "agent.state");
    nullableString(item.sessionId, "agent.sessionId");
    nullableString(item.currentGoalId, "agent.currentGoalId");
    nullableString(item.detail, "agent.detail");
    finiteNumber(item.updatedAt, "agent.updatedAt");
    optionalString(item.provider, "agent.provider");
    optionalNullableString(item.model, "agent.model");
    optionalNullableString(item.effort, "agent.effort");
    if (item.mode !== undefined) oneOf(item.mode, ["managed", "external"], "agent.mode");
    if (item.unrestricted !== undefined && typeof item.unrestricted !== "boolean") {
      fail("agent.unrestricted must be a boolean");
    }
  });
  if (snapshot.activeGoal !== null) parseGoal(snapshot.activeGoal);
  array(snapshot.messages, "snapshot.messages").forEach(parseMessage);
  array(snapshot.claims, "snapshot.claims").forEach(parseClaim);
  array(snapshot.findings, "snapshot.findings").forEach(parseFinding);
  array(snapshot.events, "snapshot.events").forEach(parsePersistedEvent);
  array(snapshot.activities, "snapshot.activities").forEach(parseActivitySummary);
  if (snapshot.bridges !== undefined) {
    array(snapshot.bridges, "snapshot.bridges").forEach((bridge) => {
      const item = record(bridge, "bridge");
      strings(item, ["agent", "detail"]);
      oneOf(item.state, ["unknown", "checking", "ready", "failed"], "bridge.state");
    });
  }
  return snapshot as unknown as TeamSnapshot;
}

export function parseActivityDetail(value: unknown): ActivityDetail | null {
  if (value === null) return null;
  const detail = record(value, "activity detail");
  parseRetention(detail.retention);
  if (detail.kind === "command") {
    strings(detail, ["command", "stdout", "stderr"]);
    nullableString(detail.cwd, "command.cwd");
    oneOf(detail.outputMode, ["split", "combined"], "command.outputMode");
    nullableInteger(detail.exitCode, "command.exitCode");
    nullableNonnegativeNumber(detail.durationMs, "command.durationMs");
    if (typeof detail.interrupted !== "boolean") fail("command.interrupted must be a boolean");
  } else if (detail.kind === "file_change") {
    array(detail.files, "file change files").forEach((file) => {
      const item = record(file, "changed file");
      strings(item, ["path", "diff"]);
      oneOf(item.kind, ["add", "update", "delete", "move", "unknown"], "changed file kind");
      nonnegativeInteger(item.additions, "changed file additions");
      nonnegativeInteger(item.deletions, "changed file deletions");
      parseRetention(item.retention);
    });
  } else {
    fail("activity detail kind is unknown");
  }
  return detail as unknown as ActivityDetail;
}

export function parseStatusReport(value: unknown): StatusReport {
  const report = record(value, "status report");
  if (report.command !== "status") fail("status command is missing");
  string(report.stateDirectory, "status stateDirectory");
  if (typeof report.ok !== "boolean") fail("status ok must be a boolean");
  const service = record(report.service, "status service");
  oneOf(service.state, ["running", "stopped", "incompatible"], "service.state");
  nullablePositiveInteger(service.pid, "service.pid");
  nonnegativeInteger(service.connectedClients, "service.connectedClients");
  string(service.socketPath, "service.socketPath");
  nullablePositiveInteger(service.apiVersion, "service.apiVersion");
  const expected = service.expectedApiVersion ?? service.apiVersion ?? API_VERSION;
  positiveInteger(expected, "service.expectedApiVersion");
  if (service.detail !== undefined) nullableString(service.detail, "service.detail");
  return {
    command: "status",
    stateDirectory: report.stateDirectory as string,
    service: {
      state: service.state as StatusReport["service"]["state"],
      pid: service.pid as number | null,
      connectedClients: service.connectedClients as number,
      socketPath: service.socketPath as string,
      apiVersion: service.apiVersion as number | null,
      expectedApiVersion: expected as number,
      detail: (service.detail ?? null) as string | null,
    },
    ok: report.ok as boolean,
  };
}

export function parseNegotiation(value: unknown): number {
  const result = record(value, "negotiation response");
  return positiveInteger(result.apiVersion, "negotiated apiVersion");
}

function parseGoal(value: unknown): void {
  const item = record(value, "goal");
  strings(item, ["id", "instruction", "origin"]);
  nullableString(item.initialAddressee, "goal.initialAddressee");
  oneOf(item.state, ["active", "complete", "cancelled"], "goal.state");
  finiteNumber(item.createdAt, "goal.createdAt");
  finiteNumber(item.updatedAt, "goal.updatedAt");
}

function parseMessage(value: unknown): void {
  const item = record(value, "message");
  nonnegativeInteger(item.id, "message.id");
  nullableString(item.goalId, "message.goalId");
  strings(item, ["sender", "body"]);
  stringArray(item.recipients, "message.recipients");
  oneOf(item.kind, ["user", "peer", "system", "goal", "review"], "message.kind");
  oneOf(item.priority, ["normal", "urgent", "stop"], "message.priority");
  nullableString(item.priorityReason, "message.priorityReason");
  finiteNumber(item.createdAt, "message.createdAt");
}

function parseClaim(value: unknown): void {
  const item = record(value, "claim");
  strings(item, ["id", "goalId", "claimant", "summary"]);
  stringArray(item.paths, "claim.paths");
  oneOf(item.state, ["proposed", "active", "contested", "released", "superseded"], "claim.state");
  nullableString(item.note, "claim.note");
  finiteNumber(item.createdAt, "claim.createdAt");
  finiteNumber(item.updatedAt, "claim.updatedAt");
}

function parseFinding(value: unknown): void {
  const item = record(value, "finding");
  strings(item, ["id", "author", "summary"]);
  nullableString(item.target, "finding.target");
  nullableString(item.scope, "finding.scope");
  nullableString(item.evidence, "finding.evidence");
  oneOf(item.severity, ["info", "low", "medium", "high", "critical"], "finding.severity");
  oneOf(item.disposition, ["open", "resolved", "accepted", "dismissed"], "finding.disposition");
  finiteNumber(item.createdAt, "finding.createdAt");
  finiteNumber(item.updatedAt, "finding.updatedAt");
}

function parsePersistedEvent(value: unknown): asserts value is PersistedEvent {
  const item = record(value, "event");
  nonnegativeInteger(item.id, "event.id");
  nullableString(item.agent, "event.agent");
  strings(item, ["type", "summary"]);
  nullableString(item.providerEventId, "event.providerEventId");
  finiteNumber(item.createdAt, "event.createdAt");
}

function parseActivitySummary(value: unknown): asserts value is ActivitySummary {
  const item = record(value, "activity");
  strings(item, ["id", "agent", "title", "preview", "providerEventId"]);
  oneOf(item.kind, ["command", "file_change"], "activity.kind");
  oneOf(item.state, ["running", "completed", "failed", "interrupted"], "activity.state");
  positiveInteger(item.revision, "activity.revision");
  finiteNumber(item.startedAt, "activity.startedAt");
  finiteNumber(item.updatedAt, "activity.updatedAt");
  if (typeof item.hasDetail !== "boolean") fail("activity.hasDetail must be a boolean");
}

function parseRetention(value: unknown): void {
  const item = record(value, "retention");
  if (typeof item.truncated !== "boolean") fail("retention.truncated must be a boolean");
  nonnegativeInteger(item.omittedBytes, "retention.omittedBytes");
  nonnegativeInteger(item.omittedLines, "retention.omittedLines");
}

function record(value: unknown, label: string): RecordValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(`${label} must be an object`);
  return value as RecordValue;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  return value;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string") fail(`${label} must be a string`);
  return value;
}

function strings(item: RecordValue, keys: readonly string[]): void {
  for (const key of keys) string(item[key], key);
}

function stringArray(value: unknown, label: string): void {
  array(value, label).forEach((entry) => string(entry, `${label} entry`));
}

function optionalString(value: unknown, label: string): void {
  if (value !== undefined) string(value, label);
}

function nullableString(value: unknown, label: string): void {
  if (value !== null) string(value, label);
}

function optionalNullableString(value: unknown, label: string): void {
  if (value !== undefined) nullableString(value, label);
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(`${label} must be a finite number`);
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  const number = finiteNumber(value, label);
  if (!Number.isSafeInteger(number) || number < 1) fail(`${label} must be a positive integer`);
  return number;
}

function nonnegativeInteger(value: unknown, label: string): number {
  const number = finiteNumber(value, label);
  if (!Number.isSafeInteger(number) || number < 0) fail(`${label} must be a non-negative integer`);
  return number;
}

function nullablePositiveInteger(value: unknown, label: string): void {
  if (value !== null) positiveInteger(value, label);
}

function nullableInteger(value: unknown, label: string): void {
  if (value === null) return;
  const number = finiteNumber(value, label);
  if (!Number.isSafeInteger(number)) fail(`${label} must be an integer`);
}

function nullableNonnegativeNumber(value: unknown, label: string): void {
  if (value === null) return;
  const number = finiteNumber(value, label);
  if (number < 0) fail(`${label} must be non-negative`);
}

function oneOf(value: unknown, values: readonly string[], label: string): void {
  if (typeof value !== "string" || !values.includes(value)) fail(`${label} is invalid`);
}

function fail(detail: string): never {
  throw new WireValidationError(detail);
}
