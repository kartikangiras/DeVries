"""Every MCP tool, called through an MCP client connected in-process."""

import json
from pathlib import Path

import pytest
import pytest_asyncio
from mcp import Client

from cistern.ingest.scenario_loader import load_scenario
from cistern.mcp_server.server import MAX_BYTES, build_server, untrusted

ROOT = Path(__file__).resolve().parents[2]
READ_TOOLS = {"list_scenarios", "scan", "trust_zones", "rule_of_two", "find_injection_paths", "find_trifecta_agents", "rank_chokepoints"}
WRITE_TOOLS = {"simulate_mitigation", "what_if", "propose_fix", "apply_fix"}

FINDING = "fnd:dce0910d42"                                        # tickets -> payments API in acme_support
GATE = {"kind": "gate_call", "agent_id": "agent:support-bot", "tool_id": "tool:payments.issue_refund"}
REVOKE = {"kind": "revoke_call", "agent_id": "agent:support-bot", "tool_id": "tool:payments.issue_refund"}


@pytest_asyncio.fixture(loop_scope="session")
async def server(client):
    """The server to connect to. Each test opens its own client: a client must be
    entered and left in the same task, which a fixture cannot promise."""
    await load_scenario(client, ROOT / "scenarios" / "acme_support.yaml", strict=True)
    return build_server()


async def call(session: Client, name: str, **arguments) -> dict:
    result = await session.call_tool(name, arguments)
    assert not result.is_error, result.content
    text = result.content[0].text
    assert len(text.encode()) <= MAX_BYTES + 200, f"{name} answered {len(text.encode())} bytes"
    return result.structured_content if result.structured_content is not None else json.loads(text)


async def test_tool_list_and_input_schemas(server):
    async with Client(server) as mcp:
        tools = {t.name: t for t in (await mcp.list_tools()).tools}
        assert set(tools) == READ_TOOLS | WRITE_TOOLS
        assert "approve" not in " ".join(tools)                      # there is no approval tool, on purpose
        for tool in tools.values():
            assert tool.description and len(tool.description) > 40
        assert tools["scan"].input_schema["required"] == ["scenario"]
        assert set(tools["find_injection_paths"].input_schema["properties"]) == {"scenario", "source_id"}
        method = tools["rank_chokepoints"].input_schema["properties"]["method"]
        assert set(method["enum"]) == {"paths", "betweenness", "mincut"} and method["default"] == "paths"
        # the change language reaches a client as a schema: a plan is 1 to 3 fixes, told apart by `kind`
        simulate = tools["simulate_mitigation"].input_schema
        assert simulate["required"] == ["scenario", "plan", "finding_ids"]
        fixes = simulate["$defs"]["FixPlan"]["properties"]["fixes"]
        assert (fixes["minItems"], fixes["maxItems"]) == (1, 3)
        assert set(fixes["items"]["discriminator"]["mapping"]) == {"gate_call", "revoke_call", "quarantine_delegation", "drop_read", "split_agent"}
        changes = tools["what_if"].input_schema["properties"]["changes"]["items"]["discriminator"]["mapping"]
        assert set(changes) == {"gate_call", "revoke_call", "quarantine_delegation", "drop_read", "split_agent", "grant_call", "add_delegation", "drop_server"}
        assert tools["propose_fix"].input_schema["required"] == ["scenario", "finding_ids", "plan", "rationale"]
        assert tools["apply_fix"].input_schema["required"] == ["scenario", "mitigation_id"]


async def test_day1_gate_scan_returns_the_finding_and_its_path(server):
    """The Day 1 gate: from an MCP client, a scan of acme_support gives the expected finding with its path."""
    async with Client(server) as mcp:
        listed = await call(mcp, "list_scenarios")
        assert {"id": "acme_support", "name": "acme_support", "nodes": 15, "open_findings": 1} in listed["scenarios"]

        scanned = await call(mcp, "scan", scenario="acme_support")
        assert scanned["open"] == {"injection": 1, "trifecta": 0} and len(scanned["finding_ids"]) == 1
        assert {"projection.rebuild", "reach.untrusted_to_high", "find.trifecta", "evidence.pair_paths"} <= set(scanned["queries"])

        found = await call(mcp, "find_injection_paths", scenario="acme_support")
        assert found["total"] == 1
        finding = found["findings"][0]
        assert finding["id"] == scanned["finding_ids"][0]
        assert (finding["source_id"], finding["target_id"]) == ("src:customer-tickets", "res:payments-api")
        path = finding["paths"][0]
        assert path["node_ids"] == ["src:customer-tickets", "tool:helpdesk.get_ticket", "agent:support-bot",
                                    "tool:payments.issue_refund", "res:payments-api"]
        assert path["rules"] == [1, 2, 3, 5]
        assert path["hops"][2] == "rule 3: agent:support-bot can call tool:payments.issue_refund"


