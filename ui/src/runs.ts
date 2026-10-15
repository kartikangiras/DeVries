// A run's state in the words the UI shows, and what a run cites.

import type { Mitigation, Run, RunWithSteps, Step } from "./api";
import { idsIn } from "./text";

const PHASE: Record<string, string> = {
  scan: "scanning", investigate: "investigating", mitigate: "testing fixes", approval: "waiting for you",
  apply: "applying", report: "reporting", ask: "answering",
};
const OUTCOME: Record<string, string> = {
  clean: "nothing to fix", applied: "fix applied", proposed: "fix proposed", rejected: "fix rejected", no_plan: "no plan passed",
  undecided: "not decided", apply_failed: "apply failed", answered: "answered", unanswered: "not answered",
};
export const OUTCOME_SENTENCE: Record<string, string> = {
  clean: "Nothing to fix: the scan found no open findings.",
  applied: "The approved fix was applied and the rescan confirmed it.",
  proposed: "A plan passed in a sandbox and waits for a person; the run stopped there.",
  rejected: "The proposal was rejected; nothing changed.",
  no_plan: "No plan passed verification; nothing was proposed.",
  undecided: "Nobody decided in time; the proposal is still waiting.",
  apply_failed: "The approved plan could not be applied.",
};

/** A dot-and-word status for a run: the word, and the status class that colours it. */
export function runState(run: Run): { word: string; cls: string } {
  if (run.status === "failed") return { word: "failed", cls: "failed" };
  if (run.status === "awaiting_approval") return { word: "waiting for you", cls: "waiting" };
  if (run.status === "done") {
    const good = run.outcome === "applied" || run.outcome === "clean" || run.outcome === "answered";
    if (run.outcome === "proposed") return { word: OUTCOME.proposed, cls: "waiting" };
    return { word: OUTCOME[run.outcome ?? ""] ?? "done", cls: good ? "done" : "" };
  }
  return { word: PHASE[run.phase] ?? run.phase, cls: "running" };
}

export type VerdictRow = { ok: boolean; cost: number | null; plan: string; why: string };

const numbers = (resolved = 0, introduced = 0, broken = 0) => `resolves ${resolved} · introduces ${introduced} · breaks ${broken}`;

/** The sandbox verdicts a step produced: one per plan it tested. These are never folded away. */
export function verdictsOf(step: Step, mitigations: Record<string, Mitigation>): VerdictRow[] {
  const r = step.result as any;
  if (!r) return [];
  const fromVerdict = (v: any): VerdictRow => ({
    ok: !!v.passed,
    cost: typeof v.cost === "number" ? v.cost : null,
    plan: (v.summary ?? []).join(" and "),
    why: v.passed ? numbers(v.resolved?.length, v.introduced?.length, v.newly_broken?.length) : String(v.reason ?? "it did not pass"),
  });
  if (step.tool === "simulate_mitigation" && typeof r.passed === "boolean") return [fromVerdict(r)];
  if (step.tool === "propose_fix" && r.error?.verdict) return [fromVerdict(r.error.verdict)];
  if (step.tool === "baseline_search" && Array.isArray(r.failed) && Array.isArray(r.passing)) {
    return [
      ...r.failed.map((f: any): VerdictRow => ({ ok: false, cost: f.cost ?? null, plan: f.plan, why: f.reason ?? "it did not pass" })),
      ...r.passing.map((p: any): VerdictRow => {
        const m = mitigations[p.id];
        return { ok: true, cost: p.cost ?? null, plan: p.plan, why: m ? numbers(m.resolved?.length, m.introduced?.length, m.newly_broken?.length) : "resolves its target · introduces 0 · breaks 0" };
      }),
    ];
  }
  return [];
}

/** The step's own line, when its verdict rows already say what happened. */
export function mainLine(step: Step): string {
  const r = step.result as any;
  if (step.tool === "simulate_mitigation" && r && typeof r.passed === "boolean") return `one plan tested in a sandbox graph${r.sandbox_ms != null ? ` · ${r.sandbox_ms} ms` : ""}`;
  if (step.tool === "baseline_search" && r && typeof r.sandbox_runs === "number") return `${r.sandbox_runs} plan${r.sandbox_runs === 1 ? "" : "s"} tested in sandbox graphs, cheapest first`;
  return step.kind === "tool" ? step.headline ?? "" : step.text ?? "";
}

/**
 * Which step each id in a run's report came from. The server only lets a report cite ids that some
 * tool returned; this finds the tool, so the report can point at it.
 */
export function citeRun(run: RunWithSteps): { cites: Map<string, number>; rows: { n: number; step: Step }[] } {
  const holders = run.steps.filter((s) => s.kind === "tool" && !s.error);
  const hay = holders.map((s) => `${JSON.stringify(s.result ?? {})} ${s.headline ?? ""}`);
  const cites = new Map<string, number>();
  const rows: { n: number; step: Step }[] = [];
  for (const id of idsIn(run.answer ?? "")) {
    const i = hay.findIndex((h) => h.includes(id));
    if (i < 0) continue;
    let row = rows.find((r) => r.step === holders[i]);
    if (!row) {
      row = { n: rows.length + 1, step: holders[i] };
      rows.push(row);
    }
    cites.set(id, row.n);
  }
  return { cites, rows };
}
