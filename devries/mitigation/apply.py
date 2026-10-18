"""Approval and apply. The one module that may run a fix query on a working graph.

A mitigation is applied only if a person approved it and it still verifies
against the config as it stands now. The apply is resumable: the number of
fixes made so far is written to the plan after each one, so a process that
dies mid-plan leaves a plan the next apply finishes rather than one it can
never apply. One apply at a time per graph, across processes: the lock is a
key in FalkorDB itself, not a Python object, because the app and the stdio
MCP server are two processes on one database.
"""

import asyncio
import contextlib
import logging
import time
from secrets import token_hex

from pydantic import BaseModel

from devries.errors import DeVriesError, NotFound
from devries.graph import keys
from devries.graph.client import _APPLY_TOKEN, GraphClient
from devries.mitigation import sandbox, store
from devries.mitigation.dsl import config_patch
from devries.mitigation.sandbox import StaleTarget

log = logging.getLogger("devries.apply")

LOCK_TTL_S = 30          # an apply that dies holds its lock no longer than this
LOCK_WAIT_S = 10


class ApplyBusy(DeVriesError):
    code = "fix_failed"
    retryable = True


class ConfigPatch(BaseModel):
    """What was applied: the change to each config edge, and the evidence the verdict rested on."""
    scenario: str
    mitigation_id: str
    changes: list[dict]
    evidence: dict


async def approve(client: GraphClient, working_key: str, mitigation_id: str, approver: str,
                  session: str | None = None) -> store.Mitigation:
    return await store.set_status(client, working_key, mitigation_id, "approved", allowed=["proposed"], approved_by=approver,
                                  approved_session=store.session_hash(session))


async def reject(client: GraphClient, working_key: str, mitigation_id: str, approver: str,
                 reason: str | None = None, session: str | None = None) -> store.Mitigation:
    return await store.set_status(client, working_key, mitigation_id, "rejected", allowed=["proposed", "approved"],
                                  approved_by=approver, decision_reason=reason, approved_session=store.session_hash(session))


@contextlib.asynccontextmanager
async def _graph_lock(client: GraphClient, working_key: str):
    """One apply at a time per graph, across every process on this database: SET NX with a TTL on a key beside the graph."""
    name = f"lock:apply:{working_key}"
    token = token_hex(8)
    deadline = time.monotonic() + LOCK_WAIT_S
    conn = client.connection
    while True:
        if await conn.set(name, token, nx=True, ex=LOCK_TTL_S):
            break
        if time.monotonic() > deadline:
            raise ApplyBusy("another apply is working on this scenario; try again in a moment")
        await asyncio.sleep(0.1)
    try:
        yield
    finally:
        try:
            if (await conn.get(name)) in (token, token.encode()):
                await conn.delete(name)
        except Exception as e:  # noqa: BLE001 - the lock expires on its own; losing the release costs at most LOCK_TTL_S
            log.warning("could not release the apply lock on %s: %s", working_key, type(e).__name__)


async def apply_fix(client: GraphClient, working_key: str, mitigation_id: str) -> ConfigPatch:
    async with _graph_lock(client, working_key):
        return await _apply(client, working_key, mitigation_id)


async def _apply(client: GraphClient, working_key: str, mitigation_id: str) -> ConfigPatch:
    mitigation = await store.get(client, working_key, mitigation_id)
    if mitigation.status != "approved":
        raise store.WrongStatus(f"{mitigation_id} is {mitigation.status}; a person has to approve it before it can be applied",
                                status=mitigation.status)

    done = mitigation.applied_fixes
    verdict = mitigation.verdict
    if done == 0:
        # Verified against a config that has since changed: verify again before touching anything.
        if await sandbox.config_hash(client, working_key) != mitigation.config_hash or verdict is None:
            try:
                verdict = await sandbox.verify(client, working_key, mitigation.plan, mitigation.targets)
            except NotFound as e:
                raise StaleTarget(f"the config changed since {mitigation_id} was verified: {e.message}. Simulate again.") from e
            if not verdict.passed:
                raise StaleTarget(f"the config changed since {mitigation_id} was verified and the plan no longer passes: "
                                  f"{verdict.reason}. Simulate again.")
    elif verdict is None:
        raise StaleTarget(f"{mitigation_id} was part-applied by a process that left no verdict behind; simulate again")
    else:
        log.warning("%s: finishing an apply that stopped after %d of %d fixes", mitigation_id, done, len(mitigation.plan.fixes))

    for i, fix in enumerate(mitigation.plan.fixes):
        if i < done:
            continue                                     # made by the apply that died
        await sandbox.apply_change(client, working_key, fix, _token=_APPLY_TOKEN)
        await store.set_progress(client, working_key, mitigation_id, i + 1)
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
