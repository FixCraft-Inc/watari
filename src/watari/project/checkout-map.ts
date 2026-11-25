import { spawnSync } from "node:child_process";

/** Top-level entries named before the rest are counted. */
const MAX_LAYOUT_ENTRIES = 20;
/** Changed files named before the rest are summarized by directory. */
const MAX_CHANGED_FILES = 30;
const GIT_TIMEOUT_MS = 3_000;
const GIT_MAX_BUFFER = 32 * 1024 * 1024;

export interface CheckoutFacts {
  readonly branch: string | null;
  /** Tracked paths, repository-relative. */
  readonly tracked: readonly string[];
  /** `git status --porcelain` codes with their paths. */
  readonly changes: readonly { readonly status: string; readonly path: string }[];
}

/**
 * A few lines that let a peer split work without listing the tree itself.
 *
 * Every peer used to open a goal by running the same `git status` and `ls`
 * and reading the same top-level files, which spent each one's context on
 * identical exploration. This is read-only Git state, not a summary of the
 * code: where things are, and what is uncommitted.
 */
export function formatCheckoutMap(facts: CheckoutFacts): string {
  const lines: string[] = [];
  const layout = topLevelLayout(facts.tracked);
  lines.push(
    `${facts.branch ? `Branch ${facts.branch}. ` : ""}Tracked files by top-level entry: ${layout || "none"}.`,
  );
  if (facts.changes.length === 0) {
    lines.push("No uncommitted changes.");
  } else {
    const named = facts.changes.slice(0, MAX_CHANGED_FILES).map((change) => `${change.status} ${change.path}`);
    const rest = facts.changes.slice(MAX_CHANGED_FILES);
    const more = rest.length > 0 ? `, +${rest.length} more in ${countByTopLevel(rest.map((change) => change.path))}` : "";
    lines.push(`Uncommitted changes, ${facts.changes.length} files: ${named.join(", ")}${more}.`);
  }
  return lines.join("\n");
}

/** Reads the facts from Git, or null outside a repository or when Git stalls. */
export function readCheckoutFacts(root: string): CheckoutFacts | null {
  const tracked = git(root, ["ls-files", "-z"]);
  const status = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (tracked === null || status === null) return null;
  const branch = git(root, ["rev-parse", "--abbrev-ref", "HEAD"])?.trim() || null;
  return {
    branch: branch === "HEAD" ? "detached HEAD" : branch,
    tracked: tracked.split("\0").filter(Boolean),
    changes: parseStatus(status),
  };
}

/** `-z` output keeps odd file names intact. A rename or copy carries its source as the next entry. */
export function parseStatus(output: string): { status: string; path: string }[] {
  const entries = output.split("\0");
  const changes: { status: string; path: string }[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index] ?? "";
    if (entry.length < 4) continue;
    const status = entry.slice(0, 2).trim() || "?";
    changes.push({ status, path: entry.slice(3) });
    if (status.startsWith("R") || status.startsWith("C")) index += 1;
  }
  return changes;
}

function topLevelLayout(paths: readonly string[]): string {
  const directories = new Map<string, number>();
  const files: string[] = [];
  for (const path of paths) {
    const slash = path.indexOf("/");
    if (slash < 0) files.push(path);
    else {
      const directory = `${path.slice(0, slash)}/`;
      directories.set(directory, (directories.get(directory) ?? 0) + 1);
    }
  }
  const entries = [
    ...[...directories].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .map(([directory, count]) => `${directory} ${count}`),
    ...files.sort(),
  ];
  const shown = entries.slice(0, MAX_LAYOUT_ENTRIES).join(", ");
  const hidden = entries.length - MAX_LAYOUT_ENTRIES;
  return hidden > 0 ? `${shown}, +${hidden} more` : shown;
}

function countByTopLevel(paths: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const path of paths) {
    const slash = path.indexOf("/");
    const key = slash < 0 ? "./" : `${path.slice(0, slash)}/`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 8)
    .map(([directory, count]) => `${directory} (${count})`)
    .join(", ");
}

/**
 * Runs a read-only Git query. `--no-optional-locks` keeps `status` from
 * refreshing the index, which would take `index.lock` in a checkout the peers
 * are running Git in themselves.
 */
function git(root: string, args: readonly string[]): string | null {
  const result = spawnSync("git", ["--no-optional-locks", "-C", root, ...args], {
    encoding: "utf8",
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER,
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0 && typeof result.stdout === "string" ? result.stdout : null;
}
