"""Fixes, sandbox verdicts, the baseline search and the apply path."""

import asyncio

import pytest
from pydantic import ValidationError

from devries.analysis import findings
from devries.analysis.models import injection_fingerprint, trifecta_fingerprint
from devries.config import get_settings
from devries.errors import ForbiddenWrite, NotFound
from devries.graph import keys
from devries.mitigation import apply, sandbox, search, store
from devries.analysis import chokepoints
from devries.errors import InvalidFix
from devries.mitigation.candidates import candidates
from devries.mitigation.dsl import DropRead, SplitAgent, reader_id
from devries.mitigation.dsl import (
    AddDelegation, FixPlan, GateCall, GrantCall, QuarantineDelegation, RevokeCall, config_patch, mitigation_id,
)
from devries.mitigation.sandbox import StaleTarget, config_hash
from helpers import broken, build, flows, gated, set_call_gate, workflow

PRIVATE = {"id": "src:crm", "name": "crm", "trust": "private"}
EXIT = {"id": "res:mail", "name": "mail", "impact": "medium", "external": True}

TICKETS_TO_PAYMENTS = injection_fingerprint("src:tickets", "res:payments")


def gate(agent: str, tool: str) -> GateCall:
    return GateCall(kind="gate_call", agent_id=f"agent:{agent}", tool_id=f"tool:t.{tool}")


def revoke(agent: str, tool: str) -> RevokeCall:
    return RevokeCall(kind="revoke_call", agent_id=f"agent:{agent}", tool_id=f"tool:t.{tool}")


def quarantine(a: str, b: str) -> QuarantineDelegation:
    return QuarantineDelegation(kind="quarantine_delegation", from_agent_id=f"agent:{a}", to_agent_id=f"agent:{b}")


def plan(*fixes) -> FixPlan:
    return FixPlan(fixes=list(fixes))


async def desk(client, key, mode: str = "supervised") -> None:
    """A support desk: tickets (untrusted) -> get -> agent a -> refund -> payments (high), and a refund workflow."""
    await build(client, key, sources=["tickets"], resources=["payments"], tools=["get", "refund"], agents=["a"],
                workflows=[workflow("refunds", mode)],
                reads=[("get", "tickets")], writes=[("refund", "payments")], calls=[("a", "get"), ("a", "refund")],
                run_by=[("refunds", "a")], needs=[("refunds", "refund")], needs_data=[("refunds", "tickets")])
    await findings.scan(client, key)


async def no_sandboxes(client) -> bool:
    """Nothing here left a sandbox behind. An app running beside the tests makes one of its own for a
    few milliseconds on every health check, so a sandbox that is gone a moment later was not ours."""
    seen = {k for k in await client.list_graphs() if k.startswith("sbx:")}
    if not seen:
        return True
    await asyncio.sleep(0.3)
    return not seen & set(await client.list_graphs())


# ---------------------------------------------------------------------- the change language

def test_plan_cost_prefers_one_fix_and_the_least_privilege():
    assert plan(revoke("a", "t")).cost == 1 and plan(gate("a", "t")).cost == 2 and plan(quarantine("a", "b")).cost == 2
    assert plan(gate("a", "t"), gate("a", "u")).cost == 5          # 2 + 2, +1 for the second fix
    assert plan(revoke("a", "t"), revoke("a", "u")).cost == 3


def test_the_same_plan_is_the_same_mitigation_whatever_the_order():
    one, two = plan(gate("a", "t"), revoke("a", "u")), plan(revoke("a", "u"), gate("a", "t"))
    assert one.canonical() == two.canonical()
    assert mitigation_id(one, ["x", "y"]) == mitigation_id(two, ["y", "x"])
    assert mitigation_id(one, ["x"]) != mitigation_id(one, ["y"])   # the same plan for another finding is another record
    assert mitigation_id(one, ["x"]).startswith("mit:") and len(mitigation_id(one, ["x"])) == 14


def test_a_plan_is_one_to_three_fixes_and_never_a_what_if_change():
    with pytest.raises(ValidationError):
        FixPlan(fixes=[])
    with pytest.raises(ValidationError):
        FixPlan(fixes=[gate("a", f"t{i}") for i in range(4)])
    with pytest.raises(ValidationError):                            # a grant widens the config: it is not a fix
        FixPlan.model_validate({"fixes": [{"kind": "grant_call", "agent_id": "agent:a", "tool_id": "tool:t.x"}]})
    with pytest.raises(ValidationError):
        FixPlan.model_validate({"fixes": [{"kind": "drop_table", "agent_id": "agent:a", "tool_id": "tool:t.x"}]})


def test_a_fix_is_also_the_change_it_makes_to_the_config():
    assert config_patch(gate("a", "refund")) == {
        "op": "set_gate", "edge": "CAN_CALL", "from_id": "agent:a", "to_id": "tool:t.refund", "gate": "human_approval"}
    assert config_patch(revoke("a", "refund"))["op"] == "delete"
    assert config_patch(quarantine("a", "b"))["edge"] == "DELEGATES_TO"
    with pytest.raises(ValueError):
        config_patch(GrantCall(kind="grant_call", agent_id="agent:a", tool_id="tool:t.x"))


