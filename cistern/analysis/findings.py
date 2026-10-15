"""Scans: turn a working graph into findings, each with evidence a person can follow.

`compute` only reads. `scan` rebuilds the projection, computes, and writes the
findings back as audit nodes. The same graph always gives the same scan.
"""

import json
import time
from secrets import token_hex

from cistern.errors import NotFound
from cistern.analysis.models import (
    STANDING_KINDS, drift_fingerprint, poison_fingerprint,
    Finding, PathEvidence, ScanResult, finding_id, injection_fingerprint, trifecta_fingerprint,
)
from cistern.errors import QueryTimeout
from cistern.graph import projection
from cistern.graph.client import GraphClient

EVIDENCE_PATHS = 10       # paths fetched per source and sink
EVIDENCE_MAX_HOPS = 12    # hop limit for evidence only; verdicts have none
ROUTE_COUNT_CAP = 50      # how far a finding's routes are counted once more than EVIDENCE_PATHS exist


async def _paths(client: GraphClient, graph_key: str, source_id: str, target_id: str,
                 nodes: int, k: int, leg: str = "path") -> tuple[list[PathEvidence], bool]:
    """Paths from source to sink, fewest hops first. If none fits the hop limit, lift it for one."""
    rows = await client.run("evidence.pair_paths", graph_key, source_id=source_id, target_id=target_id,
                            max_len=EVIDENCE_MAX_HOPS, k=k)
    lifted = False
    if not rows:
        rows = await client.run("evidence.pair_paths", graph_key, source_id=source_id, target_id=target_id,
                                max_len=max(nodes, 1), k=1)
        lifted = bool(rows)
    return [PathEvidence(node_ids=r["node_ids"], rules=r["rules"], leg=leg) for r in rows], lifted


async def compute(client: GraphClient, graph_key: str) -> tuple[list[Finding], bool]:
    """Findings in the graph as its projection stands. Reads only. Returns (findings, partial)."""
    nodes = (await client.run("graph.node_count", graph_key))[0]["nodes"]
    # Depth = node count: no simple path is longer, so a search never stops early.
    # It has to be positive: a depth of 0 returns nothing at all.
    depth = max(nodes, 1)
    reach = await client.run("reach.untrusted_to_high", graph_key, max_depth=depth)
    trifecta = await client.run("find.trifecta", graph_key, max_depth=depth)

    findings: list[Finding] = []
    partial = False

    for row in sorted(reach, key=lambda r: r["source"]):
        for target in sorted(row["targets"]):
            fingerprint = injection_fingerprint(row["source"], target)
            evidence, lifted = [], False
            routes: int | None = None
            try:
                evidence, lifted = await _paths(client, graph_key, row["source"], target, nodes, EVIDENCE_PATHS)
                routes = len(evidence)
                if len(evidence) >= EVIDENCE_PATHS:          # more may exist: count them, up to the cap
                    counted = await client.run("evidence.pair_count", graph_key, source_id=row["source"], target_id=target,
                                               max_len=EVIDENCE_MAX_HOPS, k=ROUTE_COUNT_CAP)
                    routes = counted[0]["routes"] if counted else len(evidence)
            except QueryTimeout:
                partial = True
            findings.append(Finding(
                id=finding_id(fingerprint), fingerprint=fingerprint, kind="injection", severity="critical",
                source_id=row["source"], target_id=target, evidence=evidence, evidence_lifted=lifted,
                routes=routes, routes_capped=routes is not None and routes >= ROUTE_COUNT_CAP,
            ))

    for row in sorted(trifecta, key=lambda r: r["agent"]):
        agent = row["agent"]
        untrusted, private, exits = sorted(row["untrusted"]), sorted(row["private_data"]), sorted(row["exits"])
        fingerprint = trifecta_fingerprint(agent)
        evidence: list[PathEvidence] = []
        lifted = False
        try:
            for leg, source_id, target_id in (("untrusted", untrusted[0], agent),
                                              ("private", private[0], agent),
                                              ("exit", agent, exits[0])):
                paths, was_lifted = await _paths(client, graph_key, source_id, target_id, nodes, 1, leg)
                evidence += paths
                lifted = lifted or was_lifted
        except QueryTimeout:
            partial = True
        findings.append(Finding(
            id=finding_id(fingerprint), fingerprint=fingerprint, kind="trifecta", severity="high",
            agent_id=agent, untrusted_ids=untrusted, private_ids=private, exit_ids=exits,
            evidence=evidence, evidence_lifted=lifted,
        ))

    return findings, partial


