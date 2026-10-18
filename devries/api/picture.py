"""What the overview and the posture pages are made of: the graph as the chart takes it, the one-sentence summary, the picture of a graph and the views of the cut and the servers."""

from typing import Any

from devries import views
from devries.analysis import chokepoints, scorecard, zones
from devries.analysis import findings as findings_mod
from devries.analysis.models import ChokepointReport, Finding
from devries.analysis.scorecard import AgentCard
from devries.graph.client import GraphClient

FLOW_LAYER = ["FLOWS_TO", "GATED_FLOW"]
CONFIG_LAYER = ["CAN_CALL", "DELEGATES_TO", "READS", "WRITES", "FEEDS"]


def config_sentence(rel: str, a: str, b: str, gate: str | None) -> str:
    base = {"CAN_CALL": f"{a} can call {b}", "DELEGATES_TO": f"{a} delegates to {b}",
            "READS": f"{a} reads {b}", "WRITES": f"{a} acts on {b}",
            "FEEDS": f"what is written to {a} is read back from {b}"}[rel]
    if gate == "human_approval":
        return base + ", and a person approves each call"
    if gate == "quarantine":
        return base + ", and only structured fields come back"
    return base


async def graph_view(client: GraphClient, key: str, layer: str) -> dict[str, Any]:
    """One layer of a graph as the chart takes it: nodes with their zone, links with a sentence each, workflows."""
    zone_of: dict[str, dict[str, Any]] = {}
    for zone in await zones.trust_zones(client, key):          # blast zones come first, and the first zone wins
        for member in zone.members:
            zone_of.setdefault(member, {"zone": zone.component_id, "blast": zone.is_blast_zone})
    for group in await zones.communities(client, key):         # finer than a zone: what hangs together, for colouring
        for member in group.members:
            zone_of.setdefault(member, {})["community"] = group.component_id
    reached: set[str] = set()
    rank_of: dict[str, dict[str, Any]] = {}
    if layer == "flow":                                        # what untrusted text reaches: FalkorDB's answer, not the page's
        depth = max(1, (await client.run("graph.node_count", key))[0]["nodes"])
        rows = await client.run("reach.untrusted_nodes", key, max_depth=depth)
        reached = set(rows[0]["reached"]) if rows else set()
        for i, row in enumerate(await client.run("choke.pagerank", key), 1):
            rank_of[row["id"]] = {"pagerank": round(row["score"], 3), "pagerank_rank": i}
    nodes = []
    for row in await client.run("ui.nodes", key):
        data = {k: v for k, v in row.items() if k not in ("nid", "label") and v is not None}
        if layer == "flow":
            data["tainted"] = row["id"] in reached or (row["label"] == "DataSource" and row["trust"] == "untrusted")
            data |= rank_of.get(row["id"], {})
        nodes.append({"id": row["nid"], "label": row["label"], "data": data | zone_of.get(row["id"], {})})
    links = []
    for row in await client.run("ui.links", key, types=FLOW_LAYER if layer == "flow" else CONFIG_LAYER):
        if layer == "flow":
            sentence = views.hop_sentence(row["rule"], row["from_id"], row["to_id"])
            if row["rel"] == "GATED_FLOW":
                sentence = f"blocked by {row['gate']}: {sentence}"
        else:
            sentence = config_sentence(row["rel"], row["from_id"], row["to_id"], row["gate"])
        data = {"from_id": row["from_id"], "to_id": row["to_id"], "rule": row["rule"],
                "gate": row["gate"], "sentence": sentence}
        if layer == "flow":                               # what a person could change to cut this hop
            data |= views.behind_hop(row["rule"], row["from_id"], row["to_id"])
        links.append({"id": row["lid"], "rel": row["rel"], "data": data})
    return {"layer": layer, "nodes": nodes, "links": links, "workflows": await client.run("ui.workflows", key)}