# ---------------------------------------------------------------------- one test per fix query

async def test_gate_call_cuts_rule_3_and_nothing_else(client, sandbox):
    await desk_in_sandbox(client, sandbox)
    await sandbox_change(client, sandbox, gate("a", "refund"))
    assert ("agent:a", 3, "tool:t.refund") not in await flows(client, sandbox)
    assert ("agent:a", 3, "tool:t.refund", "human_approval") in await gated(client, sandbox)
    assert ("tool:t.get", 2, "agent:a") in await flows(client, sandbox)      # reading is untouched


async def test_revoke_call_removes_the_grant_and_both_hops_behind_it(client, sandbox):
    await desk_in_sandbox(client, sandbox)
    await sandbox_change(client, sandbox, revoke("a", "refund"))
    assert ("agent:a", 3, "tool:t.refund") not in await flows(client, sandbox)
    assert await gated(client, sandbox) == set()                             # gone, not gated
    await sandbox_change(client, sandbox, revoke("a", "get"))
    assert ("tool:t.get", 2, "agent:a") not in await flows(client, sandbox)
    assert ("src:tickets", 1, "tool:t.get") in await flows(client, sandbox)  # the tool still reads; nobody calls it


async def test_quarantine_cuts_rule_6_and_keeps_rule_4(client, sandbox):
    await build(client, sandbox, agents=["a", "b"], delegations=[("a", "b")])
    await sandbox_change(client, sandbox, quarantine("a", "b"))
    assert await flows(client, sandbox) == {("agent:a", 4, "agent:b")}
    assert await gated(client, sandbox) == {("agent:b", 6, "agent:a", "quarantine")}


async def test_a_fix_that_changes_nothing_is_a_stale_target(client, sandbox):
    await desk_in_sandbox(client, sandbox)
    await sandbox_change(client, sandbox, gate("a", "refund"))
    with pytest.raises(StaleTarget):                                         # already gated
        await sandbox_change(client, sandbox, gate("a", "refund"))
    with pytest.raises(StaleTarget):                                         # no such grant
        await sandbox_change(client, sandbox, revoke("a", "nothing"))
    with pytest.raises(StaleTarget):                                         # already granted
        await sandbox_change(client, sandbox, GrantCall(kind="grant_call", agent_id="agent:a", tool_id="tool:t.get"))


async def desk_in_sandbox(client, key) -> None:
    await build(client, key, sources=["tickets"], resources=["payments"], tools=["get", "refund"], agents=["a"],
                reads=[("get", "tickets")], writes=[("refund", "payments")], calls=[("a", "get"), ("a", "refund")])
    await client.run("projection.rebuild", key)


async def sandbox_change(client, key, change) -> None:
    await sandbox.apply_change(client, key, change)
    await client.run("projection.rebuild", key)


# ---------------------------------------------------------------------- who may change config

async def test_no_fix_runs_on_a_working_graph_outside_apply(client, graph):
    await desk(client, graph)
    before = await sandbox.config_hash(client, graph)
    for query, params in (("fix.gate_call", {"agent_id": "agent:a", "tool_id": "tool:t.refund"}),
                          ("fix.revoke_call", {"agent_id": "agent:a", "tool_id": "tool:t.refund"}),
                          ("fix.quarantine_delegation", {"from_agent_id": "agent:a", "to_agent_id": "agent:a"}),
                          ("whatif.grant_call", {"agent_id": "agent:a", "tool_id": "tool:t.get"}),
                          ("whatif.add_delegation", {"from_agent_id": "agent:a", "to_agent_id": "agent:a"})):
        with pytest.raises(ForbiddenWrite):
            await client.run(query, graph, **params)
        with pytest.raises(ForbiddenWrite):                          # a made-up token is not the token
            await client.run(query, graph, _token=object(), **params)
    with pytest.raises(ForbiddenWrite):
        await sandbox.apply_change(client, graph, gate("a", "refund"))
    assert await sandbox.config_hash(client, graph) == before


# ---------------------------------------------------------------------- diff and verify

async def test_a_verdict_is_measured_in_a_copy_and_leaves_the_graph_alone(client, graph):
    await desk(client, graph)
    config, flow = await sandbox.config_hash(client, graph), await flows(client, graph)
    verdict = await sandbox.verify(client, graph, plan(gate("a", "refund")), [TICKETS_TO_PAYMENTS])
    assert verdict.passed and verdict.reason is None and verdict.remaining == []
    assert verdict.diff.open_before == [TICKETS_TO_PAYMENTS] and verdict.diff.open_after == []
    assert verdict.diff.resolved == [TICKETS_TO_PAYMENTS] and verdict.diff.introduced == []
    assert verdict.diff.findings[TICKETS_TO_PAYMENTS].source_id == "src:tickets"
    assert (await sandbox.config_hash(client, graph), await flows(client, graph)) == (config, flow)
    assert [f.status for f in await findings.stored(client, graph)] == ["open"]
    assert await no_sandboxes(client)


