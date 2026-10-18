"""The baseline search: a deterministic walk over the candidates, cheapest first.

It is the scripted fallback, the data behind the Mitigations view, and the
yardstick the agent is measured against. It is not what the agent runs.

The search does not stop at the first passing plan: the Options step shows every
plan a sandbox was asked about, and a person who rejects the recommendation is
offered the next one. So its `sandbox_runs` is not the number it would take to
find a fix; `to_first_pass` is, and that is the count an agent is compared with.
"""

from itertools import combinations
from typing import Callable

from pydantic import BaseModel

from devries.analysis import chokepoints
from devries.analysis import findings as findings_mod
from devries.analysis.models import Finding
from devries.config import get_settings
from devries.errors import NotFound
from devries.graph.client import GraphClient
from devries.mitigation import sandbox, store
from devries.mitigation.candidates import candidates
from devries.mitigation.dsl import FixPlan, Verdict
from devries.mitigation.sandbox import SandboxError, StaleTarget


class SearchResult(BaseModel):
    targets: list[str]                      # finding ids the search set out to resolve
    passing: list[store.Mitigation]         # best first
    failed: list[store.Mitigation]          # every plan that was tried and did not pass, with its reason
    sandbox_runs: int
    to_first_pass: int | None = None        # sandboxes spent before the first passing plan: the fair count against an agent


def default_target(findings: list[Finding]) -> list[Finding]:
    """The single most severe open finding: injection before trifecta, then by id. One finding at a
    time keeps each proposal small enough for a person to review."""
    open_ = [f for f in findings if f.status == "open" and f.kind in ("injection", "trifecta")]    # the rest is accepted, never fixed
    if not open_:
        return []
    return [sorted(open_, key=lambda f: (f.kind != "injection", f.source_id or "", f.target_id or "", f.agent_id or ""))[0]]


async def search(client: GraphClient, working_key: str, finding_ids: list[str] | None = None, *,
                 budget: int | None = None, want: int = 3, source: str = "search",
                 on_verdict: Callable[[Verdict], None] | None = None) -> SearchResult:
    budget = budget or get_settings().sandbox_budget
    current, _ = await findings_mod.current(client, working_key)
    if finding_ids:
        by_id = {f.id: f for f in current}
        missing = [i for i in finding_ids if i not in by_id]
        if missing:
            raise NotFound(f"not a current finding in this scenario: {missing[0]}")
        targets = [by_id[i] for i in finding_ids]
    else:
        targets = default_target(current)
    if not targets:
        return SearchResult(targets=[], passing=[], failed=[], sandbox_runs=0)

    fingerprints = [f.fingerprint for f in targets]
    report = chokepoints.from_paths(targets)
    capability = {row["id"]: row["capability"] for row in await client.run("node.names", working_key)}
    singles = candidates(report, capability)
    config = await sandbox.config_hash(client, working_key)

    verdicts: list[Verdict] = []

    async def try_plans(plans: list[FixPlan]) -> None:
        for plan in plans:                                   # one sandbox at a time
            if len(verdicts) >= budget:
                return
            try:
                verdicts.append(await sandbox.verify(client, working_key, plan, fingerprints))
            except (StaleTarget, SandboxError):
                continue                                     # the edge changed under us, or this sandbox failed: next plan
            if on_verdict is not None:
                on_verdict(verdicts[-1])

    await try_plans(singles)
    if not any(v.passed for v in verdicts):                  # no single fix works: try pairs of the best six
        pairs = [FixPlan(fixes=[a.fixes[0], b.fixes[0]]) for a, b in combinations(singles[:6], 2)]
        await try_plans(sorted(pairs, key=lambda p: p.cost))

    stored = [await store.record(client, working_key, v, config_hash=config, source=source) for v in verdicts]
    by_plan = {m.id: (m, v) for m, v in zip(stored, verdicts)}
    # cheapest first, then the plan that closes more; ties go by the plan itself, so the same graph gives the same answer
    passing = sorted((mv for mv in by_plan.values() if mv[1].passed),
                     key=lambda mv: (mv[1].plan.cost, -len(mv[1].diff.resolved), mv[1].plan.canonical()))
    first_pass = next((i + 1 for i, v in enumerate(verdicts) if v.passed), None)
    return SearchResult(
        targets=[f.id for f in targets],
        passing=[m for m, _ in passing][:want],
        failed=[m for m, v in by_plan.values() if not v.passed],
        sandbox_runs=len(verdicts),
        to_first_pass=first_pass,
    )
