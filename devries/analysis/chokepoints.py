"""From paths to the config edges a fix can act on.

Evidence is made of flow hops; fixes act on config edges. Each hop is mapped
back to the config edge behind it, and edges are ranked by how many evidence
paths cross them. It only sees the paths that were fetched, so it can miss an
edge that sits only on a longer path; sandbox verification catches that.
"""

from collections import Counter, defaultdict

from devries.analysis.models import ChokepointReport, EdgeRef, EdgeScore, Finding, NodeScore
from devries.graph.client import GraphClient

# hop rule -> fix kinds that can cut it (rules 4 and 5 cannot be cut)
FIXES = {
    1: ["drop_read"],
    2: ["revoke_call"],
    3: ["revoke_call", "gate_call"],
    6: ["quarantine_delegation"],
}


def config_edge(rule: int, from_id: str, to_id: str) -> EdgeRef | None:
    """The config edge behind one flow hop from_id -> to_id, or None if no fix can cut it."""
    if rule == 1:    # DataSource -> Tool, behind (Tool)-[:READS]->(DataSource)
        return EdgeRef(rel="READS", from_id=to_id, to_id=from_id, rule=1)
    if rule == 2:    # Tool -> Agent, behind (Agent)-[:CAN_CALL]->(Tool)
        return EdgeRef(rel="CAN_CALL", from_id=to_id, to_id=from_id, rule=2)
    if rule == 3:    # Agent -> Tool, behind (Agent)-[:CAN_CALL]->(Tool)
        return EdgeRef(rel="CAN_CALL", from_id=from_id, to_id=to_id, rule=3)
    if rule == 6:    # Delegate -> Agent, behind (Agent)-[:DELEGATES_TO]->(Delegate)
        return EdgeRef(rel="DELEGATES_TO", from_id=to_id, to_id=from_id, rule=6)
    return None


def from_paths(findings: list[Finding], top: int | None = None) -> ChokepointReport:
    counts: Counter[tuple[str, str, str, int]] = Counter()
    for finding in findings:
        for path in finding.evidence:
            seen: set[tuple[str, str, str, int]] = set()
            for i, rule in enumerate(path.rules):
                edge = config_edge(rule, path.node_ids[i], path.node_ids[i + 1])
                if edge is not None:
                    seen.add((edge.rel, edge.from_id, edge.to_id, edge.rule))
            counts.update(seen)                 # a path counts once per edge, however it loops
    ranked = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
    edges = [
        EdgeScore(edge=EdgeRef(rel=rel, from_id=a, to_id=b, rule=rule), score=float(n), fixes=FIXES[rule])
        for (rel, a, b, rule), n in ranked
    ]
    splits, tools = _split_candidates(findings)
    return ChokepointReport(method="paths", edges=edges[:top] if top else edges, split_candidates=splits, split_tools=tools)


def through(findings: list[Finding]) -> dict[str, dict[str, int]]:
    """Per node id: `routes`, how many distinct evidence paths pass through it (not at either end), and `findings`,
    how many findings have it anywhere on a path. The subject of a trifecta is on its own legs' ends, so it counts
    as a finding there and as a route only where another finding's path runs through it."""
    routes: dict[str, set[tuple[str, ...]]] = defaultdict(set)
    hits: dict[str, set[str]] = defaultdict(set)
    for finding in findings:
        for path in finding.evidence:
            for node_id in path.node_ids:
                hits[node_id].add(finding.id)
            for node_id in path.node_ids[1:-1]:
                routes[node_id].add(tuple(path.node_ids))
    return {node_id: {"routes": len(routes[node_id]), "findings": len(ids)} for node_id, ids in hits.items()}


