"""Indexes and constraints: created once, safe to ask for again, and actually enforced."""

import pytest
import redis.exceptions as rex
from helpers import agent

from devries.graph import schema
from devries.graph.catalog import CONSTRAINED_LABELS, INDEXES


async def test_bootstrap_creates_everything_and_can_run_twice(client, graph):
    await schema.bootstrap(client, graph)
    await schema.bootstrap(client, graph)                      # a second run changes nothing and raises nothing
    constraints = await client.graph(graph).list_constraints()
    assert {(c["type"], c["label"]) for c in constraints} == \
        {(kind, label) for label in CONSTRAINED_LABELS for kind in ("UNIQUE", "MANDATORY")}
    assert all(c["status"] == "OPERATIONAL" for c in constraints)
    indexed = await client.graph(graph).ro_query("CALL db.indexes() YIELD label, properties RETURN label, properties")
    assert {(label, prop) for label, props in indexed.result_set for prop in props} >= set(INDEXES)


async def test_a_duplicate_or_missing_id_is_refused(client, graph):
    await schema.bootstrap(client, graph)
    await client.run("ingest.agents", graph, rows=[agent("a")])
    await client.run("ingest.agents", graph, rows=[agent("a")])   # MERGE on the id: still one node
    assert (await client.run("graph.node_count", graph))[0]["nodes"] == 1
    raw = client.graph(graph)
    with pytest.raises(rex.ResponseError, match="unique constraint"):
        await raw.query("CREATE (:Agent {id:'agent:a'})")
    with pytest.raises(rex.ResponseError, match="mandatory constraint"):
        await raw.query("CREATE (:Agent {name:'no id'})")
