"""Indexes and constraints for a working graph.

A unique constraint needs its exact-match index first, and constraint creation
is asynchronous: the command answers PENDING and the status moves to
OPERATIONAL or FAILED later. The bootstrap waits for the answer.
"""

import asyncio
import time

import redis.exceptions as rex

from devries.errors import DeVriesError
from devries.graph.catalog import CONSTRAINED_LABELS, INDEXES
from devries.graph.client import GraphClient


class SchemaError(DeVriesError):
    code = "schema_error"


async def bootstrap(client: GraphClient, graph_key: str, wait_s: float = 10.0) -> None:
    for label, prop in INDEXES:
        try:
            await client.run(f"schema.index.{label.lower()}_{prop}", graph_key)
        except rex.ResponseError as e:
            if "already indexed" not in str(e).lower():
                raise

    graph = client.graph(graph_key)
    existing = {(c["type"], c["label"]) for c in await graph.list_constraints()}
    for label in CONSTRAINED_LABELS:
        if ("UNIQUE", label) not in existing:
            await graph.create_node_unique_constraint(label, "id")
        if ("MANDATORY", label) not in existing:
            await graph.create_node_mandatory_constraint(label, "id")

    deadline = time.monotonic() + wait_s
    while True:
        constraints = await graph.list_constraints()
        failed = [c for c in constraints if c.get("status") == "FAILED"]
        if failed:
            raise SchemaError(f"constraint failed on {failed[0]['label']}: existing data conflicts with it")
        if len(constraints) >= 2 * len(CONSTRAINED_LABELS) and all(c.get("status") == "OPERATIONAL" for c in constraints):
            return
        if time.monotonic() > deadline:
            pending = sorted({c["label"] for c in constraints if c.get("status") != "OPERATIONAL"})
            raise SchemaError(f"constraints not operational after {wait_s:g} s: {pending}")
        await asyncio.sleep(0.05)