async def test_a_gate_passes_for_a_supervised_workflow_and_fails_for_an_autonomous_one(client, graph):
    """The reason a human-approval gate cannot win everywhere."""
    await desk(client, graph, mode="supervised")
    assert (await sandbox.verify(client, graph, plan(gate("a", "refund")), [TICKETS_TO_PAYMENTS])).passed
    await client.run("ingest.workflows", graph, rows=[workflow("refunds", "autonomous")])
    verdict = await sandbox.verify(client, graph, plan(gate("a", "refund")), [TICKETS_TO_PAYMENTS])
    assert not verdict.passed and verdict.remaining == []           # it does close the finding
    broken = verdict.diff.newly_broken[0]
    assert (broken.workflow_id, broken.kind, broken.missing_id, broken.gated) == ("wf:refunds", "tool", "tool:t.refund", True)
    assert "wf:refunds" in verdict.reason and "approval" in verdict.reason


async def test_revoke_fails_when_a_workflow_needs_the_tool_or_the_data(client, graph):
    await desk(client, graph)
    tool = await sandbox.verify(client, graph, plan(revoke("a", "refund")), [TICKETS_TO_PAYMENTS])
    assert not tool.passed and "wf:refunds" in tool.reason and "call tool:t.refund" in tool.reason
    assert not tool.diff.newly_broken[0].gated                       # gone, not gated
    data = await sandbox.verify(client, graph, plan(revoke("a", "get")), [TICKETS_TO_PAYMENTS])
    assert not data.passed and data.diff.newly_broken[0].kind == "data" and "read src:tickets" in data.reason


async def test_revoke_passes_when_nothing_needs_the_grant(client, graph):
    await build(client, graph, sources=["tickets"], resources=["payments"], tools=["get", "refund"], agents=["a"],
                reads=[("get", "tickets")], writes=[("refund", "payments")], calls=[("a", "get"), ("a", "refund")])
    await findings.scan(client, graph)
    assert (await sandbox.verify(client, graph, plan(revoke("a", "refund")), [TICKETS_TO_PAYMENTS])).passed


async def test_a_plan_that_misses_its_target_fails_and_says_what_is_left(client, graph):
    """Two ways to pay: gating one of them leaves the finding open."""
    await build(client, graph, sources=["tickets"], resources=["payments"], tools=["get", "refund", "payout"],
                agents=["a"], reads=[("get", "tickets")], writes=[("refund", "payments"), ("payout", "payments")],
                calls=[("a", "get"), ("a", "refund"), ("a", "payout")])
    await findings.scan(client, graph)
    verdict = await sandbox.verify(client, graph, plan(gate("a", "refund")), [TICKETS_TO_PAYMENTS])
    assert not verdict.passed and verdict.remaining == [TICKETS_TO_PAYMENTS]
    assert verdict.reason == f"leaves open: fnd:{TICKETS_TO_PAYMENTS[:10]}"
    assert (await sandbox.verify(client, graph, plan(gate("a", "refund"), gate("a", "payout")), [TICKETS_TO_PAYMENTS])).passed


async def test_three_unrelated_findings_each_have_a_passing_plan(client, graph):
    """A verdict is about its targets: a plan is never failed for a finding it was not asked to fix."""
    names = ["x", "y", "z"]
    await build(client, graph, sources=[f"in{n}" for n in names], resources=[f"out{n}" for n in names],
                tools=[f"get{n}" for n in names] + [f"act{n}" for n in names], agents=names,
                reads=[(f"get{n}", f"in{n}") for n in names], writes=[(f"act{n}", f"out{n}") for n in names],
                calls=[(n, f"get{n}") for n in names] + [(n, f"act{n}") for n in names])
    assert len((await findings.scan(client, graph)).findings) == 3
    for n in names:
        target = injection_fingerprint(f"src:in{n}", f"res:out{n}")
        verdict = await sandbox.verify(client, graph, plan(gate(n, f"act{n}")), [target])
        assert verdict.passed and verdict.diff.resolved == [target] and len(verdict.diff.open_after) == 2


async def test_a_need_that_was_already_unmet_is_not_held_against_a_plan(client, graph):
    await desk(client, graph)
    await build(client, graph, tools=["export"], workflows=["reports"], run_by=[("reports", "a")], needs=[("reports", "export")])
    verdict = await sandbox.verify(client, graph, plan(gate("a", "refund")), [TICKETS_TO_PAYMENTS])
    assert verdict.passed and verdict.diff.newly_broken == []       # wf:reports could not run before either


