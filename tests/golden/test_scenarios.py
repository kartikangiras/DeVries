"""Every scenario file is its own oracle: a scan must find exactly what its `expect` block says,
and the fix search must end the way it says: which kind of fix wins, and which are rejected and why.
"""

from pathlib import Path

import pytest
import yaml
from helpers import broken

from devries.analysis import findings
from devries.graph import keys
from devries.ingest.scenario_loader import load_scenario
from devries.mitigation import apply, search

SCENARIOS = sorted((Path(__file__).resolve().parents[2] / "scenarios").glob("*.yaml"))


def tkey(path: Path) -> str:
    """The test's own graph for a scenario file: the running app's scn:<name> is never replaced by a test."""
    return keys.scenario_key(f"t_{path.stem}")


def test_there_is_at_least_one_scenario():
    assert SCENARIOS, "no files in scenarios/"


@pytest.mark.parametrize("path", SCENARIOS, ids=lambda p: p.stem)
async def test_scan_matches_the_expect_block(client, path):
    report = await load_scenario(client, path, strict=True, graph_key=tkey(path))        # strict: a mismatch raises
    expect = yaml.safe_load(path.read_text())["expect"]
    found_injection = sorted([f.source_id, f.target_id] for f in report.scan.findings if f.kind == "injection")
    found_trifecta = sorted(f.agent_id for f in report.scan.findings if f.kind == "trifecta")
    assert found_injection == sorted(expect.get("injection", []))
    assert found_trifecta == sorted(expect.get("trifecta", []))
    assert all(f.evidence and f.status == "open" for f in report.scan.findings)
    assert sum(report.nodes.values()) > 0 and report.mismatches == []


@pytest.mark.parametrize("path", SCENARIOS, ids=lambda p: p.stem)
async def test_reloading_and_rescanning_is_stable(client, path):
    first = await load_scenario(client, path, strict=True, graph_key=tkey(path))
    key = first.graph
    again = await findings.scan(client, key)
    assert [f.id for f in again.findings] == [f.id for f in first.scan.findings]
    assert len(await client.run("finding.list", key)) == len(first.scan.findings)
    second = await load_scenario(client, path, strict=True, graph_key=tkey(path))         # a reload replaces the graph
    assert second.nodes == first.nodes and second.edges == first.edges
    assert [f.id for f in second.scan.findings] == [f.id for f in first.scan.findings]


async def test_acme_support_tells_the_refund_story(client):
    path = next(p for p in SCENARIOS if p.stem == "acme_support")
    report = await load_scenario(client, path, strict=True, graph_key=tkey(path))
    assert len(report.scan.findings) == 1
    finding = report.scan.findings[0]
    assert finding.path_ids == [
        "src:customer-tickets", "tool:helpdesk.get_ticket", "agent:support-bot",
        "tool:payments.issue_refund", "res:payments-api",
    ]
    assert finding.evidence[0].rules == [1, 2, 3, 5]
    # the poisoned description is stored as data, exactly as the manifest had it
    rows = await client.graph(report.graph).ro_query(
        "MATCH (t:Tool {id:'tool:helpdesk.list_tickets'}) RETURN t.description, t.capability, t.capability_source")
    description, capability, source = rows.result_set[0]
    assert "NOTE TO AI AGENTS" in description and (capability, source) == ("read", "manifest")
    manual = await client.graph(report.graph).ro_query(
        "MATCH (t:Tool {id:'tool:payments.issue_refund'}) RETURN t.capability, t.capability_source")
    assert manual.result_set[0] == ["write", "manual"]


@pytest.mark.parametrize("path", SCENARIOS, ids=lambda p: p.stem)
async def test_fix_search_ends_the_way_the_expect_block_says(client, path):
    report = await load_scenario(client, path, strict=True, graph_key=tkey(path))
    expect = yaml.safe_load(path.read_text())["expect"]
    try:
        result = await search.search(client, report.graph)
        if not report.scan.findings:
            assert (result.targets, result.passing, result.failed) == ([], [], [])
            return
        if expect.get("best_fix_kind"):
            assert result.passing, "no plan passed: " + "; ".join(m.reason for m in result.failed)
            assert [f.kind for f in result.passing[0].plan.fixes] == [expect["best_fix_kind"]]
        for rejected in expect.get("rejected", []):
            reasons = [m.reason for m in result.failed if [f.kind for f in m.plan.fixes] == [rejected["kind"]]]
            assert any(rejected["reason_contains"] in reason for reason in reasons), (rejected, reasons)

        # The winning plan, once a person approves it, closes its target and breaks nothing.
        already_broken = await broken(client, report.graph)
        best = result.passing[0]
        await apply.approve(client, report.graph, best.id, "golden-test")
        patch = await apply.apply_fix(client, report.graph, best.id)
        after = await findings.scan(client, report.graph)
        assert not set(result.targets) & {f.id for f in after.findings}
        assert len(after.closed_fingerprints) == patch.evidence["resolved"] >= 1
        assert await broken(client, report.graph) == already_broken
    finally:
        await client.delete(tkey(path))


