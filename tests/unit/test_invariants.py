"""The six invariants of the projection (PLAN.md section 5), with rule 7 as the one exception to the fourth."""

from helpers import build, flows, gated, rebuild, set_call_gate

from devries.analysis import findings
from devries.graph.projection import SIGNATURES

BUSY = dict(
    sources=["tickets", {"id": "src:crm", "name": "crm", "trust": "private"}],
    resources=["payments", {"id": "res:mail", "name": "mail", "impact": "medium", "external": True}],
    tools=["get", "search", "refund", "send", "fetch"],
    agents=["a", "b", "c"],
    reads=[("get", "tickets"), ("search", "crm"), ("fetch", "tickets")],
    writes=[("refund", "payments"), ("send", "mail"), ("fetch", "mail")],     # fetch both reads and writes
    calls=[("a", "get"), ("a", "refund"), ("b", "search"), ("b", "send", "human_approval"), ("c", "fetch")],
    delegations=[("a", "b"), ("b", "c", "quarantine")],
    feeds=[("mail", "crm")],                                                   # sent mail is filed in the CRM
)


async def test_1_rebuild_is_idempotent(client, graph):
    await build(client, graph, **BUSY)
    await rebuild(client, graph)
    first = (await client.run("flow.edges", graph), await client.run("flow.gated_edges", graph))
    await rebuild(client, graph)
    second = (await client.run("flow.edges", graph), await client.run("flow.gated_edges", graph))
    assert first == second and len(first[0]) > 0 and len(first[1]) > 0


async def test_2_projection_depends_only_on_config_edges_and_gates(client, graph):
    await build(client, graph, **BUSY)
    await rebuild(client, graph)
    before = await flows(client, graph), await gated(client, graph)
    # change everything that is not a config edge or a gate
    await client.run("ingest.agents", graph, rows=[{"id": "agent:a", "name": "renamed", "owner": "someone"}])
    await client.run("ingest.data_sources", graph, rows=[{"id": "src:tickets", "name": "renamed", "trust": "internal"}])
    await client.run("ingest.resources", graph, rows=[{"id": "res:payments", "name": "renamed", "impact": "low", "external": True}])
    await rebuild(client, graph)
    assert (await flows(client, graph), await gated(client, graph)) == before


async def test_3_every_derived_edge_has_a_rule_and_matching_labels(client, graph):
    await build(client, graph, **BUSY)
    await rebuild(client, graph)
    rows = await client.run("flow.edges", graph) + await client.run("flow.gated_edges", graph)
    assert rows
    for row in rows:
        assert row["rule"] in SIGNATURES
        assert (row["from_label"], row["to_label"]) == SIGNATURES[row["rule"]], row
    assert {r["rule"] for r in await client.run("flow.gated_edges", graph)} <= {3, 6}


async def test_4_no_flow_starts_at_a_resource_or_ends_at_a_data_source_except_a_feed(client, graph):
    await build(client, graph, **BUSY)
    await rebuild(client, graph)
    rows = await client.run("flow.edges", graph)
    for row in rows:
        if row["rule"] == 7:                                     # stored taint: a resource feeds a data source
            assert (row["from_label"], row["to_label"]) == ("Resource", "DataSource"), row
        else:
            assert row["from_label"] != "Resource" and row["to_label"] != "DataSource", row
    assert [(r["from_id"], r["to_id"]) for r in rows if r["rule"] == 7] == [("res:mail", "src:crm")]


async def test_5_gates_remove_exactly_their_flow_edge(client, graph):
    await build(client, graph, **BUSY)
    await rebuild(client, graph)
    edges, held = await flows(client, graph), await gated(client, graph)
    assert ("agent:b", 3, "tool:t.send") not in edges and ("agent:b", 3, "tool:t.send", "human_approval") in held
    assert ("agent:c", 6, "agent:b") not in edges and ("agent:c", 6, "agent:b", "quarantine") in held
    assert ("agent:b", 4, "agent:c") in edges                    # quarantine does not stop context going down
    # a grant to a tool that writes nothing yields no rule-3 edge of either kind
    assert not any(rule == 3 and to in ("tool:t.get", "tool:t.search") for _, rule, to in edges)
    assert not any(rule == 3 and to in ("tool:t.get", "tool:t.search") for _, rule, to, _ in held)


async def test_6_an_open_finding_exists_exactly_when_its_fact_holds(client, graph):
    await build(client, graph, sources=["tickets"], resources=["payments"], tools=["get", "refund"], agents=["a"],
                reads=[("get", "tickets")], writes=[("refund", "payments")], calls=[("a", "get"), ("a", "refund")])
    first = await findings.scan(client, graph)
    assert [(f.kind, f.source_id, f.target_id, f.status) for f in first.findings] == \
        [("injection", "src:tickets", "res:payments", "open")]
    fingerprint = first.findings[0].fingerprint

    await set_call_gate(client, graph, "a", "refund", "human_approval")      # the fact stops holding
    second = await findings.scan(client, graph)
    assert second.findings == [] and second.closed_fingerprints == [fingerprint]
    stored = await findings.stored(client, graph)
    assert [(f.fingerprint, f.status) for f in stored] == [(fingerprint, "closed")]

    await set_call_gate(client, graph, "a", "refund", None)                  # and holds again
    third = await findings.scan(client, graph)
    assert third.reopened_fingerprints == [fingerprint]
    stored = await findings.stored(client, graph)
    assert [(f.fingerprint, f.status) for f in stored] == [(fingerprint, "open")]   # reopened in place, not duplicated
    row = (await client.run("finding.list", graph))[0]
    assert row["reopened_at"] is not None and row["created_at"] == first.started_at