def _split_candidates(findings: list[Finding]) -> tuple[list[tuple[str, int]], dict[str, list[str]]]:
    """Agents that read and then act: one that takes a rule-2 hop in and sends a rule-3 hop out. An injection
    path is looked at on its own; the legs of a trifecta are looked at together, since they meet at the agent.
    Splitting such an agent puts its reading tools behind a quarantined reader."""
    count: Counter[str] = Counter()
    reads: dict[str, set[str]] = defaultdict(set)
    for finding in findings:
        groups = [[p] for p in finding.evidence] if finding.kind == "injection" else [finding.evidence]
        for group in groups:
            into: dict[str, set[str]] = defaultdict(set)      # agent -> tools whose output enters it
            acts: set[str] = set()
            for path in group:
                for i, rule in enumerate(path.rules):
                    if rule == 2:
                        into[path.node_ids[i + 1]].add(path.node_ids[i])
                    elif rule == 3:
                        acts.add(path.node_ids[i])
            for agent in sorted(set(into) & acts):
                count[agent] += 1
                reads[agent] |= into[agent]
    ranked = sorted(count.items(), key=lambda kv: (-kv[1], kv[0]))
    return ranked, {agent: sorted(reads[agent]) for agent, _ in ranked}


UNCUTTABLE = 1000       # the capacity projection.rebuild gives a hop no fix can cut (rules 4, 5 and 7)


async def mincut(client: GraphClient, graph_key: str) -> ChokepointReport:
    """The cheapest set of flow edges that separates every untrusted source from every high-impact resource.

    FalkorDB computes the max flow; by the max-flow min-cut theorem its value is the cost of that cut. The cut is
    then read off here: the edges that leave the part of the graph still reachable from the sources once every
    saturated edge is taken away. It is a guide, not a proof of the best plan: it knows nothing about workflows,
    one revoke removes two flow edges, and a plan pays a point for each extra fix. Trifectas are not a cut."""
    rows = await client.run("choke.maxflow", graph_key)
    if not rows:                                             # no untrusted source, or no high-impact resource
        return ChokepointReport(method="mincut", cut_cost=0)
    row = rows[0]
    flow = {(a, b, rule): f for a, b, rule, f in zip(row["from_ids"], row["to_ids"], row["rules"], row["flows"])}
    edges = await client.run("flow.edges", graph_key)

    # What the sources still reach in the residual graph: forward along spare capacity, backward along flow.
    # The walk is over the flow layer's own nodes (`from_key`, `to_key`), where the acting side of a tool is
    # a node apart from its reading side; the cut is then named by tool (`from_id`, `to_id`).
    residual: dict[str, list[str]] = defaultdict(list)
    for e in edges:
        f = flow.get((e["from_key"], e["to_key"], e["rule"]), 0.0)
        if (e["capacity"] or 0) - f > 1e-9:
            residual[e["from_key"]].append(e["to_key"])
        if f > 1e-9:
            residual[e["to_key"]].append(e["from_key"])
    reached = set(row["source_ids"])
    queue = list(reached)
    while queue:
        for nxt in residual[queue.pop()]:
            if nxt not in reached:
                reached.add(nxt)
                queue.append(nxt)

    cut: list[EdgeScore] = []
    for e in edges:
        if e["from_key"] in reached and e["to_key"] not in reached:
            behind = config_edge(e["rule"], e["from_id"], e["to_id"])
            if behind is None:                               # a hop no fix can cut: named, with nothing to offer
                rel = {4: "DELEGATES_TO", 5: "WRITES", 7: "FEEDS"}[e["rule"]]
                behind = EdgeRef(rel=rel, from_id=e["from_id"], to_id=e["to_id"], rule=e["rule"])
            cut.append(EdgeScore(edge=behind, score=float(e["capacity"] or 0), fixes=FIXES.get(e["rule"], [])))
    cut.sort(key=lambda s: (-s.score, s.edge.rel, s.edge.from_id, s.edge.to_id))
    return ChokepointReport(method="mincut", edges=cut, cut_cost=int(round(row["max_flow"])))


async def betweenness(client: GraphClient, graph_key: str) -> ChokepointReport:
    rows = await client.run("choke.betweenness", graph_key)
    return ChokepointReport(method="betweenness", nodes=[
        NodeScore(id=r["id"], name=r["name"], label=r["label"], score=float(r["score"])) for r in rows
    ])