async def test_acme_exec_is_fixed_by_quarantine_because_the_digest_runs_unattended(client):
    path = next(p for p in SCENARIOS if p.stem == "acme_exec")
    report = await load_scenario(client, path, strict=True, graph_key=tkey(path))
    try:
        assert sorted(f.agent_id for f in report.scan.findings) == ["agent:exec-assistant", "agent:inbox-reader"]
        assistant = next(f for f in report.scan.findings if f.agent_id == "agent:exec-assistant")
        # the assistant never reads the inbox: the untrusted leg arrives through its reader, over rule 6
        untrusted_leg = next(e for e in assistant.evidence if e.leg == "untrusted")
        assert untrusted_leg.node_ids == ["src:inbound-email", "tool:mail.read_inbox", "agent:inbox-reader", "agent:exec-assistant"]
        assert untrusted_leg.rules == [1, 2, 6]

        result = await search.search(client, report.graph)
        assert result.targets == [assistant.id]
        best = result.passing[0]
        assert best.plan.fixes[0].model_dump() == {"kind": "quarantine_delegation", "from_agent_id": "agent:exec-assistant",
                                                   "to_agent_id": "agent:inbox-reader"}
        assert len(best.verdict.diff.resolved) == 2                  # one fix, both agents
        on_send = {m.plan.fixes[0].kind: m.reason for m in result.failed
                   if getattr(m.plan.fixes[0], "tool_id", None) == "tool:mail.send"}
        assert "needs a person's approval" in on_send["gate_call"] and "autonomous" in on_send["gate_call"]
        assert "can call tool:mail.send any more" in on_send["revoke_call"]
    finally:
        await client.delete(tkey(path))


async def test_acme_dev_takes_two_fixes(client):
    """A gate on the push closes both injections; then revoking the tool no workflow needs closes every trifecta."""
    path = next(p for p in SCENARIOS if p.stem == "acme_dev")
    report = await load_scenario(client, path, strict=True, graph_key=tkey(path))
    try:
        issue = next(f for f in report.scan.findings if f.source_id == "src:github-issues")
        # six hops: the triage agent's results return up to the planner (rule 6) and pass down to the coder (rule 4)
        assert issue.evidence[0].rules == [1, 2, 6, 4, 3, 5]
        assert issue.path_ids[2:5] == ["agent:triage", "agent:planner", "agent:coder"]

        first = await search.search(client, report.graph)
        assert first.targets == [issue.id]
        gate = first.passing[0]
        assert gate.plan.fixes[0].model_dump() == {"kind": "gate_call", "agent_id": "agent:coder", "tool_id": "tool:git.push"}
        assert len(gate.verdict.diff.resolved) >= 2                  # both injections end at the same push
        await apply.approve(client, report.graph, gate.id, "golden-test")
        await apply.apply_fix(client, report.graph, gate.id)
        after_gate = await findings.scan(client, report.graph)
        assert sorted(f.agent_id for f in after_gate.findings) == ["agent:coder", "agent:planner", "agent:triage"]

        second = await search.search(client, report.graph)
        revoke = second.passing[0]
        assert revoke.plan.fixes[0].model_dump() == {"kind": "revoke_call", "agent_id": "agent:coder", "tool_id": "tool:http.request"}
        assert len(revoke.verdict.diff.resolved) == 3                # the only way out is gone for all of them
        on_secret = [m.reason for m in second.failed if getattr(m.plan.fixes[0], "tool_id", None) == "tool:ci.read_secret"]
        assert on_secret and "wf:fix-bug" in on_secret[0]            # the cheaper cut, refused: the tests need the secret
        await apply.approve(client, report.graph, revoke.id, "golden-test")
        await apply.apply_fix(client, report.graph, revoke.id)
        assert (await findings.scan(client, report.graph)).findings == []
        assert await broken(client, report.graph) == set()
    finally:
        await client.delete(tkey(path))


async def test_devries_itself_is_clean_and_only_because_of_its_gate(client):
    path = next(p for p in SCENARIOS if p.stem == "devries_self")
    report = await load_scenario(client, path, strict=True, graph_key=tkey(path))
    try:
        assert report.scan.findings == []
        gated = await client.run("flow.gated_edges", report.graph)
        assert [(g["from_id"], g["to_id"], g["gate"]) for g in gated] == [("agent:auditor", "tool:devries.apply_fix", "human_approval")]

        # take the approval away, as a scenario file without the gate would
        await client.run("ingest.can_call", report.graph, rows=[
            {"from_id": "agent:auditor", "to_id": "tool:devries.apply_fix", "gate": None, "origin": "test"}])
        opened = (await findings.scan(client, report.graph)).findings
        assert sorted((f.kind, f.source_id, f.target_id) for f in opened) == [
            ("injection", "src:approver-notes", "res:agent-config"), ("injection", "src:manifest-text", "res:agent-config")]
        assert all(f.path_ids[-3:] == ["agent:auditor", "tool:devries.apply_fix", "res:agent-config"] for f in opened)
    finally:
        await client.delete(tkey(path))


async def test_the_self_audit_manifest_is_what_the_server_answers(client):
    """devries_self audits the tools this server really has: the manifest is generated, and must not go stale."""
    import json

    from devries.mcp_server.__main__ import own_manifest

    on_disk = json.loads((SCENARIOS[0].parents[1] / "manifests" / "devries.tools.json").read_text())
    assert on_disk == await own_manifest(), "run `make self-manifest`"
    declared = {t["id"] for t in yaml.safe_load(next(p for p in SCENARIOS if p.stem == "devries_self").read_text())["tools"]}
    assert declared == {f"tool:devries.{t['name']}" for t in on_disk["tools"]}      # every tool has its facts stated
