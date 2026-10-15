"""From a chokepoint report to candidate plans: one fix per plan, in the order the report ranked the edges."""

from cistern.analysis.models import ChokepointReport, EdgeRef
from cistern.mitigation.dsl import COST, DropRead, FixPlan, GateCall, QuarantineDelegation, RevokeCall, SplitAgent


def fix_for(kind: str, edge: EdgeRef):
    """The fix of this kind that acts on this config edge, or None if the two do not go together."""
    if kind == "gate_call" and edge.rel == "CAN_CALL":
        return GateCall(kind="gate_call", agent_id=edge.from_id, tool_id=edge.to_id)
    if kind == "revoke_call" and edge.rel == "CAN_CALL":
        return RevokeCall(kind="revoke_call", agent_id=edge.from_id, tool_id=edge.to_id)
    if kind == "quarantine_delegation" and edge.rel == "DELEGATES_TO":
        return QuarantineDelegation(kind="quarantine_delegation", from_agent_id=edge.from_id, to_agent_id=edge.to_id)
    if kind == "drop_read" and edge.rel == "READS":
        return DropRead(kind="drop_read", tool_id=edge.from_id, source_id=edge.to_id)
    return None


def candidates(report: ChokepointReport, capability: dict[str, str | None] | None = None) -> list[FixPlan]:
    """Single-fix plans, cheapest first; within a cost, in the report's own order (most-crossed edge first).
    A split is offered for an agent that reads and then acts, with those of its reading tools that are
    known to read: `capability` says which, and without it no split is offered."""
    plans: list[FixPlan] = []
    seen: set[str] = set()
    for agent, _ in report.split_candidates:
        readers = [t for t in report.split_tools.get(agent, []) if (capability or {}).get(t) == "read"]
        if readers:
            plans.append(FixPlan(fixes=[SplitAgent(kind="split_agent", agent_id=agent, reader_tool_ids=readers)]))
            seen.add(plans[-1].canonical())
    for scored in report.edges:
        for kind in scored.fixes:
            if kind not in COST:
                continue
            fix = fix_for(kind, scored.edge)
            if fix is None:
                continue
            plan = FixPlan(fixes=[fix])
            if plan.canonical() not in seen:              # one grant can sit behind a rule-2 and a rule-3 hop
                seen.add(plan.canonical())
                plans.append(plan)
    return sorted(plans, key=lambda p: p.cost)            # stable: keeps the report's order within a cost
