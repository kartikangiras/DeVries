"""The derived flow layer. FLOWS_TO is a pure function of the config edges and
is only ever rebuilt whole, in one atomic query, so a reader never sees half of it."""

from cistern.graph.client import GraphClient

RULES = {
    1: "data enters a tool that reads it",
    2: "a reading tool's output enters the agent that calls it",
    3: "a tainted agent drives the tools it can call that act on something",
    4: "a delegator's context passes to its delegate",
    5: "a tool acts on a resource",
    6: "a delegate's results return to its delegator",
    7: "what is written to a resource is read back from the data source it feeds",
}

# (from label, to label) each rule may connect
SIGNATURES = {
    1: ("DataSource", "Tool"),
    2: ("Tool", "Agent"),
    3: ("Agent", "Tool"),
    4: ("Agent", "Agent"),
    5: ("Tool", "Resource"),
    6: ("Agent", "Agent"),
    7: ("Resource", "DataSource"),
}


async def rebuild(client: GraphClient, graph_key: str) -> None:
    await client.run("projection.rebuild", graph_key)