async def test_verify_refuses_ids_and_targets_that_are_not_there(client, graph):
    await desk(client, graph)
    with pytest.raises(NotFound, match="agent:ghost"):
        await sandbox.verify(client, graph, plan(gate("ghost", "refund")), [TICKETS_TO_PAYMENTS])
    with pytest.raises(NotFound, match="is not a tool"):             # a real id of the wrong kind
        await sandbox.verify(client, graph, plan(GateCall(kind="gate_call", agent_id="agent:a", tool_id="src:tickets")),
                             [TICKETS_TO_PAYMENTS])
    with pytest.raises(NotFound, match="not an open finding"):
        await sandbox.verify(client, graph, plan(gate("a", "refund")), [injection_fingerprint("src:tickets", "res:nowhere")])
    with pytest.raises(StaleTarget):                                 # real ids, but no such grant
        await sandbox.verify(client, graph, plan(revoke("a", "refund"), revoke("a", "refund")), [TICKETS_TO_PAYMENTS])
    assert await no_sandboxes(client)                                # every failure still deleted its sandbox


async def test_what_if_a_grant_opens_a_finding_and_never_leaves_the_sandbox(client, graph):
    """An agent that only reads tickets gets the refund tool: what would that open?"""
    await build(client, graph, sources=["tickets"], resources=["payments"], tools=["get", "refund"], agents=["a", "b"],
                reads=[("get", "tickets")], writes=[("refund", "payments")], calls=[("a", "get"), ("b", "refund")])
    assert (await findings.scan(client, graph)).findings == []
    config = await sandbox.config_hash(client, graph)
    grant = await sandbox.diff(client, graph, [GrantCall(kind="grant_call", agent_id="agent:a", tool_id="tool:t.refund")])
    assert grant.introduced == [TICKETS_TO_PAYMENTS] and grant.open_before == [] and grant.resolved == []
    assert grant.findings[TICKETS_TO_PAYMENTS].kind == "injection"
    delegation = await sandbox.diff(client, graph, [AddDelegation(kind="add_delegation", from_agent_id="agent:a", to_agent_id="agent:b")])
    assert delegation.introduced == [TICKETS_TO_PAYMENTS]            # a's context passes down to b, which can pay
    assert await sandbox.config_hash(client, graph) == config and await no_sandboxes(client)
    assert (await findings.scan(client, graph)).findings == []


async def test_quarantine_is_what_fixes_a_delegated_trifecta(client, graph):
    await build(client, graph, sources=["inbox", PRIVATE], resources=[EXIT], tools=["read", "search", "send"],
                agents=["assistant", "reader"], workflows=[workflow("digest", "autonomous")],
                reads=[("read", "inbox"), ("search", "crm")], writes=[("send", "mail")],
                calls=[("reader", "read"), ("assistant", "search"), ("assistant", "send")],
                delegations=[("assistant", "reader")], run_by=[("digest", "assistant")], needs=[("digest", "send")],
                needs_data=[("digest", "inbox"), ("digest", "crm")])
    both = sorted([trifecta_fingerprint("agent:assistant"), trifecta_fingerprint("agent:reader")])
    assert sorted(f.fingerprint for f in (await findings.scan(client, graph)).findings) == both
    target = [trifecta_fingerprint("agent:assistant")]
    assert not (await sandbox.verify(client, graph, plan(gate("assistant", "send")), target)).passed
    assert not (await sandbox.verify(client, graph, plan(revoke("assistant", "send")), target)).passed
    verdict = await sandbox.verify(client, graph, plan(quarantine("assistant", "reader")), target)
    assert verdict.passed and verdict.diff.resolved == both          # credit for the second finding it also closes


async def test_twenty_verdicts_in_a_row_while_another_client_scans(client, graph):
    await desk(client, graph)
    stop = asyncio.Event()

    async def keep_scanning() -> int:
        n = 0
        while not stop.is_set():
            await findings.scan(client, graph)
            n += 1
        return n

    scanner = asyncio.create_task(keep_scanning())
    try:
        verdicts = [await sandbox.verify(client, graph, plan(gate("a", "refund")), [TICKETS_TO_PAYMENTS]) for _ in range(20)]
    finally:
        stop.set()
    assert await scanner > 0
    assert all(v.passed for v in verdicts) and await no_sandboxes(client)


async def test_the_janitor_removes_only_old_sandboxes(client, graph):
    await desk(client, graph)
    old, new = f"sbx:{1_600_000_000_000}:abc123", keys.sandbox_key()
    try:
        await client.copy(graph, old)
        await client.copy(graph, new)
        assert await sandbox.sweep(client) == [old]
        assert await client.exists(new) and not await client.exists(old) and await client.exists(graph)
    finally:
        await client.delete(old)
        await client.delete(new)


async def test_config_hash_follows_config_and_ignores_audit_nodes(client, graph):
    await desk(client, graph)
    first = await sandbox.config_hash(client, graph)
    await findings.scan(client, graph)                               # findings and VIA edges are not config
    await search.search(client, graph)                               # nor are mitigations
    assert await sandbox.config_hash(client, graph) == first
    await set_call_gate(client, graph, "a", "refund", "human_approval")
    gated_hash = await sandbox.config_hash(client, graph)
    assert gated_hash != first
    await client.run("ingest.data_sources", graph, rows=[{"id": "src:tickets", "name": "tickets", "trust": "internal"}])
    assert await sandbox.config_hash(client, graph) != gated_hash    # a trust label decides findings too


