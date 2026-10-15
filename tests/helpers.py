"""Small builders for config graphs in tests. They go through the same ingest queries the loader uses."""

from cistern.graph.client import GraphClient


def src(name: str, trust: str = "untrusted") -> dict:
    return {"id": f"src:{name}", "name": name, "trust": trust}


def res(name: str, impact: str = "high", external: bool = False) -> dict:
    return {"id": f"res:{name}", "name": name, "impact": impact, "external": external}


def agent(name: str) -> dict:
    return {"id": f"agent:{name}", "name": name, "owner": None}


def tool(name: str, description: str = "") -> dict:
    return {"id": f"tool:t.{name}", "name": name, "server_id": "srv:t", "description": description,
            "capability": "unknown", "capability_source": "none"}


def workflow(name: str, mode: str = "supervised") -> dict:
    return {"id": f"wf:{name}", "name": name, "description": None, "mode": mode}


async def build(client: GraphClient, key: str, *, sources=(), resources=(), agents=(), tools=(), workflows=(),
                reads=(), writes=(), calls=(), delegations=(), run_by=(), needs=(), needs_data=(), feeds=()) -> None:
    """Edges are tuples of short names: reads=[("get", "tickets")] means tool:t.get reads src:tickets.
    calls and delegations take an optional third element, the gate. feeds=[("notes", "wiki")] means
    what is written to res:notes is read back from src:wiki."""
    await client.run("ingest.servers", key, rows=[{"id": "srv:t", "name": "t", "source_url": None, "synthetic": True}])
    nodes = {
        "ingest.tools": [tool(t) if isinstance(t, str) else t for t in tools],
        "ingest.data_sources": [src(s) if isinstance(s, str) else s for s in sources],
        "ingest.resources": [res(r) if isinstance(r, str) else r for r in resources],
        "ingest.agents": [agent(a) if isinstance(a, str) else a for a in agents],
        "ingest.workflows": [workflow(w) if isinstance(w, str) else w for w in workflows],
    }
    for name, rows in nodes.items():
        if rows:
            await client.run(name, key, rows=rows)

    def gate(edge):
        return edge[2] if len(edge) > 2 else None

    edges = {
        "ingest.reads": [{"from_id": f"tool:t.{t}", "to_id": f"src:{s}"} for t, s in reads],
        "ingest.writes": [{"from_id": f"tool:t.{t}", "to_id": f"res:{r}"} for t, r in writes],
        "ingest.feeds": [{"from_id": f"res:{r}", "to_id": f"src:{s}"} for r, s in feeds],
        "ingest.can_call": [{"from_id": f"agent:{e[0]}", "to_id": f"tool:t.{e[1]}", "gate": gate(e), "origin": "test"} for e in calls],
        "ingest.delegates_to": [{"from_id": f"agent:{e[0]}", "to_id": f"agent:{e[1]}", "gate": gate(e), "origin": "test"} for e in delegations],
        "ingest.run_by": [{"from_id": f"wf:{w}", "to_id": f"agent:{a}"} for w, a in run_by],
        "ingest.needs": [{"from_id": f"wf:{w}", "to_id": f"tool:t.{t}"} for w, t in needs],
        "ingest.needs_data": [{"from_id": f"wf:{w}", "to_id": f"src:{s}"} for w, s in needs_data],
    }
    for name, rows in edges.items():
        if rows:
            written = (await client.run(name, key, rows=rows))[0]["written"]
            assert written == len(rows), f"{name}: wrote {written} of {len(rows)}; an endpoint is missing"


async def set_call_gate(client: GraphClient, key: str, agent_name: str, tool_name: str, gate: str | None) -> None:
    await client.run("ingest.can_call", key, rows=[{"from_id": f"agent:{agent_name}", "to_id": f"tool:t.{tool_name}", "gate": gate, "origin": "test"}])


async def set_delegation_gate(client: GraphClient, key: str, a: str, b: str, gate: str | None) -> None:
    await client.run("ingest.delegates_to", key, rows=[{"from_id": f"agent:{a}", "to_id": f"agent:{b}", "gate": gate, "origin": "test"}])


async def rebuild(client: GraphClient, key: str) -> None:
    await client.run("projection.rebuild", key)


async def flows(client: GraphClient, key: str) -> set[tuple[str, int, str]]:
    return {(r["from_id"], r["rule"], r["to_id"]) for r in await client.run("flow.edges", key)}


async def gated(client: GraphClient, key: str) -> set[tuple[str, int, str, str]]:
    return {(r["from_id"], r["rule"], r["to_id"], r["gate"]) for r in await client.run("flow.gated_edges", key)}


async def broken(client: GraphClient, key: str) -> set[tuple[str, str, str]]:
    return {(r["workflow"], r["kind"], r["missing"]) for r in await client.run("wf.broken", key)}
