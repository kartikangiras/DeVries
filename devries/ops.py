"""Operations: an engine call together with the events it causes.

The MCP tools and the API both come through here, so a scan started by the
auditor, by a visitor or by an outside MCP client shows up on the same stream.
"""

from devries import views
from devries.analysis import findings as findings_mod
from devries.analysis.models import ScanResult, finding_id
from devries.errors import FixFailed, InvalidFix, NotFound
from devries.events import bus
from devries.graph.client import GraphClient
from devries.mitigation import apply as apply_mod
from devries.mitigation import sandbox, store
from devries.mitigation import search as search_mod
from devries.mitigation.apply import ConfigPatch
from devries.mitigation.dsl import Diff, FixPlan, Verdict, describe
from devries.mitigation.search import SearchResult
from devries.mitigation.store import Mitigation


async def scan(client: GraphClient, key: str) -> ScanResult:
    bus.publish(key, "scan.started")
    result = await findings_mod.scan(client, key)
    new = set(result.opened_fingerprints) | set(result.reopened_fingerprints)
    for finding in result.findings:
        if finding.fingerprint in new:
            bus.publish(key, "finding.opened", {
                "id": finding.id, "kind": finding.kind, "severity": finding.severity,
                "source_id": finding.source_id, "target_id": finding.target_id, "agent_id": finding.agent_id,
                "path_ids": finding.path_ids, "reopened": finding.fingerprint in result.reopened_fingerprints,
            })
    for fingerprint in result.closed_fingerprints:
        bus.publish(key, "finding.closed", {
            "id": finding_id(fingerprint),
            "status": "mitigated" if fingerprint in result.mitigated_fingerprints else "closed",
        })
    bus.publish(key, "scan.finished", {
        "scan_id": result.scan_id, "duration_ms": result.duration_ms, "partial": result.partial,
        "open": [f.id for f in result.findings if f.status == "open"],
        "closed": [finding_id(fp) for fp in result.closed_fingerprints],
    })
    return result


async def fingerprints(client: GraphClient, key: str, finding_ids: list[str]) -> list[str]:
    """Finding ids -> fingerprints, for findings that hold right now. Reads only."""
    if not finding_ids:
        raise InvalidFix("name at least one finding id: a plan is verified against the findings it must resolve")
    by_id = {ref.id: fp for fp, ref in (await sandbox.measure(client, key)).findings.items()}
    missing = [i for i in finding_ids if i not in by_id]
    if missing:
        raise NotFound(f"no open finding with id {missing[0]!r} here; open findings: {sorted(by_id) or 'none'}")
    return sorted({by_id[i] for i in finding_ids})


async def simulate(client: GraphClient, key: str, plan: FixPlan, finding_ids: list[str]) -> Verdict:
    verdict = await sandbox.verify(client, key, plan, await fingerprints(client, key, finding_ids))
    _simulated(key, verdict)
    return verdict


def _simulated(key: str, verdict: Verdict) -> None:
    bus.publish(key, "mitigation.simulated", {
        "summary": [describe(f) for f in verdict.plan.fixes], "plan": verdict.plan.model_dump(),
        "cost": verdict.plan.cost, "passed": verdict.passed, "reason": verdict.reason,
        "targets": [finding_id(fp) for fp in verdict.targets], "resolved": len(verdict.diff.resolved),
        "sandbox_ms": verdict.diff.sandbox_ms,
    })


async def what_if(client: GraphClient, key: str, changes: list) -> Diff:
    if not changes:
        raise InvalidFix("name at least one change")
    return await sandbox.diff(client, key, changes)


async def propose(client: GraphClient, key: str, plan: FixPlan, finding_ids: list[str], rationale: str | None,
                  source: str = "agent") -> Mitigation:
    """Verify again, whatever the caller says it saw, and store the plan only if it passes."""
    targets = await fingerprints(client, key, finding_ids)
    config = await sandbox.config_hash(client, key)
    verdict = await sandbox.verify(client, key, plan, targets)
    _simulated(key, verdict)
    if not verdict.passed:
        raise FixFailed(verdict.reason or "the plan did not pass verification", verdict=views.verdict_view(verdict))
    mitigation = await store.record(client, key, verdict, config_hash=config, source=source, rationale=rationale)
    if mitigation.status == "proposed":
        bus.publish(key, "mitigation.proposed", views.mitigation_view(mitigation))
    return mitigation