# ---------------------------------------------------------------------- the baseline search

async def test_search_returns_the_cheapest_plan_that_passes_and_records_the_rest(client, graph):
    await desk(client, graph)
    result = await search.search(client, graph)
    assert result.targets == [f"fnd:{TICKETS_TO_PAYMENTS[:10]}"] and result.sandbox_runs == 4     # two revokes, the gate, one drop
    assert [m.plan.fixes[0].kind for m in result.passing] == ["gate_call"]
    best = result.passing[0]
    assert (best.status, best.passed, best.cost, best.source) == ("proposed", True, 2, "search")
    assert best.config_hash == await sandbox.config_hash(client, graph)
    assert sorted((m.plan.fixes[0].kind, m.status) for m in result.failed) == [("drop_read", "failed")] + [("revoke_call", "failed")] * 2
    assert all("wf:refunds" in m.reason for m in result.failed)
    assert {m.id for m in await store.list_all(client, graph)} == {m.id for m in result.passing + result.failed}
    again = await search.search(client, graph)                       # same graph, same answer, same records
    assert [m.id for m in again.passing] == [best.id] and len(await store.list_all(client, graph)) == 4


async def test_search_prefers_revoke_when_nothing_needs_the_grant(client, graph):
    await build(client, graph, sources=["tickets"], resources=["payments"], tools=["get", "refund"], agents=["a"],
                reads=[("get", "tickets")], writes=[("refund", "payments")], calls=[("a", "get"), ("a", "refund")])
    await findings.scan(client, graph)
    result = await search.search(client, graph)
    assert {m.plan.fixes[0].kind for m in result.passing} == {"revoke_call", "gate_call"}
    assert result.passing[0].plan.fixes[0].kind == "revoke_call" and result.passing[0].cost == 1


async def test_search_escalates_to_a_pair_when_no_single_fix_passes(client, graph):
    """Two ways to pay and a workflow that needs both, plus the tickets: only gating both passes."""
    await build(client, graph, sources=["tickets"], resources=["payments"], tools=["get", "refund", "payout"],
                agents=["a"], workflows=["desk"],
                reads=[("get", "tickets")], writes=[("refund", "payments"), ("payout", "payments")],
                calls=[("a", "get"), ("a", "refund"), ("a", "payout")],
                run_by=[("desk", "a")], needs=[("desk", "refund"), ("desk", "payout")], needs_data=[("desk", "tickets")])
    await findings.scan(client, graph)
    result = await search.search(client, graph)
    assert len(result.passing) == 1 and result.sandbox_runs <= get_settings().sandbox_budget
    best = result.passing[0]
    assert sorted((f.kind, f.tool_id) for f in best.plan.fixes) == [("gate_call", "tool:t.payout"), ("gate_call", "tool:t.refund")]
    assert best.cost == 5 and all(not m.passed and m.reason for m in result.failed)


async def test_search_stops_at_its_budget(client, graph):
    await desk(client, graph)
    result = await search.search(client, graph, budget=1)
    assert result.sandbox_runs == 1 and result.passing == [] and len(result.failed) == 1


async def test_search_on_a_clean_graph_and_on_an_unknown_finding(client, graph):
    await build(client, graph, sources=["tickets"], tools=["get"], agents=["a"], reads=[("get", "tickets")], calls=[("a", "get")])
    await findings.scan(client, graph)
    empty = await search.search(client, graph)
    assert (empty.targets, empty.passing, empty.failed, empty.sandbox_runs) == ([], [], [], 0)
    with pytest.raises(NotFound):
        await search.search(client, graph, ["fnd:0000000000"])


# ---------------------------------------------------------------------- approval and apply

async def test_apply_needs_a_persons_approval_and_then_closes_the_finding(client, graph):
    await desk(client, graph)
    best = (await search.search(client, graph)).passing[0]
    with pytest.raises(store.WrongStatus) as refused:
        await apply.apply_fix(client, graph, best.id)
    assert refused.value.code == "needs_approval" and await flows_has_refund(client, graph)

    approved = await apply.approve(client, graph, best.id, "kartik")
    assert (approved.status, approved.approved_by) == ("approved", "kartik")
    patch = await apply.apply_fix(client, graph, best.id)
    assert patch.model_dump() == {
        "scenario": keys.scenario_of(graph), "mitigation_id": best.id,
        "changes": [{"op": "set_gate", "edge": "CAN_CALL", "from_id": "agent:a", "to_id": "tool:t.refund", "gate": "human_approval"}],
        "evidence": {"targets": 1, "resolved": 1, "introduced": 0, "newly_broken": 0, "open_after": 0},
    }
    assert not await flows_has_refund(client, graph)                 # the projection was rebuilt
    scan = await findings.scan(client, graph)
    assert scan.findings == [] and scan.closed_fingerprints == [TICKETS_TO_PAYMENTS]
    assert [f.status for f in await findings.stored(client, graph)] == ["mitigated"]   # mitigated, not just closed
    applied = await store.get(client, graph, best.id)
    assert applied.status == "applied" and applied.applied_at and applied.approved_by == "kartik"

    with pytest.raises(store.WrongStatus):                           # once
        await apply.apply_fix(client, graph, best.id)
    with pytest.raises(store.WrongStatus):
        await apply.approve(client, graph, best.id, "someone else")


