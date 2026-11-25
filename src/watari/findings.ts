import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { ProjectContext } from "./models.ts";
import { RuntimeClient } from "./service/client.ts";
import { resolveStateLocation } from "./state/location.ts";
import type { TeamFinding, TeamGoal } from "./state/types.ts";

export interface FindingsResult {
  /** Where the findings came from: the live chat, an archived one, or nowhere. */
  readonly source: "service" | "archive" | "none";
  /** The archive file, when the findings came from one. */
  readonly archive: string | null;
  readonly goal: Pick<TeamGoal, "id" | "instruction"> | null;
  readonly findings: readonly TeamFinding[];
}

/**
 * The team's findings for a checkout, from wherever they still are.
 *
 * A review usually ends with the user closing the UI, after which the service
 * archives the chat and exits. The live chat is asked first, and when it has
 * no findings the newest archived chat that has some answers instead, so the
 * result of the last review is still one command away.
 */
export async function loadFindings(project: ProjectContext): Promise<FindingsResult> {
  const location = resolveStateLocation(project);
  const live = await liveFindings(location.socketPath);
  if (live && live.findings.length > 0) return live;
  return newestArchivedFindings(location.chatsDirectory) ?? {
    source: "none",
    archive: null,
    goal: live?.goal ?? null,
    findings: [],
  };
}

async function liveFindings(socketPath: string): Promise<FindingsResult | null> {
  let client: RuntimeClient | null = null;
  try {
    client = await RuntimeClient.connect(socketPath);
    const snapshot = await client.refresh();
    return {
      source: "service",
      archive: null,
      goal: snapshot.activeGoal,
      findings: snapshot.findings,
    };
  } catch {
    return null;
  } finally {
    client?.close();
  }
}

function newestArchivedFindings(directory: string): FindingsResult | null {
  let names: string[];
  try {
    names = readdirSync(directory).filter((name) => name.endsWith(".json"));
  } catch {
    return null;
  }
  // Archive names start with an ISO timestamp, so name order is age order.
  for (const name of names.sort().reverse()) {
    const path = join(directory, name);
    const archived = readArchive(path);
    if (archived && archived.findings.length > 0) {
      return { source: "archive", archive: path, ...archived };
    }
  }
  return null;
}

/** Reads only what the report needs, so an archive from an older build still counts. */
function readArchive(path: string): Pick<FindingsResult, "goal" | "findings"> | null {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  if (!isRecord(value) || !Array.isArray(value.findings)) return null;
  const findings = value.findings.filter(isFinding);
  const goal = isRecord(value.activeGoal) &&
      typeof value.activeGoal.id === "string" &&
      typeof value.activeGoal.instruction === "string"
    ? { id: value.activeGoal.id, instruction: value.activeGoal.instruction }
    : null;
  return { goal, findings };
}

function isFinding(value: unknown): value is TeamFinding {
  return isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.author === "string" &&
    typeof value.severity === "string" &&
    typeof value.summary === "string" &&
    typeof value.disposition === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
