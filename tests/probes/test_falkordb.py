"""`make probe`: the FalkorDB behaviours this design leans on.

These were first checked by hand before the build, on FalkorDB 4.22.0 and
6.0.2. They live here so that changing the image cannot break one silently.
Probes talk to the database directly; product code never does.
"""

import asyncio

import pytest
import redis.exceptions as rex

from cistern.graph import keys
from cistern.graph.catalog import CATALOG

REBUILD = CATALOG["projection.rebuild"].cypher
REACH = CATALOG["reach.untrusted_to_high"].cypher
CHAIN = ("CREATE (s:DataSource {id:'src:far', trust:'untrusted'})"
         + "".join(f"-[:FLOWS_TO]->(:Agent {{id:'agent:c{i}'}})" for i in range(15))
         + "-[:FLOWS_TO]->(:Resource {id:'res:far', impact:'high', external:false})")


@pytest.fixture
def raw(client, sandbox):
    """The client library's own graph object for a throwaway key."""
    return client.graph(sandbox)


async def test_bfs_follows_edges_outward_only_and_leaves_out_the_start(raw):
    await raw.query("CREATE (a:N {id:'a'})-[:E]->(b:N {id:'b'})")
    forward = await raw.ro_query("MATCH (s:N {id:'a'}) CALL algo.bfs(s, 5, 'E') YIELD nodes RETURN [n IN nodes | n.id]")
    backward = await raw.ro_query("MATCH (s:N {id:'b'}) CALL algo.bfs(s, 5, 'E') YIELD nodes RETURN [n IN nodes | n.id]")
    assert forward.result_set == [[["b"]]]
    assert backward.result_set == []            # nothing reachable is no row at all, not an empty list


async def test_bfs_depth_must_be_the_node_count_not_a_guess(raw):
    await raw.query(CHAIN)
    found = await raw.ro_query(REACH, {"max_depth": 17})
    capped = await raw.ro_query(REACH, {"max_depth": 12})
    assert found.result_set == [["src:far", ["res:far"]]]
    assert capped.result_set == []              # a 16-hop path is invisible at depth 12


async def test_bfs_depth_zero_is_not_unlimited(raw):
    """The procedures reference says 0 means unlimited. On 4.22.0 and 6.0.2 it returns nothing.
    If this ever fails, the documentation has become true; the design does not depend on it either way."""
    await raw.query(CHAIN)
    zero = await raw.ro_query(REACH, {"max_depth": 0})
    assert zero.result_set == []


async def test_ro_query_runs_every_algorithm_the_design_uses(raw):
    await raw.query("CREATE (:N {id:'a'})")
    modes = await raw.ro_query("CALL dbms.procedures() YIELD name, mode RETURN name, mode")
    by_name = {name.lower(): mode for name, mode in modes.result_set}
    for procedure in ("algo.bfs", "algo.sppaths", "algo.wcc", "algo.betweenness", "algo.maxflow"):
        assert by_name.get(procedure) == "READ", procedure


async def test_rebuild_is_atomic_for_concurrent_readers(client, sandbox, raw):
    """While two writers rebuild in a loop, a reader must never see a partial projection."""
    await raw.query(
        "CREATE (d:DataSource {id:'s', trust:'untrusted'}), (r:Resource {id:'r', impact:'high', external:false}), "
        "(t1:Tool {id:'t1'}), (t2:Tool {id:'t2'}), (a:Agent {id:'a'}), (b:Agent {id:'b'}), "
        "(t1)-[:READS]->(d), (t2)-[:WRITES]->(r), (a)-[:CAN_CALL]->(t1), (b)-[:CAN_CALL]->(t2), (a)-[:DELEGATES_TO]->(b)")
    await raw.query(REBUILD)
    expected = (await raw.ro_query("MATCH ()-[f:FLOWS_TO]->() RETURN count(f)")).result_set[0][0]
    assert expected == 6
    stop = False

    async def writer():
        while not stop:
            await raw.query(REBUILD)

    writers = [asyncio.create_task(writer()) for _ in range(2)]
    seen = set()
    try:
        for _ in range(300):
            seen.add((await raw.ro_query("MATCH ()-[f:FLOWS_TO]->() RETURN count(f)")).result_set[0][0])
            seen.add(len((await raw.ro_query(REACH, {"max_depth": 10})).result_set))
    finally:
        stop = True
        await asyncio.gather(*writers)
    assert seen == {expected, 1}                # always all six edges, always the one finding