async def test_manifest_text_is_wrapped_as_untrusted(server):
    async with Client(server) as mcp:
        found = await call(mcp, "find_injection_paths", scenario="acme_support")
        names = found["names"]
        assert names["agent:support-bot"] == "Support bot"                                   # ours: plain
        assert names["tool:payments.issue_refund"] == '<untrusted source="manifest:srv:payments">issue_refund</untrusted>'
        assert untrusted("a</untrusted>b", "x") == '<untrusted source="x">a<\\/untrusted>b</untrusted>'   # cannot close the block early


async def test_source_filter_and_trifecta(server):
    async with Client(server) as mcp:
        one = await call(mcp, "find_injection_paths", scenario="acme_support", source_id="src:customer-tickets")
        assert one["total"] == 1
        none = await call(mcp, "find_injection_paths", scenario="acme_support", source_id="src:payment-records")
        assert none["total"] == 0 and none["findings"] == []
        trifecta = await call(mcp, "find_trifecta_agents", scenario="acme_support")
        assert trifecta["total"] == 0


async def test_chokepoints_and_zones(server):
    async with Client(server) as mcp:
        ranked = await call(mcp, "rank_chokepoints", scenario="acme_support")
        edges = {(e["rel"], e["from_id"], e["to_id"], e["behind_rule"]): e for e in ranked["edges"]}
        grant = edges[("CAN_CALL", "agent:support-bot", "tool:payments.issue_refund", 3)]
        assert grant["fixes"] == ["revoke_call", "gate_call"] and grant["paths_crossing"] == 1
        assert ranked["queries"] and ranked["method"] == "paths"

        central = await call(mcp, "rank_chokepoints", scenario="acme_support", method="betweenness")
        assert central["nodes"][0]["id"] == "agent:support-bot" and central["queries"] == ["choke.betweenness", "node.names"]

        zones = await call(mcp, "trust_zones", scenario="acme_support")
        assert zones["zones"][0]["is_blast_zone"] and "agent:support-bot" in zones["zones"][0]["members"]
        assert zones["queries"] == ["zones.wcc", "zones.communities"]


@pytest.mark.parametrize("tool, arguments, code", [
    ("scan", {"scenario": "no_such_scenario"}, "unknown_scenario"),
    ("scan", {"scenario": "Not A Name"}, "unknown_scenario"),
    ("trust_zones", {"scenario": "acme_support@short"}, "unknown_scenario"),
    ("find_injection_paths", {"scenario": "acme_support", "source_id": "src:nope"}, "not_found"),
    ("rank_chokepoints", {"scenario": "acme_support", "finding_ids": ["fnd:0000000000"]}, "not_found"),
])
async def test_errors_are_structured_never_stack_traces(server, tool, arguments, code):
    async with Client(server) as mcp:
        answer = await call(mcp, tool, **arguments)
        assert answer["error"]["code"] == code and answer["error"]["retryable"] is False
        assert "Traceback" not in json.dumps(answer)