def _details(finding: Finding) -> str:
    return json.dumps({
        "evidence": [e.model_dump() for e in finding.evidence],
        "evidence_lifted": finding.evidence_lifted,
        "routes": finding.routes,
        "routes_capped": finding.routes_capped,
        "server_id": finding.server_id,
        "drift": finding.drift,
        "tool_id": finding.tool_id,
        "flags": finding.flags,
        "untrusted_ids": finding.untrusted_ids,
        "private_ids": finding.private_ids,
        "exit_ids": finding.exit_ids,
    }, separators=(",", ":"))


def _from_row(row: dict) -> Finding:
    details = json.loads(row["evidence_json"]) if row.get("evidence_json") else {}
    return Finding(
        id=row["id"], fingerprint=row["fingerprint"], kind=row["kind"], severity=row["severity"],
        status=row["status"], source_id=row.get("source_id"), target_id=row.get("target_id"),
        agent_id=row.get("agent_id"),
        evidence=[PathEvidence(**e) for e in details.get("evidence", [])],
        evidence_lifted=details.get("evidence_lifted", False),
        routes=details.get("routes"),
        routes_capped=details.get("routes_capped", False),
        server_id=details.get("server_id"),
        drift=details.get("drift"),
        tool_id=details.get("tool_id"),
        flags=details.get("flags", []),
        accepted_by=row.get("accepted_by"),
        untrusted_ids=details.get("untrusted_ids", []),
        private_ids=details.get("private_ids", []),
        exit_ids=details.get("exit_ids", []),
    )


async def stored(client: GraphClient, graph_key: str) -> list[Finding]:
    """The findings written to the graph by the last scans, whatever their status."""
    return [_from_row(row) for row in await client.run("finding.list", graph_key)]


async def open_drift(client: GraphClient, graph_key: str, server_id: str, manifest_hash: str, changes: dict) -> Finding:
    """A server's manifest is not the one loaded before: a finding that stands until a person accepts it.
    One per manifest the server was seen with, so accepting one does not accept the next."""
    fingerprint = drift_fingerprint(server_id, manifest_hash)
    finding = Finding(id=finding_id(fingerprint), fingerprint=fingerprint, kind="drift", severity="medium",
                      server_id=server_id, drift=changes)
    now = int(time.time() * 1000)
    row = (await client.run("finding.upsert", graph_key, fingerprint=fingerprint, id=finding.id, kind="drift",
                            severity="medium", source_id=None, target_id=None, agent_id=None, path_ids=[],
                            evidence_json=_details(finding), now=now))[0]
    finding.status = row["status"]
    return finding


async def open_poisoned(client: GraphClient, graph_key: str, tool_id: str, description_hash: str, flags: list[dict],
                        on_path: bool) -> Finding:
    """A tool's description reads as an instruction to a model, or hides text, or reaches for another tool.
    High when the tool sits on an open finding's path, medium otherwise. Stands until a person accepts it."""
    fingerprint = poison_fingerprint(tool_id, description_hash)
    finding = Finding(id=finding_id(fingerprint), fingerprint=fingerprint, kind="poisoned_description",
                      severity="high" if on_path else "medium", tool_id=tool_id, flags=flags)
    now = int(time.time() * 1000)
    row = (await client.run("finding.upsert", graph_key, fingerprint=fingerprint, id=finding.id, kind=finding.kind,
                            severity=finding.severity, source_id=None, target_id=None, agent_id=None, path_ids=[tool_id],
                            evidence_json=_details(finding), now=now))[0]
    await client.run("finding.clear_via", graph_key, fingerprint=fingerprint)
    await client.run("finding.set_via", graph_key, fingerprint=fingerprint, path_ids=[tool_id])   # so the tool's page lists it
    finding.status = row["status"]
    return finding


