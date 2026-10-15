"""Scans, evidence, chokepoints, zones, the workflow check and the canary."""

import pytest

from cistern.analysis import canary, chokepoints, findings, zones
from cistern.analysis.models import Finding, PathEvidence
from cistern.errors import CanaryFailed
from helpers import broken, build, res, set_call_gate, src

PRIVATE = {"id": "src:crm", "name": "crm", "trust": "private"}
EXIT = {"id": "res:mail", "name": "mail", "impact": "medium", "external": True}


async def test_scan_finds_injection_with_its_path_and_stores_it(client, graph):
    await build(client, graph, sources=["tickets"], resources=["payments"], tools=["get", "refund"], agents=["a"],
                reads=[("get", "tickets")], writes=[("refund", "payments")], calls=[("a", "get"), ("a", "refund")])
    result = await findings.scan(client, graph)
    assert len(result.findings) == 1 and not result.partial
    found = result.findings[0]
    assert (found.kind, found.severity, found.status) == ("injection", "critical", "open")
    assert found.evidence[0].node_ids == ["src:tickets", "tool:t.get", "agent:a", "tool:t.refund", "res:payments"]
    assert found.evidence[0].rules == [1, 2, 3, 5]
    assert found.id.startswith("fnd:") and found.id == f"fnd:{found.fingerprint[:10]}"
    via = [r["id"] for r in await client.run("finding.via", graph, fingerprint=found.fingerprint)]
    assert via == found.path_ids                               # the audit trail in the graph matches the evidence


async def test_rescan_updates_in_place(client, graph):
    await build(client, graph, sources=["tickets"], resources=["payments"], tools=["get", "refund"], agents=["a"],
                reads=[("get", "tickets")], writes=[("refund", "payments")], calls=[("a", "get"), ("a", "refund")])
    first = await findings.scan(client, graph)
    second = await findings.scan(client, graph)
    assert [f.id for f in first.findings] == [f.id for f in second.findings]
    assert len(await client.run("finding.list", graph)) == 1    # one node, not one per scan
    assert len(await client.run("finding.via", graph, fingerprint=first.findings[0].fingerprint)) == 5
    assert second.closed_fingerprints == [] and second.reopened_fingerprints == []


async def test_trifecta_needs_all_three_legs(client, graph):
    await build(client, graph, sources=["inbox", PRIVATE], resources=[EXIT], tools=["read", "search", "send"],
                agents=["a"], reads=[("read", "inbox"), ("search", "crm")], writes=[("send", "mail")],
                calls=[("a", "read"), ("a", "search"), ("a", "send")])
    result = await findings.scan(client, graph)
    assert [(f.kind, f.agent_id, f.severity) for f in result.findings] == [("trifecta", "agent:a", "high")]
    found = result.findings[0]
    assert (found.untrusted_ids, found.private_ids, found.exit_ids) == (["src:inbox"], ["src:crm"], ["res:mail"])
    assert [e.leg for e in found.evidence] == ["untrusted", "private", "exit"]
    assert found.path_ids == ["src:inbox", "tool:t.read", "agent:a", "tool:t.send", "res:mail"]

    await set_call_gate(client, graph, "a", "send", "human_approval")     # take away the exit: no trifecta
    assert (await findings.scan(client, graph)).findings == []


async def test_trifecta_reaches_through_a_delegate_unless_quarantined(client, graph):
    """The assistant never reads the inbox itself; its reader does, and the results come back (rule 6)."""
    await build(client, graph, sources=["inbox", PRIVATE], resources=[EXIT], tools=["read", "search", "send"],
                agents=["assistant", "reader"], reads=[("read", "inbox"), ("search", "crm")], writes=[("send", "mail")],
                calls=[("reader", "read"), ("assistant", "search"), ("assistant", "send")],
                delegations=[("assistant", "reader")])
    first = await findings.scan(client, graph)
    assert {f.agent_id for f in first.findings} == {"agent:assistant", "agent:reader"}

    await client.run("ingest.delegates_to", graph, rows=[
        {"from_id": "agent:assistant", "to_id": "agent:reader", "gate": "quarantine", "origin": "test"}])
    assert (await findings.scan(client, graph)).findings == []


async def test_three_unrelated_findings_are_all_found(client, graph):
    await build(
        client, graph,
        sources=["tickets", "issues", "inbox", PRIVATE],
        resources=["payments", "repo", EXIT],
        tools=["get", "refund", "issue", "push", "read", "search", "send"],
        agents=["support", "coder", "assistant"],
        reads=[("get", "tickets"), ("issue", "issues"), ("read", "inbox"), ("search", "crm")],
        writes=[("refund", "payments"), ("push", "repo"), ("send", "mail")],
        calls=[("support", "get"), ("support", "refund"), ("coder", "issue"), ("coder", "push"),
               ("assistant", "read"), ("assistant", "search"), ("assistant", "send")],
    )
    result = await findings.scan(client, graph)
    assert sorted((f.kind, f.source_id or f.agent_id, f.target_id) for f in result.findings) == [
        ("injection", "src:issues", "res:repo"),
        ("injection", "src:tickets", "res:payments"),
        ("trifecta", "agent:assistant", None),
    ]
    assert all(f.evidence for f in result.findings)


