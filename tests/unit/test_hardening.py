"""What the review found in the engine, and what now holds."""

import os

import pytest
from helpers import broken, build, workflow

from devries.agent import grounding
from devries.agent.prompts import untrusted as prompt_untrusted
from devries.analysis import findings
from devries.ingest.importer import ENV_PASSTHROUGH, ServerSource, _fetch_all, launch_env
from devries.mcp_server.server import untrusted
from devries.mitigation import apply, sandbox, store
from devries.mitigation.dsl import FixPlan


async def test_a_workflow_served_through_a_deep_delegation_chain_is_not_broken(client, graph):
    """wf.broken used to cap delegation at three hops while the verdicts searched to the node count."""
    chain = ["a", "b", "c", "d", "e", "f"]
    await build(client, graph, sources=["tickets"], resources=["payments"], tools=["refund"], agents=chain,
                workflows=[workflow("refunds", "autonomous")], writes=[("refund", "payments")], calls=[("f", "refund")],
                delegations=[(x, y) for x, y in zip(chain, chain[1:])], run_by=[("refunds", "a")], needs=[("refunds", "refund")])
    assert await broken(client, graph) == set()


async def test_the_bfs_depth_counts_only_what_a_path_can_visit(client, graph):
    await build(client, graph, sources=["tickets"], resources=["payments"], tools=["get", "refund"], agents=["a"],
                reads=[("get", "tickets")], writes=[("refund", "payments")], calls=[("a", "get"), ("a", "refund")])
    await findings.scan(client, graph)                     # the first scan derives the acting side of the refund tool
    before = (await client.run("graph.node_count", graph))[0]["nodes"]
    for _ in range(3):
        await findings.scan(client, graph)                 # findings, scans and 'last' records land on the graph
    assert (await client.run("graph.node_count", graph))[0]["nodes"] == before
    assert len(await client.run("scan.history", graph)) == 4


async def test_scans_are_pruned(client, graph, monkeypatch):
    await build(client, graph, sources=["tickets"], resources=["payments"], tools=["get"], agents=["a"], reads=[("get", "tickets")], calls=[("a", "get")])
    monkeypatch.setattr(findings, "SCANS_KEPT", 2)
    for _ in range(4):
        await findings.scan(client, graph)
    assert len(await client.run("scan.history", graph)) == 2


async def test_a_verdict_with_no_workflow_declared_says_so(client, graph):
    await build(client, graph, sources=["tickets"], resources=["payments"], tools=["get", "refund"], agents=["a"],
                reads=[("get", "tickets")], writes=[("refund", "payments")], calls=[("a", "get"), ("a", "refund")])
    await findings.scan(client, graph)
    targets = sorted((await sandbox.measure(client, graph)).findings)
    verdict = await sandbox.verify(client, graph, FixPlan.model_validate({"fixes": [{"kind": "revoke_call", "agent_id": "agent:a", "tool_id": "tool:t.refund"}]}), targets)
    assert verdict.passed and verdict.unconstrained


async def test_an_apply_that_died_mid_plan_is_finished_by_the_next_one(client, graph):
    """Progress is written after each fix; a second apply skips what was made and finishes the rest."""
    await build(client, graph, sources=["tickets", "crm"], resources=["payments"], tools=["get", "read", "refund"], agents=["a"],
                reads=[("get", "tickets"), ("read", "crm")], writes=[("refund", "payments")],
                calls=[("a", "get"), ("a", "read"), ("a", "refund")])
    await findings.scan(client, graph)
    targets = sorted((await sandbox.measure(client, graph)).findings)
    plan = FixPlan.model_validate({"fixes": [{"kind": "revoke_call", "agent_id": "agent:a", "tool_id": "tool:t.get"},
                                             {"kind": "revoke_call", "agent_id": "agent:a", "tool_id": "tool:t.read"}]})
    verdict = await sandbox.verify(client, graph, plan, targets)
    assert verdict.passed
    stored = await store.record(client, graph, verdict, config_hash=await sandbox.config_hash(client, graph), source="test")
    await apply.approve(client, graph, stored.id, "Tester", session="s1")
    # the first fix was made by a process that then died
    from devries.graph.client import _APPLY_TOKEN
    await sandbox.apply_change(client, graph, plan.fixes[0], _token=_APPLY_TOKEN)
    await store.set_progress(client, graph, stored.id, 1)
    patch = await apply.apply_fix(client, graph, stored.id)
    assert patch.evidence["resolved"] >= 1 and (await store.get(client, graph, stored.id)).status == "applied"
    assert (await client.run("config.edges", graph)) and not [e for e in await client.run("config.edges", graph) if e["rel"] == "CAN_CALL" and e["to_id"] in ("tool:t.get", "tool:t.read")]