async def flows_has_refund(client, key) -> bool:
    return ("agent:a", 3, "tool:t.refund") in await flows(client, key)


async def test_a_failed_plan_can_never_be_approved(client, graph):
    await desk(client, graph)
    failed = (await search.search(client, graph)).failed[0]
    with pytest.raises(store.WrongStatus):
        await apply.approve(client, graph, failed.id, "kartik")
    with pytest.raises(store.WrongStatus):
        await apply.apply_fix(client, graph, failed.id)
    with pytest.raises(NotFound):
        await apply.approve(client, graph, "mit:0000000000", "kartik")


async def test_a_rejected_plan_stays_rejected(client, graph):
    await desk(client, graph)
    best = (await search.search(client, graph)).passing[0]
    rejected = await apply.reject(client, graph, best.id, "kartik", "refunds must stay unattended")
    assert (rejected.status, rejected.decision_reason) == ("rejected", "refunds must stay unattended")
    with pytest.raises(store.WrongStatus):
        await apply.apply_fix(client, graph, best.id)
    again = await search.search(client, graph)                       # the search finds it again, the record does not move
    assert again.passing[0].id == best.id and again.passing[0].status == "rejected"
    assert await flows_has_refund(client, graph)


async def test_apply_verifies_again_when_the_config_changed_since_the_verdict(client, graph):
    await desk(client, graph)
    best = (await search.search(client, graph)).passing[0]
    await apply.approve(client, graph, best.id, "kartik")
    # Meanwhile the desk becomes unattended: the approved gate would now break it.
    await client.run("ingest.workflows", graph, rows=[workflow("refunds", "autonomous")])
    with pytest.raises(StaleTarget) as stale:
        await apply.apply_fix(client, graph, best.id)
    assert stale.value.code == "stale" and "wf:refunds" in stale.value.message
    assert await flows_has_refund(client, graph) and (await store.get(client, graph, best.id)).status == "approved"
    # Back to supervised: the hash still differs from the stored one, the plan verifies again and is applied.
    await client.run("ingest.workflows", graph, rows=[workflow("refunds", "supervised")])
    await build(client, graph, tools=["note"], calls=[("a", "note")])
    assert (await apply.apply_fix(client, graph, best.id)).evidence["resolved"] == 1
    assert not await flows_has_refund(client, graph)


async def test_apply_is_stale_when_its_finding_is_already_gone(client, graph):
    await desk(client, graph)
    best = (await search.search(client, graph)).passing[0]
    await apply.approve(client, graph, best.id, "kartik")
    await client.run("ingest.data_sources", graph, rows=[{"id": "src:tickets", "name": "tickets", "trust": "internal"}])
    with pytest.raises(StaleTarget, match="not an open finding"):
        await apply.apply_fix(client, graph, best.id)
    assert await flows_has_refund(client, graph)


async def test_two_applies_at_once_change_the_graph_once(client, graph):
    await desk(client, graph)
    best = (await search.search(client, graph)).passing[0]
    await apply.approve(client, graph, best.id, "kartik")
    results = await asyncio.gather(apply.apply_fix(client, graph, best.id), apply.apply_fix(client, graph, best.id),
                                   return_exceptions=True)
    assert sorted(type(r).__name__ for r in results) == ["ConfigPatch", "WrongStatus"]


async def test_a_plan_applied_once_can_be_proposed_again_if_its_finding_reopens(client, graph):
    await desk(client, graph)
    best = (await search.search(client, graph)).passing[0]
    await apply.approve(client, graph, best.id, "kartik")
    await apply.apply_fix(client, graph, best.id)
    assert (await findings.scan(client, graph)).findings == []
    await set_call_gate(client, graph, "a", "refund", None)          # someone takes the gate off again
    reopened = await findings.scan(client, graph)
    assert reopened.reopened_fingerprints == [TICKETS_TO_PAYMENTS]
    again = (await search.search(client, graph)).passing[0]
    assert again.id == best.id and again.status == "proposed"


# ---------------------------------------------------------------------- drop_read and split_agent

def drop(tool: str, source: str) -> DropRead:
    return DropRead(kind="drop_read", tool_id=f"tool:t.{tool}", source_id=f"src:{source}")


def split(agent: str, *tools: str) -> SplitAgent:
    return SplitAgent(kind="split_agent", agent_id=f"agent:{agent}", reader_tool_ids=[f"tool:t.{t}" for t in tools])


def reads(name: str) -> dict:
    """A tool that is known to read: only such a tool may move to a reader."""
    return {"id": f"tool:t.{name}", "name": name, "server_id": "srv:t", "description": "", "capability": "read", "capability_source": "manual"}


