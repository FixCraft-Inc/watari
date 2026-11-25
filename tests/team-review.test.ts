import { describe, expect, test } from "bun:test";

import { TeamStore } from "../src/watari/state/store.ts";
import type { TeamFinding } from "../src/watari/state/types.ts";
import { TeamApplicationService } from "../src/watari/team/service.ts";
import { IdentityBoundTeamTools } from "../src/watari/team/tools.ts";
import {
  DEFAULT_REVIEW_SCOPE,
  findingGroup,
  findingsReport,
  reviewGoal,
} from "../src/watari/team/review.ts";
import { parseCommand } from "../src/watari/tui/commands.ts";

function setup() {
  const store = new TeamStore(":memory:");
  store.registerAgent({ id: "codex", backend: "codex", displayName: "Codex", model: "gpt-test", effort: "high" });
  store.registerAgent({ id: "claude", backend: "claude", displayName: "Claude" });
  store.registerAgent({ id: "helper", backend: "opencode", displayName: "Helper", provider: "opencode" });
  const goal = store.createGoal({
    instruction: "Review the transport",
    initialAddressee: null,
    participants: ["codex", "claude", "helper"],
  });
  const service = new TeamApplicationService({ store });
  const tools = (agent: string) => new IdentityBoundTeamTools({ agent, service });
  return { store, goal, codex: tools("codex"), claude: tools("claude"), helper: tools("helper") };
}

describe("claims between live and offline peers", () => {
  test("an offline peer's overlapping claim is taken over instead of contested", () => {
    const { store, goal } = setup();
    const stale = store.createClaim({
      goalId: goal.id,
      claimant: "claude",
      summary: "framing rewrite",
      paths: ["src/transport/**"],
      state: "active",
    });
    store.setAgentState("claude", "failed", { detail: "Claude assistant error: rate_limit" });

    const takeover = store.createClaim({
      goalId: goal.id,
      claimant: "codex",
      summary: "finish the framing rewrite",
      paths: ["src/transport/frame.ts"],
      state: "active",
    });

    expect(takeover.state).toBe("active");
    expect(takeover.takenOver.map((claim) => claim.id)).toEqual([stale.id]);
    const previous = store.claims(goal.id).find((claim) => claim.id === stale.id);
    expect(previous?.state).toBe("superseded");
    expect(previous?.note).toContain("taken over by codex while claude was offline");
    store.close();
  });

  test("a removed agent's claim is taken over too, since it can never answer a contest", () => {
    const { store, goal } = setup();
    const left = store.createClaim({ goalId: goal.id, claimant: "helper", summary: "docs", paths: ["docs/**"], state: "active" });
    store.unregisterAgent("helper");

    const mine = store.createClaim({ goalId: goal.id, claimant: "claude", summary: "docs", paths: ["docs/a.md"], state: "active" });

    expect(mine.state).toBe("active");
    expect(mine.takenOver.map((claim) => claim.id)).toEqual([left.id]);
    store.close();
  });

  test("the peer whose claim was contested hears about it, passively", async () => {
    const { store, goal, codex } = setup();
    const theirs = store.createClaim({ goalId: goal.id, claimant: "claude", summary: "decoder", paths: ["src/decoder/**"] });

    const result = await codex.call("team_claim", { scope: "frame fix", paths: ["src/decoder/frame.ts"] });

    expect(result).toMatchObject({ ok: true, value: { state: "contested", conflicts: [{ id: theirs.id }] } });
    const notice = store.pendingInbox("claude").at(-1);
    expect(notice).toMatchObject({ sender: "watari", delivery: "passive" });
    expect(notice?.body).toContain(`codex's new claim`);
    expect(notice?.body).toContain(`overlaps your claim ${theirs.id} on src/decoder/frame.ts`);
    store.close();
  });

  test("releasing one side of a contest returns the other claim to active", () => {
    const { store, goal } = setup();
    const first = store.createClaim({ goalId: goal.id, claimant: "codex", summary: "a", paths: ["src/x/**"] });
    const second = store.createClaim({ goalId: goal.id, claimant: "claude", summary: "b", paths: ["src/x/y.ts"] });
    expect(store.claims(goal.id).every((claim) => claim.state === "contested")).toBe(true);

    store.setClaimState(first.id, "codex", "released");

    expect(store.claims(goal.id).find((claim) => claim.id === second.id)?.state).toBe("active");
    store.close();
  });

  test("a claim stays contested while another live overlap remains", () => {
    const { store, goal } = setup();
    const first = store.createClaim({ goalId: goal.id, claimant: "codex", summary: "a", paths: ["src/x/**"] });
    const second = store.createClaim({ goalId: goal.id, claimant: "claude", summary: "b", paths: ["src/x/y.ts"] });
    store.createClaim({ goalId: goal.id, claimant: "helper", summary: "c", paths: ["src/x/y.ts"] });

    store.setClaimState(first.id, "codex", "released");

    expect(store.claims(goal.id).find((claim) => claim.id === second.id)?.state).toBe("contested");
    store.close();
  });

  test("team_claim reports what it took over", async () => {
    const { store, goal, codex } = setup();
    store.createClaim({ goalId: goal.id, claimant: "claude", summary: "parser", paths: ["src/parser.ts"] });
    store.setAgentState("claude", "stopped");

    const result = await codex.call("team_claim", { scope: "parser", paths: ["src/parser.ts"] });

    expect(result).toMatchObject({
      ok: true,
      value: { claimant: "codex", state: "active", taken_over: [{ from: "claude", scope: "parser" }] },
    });
    expect(Object.keys(result.value as object)).not.toContain("conflicts");
    store.close();
  });
});