async def test_the_apply_lock_is_a_key_in_the_database(client, graph):
    await build(client, graph, sources=["tickets"], resources=["payments"], tools=["get", "refund"], agents=["a"],
                reads=[("get", "tickets")], writes=[("refund", "payments")], calls=[("a", "get"), ("a", "refund")])
    await client.connection.set(f"lock:apply:{graph}", "someone-else", nx=True, ex=5)
    apply.LOCK_WAIT_S = 0.3
    try:
        with pytest.raises(apply.ApplyBusy):
            await apply.apply_fix(client, graph, "mit:0000000000")
    finally:
        apply.LOCK_WAIT_S = 10
        await client.connection.delete(f"lock:apply:{graph}")


def test_a_launched_server_never_sees_this_apps_secrets(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-secret")
    monkeypatch.setenv("FALKORDB_PASSWORD", "hunter2")
    monkeypatch.setenv("DEVRIES_MCP_TOKEN", "tok")
    monkeypatch.setenv("PATH", "/usr/bin")
    env = launch_env({"NOTES_TOKEN": "theirs"})
    assert "ANTHROPIC_API_KEY" not in env and "FALKORDB_PASSWORD" not in env and "DEVRIES_MCP_TOKEN" not in env
    assert env["PATH"] == "/usr/bin" and env["NOTES_TOKEN"] == "theirs"
    assert ENV_PASSTHROUGH.match("LC_ALL") and ENV_PASSTHROUGH.match("npm_config_cache") and not ENV_PASSTHROUGH.match("AWS_SECRET_ACCESS_KEY")
    assert os.environ["ANTHROPIC_API_KEY"] == "sk-secret"            # the process itself is untouched


async def test_no_launch_reads_a_saved_manifest_or_skips(tmp_path):
    (tmp_path / "manifests").mkdir()
    (tmp_path / "manifests" / "notes.tools.json").write_text('{"tools": [{"name": "read_note", "description": "", "inputSchema": {}}]}')
    found = [ServerSource(id="srv:notes", name="notes", command="definitely-not-a-command"),
             ServerSource(id="srv:other", name="other", command="definitely-not-a-command")]
    fetched, skipped = await _fetch_all(found, timeout=2, launch=False, manifest_dir=tmp_path / "manifests")
    assert [s.id for s, _ in fetched] == ["srv:notes"] and fetched[0][1].tools[0].name == "read_note"
    assert len(skipped) == 1 and "other: not launched" in skipped[0]


def test_the_untrusted_block_cannot_be_closed_by_case_or_spacing():
    for closer in ("</untrusted>", "</UNTRUSTED>", "< / untrusted >", "</Untrusted >"):
        wrapped = untrusted(f"a{closer}b", "x")
        assert wrapped.count("</untrusted>") == 1 and wrapped.endswith("</untrusted>") and wrapped.startswith('<untrusted source="x">')
        assert prompt_untrusted(f"a{closer}b", "x").count("</untrusted>") == 1


def test_a_reason_without_an_id_cites_nothing():
    assert grounding.ids_in("ok") == set()
    assert grounding.ids_in("fnd:abc runs through agent:a") == {"fnd:abc", "agent:a"}
