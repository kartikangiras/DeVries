"""One test per taint rule, plus the gates. Each builds the smallest config graph that shows the rule."""

from cistern.analysis import findings
from helpers import build, flows, gated, rebuild, set_call_gate, set_delegation_gate


async def test_rule1_data_enters_a_tool_that_reads_it(client, graph):
    await build(client, graph, sources=["tickets"], tools=["get"], reads=[("get", "tickets")])
    await rebuild(client, graph)
    assert await flows(client, graph) == {("src:tickets", 1, "tool:t.get")}


async def test_rule2_reading_tool_output_enters_its_caller(client, graph):
    await build(client, graph, sources=["tickets"], tools=["get", "noop"], agents=["a"],
                reads=[("get", "tickets")], calls=[("a", "get"), ("a", "noop")])
    await rebuild(client, graph)
    edges = await flows(client, graph)
    assert ("tool:t.get", 2, "agent:a") in edges
    assert ("tool:t.noop", 2, "agent:a") not in edges        # a tool that reads nothing returns nothing tainted


async def test_rule2_ignores_a_gate_on_a_read_tool(client, graph):
    await build(client, graph, sources=["tickets"], tools=["get"], agents=["a"],
                reads=[("get", "tickets")], calls=[("a", "get", "human_approval")])
    await rebuild(client, graph)
    assert ("tool:t.get", 2, "agent:a") in await flows(client, graph)   # approving the read does not clean what comes back


async def test_rule3_agent_drives_tools_that_act(client, graph):
    await build(client, graph, resources=["payments"], tools=["refund"], agents=["a"],
                writes=[("refund", "payments")], calls=[("a", "refund")])
    await rebuild(client, graph)
    assert ("agent:a", 3, "tool:t.refund") in await flows(client, graph)
    assert await gated(client, graph) == set()


async def test_rule3_respects_human_approval(client, graph):
    await build(client, graph, resources=["payments"], tools=["refund"], agents=["a"],
                writes=[("refund", "payments")], calls=[("a", "refund")])
    await set_call_gate(client, graph, "a", "refund", "human_approval")
    await rebuild(client, graph)
    assert ("agent:a", 3, "tool:t.refund") not in await flows(client, graph)
    assert await gated(client, graph) == {("agent:a", 3, "tool:t.refund", "human_approval")}
    await set_call_gate(client, graph, "a", "refund", None)             # and comes back when the gate goes
    await rebuild(client, graph)
    assert ("agent:a", 3, "tool:t.refund") in await flows(client, graph)
    assert await gated(client, graph) == set()


async def test_rule3_does_not_apply_to_read_only_tools(client, graph):
    await build(client, graph, sources=["crm"], tools=["search"], agents=["a"],
                reads=[("search", "crm")], calls=[("a", "search")])
    await rebuild(client, graph)
    edges = await flows(client, graph)
    assert ("agent:a", 3, "tool:t.search") not in edges
    assert await gated(client, graph) == set()


async def test_agents_sharing_only_a_read_tool_are_not_connected(client, graph):
    """Regression: with rule 3 on every grant, a -> search -> b looked like a path."""
    await build(client, graph, sources=["inbox", {"id": "src:crm", "name": "crm", "trust": "private"}],
                resources=["payments"], tools=["read_inbox", "search", "refund"], agents=["a", "b"],
                reads=[("read_inbox", "inbox"), ("search", "crm")], writes=[("refund", "payments")],
                calls=[("a", "read_inbox"), ("a", "search"), ("b", "search"), ("b", "refund")])
    await rebuild(client, graph)
    edges = await flows(client, graph)
    assert not any(a == "agent:a" and b == "tool:t.search" for a, _, b in edges)
    rows = await client.run("reach.untrusted_to_high", graph, max_depth=50)
    assert rows == []                                                   # inbox cannot reach payments through the shared search


async def test_rule4_context_passes_down_even_when_quarantined(client, graph):
    await build(client, graph, agents=["a", "b"], delegations=[("a", "b", "quarantine")])
    await rebuild(client, graph)
    assert ("agent:a", 4, "agent:b") in await flows(client, graph)


async def test_rule5_tool_acts_on_a_resource(client, graph):
    await build(client, graph, resources=["payments"], tools=["refund"], writes=[("refund", "payments")])
    await rebuild(client, graph)
    assert await flows(client, graph) == {("tool:t.refund", 5, "res:payments")}


async def test_rule6_results_return_unless_quarantined(client, graph):
    await build(client, graph, agents=["a", "b"], delegations=[("a", "b")])
    await rebuild(client, graph)
    assert ("agent:b", 6, "agent:a") in await flows(client, graph)

    await set_delegation_gate(client, graph, "a", "b", "quarantine")
    await rebuild(client, graph)
    edges = await flows(client, graph)
    assert ("agent:b", 6, "agent:a") not in edges
    assert ("agent:b", 6, "agent:a", "quarantine") in await gated(client, graph)
    assert ("agent:a", 4, "agent:b") in edges                            # context still passes down


async def test_rule7_what_is_written_to_a_store_is_read_back_from_it(client, graph):
    """Stored taint: two agents that never talk, joined by a note one writes and the other reads."""
    shape = dict(
        sources=["tickets", {"id": "src:notes", "name": "notes", "trust": "internal"}],
        resources=["payments", {"id": "res:notes-store", "name": "notes store", "impact": "low", "external": False}],
        tools=["get", "add_note", "read_notes", "refund"], agents=["bot", "assistant"],
        reads=[("get", "tickets"), ("read_notes", "notes")], writes=[("add_note", "notes-store"), ("refund", "payments")],
        calls=[("bot", "get"), ("bot", "add_note"), ("assistant", "read_notes"), ("assistant", "refund")],
    )
    await build(client, graph, **shape)
    assert (await findings.scan(client, graph)).findings == []       # without the feed the model cannot see it

    await client.run("ingest.feeds", graph, rows=[{"from_id": "res:notes-store", "to_id": "src:notes"}])
    await rebuild(client, graph)
    assert ("res:notes-store", 7, "src:notes") in await flows(client, graph)
    found = (await findings.scan(client, graph)).findings
    assert [(f.kind, f.source_id, f.target_id) for f in found] == [("injection", "src:tickets", "res:payments")]
    assert found[0].evidence[0].rules == [1, 2, 3, 5, 7, 1, 2, 3, 5]  # nine hops, through the store
    assert found[0].path_ids[4:6] == ["res:notes-store", "src:notes"]


async def test_rule7_has_no_fix_of_its_own(client, graph):
    from cistern import views
    from cistern.analysis.chokepoints import config_edge

    assert config_edge(7, "res:notes-store", "src:notes") is None
    behind = views.behind_hop(7, "res:notes-store", "src:notes")
    assert behind == {"config": {"rel": "FEEDS", "from_id": "res:notes-store", "to_id": "src:notes"}, "fixes": []}