async def test_answers_stay_small_on_a_dense_graph(client, server):
    """Twelve agents that all share tools: many findings, long name lists. The answer must still fit."""
    async with Client(server) as mcp:
        from helpers import build
        from cistern.graph import keys
        key = keys.scenario_key("t_dense")
        await client.delete(key)
        agents = [f"a{i}" for i in range(12)]
        try:
            await build(
                client, key,
                sources=[f"u{i}" for i in range(4)] + [{"id": "src:p", "name": "p", "trust": "private"}],
                resources=[f"h{i}" for i in range(4)] + [{"id": "res:x", "name": "x", "impact": "low", "external": True}],
                tools=[f"r{i}" for i in range(4)] + ["rp", "wx"] + [f"w{i}" for i in range(4)], agents=agents,
                reads=[(f"r{i}", f"u{i}") for i in range(4)] + [("rp", "p")],
                writes=[(f"w{i}", f"h{i}") for i in range(4)] + [("wx", "x")],
                calls=[(a, t) for a in agents for t in ("r0", "r1", "r2", "r3", "rp", "wx", "w0", "w1", "w2", "w3")],
                delegations=[(agents[i], agents[(i + 1) % 12]) for i in range(12)],
            )
            scanned = await call(mcp, "scan", scenario="t_dense")
            assert scanned["open"] == {"injection": 16, "trifecta": 12}
            for tool, arguments in (("find_injection_paths", {}), ("find_trifecta_agents", {}),
                                    ("rank_chokepoints", {}), ("trust_zones", {})):
                answer = await call(mcp, tool, scenario="t_dense", **arguments)      # call() asserts the size
                assert "error" not in answer
            injections = await call(mcp, "find_injection_paths", scenario="t_dense")
            assert injections["total"] == 16 and injections["truncated"] is True
            assert len(injections["findings"]) + len(injections["more_ids"]) == 16
        finally:
            await client.delete(key)


# ---------------------------------------------------------------------- the write side

async def test_simulate_reports_a_verdict_and_changes_nothing(client, server):
    from cistern.mitigation.sandbox import config_hash
    before = await config_hash(client, "scn:acme_support")
    async with Client(server) as mcp:
        failed = await call(mcp, "simulate_mitigation", scenario="acme_support", finding_ids=[FINDING], plan={"fixes": [REVOKE]})
        assert failed["passed"] is False and failed["cost"] == 1 and failed["remaining"] == []
        assert failed["reason"] == "breaks wf:refund-request: nothing on its path can call tool:payments.issue_refund any more"
        assert failed["newly_broken"][0]["workflow_id"] == "wf:refund-request" and failed["next"]
        assert failed["names"]["tool:payments.issue_refund"].startswith("<untrusted")

        passed = await call(mcp, "simulate_mitigation", scenario="acme_support", finding_ids=[FINDING], plan={"fixes": [GATE]})
        assert passed["passed"] is True and passed["reason"] is None and passed["cost"] == 2
        assert passed["resolved"] == [FINDING] and passed["open_after"] == [] and passed["introduced"] == []
        assert passed["summary"] == ["require human approval before agent:support-bot calls tool:payments.issue_refund"]
        assert {"fix.gate_call", "projection.rebuild", "reach.untrusted_to_high", "find.trifecta", "wf.broken"} <= set(passed["queries"])
    assert await config_hash(client, "scn:acme_support") == before


async def test_what_if_shows_what_a_wider_config_would_open(client, server):
    """A second agent that can only read tickets is given the refund tool."""
    from helpers import build
    from cistern.analysis import findings
    key = "scn:t_whatif"
    await client.delete(key)
    try:
        await build(client, key, sources=["tickets"], resources=["payments"], tools=["get", "refund"], agents=["reader", "payer"],
                    reads=[("get", "tickets")], writes=[("refund", "payments")], calls=[("reader", "get"), ("payer", "refund")])
        await findings.scan(client, key)
        async with Client(server) as mcp:
            answer = await call(mcp, "what_if", scenario="t_whatif",
                                changes=[{"kind": "grant_call", "agent_id": "agent:reader", "tool_id": "tool:t.refund"}])
            assert answer["changes"] == ["grant tool:t.refund to agent:reader"]
            assert answer["open_before"] == [] and len(answer["introduced"]) == 1 and answer["resolved"] == []
            opened = answer["introduced"][0]
            assert (opened["kind"], opened["source_id"], opened["target_id"]) == ("injection", "src:tickets", "res:payments")
            assert opened["path_ids"] == ["src:tickets", "tool:t.get", "agent:reader", "tool:t.refund", "res:payments"]
            assert "whatif.grant_call" in answer["queries"] and "unchanged" in answer["note"]
            again = await call(mcp, "find_injection_paths", scenario="t_whatif")
            assert again["total"] == 0                               # nothing left the sandbox
    finally:
        await client.delete(key)


