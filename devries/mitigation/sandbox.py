"""Sandboxes: what happens to the findings and the workflows if these changes are applied?

Every answer is measured in a throwaway graph. A sandbox is cloned from a
working graph, measured, changed, measured again and deleted. Nothing here can
write to a working graph: the fix queries are guarded, and only apply.py holds
the token.
"""

import contextlib
import json
import logging
import time
from dataclasses import dataclass, field
from hashlib import sha1

import redis.exceptions as rex

from devries.analysis.models import finding_id, injection_fingerprint, trifecta_fingerprint
from devries.config import get_settings
from devries.errors import DeVriesError, InvalidFix, NotFound, QueryTimeout
from devries.graph import keys
from devries.graph.client import GraphClient
from devries.mitigation.dsl import Broken, Diff, FindingRef, FixPlan, Verdict, nothing_to_change, reader_id

log = logging.getLogger("devries.sandbox")

# change kind -> (catalog query, its parameters)
QUERY_FOR = {
    "gate_call": ("fix.gate_call", ("agent_id", "tool_id")),
    "revoke_call": ("fix.revoke_call", ("agent_id", "tool_id")),
    "quarantine_delegation": ("fix.quarantine_delegation", ("from_agent_id", "to_agent_id")),
    "drop_read": ("fix.drop_read", ("tool_id", "source_id")),
    "split_agent": ("fix.split_agent", ("agent_id", "reader_tool_ids")),
    "grant_call": ("whatif.grant_call", ("agent_id", "tool_id")),
    "add_delegation": ("whatif.add_delegation", ("from_agent_id", "to_agent_id")),
    "drop_server": ("whatif.drop_server", ("server_id",)),
}

class StaleTarget(DeVriesError):
    code = "stale"
    retryable = True


class SandboxError(DeVriesError):
    code = "sandbox_error"
    retryable = True


@dataclass
class Measure:
    findings: dict[str, FindingRef] = field(default_factory=dict)          # by fingerprint
    broken: dict[tuple[str, str, str], Broken] = field(default_factory=dict)   # by (workflow, kind, missing)
    legs: dict[str, tuple[str, str]] = field(default_factory=dict)         # trifecta fingerprint -> (an untrusted source, an exit)


async def clone(client: GraphClient, source_key: str, dest_key: str) -> None:
    """A private copy of a working graph: GRAPH.COPY, one at a time, with one retry inside the client."""
    try:
        await client.copy(source_key, dest_key)
    except rex.ResponseError as e:
        raise SandboxError(f"sandbox error: could not copy the graph ({e})") from e
    except rex.TimeoutError as e:
        raise SandboxError("sandbox error: copying the graph timed out") from e


async def measure(client: GraphClient, graph_key: str) -> Measure:
    """The three verdict queries: which findings hold, and which workflows are broken."""
    nodes = (await client.run("graph.node_count", graph_key))[0]["nodes"]
    depth = max(nodes, 1)                                # never 0: that returns nothing at all
    out = Measure()
    for row in await client.run("reach.untrusted_to_high", graph_key, max_depth=depth):
        for target in row["targets"]:
            fp = injection_fingerprint(row["source"], target)
            out.findings[fp] = FindingRef(id=finding_id(fp), fingerprint=fp, kind="injection",
                                          source_id=row["source"], target_id=target)
    for row in await client.run("find.trifecta", graph_key, max_depth=depth):
        fp = trifecta_fingerprint(row["agent"])
        out.findings[fp] = FindingRef(id=finding_id(fp), fingerprint=fp, kind="trifecta", agent_id=row["agent"])
        out.legs[fp] = (sorted(row["untrusted"])[0], sorted(row["exits"])[0])
    for row in await client.run("wf.broken", graph_key):
        item = Broken(workflow_id=row["workflow"], kind=row["kind"], missing_id=row["missing"],
                      mode=row["mode"] or "supervised", gated=bool(row["gated"]))
        out.broken[item.key] = item
    return out


async def check_ids(client: GraphClient, graph_key: str, changes: list) -> None:
    """Every id a change names must exist, with the right kind. A missing edge is a different error (stale)."""
    rows = await client.run("node.names", graph_key)
    known = {row["id"]: row["label"] for row in rows}
    capability = {row["id"]: row["capability"] for row in rows}
    words = {"Agent": "an agent", "Tool": "a tool", "DataSource": "a data source", "MCPServer": "a server"}
    for change in changes:
        wanted = {"agent_id": "Agent", "tool_id": "Tool", "from_agent_id": "Agent", "to_agent_id": "Agent",
                  "source_id": "DataSource", "server_id": "MCPServer"}
        named = [(getattr(change, attr, None), label) for attr, label in wanted.items()]
        named += [(tool, "Tool") for tool in getattr(change, "reader_tool_ids", [])]
        for value, label in named:
            if value is not None and known.get(value) != label:
                raise NotFound(f"{value!r} is not {words[label]} in this scenario")
        # a reader exists to hold what was read: a tool that might act, or that nobody has labelled, stays put
        for tool in getattr(change, "reader_tool_ids", []):
            if capability.get(tool) != "read":
                raise InvalidFix(f"{tool} cannot move to a reader: its capability is {capability.get(tool) or 'unknown'}, "
                                 f"and only a tool known to read may")


async def apply_change(client: GraphClient, graph_key: str, change, *, _token: object = None) -> None:
    query, fields = QUERY_FOR[change.kind]
    params = {f: getattr(change, f) for f in fields}
    if change.kind == "split_agent":
        params["reader_id"] = reader_id(change.agent_id)
    changed = (await client.run(query, graph_key, _token=_token, **params))[0]["changed"]
    if changed == 0:
        raise StaleTarget(f"nothing to change: {nothing_to_change(change)}")


