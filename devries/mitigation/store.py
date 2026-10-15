"""Mitigations as audit nodes in the working graph: every plan that was tested, with its verdict."""

import time
from typing import Literal

from pydantic import BaseModel

from devries.errors import DeVriesError, NotFound
from devries.graph.client import GraphClient
from devries.mitigation.dsl import FixPlan, Verdict, mitigation_id

Status = Literal["proposed", "approved", "applied", "rejected", "failed"]


class WrongStatus(DeVriesError):
    code = "needs_approval"


class Mitigation(BaseModel):
    id: str
    status: Status
    plan: FixPlan
    cost: int
    targets: list[str]                      # finding fingerprints
    verdict: Verdict | None = None
    passed: bool = False
    reason: str | None = None               # why the plan failed verification
    rationale: str | None = None            # why whoever proposed it chose it
    source: str = "search"                  # search | agent | scripted
    config_hash: str | None = None          # the config it was verified against
    approved_by: str | None = None
    decision_reason: str | None = None
    created_at: int | None = None
    applied_at: int | None = None


def _from_row(row: dict) -> Mitigation:
    return Mitigation(
        id=row["id"], status=row["status"], plan=FixPlan.model_validate_json(row["fix_json"]),
        cost=row["cost"], targets=list(row["target_fingerprints"] or []),
        verdict=Verdict.model_validate_json(row["verdict_json"]) if row.get("verdict_json") else None,
        passed=bool(row.get("passed")), reason=row.get("reason"), rationale=row.get("rationale"),
        source=row.get("source") or "search", config_hash=row.get("config_hash"),
        approved_by=row.get("approved_by"), decision_reason=row.get("decision_reason"),
        created_at=row.get("created_at"), applied_at=row.get("applied_at"),
    )


async def record(client: GraphClient, working_key: str, verdict: Verdict, *, config_hash: str,
                 source: str, rationale: str | None = None) -> Mitigation:
    """Store a tested plan. A passing plan is `proposed`, a failing one `failed`. The same plan for the same
    targets is one node; once approved, applied or rejected its verdict and status are no longer overwritten."""
    mid = mitigation_id(verdict.plan, verdict.targets)
    await client.run(
        "mitigation.record", working_key, id=mid, now=int(time.time() * 1000),
        status="proposed" if verdict.passed else "failed",
        fix_json=verdict.plan.model_dump_json(), cost=verdict.plan.cost, targets=verdict.targets,
        config_hash=config_hash, verdict_json=verdict.model_dump_json(), passed=verdict.passed,
        reason=verdict.reason, rationale=rationale, source=source,
    )
    return await get(client, working_key, mid)


async def get(client: GraphClient, working_key: str, mitigation_id_: str) -> Mitigation:
    rows = await client.run("mitigation.get", working_key, id=mitigation_id_)
    if not rows:
        raise NotFound(f"no mitigation {mitigation_id_!r} in this scenario")
    return _from_row(rows[0])


async def list_all(client: GraphClient, working_key: str) -> list[Mitigation]:
    return [_from_row(row) for row in await client.run("mitigation.list", working_key)]


async def set_status(client: GraphClient, working_key: str, mitigation_id_: str, status: Status, *,
                     allowed: list[Status], approved_by: str | None = None, applied_at: int | None = None,
                     decision_reason: str | None = None) -> Mitigation:
    rows = await client.run(
        "mitigation.set_status", working_key, id=mitigation_id_, status=status, allowed=allowed,
        now=int(time.time() * 1000), approved_by=approved_by, applied_at=applied_at, decision_reason=decision_reason,
    )
    if not rows:
        current = await get(client, working_key, mitigation_id_)      # raises NotFound if it does not exist
        raise WrongStatus(f"{mitigation_id_} is {current.status}; it must be {' or '.join(allowed)} to become {status}",
                          status=current.status)
    return await get(client, working_key, mitigation_id_)
