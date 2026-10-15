"""A scanner's worst failure is a clean report that is wrong.

The canary builds a small graph with one known injection (down a 16-hop chain)
and one known trifecta agent, runs the real verdict queries on it, and fails
loudly if either is missing. It exists because of a real surprise: FalkorDB's
BFS with a depth of 0, documented as unlimited, returns nothing at all.
"""

import time

from pydantic import BaseModel

from devries.analysis import findings as findings_mod
from devries.errors import CanaryFailed
from devries.graph import keys, projection
from devries.graph.client import GraphClient

EXPECTED_INJECTION = {("src:canary-untrusted", "res:canary-high")}
EXPECTED_TRIFECTA = {"agent:canary-tri"}
EXPECTED_HOPS = 16


class CanaryResult(BaseModel):
    ok: bool
    detail: str
    checked_at: int
    ms: int


async def run_canary(client: GraphClient) -> CanaryResult:
    key = keys.sandbox_key()
    t0 = time.monotonic()
    problems: list[str] = []
    try:
        await client.run("canary.build", key)
        await projection.rebuild(client, key)
        found, _ = await findings_mod.compute(client, key)
        injection = {(f.source_id, f.target_id) for f in found if f.kind == "injection"}
        trifecta = {f.agent_id for f in found if f.kind == "trifecta"}
        if injection != EXPECTED_INJECTION:
            problems.append(f"injection findings {sorted(injection)} instead of {sorted(EXPECTED_INJECTION)}")
        if trifecta != EXPECTED_TRIFECTA:
            problems.append(f"trifecta agents {sorted(trifecta)} instead of {sorted(EXPECTED_TRIFECTA)}")
        chain = next((f for f in found if f.kind == "injection"), None)
        hops = len(chain.evidence[0].rules) if chain and chain.evidence else 0
        if chain is not None and hops != EXPECTED_HOPS:
            problems.append(f"the known path has {hops} hops in the evidence instead of {EXPECTED_HOPS}")
    except Exception as e:                                  # the canary must never raise past here
        problems.append(f"{type(e).__name__}: {e}")
    finally:
        try:
            await client.delete(key)
        except Exception:
            pass
    return CanaryResult(
        ok=not problems,
        detail="known injection and trifecta found" if not problems else "; ".join(problems),
        checked_at=int(time.time() * 1000),
        ms=int((time.monotonic() - t0) * 1000),
    )


_last: dict[int, CanaryResult] = {}


async def ensure(client: GraphClient, ttl_s: int = 300) -> CanaryResult:
    """Run the canary unless a passing result is fresh; raise if it fails. A failure is never cached."""
    last = _last.get(id(client))
    if last is not None and last.ok and (time.time() * 1000 - last.checked_at) < ttl_s * 1000:
        return last
    result = await run_canary(client)
    if not result.ok:
        _last.pop(id(client), None)
        raise CanaryFailed(f"refusing to scan: the self-check failed ({result.detail})")
    _last[id(client)] = result
    return result