MAX_INTRODUCED_PATHS = 5


async def _one_path(client: GraphClient, key: str, after: Measure, fingerprint: str) -> list[str]:
    """One path for a finding the changes would introduce, so a what-if can show what it opens."""
    ref = after.findings[fingerprint]

    async def shortest(source_id: str, target_id: str) -> list[str]:
        rows = await client.run("evidence.pair_paths", key, source_id=source_id, target_id=target_id, max_len=12, k=1)
        return rows[0]["node_ids"] if rows else []

    try:
        if ref.kind == "injection":
            return await shortest(ref.source_id, ref.target_id)
        untrusted, exit_ = after.legs[fingerprint]
        into, out = await shortest(untrusted, ref.agent_id), await shortest(ref.agent_id, exit_)
        return into + out[1:] if into and out else []
    except QueryTimeout:
        return []                                        # a path is an explanation; the verdict does not need it


async def diff(client: GraphClient, working_key: str, changes: list) -> Diff:
    """Clone, measure, change, rebuild, measure again, delete. Before and after describe the same snapshot."""
    if keys.kind(working_key) != "working":
        raise SandboxError("a sandbox is cloned from a working graph")
    await check_ids(client, working_key, changes)
    key = keys.sandbox_key()
    t0 = time.monotonic()
    try:
        await clone(client, working_key, key)
        await client.run("projection.rebuild", key)
        before = await measure(client, key)
        for change in changes:
            await apply_change(client, key, change)
        await client.run("projection.rebuild", key)
        after = await measure(client, key)
        for fp in sorted(set(after.findings) - set(before.findings))[:MAX_INTRODUCED_PATHS]:
            after.findings[fp].path_ids = await _one_path(client, key, after, fp)   # the sandbox is about to go
    finally:
        await client.delete(key)
    named = {**before.findings, **after.findings}
    return Diff(
        open_before=sorted(before.findings), open_after=sorted(after.findings),
        resolved=sorted(set(before.findings) - set(after.findings)),
        introduced=sorted(set(after.findings) - set(before.findings)),
        # a need that was already unmet before the changes is not held against them
        newly_broken=[after.broken[k] for k in sorted(set(after.broken) - set(before.broken))],
        findings=named, sandbox_ms=int((time.monotonic() - t0) * 1000),
    )


@contextlib.asynccontextmanager
async def changed(client: GraphClient, working_key: str, changes: list):
    """A sandbox copy with the changes applied and the flow layer rebuilt, to be read and nothing else.
    It is deleted on the way out, like every sandbox."""
    if keys.kind(working_key) != "working":
        raise SandboxError("a sandbox is cloned from a working graph")
    await check_ids(client, working_key, changes)
    key = keys.sandbox_key()
    try:
        await clone(client, working_key, key)
        for change in changes:
            await apply_change(client, key, change)
        await client.run("projection.rebuild", key)
        yield key
    finally:
        await client.delete(key)


def explain_failure(remaining: list[str], d: Diff) -> str:
    parts = [b.sentence() for b in d.newly_broken]
    if remaining:
        parts.append("leaves open: " + ", ".join(d.findings[fp].id for fp in remaining))
    if d.introduced:
        parts.append("introduces: " + ", ".join(d.findings[fp].id for fp in d.introduced))
    return "; ".join(parts)


async def verify(client: GraphClient, working_key: str, plan: FixPlan, targets: list[str]) -> Verdict:
    """A plan passes when it resolves every target, introduces nothing and breaks no workflow that worked."""
    d = await diff(client, working_key, list(plan.fixes))
    unknown = sorted(set(targets) - set(d.open_before))
    if unknown:
        raise NotFound("not an open finding in this scenario: " + ", ".join(finding_id(fp) for fp in unknown))
    remaining = sorted(set(targets) & set(d.open_after))
    passed = not remaining and not d.introduced and not d.newly_broken
    # with no workflow declared, "breaks nothing" is vacuous: the verdict carries that so a page can say it
    counts = await client.run("overview.counts", working_key)
    unconstrained = not counts or not counts[0].get("workflows")
    return Verdict(plan=plan, targets=sorted(targets), passed=passed, remaining=remaining, diff=d,
                   reason=None if passed else explain_failure(remaining, d), unconstrained=unconstrained)


async def config_hash(client: GraphClient, graph_key: str) -> str:
    """A hash of everything a verdict depends on: config edges with their gates, and the facts on the nodes."""
    edges = [(e["rel"], e["from_id"], e["to_id"], e["gate"]) for e in await client.run("config.edges", graph_key)]
    nodes = [(n["label"], n["id"], n["trust"], n["impact"], n["external"], n["mode"])
             for n in await client.run("config.nodes", graph_key)]
    return sha1(json.dumps([edges, nodes], separators=(",", ":")).encode()).hexdigest()


async def sweep(client: GraphClient, max_age_min: int | None = None) -> list[str]:
    """Delete sandboxes left behind by a crash. Their age is in the key."""
    limit_ms = (max_age_min if max_age_min is not None else get_settings().sandbox_ttl_min) * 60_000
    removed = []
    for key in await client.list_graphs():
        if key.startswith("sbx:") and keys.SANDBOX_RE.fullmatch(key) and keys.sandbox_age_ms(key) > limit_ms:
            await client.delete(key)
            removed.append(key)
    return removed
