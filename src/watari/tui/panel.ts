import type { TeamClaim, TeamFinding, TeamSnapshot, TeamTodo } from "../state/types.ts";

const PEER_HEADING = 1;
/**
 * A peer's name/state row plus the one line under it.
 *
 * Exactly two, whatever is known about that peer: the bridge shows as a glyph
 * beside the name and only takes the second line when it is the thing that is
 * wrong. Getting this wrong is not cosmetic. The panel would draw past its
 * pane and over the transcript beside it.
 */
const PEER_ROWS = 2;
const SECTION_HEADING = 2;
const ENTRY_ROWS = 2;
/** A TODO is its state, owner, and title on a single row. */
const TODO_ROWS = 1;

function peerCost(snapshot: TeamSnapshot): number {
  return snapshot.agents.length * PEER_ROWS;
}

export interface PanelBudget {
  readonly claims: readonly TeamClaim[];
  readonly findings: readonly TeamFinding[];
  readonly todos: readonly TeamTodo[];
  readonly hiddenClaims: number;
  readonly hiddenFindings: number;
  readonly hiddenTodos: number;
}

/** Rows a section occupies, including its heading and the blank line above it. */
function cost(entries: number, rows = ENTRY_ROWS): number {
  return entries > 0 ? SECTION_HEADING + entries * rows : 0;
}

function capacity(rows: number, entryRows = ENTRY_ROWS): number {
  return rows >= SECTION_HEADING + entryRows ? Math.floor((rows - SECTION_HEADING) / entryRows) : 0;
}

/** TODO items that still describe work, in the order they were written. */
export function openTodos(snapshot: TeamSnapshot): readonly TeamTodo[] {
  return (snapshot.todos ?? []).filter((todo) =>
    todo.state === "todo" || todo.state === "doing" || todo.state === "blocked"
  );
}

/**
 * Decides how much of the standing team state fits beside the transcript.
 *
 * The peer roster is never trimmed, because it is the one thing the panel
 * exists for. The remaining rows go to the split of claims, findings, and open
 * TODO items that shows the most entries, and ties break towards showing every
 * section rather than filling the panel with one of them.
 */
export function panelBudget(snapshot: TeamSnapshot, height: number): PanelBudget {
  const claims = snapshot.claims.filter((claim) => claim.state !== "released");
  const findings = snapshot.findings.filter((finding) => finding.disposition === "open");
  const todos = openTodos(snapshot);
  const room = Math.max(0, height - PEER_HEADING - peerCost(snapshot));
  const totals: Choice = { claims: claims.length, findings: findings.length, todos: todos.length };

  let best: Choice = { claims: 0, findings: 0, todos: 0 };
  const claimLimit = Math.min(claims.length, capacity(room));
  const findingLimit = Math.min(findings.length, capacity(room));
  const todoLimit = Math.min(todos.length, capacity(room, TODO_ROWS));

  for (let claimCount = 0; claimCount <= claimLimit; claimCount += 1) {
    for (let findingCount = 0; findingCount <= findingLimit; findingCount += 1) {
      const used = cost(claimCount) + cost(findingCount);
      if (used > room) continue;
      for (let todoCount = 0; todoCount <= todoLimit; todoCount += 1) {
        // Each further TODO only costs more, so the rest cannot fit either.
        if (used + cost(todoCount, TODO_ROWS) > room) break;
        const candidate = { claims: claimCount, findings: findingCount, todos: todoCount };
        if (better(candidate, best, totals)) best = candidate;
      }
    }
  }

  return {
    claims: best.claims > 0 ? claims.slice(-best.claims) : [],
    findings: best.findings > 0 ? findings.slice(-best.findings) : [],
    todos: best.todos > 0 ? todos.slice(0, best.todos) : [],
    hiddenClaims: claims.length - best.claims,
    hiddenFindings: findings.length - best.findings,
    hiddenTodos: todos.length - best.todos,
  };
}

interface Choice {
  readonly claims: number;
  readonly findings: number;
  readonly todos: number;
}

/**
 * Ranks two candidate splits. Showing something from every section beats
 * showing more of one, and an unresolved finding outranks a claim, because a
 * finding is the one thing the panel must not let disappear quietly.
 */
function better(candidate: Choice, incumbent: Choice, totals: Choice): boolean {
  const rank = (choice: Choice): readonly number[] => [
    (totals.claims === 0 || choice.claims > 0 ? 1 : 0) +
      (totals.findings === 0 || choice.findings > 0 ? 1 : 0) +
      (totals.todos === 0 || choice.todos > 0 ? 1 : 0),
    choice.findings > 0 ? 1 : 0,
    choice.claims + choice.findings + choice.todos,
    -Math.abs(choice.claims - choice.findings),
    choice.findings,
  ];
  const left = rank(candidate);
  const right = rank(incumbent);
  for (const [index, value] of left.entries()) {
    const other = right[index] ?? 0;
    if (value !== other) return value > other;
  }
  return false;
}

/** Rows the panel will actually draw, so callers can assert it never overflows. */
export function panelRows(snapshot: TeamSnapshot, budget: PanelBudget): number {
  return (
    PEER_HEADING +
    peerCost(snapshot) +
    cost(budget.claims.length) +
    cost(budget.findings.length) +
    cost(budget.todos.length, TODO_ROWS)
  );
}
