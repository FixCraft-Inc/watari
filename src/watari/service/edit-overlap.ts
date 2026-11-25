import { isAbsolute, relative, sep } from "node:path";

import type { AgentId } from "../models.ts";
import { pathsOverlap } from "../state/store.ts";
import type { TeamClaim } from "../state/types.ts";

/** One peer changed a file another live peer claimed or already changed. */
export interface EditOverlap {
  readonly path: string;
  readonly editor: AgentId;
  readonly other: AgentId;
  /** The other peer's claim covering the path, when that is why it overlaps. */
  readonly claim: Pick<TeamClaim, "id" | "summary"> | null;
}

/**
 * Notices two peers changing the same file within one goal.
 *
 * Claims are advisory: a peer can forget to claim, claim too narrowly, or edit
 * outside its claim. Watari sees every completed edit through the providers'
 * own file-change events, so it can tell both peers the moment their work
 * collides instead of leaving them to find out from a broken diff. It records
 * paths only, and says nothing about whose change is right.
 */
export class EditOverlapWatch {
  readonly #root: string;
  /** Repository-relative path to the peers that changed it during the goal. */
  readonly #editors = new Map<string, Set<AgentId>>();
  readonly #reported = new Set<string>();
  #goalId: string | null = null;

  constructor(root: string) {
    this.#root = root;
  }

  /**
   * Records `editor`'s completed changes and returns the overlaps not reported
   * before. `claims` are the goal's open claims and `live` the peers that can
   * still act on a notice.
   */
  record(input: {
    readonly goalId: string;
    readonly editor: AgentId;
    readonly paths: readonly string[];
    readonly claims: readonly TeamClaim[];
    readonly live: ReadonlySet<AgentId>;
  }): EditOverlap[] {
    if (input.goalId !== this.#goalId) this.reset(input.goalId);
    const overlaps: EditOverlap[] = [];
    for (const path of new Set(input.paths.map((raw) => this.#relative(raw)).filter(isPresent))) {
      const others = new Map<AgentId, EditOverlap["claim"]>();
      for (const claim of input.claims) {
        if (claim.claimant === input.editor || claim.paths.length === 0) continue;
        if (pathsOverlap([path], claim.paths)) others.set(claim.claimant, { id: claim.id, summary: claim.summary });
      }
      for (const earlier of this.#editors.get(path) ?? []) {
        if (earlier !== input.editor && !others.has(earlier)) others.set(earlier, null);
      }
      for (const [other, claim] of others) {
        if (!input.live.has(other)) continue;
        const key = [path, ...[input.editor, other].sort()].join("\u0000");
        if (this.#reported.has(key)) continue;
        this.#reported.add(key);
        overlaps.push({ path, editor: input.editor, other, claim });
      }
      const editors = this.#editors.get(path) ?? new Set<AgentId>();
      editors.add(input.editor);
      this.#editors.set(path, editors);
    }
    return overlaps;
  }

  reset(goalId: string | null = null): void {
    this.#goalId = goalId;
    this.#editors.clear();
    this.#reported.clear();
  }

  /** Provider paths are usually absolute. Claims are repository-relative. */
  #relative(path: string): string | null {
    const candidate = isAbsolute(path) ? relative(this.#root, path) : path;
    if (!candidate || candidate.startsWith("..") || isAbsolute(candidate)) return null;
    return candidate.split(sep).join("/").replace(/^\.[/]/u, "");
  }
}

function isPresent<T>(value: T | null): value is T {
  return value !== null;
}