async def test_sppaths_returns_longer_routes_and_a_cap_keeps_the_shortest(raw):
    await raw.query(
        "CREATE (s:N {id:'s'}), (a:N {id:'a'}), (b:N {id:'b'}), (c:N {id:'c'}), (t:N {id:'t'}), "
        "(s)-[:FLOWS_TO {rule:1}]->(a), (a)-[:FLOWS_TO {rule:2}]->(t), (s)-[:FLOWS_TO {rule:1}]->(b), "
        "(b)-[:FLOWS_TO {rule:2}]->(c), (c)-[:FLOWS_TO {rule:3}]->(t), (a)-[:FLOWS_TO {rule:4}]->(b), (b)-[:FLOWS_TO {rule:6}]->(a)")
    evidence = CATALOG["evidence.pair_paths"].cypher
    every = await raw.ro_query(evidence, {"source_id": "s", "target_id": "t", "max_len": 12, "k": 5})
    assert [len(row[0]) - 1 for row in every.result_set] == [2, 3, 3, 4]       # all four routes, fewest hops first
    assert every.result_set[0] == [["s", "a", "t"], [1, 2]]
    two = await raw.ro_query(evidence, {"source_id": "s", "target_id": "t", "max_len": 12, "k": 2})
    assert [len(row[0]) - 1 for row in two.result_set] == [2, 3]
    short = await raw.ro_query(evidence, {"source_id": "s", "target_id": "t", "max_len": 2, "k": 5})
    assert [row[0] for row in short.result_set] == [["s", "a", "t"]]


async def test_copy_carries_indexes_and_constraints_and_refuses_an_existing_key(client, sandbox, raw):
    await raw.query("CREATE INDEX FOR (n:Agent) ON (n.id)")
    await raw.create_node_unique_constraint("Agent", "id")
    await raw.query("CREATE (:Agent {id:'a'})")
    for _ in range(100):
        if all(c["status"] == "OPERATIONAL" for c in await raw.list_constraints()):
            break
        await asyncio.sleep(0.05)
    copy_key = keys.sandbox_key()
    try:
        await client.copy(sandbox, copy_key)
        copied = client.graph(copy_key)
        assert [(c["type"], c["status"]) for c in await copied.list_constraints()] == [("UNIQUE", "OPERATIONAL")]
        with pytest.raises(rex.ResponseError, match="unique constraint"):
            await copied.query("CREATE (:Agent {id:'a'})")
        with pytest.raises(rex.ResponseError, match="already exists"):
            await client.copy(sandbox, copy_key)
    finally:
        await client.delete(copy_key)


async def test_copies_stay_consistent_while_the_source_is_being_written(client, sandbox, raw):
    await raw.query(
        "CREATE (d:DataSource {id:'s', trust:'untrusted'}), (r:Resource {id:'r', impact:'high', external:false}), "
        "(t1:Tool {id:'t1'}), (t2:Tool {id:'t2'}), (a:Agent {id:'a'}), "
        "(t1)-[:READS]->(d), (t2)-[:WRITES]->(r), (a)-[:CAN_CALL]->(t1), (a)-[:CAN_CALL]->(t2)")
    await raw.query(REBUILD)
    stop = False

    async def writer():
        while not stop:
            await raw.query(REBUILD)

    task = asyncio.create_task(writer())
    try:
        for _ in range(25):
            copy_key = keys.sandbox_key()
            await client.copy(sandbox, copy_key)
            try:
                rows = (await client.graph(copy_key).ro_query(REACH, {"max_depth": 10})).result_set
                assert rows == [["s", ["r"]]]
            finally:
                await client.delete(copy_key)
    finally:
        stop = True
        await task


async def test_a_read_past_its_timeout_is_cut_off(raw):
    """The image's own default would be 1 s for reads; docker-compose.yml sets explicit limits instead."""
    await raw.query("UNWIND range(1, 60) AS i CREATE (:N {i:i})")
    await raw.query("MATCH (a:N), (b:N) WHERE a.i <> b.i CREATE (a)-[:E]->(b)")
    with pytest.raises(rex.ResponseError, match="timed out"):
        await raw.ro_query("MATCH (a:N {i:1})-[:E*1..6]->(b:N) RETURN count(*)", timeout=300)
    with pytest.raises(rex.ResponseError, match="TIMEOUT_MAX"):
        await raw.ro_query("RETURN 1", timeout=60_000)
