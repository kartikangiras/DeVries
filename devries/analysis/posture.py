"""The posture analytics: what text planted in each untrusted source reaches, which untrusted sources reach each
target, and where the open routes meet.

Every number is FalkorDB's answer (one BFS per source or per target, betweenness) or a count over the evidence
paths the findings already carry. Context for a person; the findings are the verdicts.
"""

from collections import Counter
from typing import Any

from devries.analysis import chokepoints
from devries.analysis.models import ChokepointReport, Finding
from devries.analysis.scorecard import AgentCard
from devries.graph.client import GraphClient

Nodes = dict[str, dict[str, Any]]        # ui.nodes rows by id


async def depth_of(client: GraphClient, key: str) -> int:
    """The BFS depth every reach question uses: the node count, so no simple path is cut short. Never 0."""
    return max(1, (await client.run("graph.node_count", key))[0]["nodes"])


async def reached_by_untrusted(client: GraphClient, key: str, depth: int) -> set[str]:
    rows = await client.run("reach.untrusted_nodes", key, max_depth=depth)
    return set(rows[0]["reached"]) if rows else set()


async def reach_from(client: GraphClient, key: str, node_id: str, depth: int) -> set[str]:
    rows = await client.run("reach.from", key, id=node_id, max_depth=depth)
    return {i for i in rows[0]["reached"] if i != node_id} if rows else set()


async def reach_into(client: GraphClient, key: str, node_id: str, depth: int) -> set[str]:
    rows = await client.run("reach.into", key, id=node_id, max_depth=depth)
    return set(rows[0]["reaching"]) if rows else set()


def _of(nodes: Nodes, label: str, **facts: Any) -> set[str]:
    """The ids of one label that carry these facts: `_of(nodes, "Resource", impact="high")`."""
    return {i for i, n in nodes.items() if n["label"] == label and all(n.get(k) == v for k, v in facts.items())}


async def exposure(client: GraphClient, key: str, depth: int, nodes: Nodes) -> dict[str, int]:
    """Of the high-impact resources, the external ones and the agents, how many untrusted text reaches."""
    reached = await reached_by_untrusted(client, key, depth)
    high = {t for row in await client.run("reach.untrusted_to_high", key, max_depth=depth) for t in row["targets"]}
    agents, external = _of(nodes, "Agent"), _of(nodes, "Resource", external=True)
    return {"high_reached": len(high), "high_total": len(_of(nodes, "Resource", impact="high")),
            "external_reached": len(external & reached), "external_total": len(external),
            "agents_reached": len(agents & reached), "agents_total": len(agents)}


def _name(nodes: Nodes, node_id: str) -> str:
    return nodes.get(node_id, {}).get("name") or node_id


async def blast_radius(client: GraphClient, key: str, depth: int, nodes: Nodes) -> list[dict[str, Any]]:
    """Per untrusted source: everything it reaches, sorted by label, with the high-impact and external resources counted."""
    out = []
    for source in sorted(_of(nodes, "DataSource", trust="untrusted")):
        reached = sorted(await reach_from(client, key, source, depth))
        labels = Counter(nodes.get(i, {}).get("label") for i in reached)
        out.append({"id": source, "name": _name(nodes, source), "reached": len(reached),
                    "agents": labels["Agent"], "tools": labels["Tool"], "resources": labels["Resource"],
                    "high": len(set(reached) & _of(nodes, "Resource", impact="high")),
                    "external": len(set(reached) & _of(nodes, "Resource", external=True)), "ids": reached})
    return sorted(out, key=lambda b: (-b["high"], -b["reached"], b["id"]))


async def target_exposure(client: GraphClient, key: str, depth: int, nodes: Nodes) -> list[dict[str, Any]]:
    """Per high-impact or external resource: the untrusted sources that reach it."""
    untrusted = _of(nodes, "DataSource", trust="untrusted")
    out = []
    for target in sorted(_of(nodes, "Resource", impact="high") | _of(nodes, "Resource", external=True)):
        sources = sorted(await reach_into(client, key, target, depth) & untrusted)
        row = nodes[target]
        out.append({"id": target, "name": _name(nodes, target), "impact": row.get("impact"), "external": bool(row.get("external")),
                    "reaching": len(sources), "sources": sources})
    return sorted(out, key=lambda t: (-t["reaching"], t["impact"] != "high", t["id"]))