async def reading_desk(client, key, mode: str = "supervised") -> None:
    """The support desk again, with `get` labelled as a read tool, so the agent can be split."""
    await build(client, key, sources=["tickets"], resources=["payments"], tools=[reads("get"), "refund"], agents=["a"],
                workflows=[workflow("refunds", mode)],
                reads=[("get", "tickets")], writes=[("refund", "payments")], calls=[("a", "get"), ("a", "refund")],
                run_by=[("refunds", "a")], needs=[("refunds", "refund")], needs_data=[("refunds", "tickets")])
    await findings.scan(client, key)


def test_the_new_fixes_cost_more_than_a_gate_and_patch_the_registry_too():
    assert plan(drop("get", "tickets")).cost == 3 and plan(split("a", "get")).cost == 4
    assert config_patch(drop("get", "tickets")) == {"op": "delete", "edge": "READS", "from_id": "tool:t.get", "to_id": "src:tickets"}
    patch = config_patch(split("a", "get", "list"))
    assert (patch["op"], patch["reader_id"], patch["moved_tool_ids"], patch["gate"]) == ("split", "agent:a.reader", ["tool:t.get", "tool:t.list"], "quarantine")
    assert reader_id("agent:a") == "agent:a.reader" and reader_id("agent:a").count(":") == 1    # still one id, with one colon


async def test_drop_read_cuts_rule_1_and_fails_when_a_workflow_needs_the_data(client, graph):
    await desk(client, graph)
    verdict = await sandbox.verify(client, graph, plan(drop("get", "tickets")), [TICKETS_TO_PAYMENTS])
    assert verdict.diff.resolved == [TICKETS_TO_PAYMENTS] and not verdict.passed
    assert "nothing on its path can read src:tickets" in verdict.reason         # the refund workflow reads the tickets
    assert ("src:tickets", 1, "tool:t.get") in await flows(client, graph)        # the graph itself was not touched
    with pytest.raises(StaleTarget, match="does not read"):
        await sandbox.diff(client, graph, [drop("refund", "tickets")])


async def test_drop_read_passes_when_nothing_needs_what_was_read(client, graph):
    await build(client, graph, sources=["tickets", "web"], resources=["payments"], tools=["get", "fetch", "refund"], agents=["a"],
                workflows=[workflow("refunds")], reads=[("get", "tickets"), ("fetch", "web")], writes=[("refund", "payments")],
                calls=[("a", "get"), ("a", "fetch"), ("a", "refund")],
                run_by=[("refunds", "a")], needs=[("refunds", "refund"), ("refunds", "fetch")], needs_data=[("refunds", "tickets")])
    await findings.scan(client, graph)
    web = injection_fingerprint("src:web", "res:payments")
    # the workflow needs the fetch tool, so the grant cannot go; it does not need the web, so the read can
    assert not (await sandbox.verify(client, graph, plan(revoke("a", "fetch")), [web])).passed
    verdict = await sandbox.verify(client, graph, plan(drop("fetch", "web")), [web])
    assert verdict.passed and verdict.diff.resolved == [web]


async def test_split_agent_moves_reading_behind_a_quarantined_reader(client, graph):
    await reading_desk(client, graph)
    verdict = await sandbox.verify(client, graph, plan(split("a", "get")), [TICKETS_TO_PAYMENTS])
    assert verdict.passed and verdict.diff.introduced == [] and verdict.diff.newly_broken == []
    assert ("agent:a", 4, "agent:a.reader") not in await flows(client, graph) and await no_sandboxes(client)

    stored = await store.record(client, graph, verdict, config_hash=await config_hash(client, graph), source="search")
    await apply.approve(client, graph, stored.id, "a person")
    patch = await apply.apply_fix(client, graph, stored.id)
    assert patch.changes[0]["reader_id"] == "agent:a.reader"
    edges, held = await flows(client, graph), await gated(client, graph)
    assert ("tool:t.get", 2, "agent:a.reader") in edges and ("tool:t.get", 2, "agent:a") not in edges   # the reader reads
    assert ("agent:a", 4, "agent:a.reader") in edges                                                    # context still goes down
    assert held == {("agent:a.reader", 6, "agent:a", "quarantine")}                                    # and nothing comes back raw
    assert ("agent:a", 3, "tool:t.refund") in edges                                                     # the agent still acts
    after = await findings.scan(client, graph)
    assert after.findings == [] and after.mitigated_fingerprints == [TICKETS_TO_PAYMENTS]
    assert await broken(client, graph) == set()                                    # the workflow reads through the reader
    reader = (await client.graph(graph).ro_query("MATCH (r:Agent {id:'agent:a.reader'}) RETURN r.name, r.owner")).result_set
    assert reader == [["a (reader)", None]]
    with pytest.raises(StaleTarget, match="already has a reader"):
        await sandbox.diff(client, graph, [split("a", "get")])


