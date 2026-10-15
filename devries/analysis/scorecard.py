"""Meta's Agents Rule of Two, read off the graph.

An agent has three properties: A, it processes untrustworthy input; B, it has access to sensitive
systems or private data; C, it can change state or communicate externally. The rule: until prompt
injection can be reliably refused, an agent holds at most two of the three in a session, and one
that needs all three "should not be permitted to operate autonomously". Here A is "an untrusted
source reaches it", B is "a private source reaches it", C is "it reaches a resource", each by BFS
over the flow layer. Willison's caveat is kept too: A with C and no B is still an injection path,
and DeVries's injection finding is exactly that.
"""

from pydantic import BaseModel, Field

from devries.graph.client import GraphClient


class AgentCard(BaseModel):
    agent_id: str
    name: str | None = None
    untrusted_in: list[str] = Field(default_factory=list)     # A: the untrusted sources that reach it
    private_in: list[str] = Field(default_factory=list)       # B: the private sources that reach it
    acts_on: list[str] = Field(default_factory=list)          # C: the resources it reaches
    external: bool = False                                    # C, the "communicate externally" half
    high_impact: bool = False
    workflows: list[dict] = Field(default_factory=list)       # {id, mode}
    autonomous: bool = False                                  # it runs at least one autonomous workflow

    @property
    def properties(self) -> list[str]:
        return [p for p, held in (("A", bool(self.untrusted_in)), ("B", bool(self.private_in)), ("C", bool(self.acts_on))) if held]

    @property
    def count(self) -> int:
        return len(self.properties)

    @property
    def verdict(self) -> str:
        if self.count == 3:
            return "all three, and it runs unattended" if self.autonomous else "all three, supervised"
        if self.count == 2 and "A" in self.properties and "C" in self.properties:
            return "two: untrusted input and action, which the rule calls safe and Willison does not"
        return {2: "two", 1: "one", 0: "none"}[self.count]


async def rule_of_two(client: GraphClient, graph_key: str) -> list[AgentCard]:
    """One card per agent, worst first: most properties, then unattended, then by id."""
    depth = max(1, (await client.run("graph.node_count", graph_key))[0]["nodes"])
    cards = {row["id"]: AgentCard(agent_id=row["id"], name=row["name"])
             for row in await client.run("node.names", graph_key) if row["label"] == "Agent"}
    for row in await client.run("reach.agents_from_sources", graph_key, trust="untrusted", max_depth=depth):
        if row["agent"] in cards:
            cards[row["agent"]].untrusted_in = sorted(row["sources"])
    for row in await client.run("reach.agents_from_sources", graph_key, trust="private", max_depth=depth):
        if row["agent"] in cards:
            cards[row["agent"]].private_in = sorted(row["sources"])
    for row in await client.run("agent.acts_on", graph_key, max_depth=depth):
        if row["agent"] in cards:
            card = cards[row["agent"]]
            card.acts_on, card.external, card.high_impact = sorted(row["resources"]), bool(row["external"]), bool(row["high_impact"])
    for wf in await client.run("ui.workflows", graph_key):
        if wf["run_by"] in cards:
            card = cards[wf["run_by"]]
            card.workflows.append({"id": wf["id"], "mode": wf["mode"]})
            card.autonomous = card.autonomous or wf["mode"] == "autonomous"
    return sorted(cards.values(), key=lambda c: (-c.count, not c.autonomous, c.agent_id))


def card_view(card: AgentCard) -> dict:
    return {
        "agent_id": card.agent_id, "name": card.name, "properties": card.properties, "count": card.count,
        "untrusted_in": card.untrusted_in, "private_in": card.private_in, "acts_on": card.acts_on,
        "external": card.external, "high_impact": card.high_impact,
        "workflows": card.workflows, "autonomous": card.autonomous, "verdict": card.verdict,
    }