def chokes(findings: list[Finding], nodes: Nodes, central: ChokepointReport, top: int = 8) -> list[dict[str, Any]]:
    """The agents and tools the open routes pass through, most routes first, with their betweenness beside (None
    when the node is not among the five most central)."""
    score = {n.id: n.score for n in central.nodes}
    out = []
    for node_id, hit in chokepoints.through(findings).items():
        row = nodes.get(node_id)
        if row and row["label"] in ("Agent", "Tool"):
            out.append({"id": node_id, "name": _name(nodes, node_id), "label": row["label"], "routes": hit["routes"],
                        "findings": hit["findings"], "betweenness": round(score[node_id], 3) if node_id in score else None})
    out.sort(key=lambda c: (-c["routes"], -(c["betweenness"] if c["betweenness"] is not None else -1), c["id"]))
    return out[:top]


def _agent_row(row: dict[str, Any], card: AgentCard | None, reached: set[str], rank: dict[str, int]) -> dict[str, Any]:
    return {"owner": row["owner"], "properties": card.properties if card else [], "count": card.count if card else 0,
            "autonomous": bool(card and card.autonomous), "workflows": row["workflows"], "grants": row["grants"],
            "gated": row["gated_grants"], "delegates_to": row["delegates_to"], "reached": row["id"] in reached,
            "pagerank_rank": rank.get(row["id"])}


def _tool_row(row: dict[str, Any], reached: set[str], rank: dict[str, int]) -> dict[str, Any]:
    return {"server_id": row["server_id"], "capability": row["capability"], "held_by": row["held_by"], "gated": row["gated_holds"],
            "reads": row["reads"], "acts_on": row["acts_on"], "reached": row["id"] in reached, "pagerank_rank": rank.get(row["id"])}


async def inventory(client: GraphClient, key: str, rows: list[dict[str, Any]], findings: list[Finding],
                    cards: dict[str, AgentCard]) -> dict[str, list[dict[str, Any]]]:
    """Every agent, tool, source and resource of `inventory.rows` with what the graph says about it: whether untrusted
    text reaches it, how many agents a source reaches, how many untrusted sources reach a resource, the open findings
    with it on a path, its PageRank place and, for an agent, its Rule of Two letters. Most findings first."""
    nodes = {r["id"]: r for r in rows}
    depth = await depth_of(client, key)
    reached = await reached_by_untrusted(client, key, depth)
    rank = {r["id"]: i for i, r in enumerate(await client.run("choke.pagerank", key), 1)}
    hits = chokepoints.through(findings)
    agents, untrusted = _of(nodes, "Agent"), _of(nodes, "DataSource", trust="untrusted")
    out: dict[str, list[dict[str, Any]]] = {"agents": [], "tools": [], "sources": [], "resources": []}
    for row in rows:
        base = {"id": row["id"], "name": row["name"] or row["id"], "findings": hits.get(row["id"], {}).get("findings", 0)}
        if row["label"] == "Agent":
            out["agents"].append(base | _agent_row(row, cards.get(row["id"]), reached, rank))
        elif row["label"] == "Tool":
            out["tools"].append(base | _tool_row(row, reached, rank))
        elif row["label"] == "DataSource":
            out["sources"].append(base | {"trust": row["trust"], "read_by": row["read_by"],
                                          "reaches_agents": len(agents & await reach_from(client, key, row["id"], depth))})
        else:
            out["resources"].append(base | {"impact": row["impact"], "external": bool(row["external"]), "acted_on_by": row["acted_on_by"],
                                            "reached_by_untrusted": row["id"] in reached,
                                            "reaching_sources": len(untrusted & await reach_into(client, key, row["id"], depth))})
    for items in out.values():
        items.sort(key=lambda item: (-item["findings"], item["id"]))
    return out
