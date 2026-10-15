"""Trust zones: weakly connected components of the flow layer.

WCC ignores direction, so a zone can only prove that a source cannot reach a
resource, never that it can. Zones are for people and for the agent's triage;
no verdict depends on them.
"""

from cistern.analysis.models import Zone
from cistern.graph.client import GraphClient


async def communities(client: GraphClient, graph_key: str) -> list[Zone]:
    """Communities of the config graph by label propagation (`zones.communities`). Finer than a zone: a zone
    says what is connected at all, a community says what hangs together. The charts colour these."""
    return _zones(await client.run("zones.communities", graph_key))


async def trust_zones(client: GraphClient, graph_key: str) -> list[Zone]:
    return _zones(await client.run("zones.wcc", graph_key))


def _zones(rows) -> list[Zone]:
    zones = [
        Zone(
            component_id=row["component_id"],
            members=sorted(row["members"]),
            has_untrusted=bool(row["has_untrusted"]),
            has_high_impact=bool(row["has_high_impact"]),
            is_blast_zone=bool(row["has_untrusted"]) and bool(row["has_high_impact"]),
        )
        for row in rows
    ]
    # blast zones first, then larger zones first, stable by first member
    zones.sort(key=lambda z: (not z.is_blast_zone, -len(z.members), z.members[:1]))
    # In the flow layer a tool that acts has two nodes, its reading side and its acting side, and both answer
    # to the tool's id. A tool that only acts leaves its reading side alone in a component of its own: that
    # is not a zone. A tool whose two sides really sit in different zones stays listed in both.
    seen: set[str] = set()
    kept = []
    for zone in zones:
        if set(zone.members) <= seen:
            continue
        seen |= set(zone.members)
        kept.append(zone)
    return kept
