// Where a finding stands on the desk: the one word, its colour, and what happens next.

import type { Finding, Mitigation, Run } from "./api";
import { pathsOf } from "./paths";
import { countWord, plural } from "./text";

/** The five colours a status can take. Amber means one thing only: it is waiting for a person. */
export type Tone = "danger" | "info" | "amber" | "accent" | "muted";

export type Desk = {
  word: string;
  tone: Tone;
  pulse: boolean;
  /** The next thing that happens to it, as the inbox row says it, and the label that goes before it. */
  next: string;
  nextLabel: string;
  /** The passing plan that waits for a decision, if one does. */
  proposal: Mitigation | null;
  /** The plan that closed it, if one did. */
  applied: Mitigation | null;
  /** Every plan that was tested against it, in the order they were tested. */
  tested: Mitigation[];
};

const touches = (m: Mitigation, id: string) => m.targets.includes(id) || !!m.resolved?.includes(id);

const RUN_PHASE: Record<string, string> = {
  scan: "scanning the graph", investigate: "reading the findings", mitigate: "testing fixes in sandboxes",
  approval: "waiting for you", apply: "applying the fix", report: "writing the report",
};

/** The plan to put in front of a person when several passed: the one the audit run proposed, and
 *  failing that the search's own order: cheapest, then the one that closes most, then the first tested. */
function best(passing: Mitigation[], run: Run | null): Mitigation | null {
  const proposed = passing.find((m) => m.id === run?.mitigation_id);
  if (proposed) return proposed;
  return [...passing].sort((a, b) => a.cost - b.cost || (b.resolved?.length ?? 0) - (a.resolved?.length ?? 0) || a.created_at - b.created_at)[0] ?? null;
}

/** A passing plan waits for a person only while every finding it was verified against is still open.
 *  Once one of them is closed the plan is superseded: applying it would be refused as stale. */
export function isLive(m: Mitigation, open: Set<string>): boolean {
  return m.status === "proposed" && m.passed && m.targets.every((id) => open.has(id));
}

export function deskOf(finding: Finding, plans: Mitigation[], run: Run | null, open: Set<string>): Desk {
  const tested = plans.filter((m) => touches(m, finding.id));
  const applied = tested.find((m) => m.status === "applied" && m.resolved?.includes(finding.id)) ?? null;
  const base = { proposal: null, applied, tested, pulse: false, nextLabel: "Next" };

  if (finding.status === "mitigated") return { ...base, word: "Mitigated", tone: "accent", nextLabel: "Closed by", next: applied ? recommendation(applied) : "a fix" };
  if (finding.status === "accepted") return { ...base, word: "Accepted", tone: "muted", nextLabel: "Accepted by", next: finding.accepted_by ?? "a person" };
  if (finding.kind === "drift") return { ...base, word: "Open", tone: "danger", nextLabel: "Next", next: "read what changed, then accept it" };
  if (finding.kind === "poisoned_description") return { ...base, word: "Open", tone: "danger", nextLabel: "Next", next: "read the description, then accept it or fix the manifest" };
  if (finding.status === "closed") return { ...base, word: "Closed", tone: "muted", nextLabel: "Now", next: "no longer holds in the graph" };

  const approved = tested.find((m) => m.status === "approved");
  if (approved) return { ...base, word: "Applying", tone: "accent", pulse: true, next: "applying the fix" };

  const proposal = best(tested.filter((m) => isLive(m, open)), run);
  if (proposal) return { ...base, proposal, word: "Awaiting approval", tone: "amber", pulse: true, next: "approve the fix" };

  if (run?.kind === "audit" && run.status === "running") {
    return { ...base, word: "Investigating", tone: "info", pulse: true, next: RUN_PHASE[run.phase] ?? run.phase };
  }
  // while the audit waits on a decision about another finding's fix, the page offers no second audit: that decision comes first
  const paused = (run?.kind === "audit" && run.status === "awaiting_approval") || plans.some((m) => isLive(m, open));
  const again = paused ? "decide the fix that is waiting, then run the audit again" : "run the audit again";
  if (tested.some((m) => m.status === "rejected")) return { ...base, word: "Open", tone: "danger", next: `a fix was rejected; ${again}` };
  // a plan passed, but for a finding that has since closed: its verdict describes a graph that is gone
  if (tested.some((m) => m.status === "proposed" && m.passed)) return { ...base, word: "Open", tone: "danger", next: `its tested plan is out of date; ${again}` };
  if (tested.length) return { ...base, word: "Open", tone: "danger", next: "no plan passed yet" };
  return { ...base, word: "Open", tone: "danger", next: paused ? again : "run the audit" };
}