async def test_propose_then_apply_only_after_a_person_approves(client, server):
    from cistern.mitigation import apply
    async with Client(server) as mcp:
        try:
            refused = await call(mcp, "propose_fix", scenario="acme_support", finding_ids=[FINDING], plan={"fixes": [REVOKE]},
                                 rationale="least privilege")
            assert refused["error"]["code"] == "fix_failed" and refused["error"]["verdict"]["passed"] is False
            assert "wf:refund-request" in refused["error"]["message"]

            proposed = await call(mcp, "propose_fix", scenario="acme_support", finding_ids=[FINDING], plan={"fixes": [GATE]},
                                  rationale="The refund desk is supervised, so a gate costs it nothing.")
            mitigation_id = proposed["mitigation_id"]
            assert proposed["status"] == "proposed" and proposed["verdict"]["passed"] and "approve" in proposed["next"]
            same = await call(mcp, "propose_fix", scenario="acme_support", finding_ids=[FINDING], plan={"fixes": [GATE]},
                              rationale="again")
            assert same["mitigation_id"] == mitigation_id            # one record per plan and target

            early = await call(mcp, "apply_fix", scenario="acme_support", mitigation_id=mitigation_id)
            assert early["error"]["code"] == "needs_approval"        # no tool can approve; a model cannot get past this
            await apply.approve(client, "scn:acme_support", mitigation_id, "kartik")       # what the API does for a person
            applied = await call(mcp, "apply_fix", scenario="acme_support", mitigation_id=mitigation_id)
            assert applied["status"] == "applied" and applied["patch"]["changes"][0]["gate"] == "human_approval"
            assert "fix.gate_call" in applied["queries"]

            scanned = await call(mcp, "scan", scenario="acme_support")
            assert scanned["open"] == {"injection": 0, "trifecta": 0} and scanned["closed"] == 1
            twice = await call(mcp, "apply_fix", scenario="acme_support", mitigation_id=mitigation_id)
            assert twice["error"]["code"] == "needs_approval"
        finally:
            await load_scenario(client, ROOT / "scenarios" / "acme_support.yaml", strict=True)


@pytest.mark.parametrize("tool, arguments, code, retryable", [
    ("simulate_mitigation", {"scenario": "nope", "finding_ids": [FINDING], "plan": {"fixes": [GATE]}}, "unknown_scenario", False),
    ("simulate_mitigation", {"scenario": "acme_support", "finding_ids": [], "plan": {"fixes": [GATE]}}, "invalid_fix", False),
    ("simulate_mitigation", {"scenario": "acme_support", "finding_ids": ["fnd:0000000000"], "plan": {"fixes": [GATE]}}, "not_found", False),
    ("simulate_mitigation", {"scenario": "acme_support", "finding_ids": [FINDING],
                             "plan": {"fixes": [GATE | {"agent_id": "agent:ghost"}]}}, "not_found", False),
    ("simulate_mitigation", {"scenario": "acme_support", "finding_ids": [FINDING],
                             "plan": {"fixes": [REVOKE | {"tool_id": "tool:helpdesk.add_internal_note"}, REVOKE, REVOKE]}}, "stale", True),
    ("what_if", {"scenario": "acme_support", "changes": []}, "invalid_fix", False),
    ("what_if", {"scenario": "acme_support", "changes": [GATE | {"kind": "grant_call"}]}, "stale", True),
    ("apply_fix", {"scenario": "acme_support", "mitigation_id": "mit:0000000000"}, "not_found", False),
])
async def test_write_tool_errors_are_structured(server, tool, arguments, code, retryable):
    async with Client(server) as mcp:
        answer = await call(mcp, tool, **arguments)
        assert (answer["error"]["code"], answer["error"]["retryable"]) == (code, retryable), answer
        assert "Traceback" not in json.dumps(answer)