async def test_a_far_target_still_has_evidence_past_many_nearer_nodes(client, graph):
    """Regression: a cap of 50 paths from the source, applied before filtering to the target, starved this."""
    decoys = [f"d{i}" for i in range(60)]
    await build(
        client, graph, sources=["tickets"],
        resources=["payments"] + [res(d, impact="low") for d in decoys],
        tools=["get", "refund"] + [f"w{i}" for i in range(60)], agents=["first", "last"],
        reads=[("get", "tickets")],
        writes=[("refund", "payments")] + [(f"w{i}", f"d{i}") for i in range(60)],
        calls=[("first", "get"), ("last", "refund")] + [("first", f"w{i}") for i in range(60)],
        delegations=[("first", "last")],
    )
    result = await findings.scan(client, graph)
    assert [(f.source_id, f.target_id) for f in result.findings] == [("src:tickets", "res:payments")]
    assert result.findings[0].evidence[0].node_ids[-1] == "res:payments"


async def test_a_path_longer_than_the_evidence_limit_is_reported_with_its_path(client, graph):
    """Regression: a verdict depth of 12 missed this; the evidence limit must lift rather than drop it."""
    chain = [f"a{i}" for i in range(13)]
    await build(client, graph, sources=["tickets"], resources=["payments"], tools=["get", "refund"], agents=chain,
                reads=[("get", "tickets")], writes=[("refund", "payments")],
                calls=[("a0", "get"), ("a12", "refund")],
                delegations=[(chain[i], chain[i + 1]) for i in range(12)])
    result = await findings.scan(client, graph)
    assert len(result.findings) == 1
    found = result.findings[0]
    assert len(found.evidence[0].rules) == 16 and found.evidence_lifted


async def test_current_reads_without_writing(client, graph):
    await build(client, graph, sources=["tickets"], resources=["payments"], tools=["get", "refund"], agents=["a"],
                reads=[("get", "tickets")], writes=[("refund", "payments")], calls=[("a", "get"), ("a", "refund")])
    await client.run("projection.rebuild", graph)
    found, partial = await findings.current(client, graph)
    assert len(found) == 1 and not partial
    assert await client.run("finding.list", graph) == []          # nothing stored


def test_chokepoints_map_hops_back_to_config_edges():
    paths = [
        PathEvidence(node_ids=["src:s", "tool:t.get", "agent:r", "agent:a", "tool:t.pay", "res:p"], rules=[1, 2, 6, 3, 5]),
        PathEvidence(node_ids=["src:s", "tool:t.get", "agent:r", "agent:a", "agent:b", "tool:t.pay", "res:p"], rules=[1, 2, 6, 4, 3, 5]),
    ]
    report = chokepoints.from_paths([Finding(id="fnd:x", fingerprint="x", kind="injection", severity="critical", evidence=paths)])
    ranked = {(e.edge.rel, e.edge.from_id, e.edge.to_id, e.edge.rule): (e.score, e.fixes) for e in report.edges}
    assert ranked[("READS", "tool:t.get", "src:s", 1)] == (2.0, ["drop_read"])
    assert ranked[("CAN_CALL", "agent:r", "tool:t.get", 2)] == (2.0, ["revoke_call"])
    assert ranked[("DELEGATES_TO", "agent:a", "agent:r", 6)] == (2.0, ["quarantine_delegation"])     # delegator -> delegate
    assert ranked[("CAN_CALL", "agent:a", "tool:t.pay", 3)] == (1.0, ["revoke_call", "gate_call"])
    assert ranked[("CAN_CALL", "agent:b", "tool:t.pay", 3)] == (1.0, ["revoke_call", "gate_call"])
    assert not any(e.edge.rule in (4, 5) for e in report.edges)   # no fix cuts a delegation going down or a tool's write
    assert report.edges[0].score == 2.0                           # most-crossed edges first


async def test_betweenness_and_zones_run_on_the_flow_layer(client, graph):
    await build(client, graph, sources=["tickets", src("lonely", "internal")], resources=["payments"],
                tools=["get", "refund", "idle"], agents=["a"],
                reads=[("get", "tickets"), ("idle", "lonely")], writes=[("refund", "payments")],
                calls=[("a", "get"), ("a", "refund")])
    await client.run("projection.rebuild", graph)
    report = await chokepoints.betweenness(client, graph)
    assert report.method == "betweenness" and report.nodes[0].id == "agent:a"
    found = await zones.trust_zones(client, graph)
    blast = [z for z in found if z.is_blast_zone]
    assert len(blast) == 1 and {"src:tickets", "res:payments", "agent:a"} <= set(blast[0].members)
    assert any({"src:lonely", "tool:t.idle"} == set(z.members) and not z.is_blast_zone for z in found)