async def accept(client: GraphClient, graph_key: str, finding_id_: str, who: str) -> Finding:
    """A person accepts an open finding as it is. Only a person can; no tool offers it."""
    rows = await client.run("finding.accept", graph_key, id=finding_id_, who=who, now=int(time.time() * 1000))
    if not rows:
        raise NotFound(f"{finding_id_} is not an open finding in this scenario")
    return next(f for f in await stored(client, graph_key) if f.id == finding_id_)


async def current(client: GraphClient, graph_key: str) -> tuple[list[Finding], bool]:
    """Findings that hold right now, with the status of any stored finding of the same fingerprint.
    Reads only: it trusts the projection, which every config change rebuilds."""
    findings, partial = await compute(client, graph_key)
    kept = await stored(client, graph_key)
    status = {f.fingerprint: f.status for f in kept}
    for finding in findings:
        known = status.get(finding.fingerprint)
        # a stored finding that was closed or mitigated and holds again is open in fact
        finding.status = known if known in ("open", "accepted") else "open"
    # a standing finding (drift, a poisoned description) is not recomputed from the graph: it stays until a person accepts it
    findings += [f for f in kept if f.kind in STANDING_KINDS and f.status in ("open", "accepted")]
    return findings, partial


async def last_scan(client: GraphClient, graph_key: str) -> dict | None:
    """When this graph was last scanned and what the scan found, or None if it never was."""
    rows = await client.run("scan.last", graph_key)
    return rows[0] if rows else None


async def scan(client: GraphClient, graph_key: str) -> ScanResult:
    started_at = int(time.time() * 1000)
    t0 = time.monotonic()

    await projection.rebuild(client, graph_key)       # cheap, and rules out a stale projection
    findings, partial = await compute(client, graph_key)
    drifted = [f for f in await stored(client, graph_key) if f.kind in STANDING_KINDS and f.status in ("open", "accepted")]

    opened: list[str] = []
    reopened: list[str] = []
    for finding in findings:
        row = (await client.run(
            "finding.upsert", graph_key,
            fingerprint=finding.fingerprint, id=finding.id, kind=finding.kind, severity=finding.severity,
            source_id=finding.source_id, target_id=finding.target_id, agent_id=finding.agent_id,
            path_ids=finding.path_ids, evidence_json=_details(finding), now=started_at,
        ))[0]
        finding.status = row["status"]
        if row["reopened"]:
            reopened.append(finding.fingerprint)
        elif row["created_at"] == started_at:
            opened.append(finding.fingerprint)
        await client.run("finding.clear_via", graph_key, fingerprint=finding.fingerprint)
        if finding.path_ids:
            await client.run("finding.set_via", graph_key, fingerprint=finding.fingerprint, path_ids=finding.path_ids)

    closed = await client.run("finding.close_stale", graph_key,
                              present=[f.fingerprint for f in findings + drifted], now=started_at)
    findings += drifted                               # they are still findings on the desk

    scan_id = f"scan:{token_hex(4)}"
    duration_ms = int((time.monotonic() - t0) * 1000)
    # one record per graph, so a page can say when it was last scanned even when nothing was found
    await client.run("scan.record", graph_key, scan_id=scan_id, at=started_at, duration_ms=duration_ms,
                     injection=sum(f.kind == "injection" for f in findings),
                     trifecta=sum(f.kind == "trifecta" for f in findings), partial=partial)

    return ScanResult(
        graph=graph_key, scan_id=scan_id, started_at=started_at,
        duration_ms=duration_ms, findings=findings,
        opened_fingerprints=sorted(opened),
        closed_fingerprints=sorted(r["fingerprint"] for r in closed),
        mitigated_fingerprints=sorted(r["fingerprint"] for r in closed if r["status"] == "mitigated"),
        reopened_fingerprints=sorted(reopened), partial=partial,
    )