describe("finding verdicts", () => {
  test("only another peer can verify a finding, and a later verdict replaces the earlier one", () => {
    const { store } = setup();
    const finding = store.createFinding({ author: "codex", severity: "high", summary: "frame length unchecked" });

    expect(() => store.recordFindingVerdict(finding.id, "codex", "confirmed")).toThrow("another peer");
    store.recordFindingVerdict(finding.id, "claude", "refuted", "length is checked in decode()");
    const updated = store.recordFindingVerdict(finding.id, "claude", "confirmed", "decode() skips it for empty frames");

    expect(updated.verdicts).toEqual([
      expect.objectContaining({ reviewer: "claude", verdict: "confirmed", evidence: "decode() skips it for empty frames" }),
    ]);
    expect(store.findings()[0]?.verdicts).toHaveLength(1);
    store.resetConversation();
    expect(store.findings()).toHaveLength(0);
    store.close();
  });

  test("a refutation needs evidence and goes to the author as mail", async () => {
    const { store, codex, claude } = setup();
    const created = await codex.call("team_finding", { severity: "high", summary: "race in shutdown" });
    const id = (created.value as { id: string }).id;

    expect(await claude.call("team_finding_update", { finding_id: id, verdict: "refuted" }))
      .toMatchObject({ ok: false, error: expect.stringContaining("needs evidence") });
    expect(await claude.call("team_finding_update", { finding_id: id }))
      .toMatchObject({ ok: false, error: expect.stringContaining("disposition or a verdict") });

    const refuted = await claude.call("team_finding_update", {
      finding_id: id,
      verdict: "refuted",
      evidence: "shutdown holds the lock for the whole close",
    });

    expect(refuted).toMatchObject({ ok: true, value: { id, refuted_by: ["claude"], disposition: "open" } });
    const notice = store.pendingInbox("codex").at(-1);
    expect(notice).toMatchObject({ sender: "watari" });
    // A refutation starts a turn for an idle author, unlike a passive notice.
    expect(notice?.delivery ?? "normal").toBe("normal");
    expect(notice?.body).toContain("claude refuted your finding");
    expect(notice?.body).toContain("shutdown holds the lock");
    store.close();
  });

  test("a confirmation is passive and the status view counts it", async () => {
    const { store, codex, claude } = setup();
    const created = await codex.call("team_finding", { severity: "medium", summary: "missing bound" });
    const id = (created.value as { id: string }).id;

    await claude.call("team_finding_update", { finding_id: id, verdict: "confirmed", evidence: "reproduced" });

    expect(store.pendingInbox("codex").at(-1)).toMatchObject({ delivery: "passive" });
    const status = await codex.call("team_status", {});
    expect(status).toMatchObject({ ok: true, value: { findings: [{ id, confirmed_by: ["claude"] }] } });
    // The author still owns the disposition.
    expect(await claude.call("team_finding_update", { finding_id: id, disposition: "resolved" })).toMatchObject({
      ok: false,
    });
    expect(await codex.call("team_finding_update", { finding_id: id, disposition: "resolved" })).toMatchObject({
      ok: true,
      value: { disposition: "resolved" },
    });
    store.close();
  });
});

describe("finding announcements", () => {
  test("a new finding reaches the other live peers with a short id, passively", async () => {
    const { store, codex } = setup();
    store.setAgentState("codex", "busy");
    store.setAgentState("claude", "ready");

    const created = await codex.call("team_finding", {
      severity: "low",
      summary: "add subtracts",
      scope: "calc.py:2",
    });
    const id = (created.value as { id: string }).id;

    expect(id).toMatch(/^[0-9a-f]{8}$/u);
    const notice = store.pendingInbox("claude").at(-1);
    expect(notice).toMatchObject({ sender: "watari", delivery: "passive" });
    expect(notice?.body).toContain(`codex recorded finding ${id} (low, calc.py:2): add subtracts`);
    // A peer that is not running is not told; it can read team_status later.
    expect(store.pendingInbox("helper")).toHaveLength(0);
    expect(store.pendingInbox("codex")).toHaveLength(0);
    store.close();
  });
});