async def test_a_plan_that_breaks_the_schema_is_refused_before_it_reaches_the_graph(server):
    async with Client(server) as mcp:
        for plan in ({"fixes": [{"kind": "drop_everything", "agent_id": "agent:support-bot"}]},
                     {"fixes": []}, {"fixes": [GATE] * 4},
                     {"fixes": [{"kind": "grant_call", "agent_id": "agent:support-bot", "tool_id": "tool:helpdesk.reply"}]}):
            result = await mcp.call_tool("simulate_mitigation", {"scenario": "acme_support", "finding_ids": [FINDING], "plan": plan})
            assert result.is_error and "validation error" in result.content[0].text


async def test_mincut_names_the_cheapest_cut_and_split_candidates_are_offered(server):
    async with Client(server) as mcp:
        cut = await call(mcp, "rank_chokepoints", scenario="acme_support", method="mincut")
        assert cut["method"] == "mincut" and cut["cut_cost"] == 1 and cut["queries"] == ["choke.maxflow", "flow.edges", "node.names"]
        # one grant is all that stands between the tickets and the refund; the cut nearest the source is the read
        assert cut["edges"] == [{"rel": "CAN_CALL", "from_id": "agent:support-bot", "to_id": "tool:helpdesk.get_ticket",
                                 "behind_rule": 2, "capacity": 1, "fixes": ["revoke_call"]}]
        assert "not a verdict" in cut["note"]

        ranked = await call(mcp, "rank_chokepoints", scenario="acme_support")
        assert ranked["split_candidates"] == [{"agent_id": "agent:support-bot", "paths": 1, "reading_tool_ids": ["tool:helpdesk.get_ticket"]}]

        split = {"fixes": [{"kind": "split_agent", "agent_id": "agent:support-bot", "reader_tool_ids": ["tool:helpdesk.get_ticket"]}]}
        verdict = await call(mcp, "simulate_mitigation", scenario="acme_support", plan=split, finding_ids=[FINDING])
        assert verdict["passed"] is True and verdict["cost"] == 4 and verdict["resolved"] == [FINDING]
        assert verdict["summary"] == ["split agent:support-bot: a quarantined reader takes over tool:helpdesk.get_ticket"]
        refund = {"fixes": [{"kind": "split_agent", "agent_id": "agent:support-bot", "reader_tool_ids": ["tool:payments.issue_refund"]}]}
        refused = await call(mcp, "simulate_mitigation", scenario="acme_support", plan=refund, finding_ids=[FINDING])
        assert refused["error"]["code"] == "invalid_fix" and "only a tool known to read" in refused["error"]["message"]


async def test_rule_of_two_reads_the_three_properties_off_the_graph(server):
    async with Client(server) as mcp:
        cards = await call(mcp, "rule_of_two", scenario="acme_exec")
        assert cards["queries"][:1] == ["graph.node_count"] and "reach.agents_from_sources" in cards["queries"]
        by_id = {c["agent_id"]: c for c in cards["agents"]}
        assistant, reader = by_id["agent:exec-assistant"], by_id["agent:inbox-reader"]
        # the assistant holds all three and runs the digest unattended: the first card, and the rule's own words
        assert cards["agents"][0]["agent_id"] == "agent:exec-assistant"
        assert assistant["properties"] == ["A", "B", "C"] and assistant["autonomous"] and assistant["external"]
        assert assistant["verdict"] == "all three, and it runs unattended"
        assert assistant["untrusted_in"] == ["src:inbound-email"] and assistant["private_in"] == ["src:crm-records"]
        assert reader["count"] == 3 and not reader["autonomous"] and reader["verdict"] == "all three, supervised"

        support = {c["agent_id"]: c for c in (await call(mcp, "rule_of_two", scenario="acme_support"))["agents"]}["agent:support-bot"]
        assert support["properties"] == ["A", "C"] and "Willison" in support["verdict"]      # the injection case the rule calls safe

        zones = await call(mcp, "trust_zones", scenario="acme_dev")
        # finer than the one zone acme_dev is: the GitHub tools hang together, the git and CI tools together
        assert len(zones["communities"]) >= 3 and zones["total"] == 1
        github = next(z for z in zones["communities"] if "tool:github.get_issue" in z["members"])
        assert "tool:github.list_issues" in github["members"] and "tool:ci.deploy" not in github["members"]