async def test_workflow_check_knows_supervised_from_autonomous(client, graph):
    await build(
        client, graph, sources=["tickets"], resources=["payments"], tools=["get", "refund"], agents=["a", "helper"],
        workflows=[{"id": "wf:desk", "name": "desk", "description": None, "mode": "supervised"},
                   {"id": "wf:batch", "name": "batch", "description": None, "mode": "autonomous"}],
        reads=[("get", "tickets")], writes=[("refund", "payments")],
        calls=[("helper", "get"), ("helper", "refund")], delegations=[("a", "helper", "quarantine")],
        run_by=[("desk", "a"), ("batch", "a")], needs=[("desk", "refund"), ("batch", "refund")],
        needs_data=[("desk", "tickets"), ("batch", "tickets")],
    )
    assert await broken(client, graph) == set()                   # reachable through a quarantined delegate

    await set_call_gate(client, graph, "helper", "refund", "human_approval")
    assert await broken(client, graph) == {("wf:batch", "tool", "tool:t.refund")}   # a person in the loop breaks only the unattended one

    await set_call_gate(client, graph, "helper", "refund", None)
    assert await broken(client, graph) == set()


async def test_workflow_check_reports_missing_tools_and_data(client, graph):
    await build(
        client, graph, sources=["tickets", src("orders", "internal")], resources=["payments"],
        tools=["get", "refund"], agents=["a"], workflows=["desk"],
        reads=[("get", "tickets")], writes=[("refund", "payments")], calls=[("a", "get")],
        run_by=[("desk", "a")], needs=[("desk", "refund")], needs_data=[("desk", "tickets"), ("desk", "orders")],
    )
    assert await broken(client, graph) == {("wf:desk", "tool", "tool:t.refund"), ("wf:desk", "data", "src:orders")}


async def test_canary_passes_and_cleans_up(client):
    before = set(await client.list_graphs())
    result = await canary.run_canary(client)
    assert result.ok, result.detail
    assert set(await client.list_graphs()) == before


async def test_canary_fails_loudly_when_a_verdict_query_returns_nothing(client, monkeypatch):
    """What a BFS depth of 0 does: every query succeeds and nothing is found."""
    real_run = client.run

    async def blind(name, graph_key, **params):
        if name == "reach.untrusted_to_high":
            params["max_depth"] = 0
        return await real_run(name, graph_key, **params)

    monkeypatch.setattr(client, "run", blind)
    result = await canary.run_canary(client)
    assert not result.ok and "injection" in result.detail
    canary._last.pop(id(client), None)
    with pytest.raises(CanaryFailed):
        await canary.ensure(client, ttl_s=0)


async def test_a_scan_leaves_one_record_of_itself(client, graph):
    await build(client, graph, sources=["tickets"], resources=["payments"], tools=["get", "refund"], agents=["bot"],
                reads=[("get", "tickets")], writes=[("refund", "payments")], calls=[("bot", "get"), ("bot", "refund")])
    assert await findings.last_scan(client, graph) is None           # loaded, never scanned
    first = await findings.scan(client, graph)
    record = await findings.last_scan(client, graph)
    assert (record["scan_id"], record["at"], record["injection"], record["trifecta"]) == (first.scan_id, first.started_at, 1, 0)
    second = await findings.scan(client, graph)
    again = await findings.last_scan(client, graph)
    assert again["scan_id"] == second.scan_id != first.scan_id
    rows = await client.graph(graph).ro_query("MATCH (s:Scan) RETURN count(s)")
    assert rows.result_set[0][0] == 1                                # one record, overwritten, however often it scans


async def test_mincut_is_the_cheapest_cut_and_knows_when_there_is_none(client, graph):
    # two ways from the tickets to the payments, through two agents; cutting both reads costs 2, both refunds 2
    await build(client, graph, sources=["tickets"], resources=["payments"], tools=["get", "refund"], agents=["a", "b"],
                reads=[("get", "tickets")], writes=[("refund", "payments")],
                calls=[("a", "get"), ("a", "refund"), ("b", "get"), ("b", "refund")])
    await findings.scan(client, graph)
    report = await chokepoints.mincut(client, graph)
    assert report.method == "mincut" and report.cut_cost == 2
    assert sorted((e.edge.rel, e.edge.from_id, e.edge.to_id, e.edge.rule, e.fixes) for e in report.edges) == [
        ("CAN_CALL", "agent:a", "tool:t.get", 2, ["revoke_call"]), ("CAN_CALL", "agent:b", "tool:t.get", 2, ["revoke_call"])]

    # gate both refunds: nothing untrusted reaches the payments any more, so the flow is zero and nothing is cut
    await set_call_gate(client, graph, "a", "refund", "human_approval")
    await set_call_gate(client, graph, "b", "refund", "human_approval")
    await findings.scan(client, graph)
    closed = await chokepoints.mincut(client, graph)
    assert closed.cut_cost == 0 and closed.edges == []


async def test_mincut_without_a_source_or_a_target_is_empty(client, graph):
    await build(client, graph, sources=[src("crm", "private")], resources=[res("mail", "medium", True)], tools=["search", "send"],
                agents=["a"], reads=[("search", "crm")], writes=[("send", "mail")], calls=[("a", "search"), ("a", "send")])
    await findings.scan(client, graph)
    report = await chokepoints.mincut(client, graph)
    assert (report.cut_cost, report.edges) == (0, [])