describe("compact team answers", () => {
  test("team_roster names the caller and each peer's model without store bookkeeping", async () => {
    const { store, codex } = setup();
    const roster = await codex.call("team_roster", {});

    expect(roster).toMatchObject({
      ok: true,
      value: { you: "codex", peers: expect.arrayContaining([{ id: "codex", provider: "codex", model: "gpt-test", effort: "high", state: "starting" }]) },
    });
    expect(JSON.stringify(roster.value)).not.toContain("sessionId");
    expect(JSON.stringify(roster.value)).not.toContain("updatedAt");
    store.close();
  });

  test("team_inbox history is paged instead of returning every body", async () => {
    const { store, codex, claude } = setup();
    for (let index = 0; index < 5; index += 1) {
      await claude.call("team_send", { to: "codex", message: `note ${index}` });
    }

    const page = await codex.call("team_inbox", { after_id: 0, limit: 2 });
    expect(page).toMatchObject({
      ok: true,
      value: { messages: [{ text: "note 0" }, { text: "note 1" }], more: expect.stringContaining("after_id") },
    });
    const all = await codex.call("team_inbox", { after_id: 0 });
    expect(Array.isArray(all.value)).toBe(true);
    expect(all.value).toHaveLength(5);
    store.close();
  });
});

describe("review workflow", () => {
  test("/review opens a team-wide review goal and defaults to the uncommitted changes", () => {
    const action = parseCommand("/review", 1, ["codex", "claude"]);
    expect(action).toMatchObject({ type: "send", target: "all" });
    expect(action.type === "send" ? action.text : "").toContain(DEFAULT_REVIEW_SCOPE);

    const scoped = parseCommand("/review src/transport", 2, ["codex", "claude"]);
    expect(scoped.type === "send" ? scoped.text : "").toStartWith("Review src/transport.");
    expect(reviewGoal("x")).toContain("verdict confirmed or refuted");
  });

  test("/retry restarts the named or focused peer, and /copy findings copies the report", () => {
    expect(parseCommand("/retry claude", 0, ["codex", "claude"])).toEqual({ type: "restart", agent: "claude" });
    expect(parseCommand("/restart", 2, ["codex", "claude"])).toEqual({ type: "restart", agent: "claude" });
    expect(parseCommand("/retry", 0, ["codex", "claude"])).toMatchObject({ type: "unknown" });
    expect(parseCommand("/copy findings", 0)).toEqual({ type: "copy", scope: "findings" });
  });

  test("the findings report puts checked findings first and orders by severity", () => {
    const base = {
      author: "codex",
      target: null,
      scope: null,
      evidence: null,
      disposition: "open" as const,
      createdAt: 1,
      updatedAt: 1,
    };
    const findings: TeamFinding[] = [
      { ...base, id: "aaaaaaaa-1", severity: "low", summary: "unchecked low" },
      {
        ...base,
        id: "bbbbbbbb-2",
        severity: "medium",
        summary: "confirmed medium",
        scope: "src/a.ts:10",
        verdicts: [{ reviewer: "claude", verdict: "confirmed", evidence: "reproduced", createdAt: 2 }],
      },
      {
        ...base,
        id: "cccccccc-3",
        severity: "critical",
        summary: "confirmed critical",
        verdicts: [{ reviewer: "claude", verdict: "confirmed", evidence: null, createdAt: 2 }],
      },
      {
        ...base,
        id: "dddddddd-4",
        severity: "high",
        summary: "disputed high",
        verdicts: [{ reviewer: "claude", verdict: "refuted", evidence: "guarded upstream", createdAt: 2 }],
      },
      { ...base, id: "eeeeeeee-5", severity: "high", summary: "withdrawn", disposition: "dismissed" },
    ];

    expect(findings.map(findingGroup)).toEqual(["unverified", "confirmed", "confirmed", "disputed", "withdrawn"]);
    const report = findingsReport(findings, { instruction: "Review the transport" });
    const order = ["confirmed critical", "confirmed medium", "disputed high", "unchecked low", "withdrawn"]
      .map((text) => report.indexOf(text));
    expect(order).toEqual([...order].sort((left, right) => left - right));
    expect(report).toContain("# Findings (5)");
    expect(report).toContain("  - Scope: src/a.ts:10");
    expect(report).toContain("  - claude (refuted): guarded upstream");
    expect(findingsReport([])).toBe("No findings recorded.");
  });
});