/** How exposed a finding is, in a figure: "four hops", "three legs". */
export function exposure(finding: Finding): string {
  const paths = pathsOf(finding);
  if (finding.kind === "drift") {
    const d = finding.drift;
    return plural(d ? d.added.length + d.removed.length + Object.keys(d.changed).length : 0, "tool", "tools");
  }
  if (finding.kind === "poisoned_description") return plural(finding.flags?.length ?? 0, "mark", "marks");
  if (finding.kind === "trifecta") return plural(paths.length, "leg", "legs");
  return plural(paths[0]?.path.rules.length ?? 0, "hop", "hops");
}

const FIX_WORDS: Record<string, [string, string]> = {
  gate_call: ["gate one call", "gate %n calls"],
  revoke_call: ["revoke one grant", "revoke %n grants"],
  quarantine_delegation: ["quarantine one delegation", "quarantine %n delegations"],
  drop_read: ["stop one read", "stop %n reads"],
  split_agent: ["split one agent", "split %n agents"],
};

/** A plan in three words, for the place where a recommendation is a figure: "gate one call". */
export function recommendation(plan: Mitigation): string {
  const kinds = [...new Set(plan.plan.fixes.map((f) => f.kind))];
  const n = plan.plan.fixes.length;
  if (kinds.length !== 1 || !FIX_WORDS[kinds[0]]) return plural(n, "change", "changes");
  const [one, many] = FIX_WORDS[kinds[0]];
  return n === 1 ? one : many.replace("%n", countWord(n));
}

/** What a sandbox said about a plan: "resolves 2 · introduces 0 · breaks 0". With no workflow declared, breakage was not checked, and the line says so. */
export function verdictLine(m: Mitigation): string {
  const line = `resolves ${m.resolved?.length ?? 0} · introduces ${m.introduced?.length ?? 0} · breaks ${m.unconstrained ? "unchecked" : m.newly_broken?.length ?? 0}`;
  return m.unconstrained ? `${line} · No workflow is declared here, so nothing was checked for breakage.` : line;
}

/** The literal change to the configuration: which edge of the graph, and what happens to it. */
export function patchText(patch: any): string {
  if (patch.op === "split") {
    return `add ${patch.reader_id}, its results quarantined · move ${(patch.moved_tool_ids ?? []).join(", ")} from ${patch.agent_id} to it`;
  }
  const edge = `${patch.edge} ${patch.from_id} → ${patch.to_id}`;
  return patch.op === "delete" ? `delete ${edge}` : `${edge} · set gate = ${patch.gate}`;
}

export const FIX_VERB: Record<string, string> = {
  gate_call: "Gate", revoke_call: "Revoke", quarantine_delegation: "Quarantine", drop_read: "Drop", split_agent: "Split",
};

/** A fix as the act that makes it, for saying how a hop is cut: "revoking the grant". */
const FIX_BY: Record<string, string> = {
  gate_call: "gating the call", revoke_call: "revoking the grant", quarantine_delegation: "quarantining the delegation", drop_read: "dropping the read", split_agent: "splitting the agent",
};

/** How a hop can be cut, in words: "cut by revoking the grant or by gating the call". */
export function cutBy(fixes: string[]): string {
  return `cut by ${fixes.map((f) => FIX_BY[f] ?? f.replace(/_/g, " ")).join(" or by ")}`;
}