async def search(client: GraphClient, key: str, finding_ids: list[str] | None = None, source: str = "search") -> SearchResult:
    result = await search_mod.search(client, key, finding_ids, source=source, on_verdict=lambda v: _simulated(key, v))
    for mitigation in result.passing:
        if mitigation.status == "proposed":
            bus.publish(key, "mitigation.proposed", views.mitigation_view(mitigation))
    return result


async def approve(client: GraphClient, key: str, mitigation_id: str, approver: str, session: str | None = None) -> Mitigation:
    mitigation = await apply_mod.approve(client, key, mitigation_id, approver, session=session)
    bus.publish(key, "mitigation.approved", {"id": mitigation.id, "approved_by": approver})
    return mitigation


async def relabel(client: GraphClient, scenario: str, path, sources: dict[str, str], resources: dict[str, dict],
                  graph_key: str | None = None):
    """Write trust and impact labels into an imported scenario's file and load it again. Only a file the importer
    wrote (`imported:` set) may be changed this way: the bundled scenarios are what they are."""
    import yaml

    from devries.errors import InvalidScenario
    from devries.graph import keys
    from devries.ingest.scenario_loader import load_scenario, read_scenario

    spec = read_scenario(path).spec
    if not spec.imported:
        raise InvalidScenario(f"{scenario} was not imported; its labels are set in its file")
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    known_sources = {d["id"] for d in data.get("data_sources", [])}
    known_resources = {r["id"] for r in data.get("resources", [])}
    for sid, trust in sources.items():
        if sid not in known_sources or trust not in ("untrusted", "internal", "private", "unknown"):
            raise InvalidScenario(f"{sid}: not a data source of {scenario}, or {trust!r} is not a trust level")
    for rid, facts in resources.items():
        if rid not in known_resources or facts.get("impact") not in ("high", "medium", "low", "unknown"):
            raise InvalidScenario(f"{rid}: not a resource of {scenario}, or {facts.get('impact')!r} is not an impact")
    for d in data["data_sources"]:
        if d["id"] in sources:
            d["trust"] = sources[d["id"]]
    for r in data["resources"]:
        if r["id"] in resources:
            r["impact"] = resources[r["id"]]["impact"]
            r["external"] = bool(resources[r["id"]].get("external", r.get("external", False)))
    data["description"] = str(data.get("description", "")).split(". Label the sources")[0]
    path.write_text("# Labelled from the UI; the importer's comments were dropped by the rewrite.\n"
                    + yaml.safe_dump(data, sort_keys=False, allow_unicode=True), encoding="utf-8")
    key = graph_key or keys.scenario_key(scenario)
    report = await load_scenario(client, path, root=path.parent.parent, graph_key=key)
    bus.publish(key, "scan.finished", {"scan_id": report.scan.scan_id, "duration_ms": report.scan.duration_ms, "partial": report.scan.partial,
                                       "open": [f.id for f in report.scan.findings if f.status == "open"], "closed": []})
    return report


async def accept_finding(client: GraphClient, key: str, finding_id_: str, approver: str, session: str | None = None):
    """A person accepts a finding as it is (a drift finding, say): it stays on record, marked accepted."""
    finding = await findings_mod.accept(client, key, finding_id_, approver, session=session)
    bus.publish(key, "finding.accepted", {"id": finding.id, "kind": finding.kind, "accepted_by": approver})
    return finding


async def reject(client: GraphClient, key: str, mitigation_id: str, approver: str, reason: str | None,
                 session: str | None = None) -> Mitigation:
    mitigation = await apply_mod.reject(client, key, mitigation_id, approver, reason, session=session)
    bus.publish(key, "mitigation.rejected", {"id": mitigation.id, "rejected_by": approver, "reason": reason})
    return mitigation


async def apply(client: GraphClient, key: str, mitigation_id: str) -> ConfigPatch:
    patch = await apply_mod.apply_fix(client, key, mitigation_id)
    bus.publish(key, "mitigation.applied", {"id": mitigation_id, "patch": patch.model_dump()})
    return patch