async def test_split_agent_only_moves_tools_that_are_known_to_read(client, graph):
    await desk(client, graph)                                        # here `get` has no capability label
    with pytest.raises(InvalidFix, match="only a tool known to read"):
        await sandbox.diff(client, graph, [split("a", "get")])
    with pytest.raises(NotFound):
        await sandbox.diff(client, graph, [split("a", "nope")])
    await reading_desk(client, graph)
    with pytest.raises(InvalidFix, match="capability is unknown"):     # the refund tool acts: it stays with the agent
        await sandbox.diff(client, graph, [split("a", "get", "refund")])


async def test_a_split_whose_reader_becomes_a_trifecta_fails(client, graph):
    """A tool labelled `read` that can also send mail out: its reader would hold untrusted text, the agent's
    private context and a way out. `introduced` is what catches it."""
    fetch = reads("fetch")
    await build(client, graph, sources=["tickets", PRIVATE], resources=["payments", EXIT], tools=[fetch, "search", "refund"],
                agents=["a"], reads=[("fetch", "tickets"), ("search", "crm")], writes=[("fetch", "mail"), ("refund", "payments")],
                calls=[("a", "fetch"), ("a", "search"), ("a", "refund")])
    await findings.scan(client, graph)
    verdict = await sandbox.verify(client, graph, plan(split("a", "fetch")), [TICKETS_TO_PAYMENTS])
    reader_trifecta = trifecta_fingerprint("agent:a.reader")
    assert not verdict.passed and reader_trifecta in verdict.diff.introduced
    assert "introduces" in verdict.reason


async def test_candidates_offer_a_drop_for_each_read_and_a_split_for_an_agent_that_reads_then_acts(client, graph):
    await reading_desk(client, graph)
    current, _ = await findings.current(client, graph)
    report = chokepoints.from_paths(current)
    assert report.split_candidates == [("agent:a", 1)] and report.split_tools == {"agent:a": ["tool:t.get"]}
    capability = {row["id"]: row["capability"] for row in await client.run("node.names", graph)}
    kinds = [(p.fixes[0].kind, p.cost) for p in candidates(report, capability)]
    assert kinds == [("revoke_call", 1), ("revoke_call", 1), ("gate_call", 2), ("drop_read", 3), ("split_agent", 4)]
    assert "split_agent" not in [p.fixes[0].kind for p in candidates(report)]       # without the labels, no split is offered

    result = await search.search(client, graph)
    assert [m.plan.fixes[0].kind for m in result.passing] == ["gate_call", "split_agent"]   # both pass; the gate is cheaper
    assert result.sandbox_runs == 5


def test_the_cut_becomes_the_cheapest_fix_per_hop_with_one_fix_per_grant():
    from devries.analysis.models import ChokepointReport, EdgeRef, EdgeScore
    from devries.mitigation.candidates import cut_fixes

    report = ChokepointReport(method="mincut", cut_cost=4, edges=[
        EdgeScore(edge=EdgeRef(rel="CAN_CALL", from_id="agent:a", to_id="tool:t.pay", rule=3), score=1, fixes=["revoke_call", "gate_call"]),
        EdgeScore(edge=EdgeRef(rel="CAN_CALL", from_id="agent:a", to_id="tool:t.pay", rule=2), score=1, fixes=["revoke_call"]),
        EdgeScore(edge=EdgeRef(rel="DELEGATES_TO", from_id="agent:a", to_id="agent:r", rule=6), score=2, fixes=["quarantine_delegation"]),
        EdgeScore(edge=EdgeRef(rel="WRITES", from_id="tool:t.pay", to_id="res:p", rule=5), score=1000, fixes=[]),
    ])
    fixes = cut_fixes(report)
    assert [f.kind for f in fixes] == ["revoke_call", "quarantine_delegation"]      # the grant once, the write never
    assert (fixes[0].agent_id, fixes[0].tool_id) == ("agent:a", "tool:t.pay")
    assert (fixes[1].from_agent_id, fixes[1].to_agent_id) == ("agent:a", "agent:r")
    assert cut_fixes(ChokepointReport(method="mincut", cut_cost=0)) == []


def test_the_legs_of_a_trifecta_are_read_together_when_looking_for_an_agent_to_split():
    from devries.analysis.models import Finding, PathEvidence

    finding = Finding(id="fnd:x", fingerprint="x", kind="trifecta", severity="high", agent_id="agent:a", evidence=[
        PathEvidence(node_ids=["src:mail", "tool:read", "agent:r", "agent:a"], rules=[1, 2, 6], leg="untrusted"),
        PathEvidence(node_ids=["src:crm", "tool:search", "agent:a"], rules=[1, 2], leg="private"),
        PathEvidence(node_ids=["agent:a", "tool:send", "res:out"], rules=[3, 5], leg="exit"),
    ])
    report = chokepoints.from_paths([finding])
    # agent:a reads (the private leg) and acts (the exit leg); agent:r only reads
    assert report.split_candidates == [("agent:a", 1)] and report.split_tools == {"agent:a": ["tool:search"]}