def _sentence(open_findings: list, agents: list, counts: dict, cards: dict | None = None) -> tuple[str, str | None]:
    """The overview's title and its second line: one short sentence a stranger can read, made from the counts, and the
    trifecta count as a sentence of its own when both kinds are open. The figure beside it counts the Rule of Two
    cards that hold all three properties, so when that differs from the agents with a way out, the sentence says both."""
    injections = [f for f in open_findings if f.kind == "injection"]
    trifectas = [f for f in open_findings if f.kind == "trifecta"]
    if not injections and not trifectas:
        if counts["untrusted_sources"] == 0:
            return "No source here is written by outsiders, so nothing untrusted can flow at all.", None
        return "Nothing untrusted reaches a high-impact resource.", "No agent holds untrusted input, private data and a way out."

    def n(count: int, one: str, many: str) -> str:
        words = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"]
        return f"{words[count] if count < len(words) else count} {one if count == 1 else many}"

    parts = []
    if injections:
        hops = [len(f.evidence[0].rules) for f in injections if f.evidence]
        span = f"in {min(hops)} hops" if hops and min(hops) == max(hops) else f"in {min(hops)} to {max(hops)} hops" if hops else ""
        parts.append(f"{n(len({f.source_id for f in injections}), 'untrusted source reaches', 'untrusted sources reach')} "
                     f"{n(len({f.target_id for f in injections}), 'high-impact resource', 'high-impact resources')} through "
                     f"{n(len(agents), 'agent', 'agents')}{', ' + span if span else ''}")
    if trifectas:
        with_exit = len({getattr(f, "agent_id", None) or f.id for f in trifectas})
        all_three = sum(1 for c in (cards or {}).values() if len(c.properties) == 3)
        if cards and all_three != with_exit:
            parts.append(f"{n(all_three, 'agent holds', 'agents hold')} all three of Meta's properties, "
                         f"{n(with_exit, 'of them', 'of them')} with a way out of the organisation")
        else:
            parts.append(f"{n(with_exit, 'agent holds', 'agents hold')} untrusted input, private data and a way out")
    first, *rest = [p[0].upper() + p[1:] + "." for p in parts]
    return first, (rest[0] if rest else None)


class Picture:
    """What the overview and the posture page both start from: the counts, the findings that hold, the Rule of Two
    cards, the chart's nodes and the cheapest cut, with the open injection and trifecta findings picked out."""

    def __init__(self, counts: dict[str, Any], current: list[Finding], partial: bool, cards: dict[str, AgentCard],
                 rows: list[dict[str, Any]], cut: ChokepointReport):
        self.counts, self.current, self.partial, self.cards, self.rows, self.cut = counts, current, partial, cards, rows, cut
        self.node = {r["id"]: r for r in rows}
        self.open = [f for f in current if f.status == "open" and f.kind in ("injection", "trifecta")]
        on_path = {i for f in self.open for p in f.evidence for i in p.node_ids}
        self.agents_on = sorted(i for i in on_path if self.label(i) == "Agent")
        self.sources_on = sorted({f.source_id for f in self.open if f.source_id} | {i for f in self.open for i in f.untrusted_ids})
        self.actions_on = sorted({f.target_id for f in self.open if f.target_id} | {i for f in self.open for i in f.exit_ids})

    def label(self, node_id: str) -> str | None:
        return self.node.get(node_id, {}).get("label")

    def name(self, node_id: str) -> str:
        return self.node.get(node_id, {}).get("name") or node_id

    @property
    def sentence(self) -> str:
        return _sentence(self.open, self.agents_on, self.counts, self.cards)[0]

    @property
    def sentence_more(self) -> str | None:
        return _sentence(self.open, self.agents_on, self.counts, self.cards)[1]

    @property
    def summary_counts(self) -> dict[str, Any]:
        return self.counts | {"open_findings": len(self.open), "cut_cost": self.cut.cut_cost}


async def picture(client: GraphClient, key: str) -> Picture:
    """Read the picture of one graph: five calls, every one a catalog query or built on them."""
    return Picture((await client.run("overview.counts", key))[0], *await findings_mod.current(client, key),
                   {c.agent_id: c for c in await scorecard.rule_of_two(client, key)},
                   await client.run("ui.nodes", key), await chokepoints.mincut(client, key))


def cut_view(report: ChokepointReport) -> dict[str, Any]:
    """The cheapest cut as the page takes it: its cost, whether every hop can be cut, and the hops."""
    return {"cost": report.cut_cost, "cuttable": all(e.score < chokepoints.UNCUTTABLE for e in report.edges),
            "hops": [views.cut_hop(e) for e in report.edges]}


def servers_view(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Each server's row with its lists sorted and the empty entries an OPTIONAL MATCH leaves dropped."""
    return [{**row, "tools": sorted(t for t in row["tools"] if t), "agents": sorted(a for a in row["agents"] if a),
             "findings": sorted(f for f in row["findings"] if f)} for row in rows]

