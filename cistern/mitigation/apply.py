"""Approval and apply. The one module that may run a fix query on a working graph.

A mitigation is applied only if a person approved it and it still verifies
against the config as it stands now.
"""

import asyncio
import time

from pydantic import BaseModel

from cistern.errors import NotFound
from cistern.graph import keys
from cistern.graph.client import GraphClient, _APPLY_TOKEN
from cistern.mitigation import sandbox, store
from cistern.mitigation.dsl import config_patch
from cistern.mitigation.sandbox import StaleTarget


# One apply at a time per graph: the status check, the hash check and the writes belong together.
_locks: dict[str, asyncio.Lock] = {}


class ConfigPatch(BaseModel):
    """What was applied: the change to each config edge, and the evidence the verdict rested on."""
    scenario: str
    mitigation_id: str
    changes: list[dict]
    evidence: dict


async def approve(client: GraphClient, working_key: str, mitigation_id: str, approver: str) -> store.Mitigation:
    return await store.set_status(client, working_key, mitigation_id, "approved", allowed=["proposed"], approved_by=approver)


async def reject(client: GraphClient, working_key: str, mitigation_id: str, approver: str,
                 reason: str | None = None) -> store.Mitigation:
    return await store.set_status(client, working_key, mitigation_id, "rejected", allowed=["proposed", "approved"],
                                  approved_by=approver, decision_reason=reason)


async def apply_fix(client: GraphClient, working_key: str, mitigation_id: str) -> ConfigPatch:
    async with _locks.setdefault(working_key, asyncio.Lock()):
        return await _apply(client, working_key, mitigation_id)


async def _apply(client: GraphClient, working_key: str, mitigation_id: str) -> ConfigPatch:
    mitigation = await store.get(client, working_key, mitigation_id)
    if mitigation.status != "approved":
        raise store.WrongStatus(f"{mitigation_id} is {mitigation.status}; a person has to approve it before it can be applied",
                                status=mitigation.status)

    # Verified against a config that has since changed: verify again before touching anything.
    verdict = mitigation.verdict
    if await sandbox.config_hash(client, working_key) != mitigation.config_hash or verdict is None:
        try:
            verdict = await sandbox.verify(client, working_key, mitigation.plan, mitigation.targets)
        except NotFound as e:
            raise StaleTarget(f"the config changed since {mitigation_id} was verified: {e.message}. Simulate again.") from e
        if not verdict.passed:
            raise StaleTarget(f"the config changed since {mitigation_id} was verified and the plan no longer passes: "
                              f"{verdict.reason}. Simulate again.")

    for fix in mitigation.plan.fixes:
        await sandbox.apply_change(client, working_key, fix, _token=_APPLY_TOKEN)
    await client.run("projection.rebuild", working_key)

    applied_at = int(time.time() * 1000)
    await store.set_status(client, working_key, mitigation_id, "applied", allowed=["approved"], applied_at=applied_at)
    # Tie it to what it resolved, so the next scan closes those findings as mitigated, not just closed.
    await client.run("mitigation.link_fixes", working_key, id=mitigation_id, fingerprints=verdict.diff.resolved)

    return ConfigPatch(
        scenario=keys.scenario_of(working_key), mitigation_id=mitigation_id,
        changes=[config_patch(fix) for fix in mitigation.plan.fixes],
        evidence={"targets": len(verdict.targets), "resolved": len(verdict.diff.resolved),
                  "introduced": len(verdict.diff.introduced), "newly_broken": len(verdict.diff.newly_broken),
                  "open_after": len(verdict.diff.open_after)},
    )
