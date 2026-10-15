"""Every Cypher statement DeVries runs, as a named, parameterized query.

Nothing else in the codebase builds Cypher. `python -m devries.graph.catalog`
prints this catalog as Markdown for the README.
"""

from dataclasses import dataclass
from typing import Literal

WORKING = frozenset({"working"})
SANDBOX = frozenset({"sandbox"})
BOTH = frozenset({"working", "sandbox"})


@dataclass(frozen=True)
class NamedQuery:
    name: str
    cypher: str                  # parameters only, never string interpolation
    mode: Literal["ro", "rw"]    # ro -> GRAPH.RO_QUERY, rw -> GRAPH.QUERY
    targets: frozenset[str]      # which kinds of graph a rw query may touch
    timeout_ms: int              # must not exceed the server's TIMEOUT_MAX (10 s)
    idempotent: bool = False     # rw queries built only from MERGE / SET can be retried
    doc: str = ""
    guarded: bool = False        # may touch a working graph only through apply_fix (GraphClient checks a token)


def _index(label: str, prop: str) -> NamedQuery:
    # Label and property come from the fixed list below, never from input.
    return NamedQuery(
        name=f"schema.index.{label.lower()}_{prop}",
        cypher=f"CREATE INDEX FOR (n:{label}) ON (n.{prop})",
        mode="rw", targets=BOTH, timeout_ms=10_000,
        doc=f"Exact-match index on {label}.{prop}.",
    )


INDEXES: list[tuple[str, str]] = [
    ("Agent", "id"), ("Tool", "id"), ("MCPServer", "id"), ("DataSource", "id"),
    ("Resource", "id"), ("Workflow", "id"), ("Finding", "fingerprint"),
    ("DataSource", "trust"), ("Resource", "impact"), ("Mitigation", "id"), ("Draft", "id"),
]

# Labels that get a UNIQUE and a MANDATORY constraint on `id` (created through
# GRAPH.CONSTRAINT by the client, which is not Cypher).
CONSTRAINED_LABELS = ["Agent", "Tool", "MCPServer", "DataSource", "Resource", "Workflow"]


_QUERIES: list[NamedQuery] = [
    *[_index(label, prop) for label, prop in INDEXES],

    # ------------------------------------------------------------------ projection
    NamedQuery(
        name="projection.rebuild",
        doc="Rebuild the derived FLOWS_TO / GATED_FLOW layer from the config edges, atomically. Each flow edge "
            "carries the cost of the cheapest fix that can cut it as its capacity (1000 where no fix can), for the min cut. "
            "A tool that acts has two sides in this layer: what it reads leaves the Tool node toward its callers (rules 1, 2), "
            "and a call enters a ToolAct node and leaves only toward the resource (rules 3, 5). With one node for both, "
            "one agent's context would flow into every other caller of a tool that reads and acts. The acting side is "
            "matched by an id computed in a WITH one clause earlier: on 6.0.2 an inline {id: t.id + '#act'} in the "
            "same clause matched nothing.",
        mode="rw", targets=BOTH, timeout_ms=5_000, idempotent=True,
        cypher="""
MATCH ()-[f:FLOWS_TO]->() DELETE f
WITH count(*) AS c0
MATCH ()-[g:GATED_FLOW]->() DELETE g
WITH count(*) AS c1
MATCH (t:Tool)-[:WRITES]->(:Resource)
WITH DISTINCT t
MERGE (x:ToolAct {id: t.id + '#act'}) SET x.of = t.id, x.name = t.name
WITH count(*) AS c2
MATCH (t:Tool)-[:READS]->(d:DataSource) MERGE (d)-[:FLOWS_TO {rule:1, capacity:3}]->(t)
WITH count(*) AS c3
MATCH (a:Agent)-[:CAN_CALL]->(t:Tool)-[:READS]->(:DataSource) MERGE (t)-[:FLOWS_TO {rule:2, capacity:1}]->(a)
WITH count(*) AS c4
MATCH (a:Agent)-[c:CAN_CALL]->(t:Tool)-[:WRITES]->(:Resource) WHERE c.gate IS NULL WITH DISTINCT a, t.id + '#act' AS xid
MATCH (x:ToolAct {id: xid})
MERGE (a)-[:FLOWS_TO {rule:3, capacity:1}]->(x)
WITH count(*) AS c5
MATCH (a:Agent)-[c:CAN_CALL]->(t:Tool)-[:WRITES]->(:Resource) WHERE c.gate IS NOT NULL WITH DISTINCT a, t.id + '#act' AS xid, c.gate AS gate
MATCH (x:ToolAct {id: xid})
MERGE (a)-[:GATED_FLOW {rule:3, gate:gate}]->(x)
WITH count(*) AS c6
MATCH (a:Agent)-[:DELEGATES_TO]->(b:Agent) MERGE (a)-[:FLOWS_TO {rule:4, capacity:1000}]->(b)
WITH count(*) AS c7
MATCH (a:Agent)-[d:DELEGATES_TO]->(b:Agent) WHERE d.gate IS NULL MERGE (b)-[:FLOWS_TO {rule:6, capacity:2}]->(a)
WITH count(*) AS c8
MATCH (a:Agent)-[d:DELEGATES_TO]->(b:Agent) WHERE d.gate IS NOT NULL MERGE (b)-[:GATED_FLOW {rule:6, gate:d.gate}]->(a)
WITH count(*) AS c9
MATCH (r:Resource)-[:FEEDS]->(d:DataSource) MERGE (r)-[:FLOWS_TO {rule:7, capacity:1000}]->(d)
WITH count(*) AS c10
MATCH (t:Tool)-[:WRITES]->(r:Resource) WITH DISTINCT t.id + '#act' AS xid, r
MATCH (x:ToolAct {id: xid})
MERGE (x)-[:FLOWS_TO {rule:5, capacity:1000}]->(r)
RETURN count(*) AS rule5_edges
""",
    ),
    NamedQuery(
        name="flow.edges",
        doc="Every derived FLOWS_TO edge with its rule. An acting side is named by its tool (from_id, to_id); "
            "from_key and to_key are the nodes themselves, for the walk that reads a cut off a max flow.",
        mode="ro", targets=BOTH, timeout_ms=2_000,
        cypher="""
MATCH (x)-[f:FLOWS_TO]->(y)
RETURN coalesce(x.of, x.id) AS from_id, CASE WHEN labels(x)[0] = 'ToolAct' THEN 'Tool' ELSE labels(x)[0] END AS from_label,
       f.rule AS rule,
       coalesce(y.of, y.id) AS to_id, CASE WHEN labels(y)[0] = 'ToolAct' THEN 'Tool' ELSE labels(y)[0] END AS to_label,
       f.capacity AS capacity, x.id AS from_key, y.id AS to_key
ORDER BY from_id, rule, to_id
""",
    ),
    NamedQuery(
        name="flow.gated_edges",
        doc="Every GATED_FLOW edge: a hop that a gate currently blocks.",
        mode="ro", targets=BOTH, timeout_ms=2_000,
        cypher="""
MATCH (x)-[g:GATED_FLOW]->(y)
RETURN coalesce(x.of, x.id) AS from_id, CASE WHEN labels(x)[0] = 'ToolAct' THEN 'Tool' ELSE labels(x)[0] END AS from_label,
       g.rule AS rule, g.gate AS gate,
       coalesce(y.of, y.id) AS to_id, CASE WHEN labels(y)[0] = 'ToolAct' THEN 'Tool' ELSE labels(y)[0] END AS to_label
ORDER BY from_id, rule, to_id
""",
    ),

    # ------------------------------------------------------------------ verdicts
    NamedQuery(
        name="graph.node_count",
        doc="Node count: the BFS depth for every verdict, and the hop limit for the evidence retry.",
        mode="ro", targets=BOTH, timeout_ms=1_000,
        cypher="MATCH (n) RETURN count(n) AS nodes",
    ),
    NamedQuery(
        name="reach.untrusted_to_high",
        doc="Verdict: which high-impact resources each untrusted source reaches. "
            "$max_depth must be positive: 0 returns nothing on FalkorDB 4.22 and 6.0.",
        mode="ro", targets=BOTH, timeout_ms=2_000,
        cypher="""
MATCH (s:DataSource {trust:'untrusted'})
CALL algo.bfs(s, $max_depth, 'FLOWS_TO') YIELD nodes
UNWIND nodes AS n
WITH s, n WHERE 'Resource' IN labels(n) AND n.impact = 'high'
RETURN s.id AS source, collect(DISTINCT n.id) AS targets
""",
    ),
    NamedQuery(
        name="reach.untrusted_nodes",
        doc="Everything an untrusted source reaches over the flow layer: what a chart fills in. The sources themselves "
            "are not in the answer; BFS leaves its start out.",
        mode="ro", targets=BOTH, timeout_ms=2_000,
        cypher="""
MATCH (s:DataSource {trust:'untrusted'})
CALL algo.bfs(s, $max_depth, 'FLOWS_TO') YIELD nodes
UNWIND nodes AS n
RETURN collect(DISTINCT coalesce(n.of, n.id)) AS reached
""",
    ),
    NamedQuery(
        name="find.trifecta",
        doc="Verdict: agents reached by untrusted and by private data that can reach an external resource.",
        mode="ro", targets=BOTH, timeout_ms=2_000,
        cypher="""
MATCH (d:DataSource) WHERE d.trust IN ['untrusted', 'private']
CALL algo.bfs(d, $max_depth, 'FLOWS_TO') YIELD nodes
UNWIND nodes AS a
WITH d, a WHERE 'Agent' IN labels(a)
WITH a,
     collect(DISTINCT CASE WHEN d.trust = 'untrusted' THEN d.id END) AS untrusted,
     collect(DISTINCT CASE WHEN d.trust = 'private' THEN d.id END) AS private_data
WHERE size(untrusted) > 0 AND size(private_data) > 0
CALL algo.bfs(a, $max_depth, 'FLOWS_TO') YIELD nodes
UNWIND nodes AS x
WITH a, untrusted, private_data, x WHERE 'Resource' IN labels(x) AND x.external = true
RETURN a.id AS agent, untrusted, private_data, collect(DISTINCT x.id) AS exits
""",
    ),
    NamedQuery(
        name="wf.broken",
        doc="Verdict: any row is something a workflow needs that the config no longer gives it. A supervised "
            "workflow can use a gated grant; an autonomous one cannot. `gated` says a grant exists but every one is gated.",
        mode="ro", targets=BOTH, timeout_ms=2_000,
        cypher="""
MATCH (w:Workflow)-[:RUN_BY]->(a:Agent), (w)-[:NEEDS]->(t:Tool)
OPTIONAL MATCH (a)-[:DELEGATES_TO*0..3]->(:Agent)-[c:CAN_CALL]->(t)
WITH w, t, count(c) AS grants, sum(CASE WHEN c IS NOT NULL AND c.gate IS NULL THEN 1 ELSE 0 END) AS ungated
WHERE grants = 0 OR (w.mode = 'autonomous' AND ungated = 0)
RETURN w.id AS workflow, 'tool' AS kind, t.id AS missing, w.mode AS mode, grants > 0 AS gated
UNION
MATCH (w:Workflow)-[:RUN_BY]->(a:Agent), (w)-[:NEEDS_DATA]->(d:DataSource)
OPTIONAL MATCH p = (a)-[:DELEGATES_TO*0..3]->(:Agent)-[:CAN_CALL]->(:Tool)-[:READS]->(d)
WITH w, d, count(p) AS ways
WHERE ways = 0
RETURN w.id AS workflow, 'data' AS kind, d.id AS missing, w.mode AS mode, false AS gated
""",
    ),

    # ------------------------------------------------------------------ explanations
    NamedQuery(
        name="evidence.pair_paths",
        doc="Up to $k paths between one source and one sink, fewest hops first. Never decides a verdict.",
        mode="ro", targets=BOTH, timeout_ms=2_000,
        cypher="""
MATCH (s {id:$source_id}), (t {id:$target_id})
CALL algo.SPpaths({sourceNode: s, targetNode: t, relTypes: ['FLOWS_TO'],
                   relDirection: 'outgoing', maxLen: $max_len, pathCount: $k})
YIELD path
WITH path ORDER BY length(path)
RETURN [n IN nodes(path) | coalesce(n.of, n.id)] AS node_ids,
       [r IN relationships(path) | r.rule] AS rules
""",
    ),
    NamedQuery(
        name="evidence.pair_count",
        doc="How many routes there are between one source and one sink, counted up to $k. Shown beside the routes kept.",
        mode="ro", targets=BOTH, timeout_ms=2_000,
        cypher="""
MATCH (s {id:$source_id}), (t {id:$target_id})
CALL algo.SPpaths({sourceNode: s, targetNode: t, relTypes: ['FLOWS_TO'],
                   relDirection: 'outgoing', maxLen: $max_len, pathCount: $k})
YIELD path
RETURN count(path) AS routes
""",
    ),
    NamedQuery(
        name="reach.into",
        doc="Everything from which $id can be reached over the flow layer: one BFS from each node, kept where the "
            "node reaches the target. Answers 'what can reach X?' without a model.",
        mode="ro", targets=BOTH, timeout_ms=5_000,
        cypher="""
MATCH (n) WHERE (n:Agent OR n:Tool OR n:ToolAct OR n:DataSource OR n:Resource) AND n.id <> $id AND (n.of IS NULL OR n.of <> $id)
CALL algo.bfs(n, $max_depth, 'FLOWS_TO') YIELD nodes
WITH n, nodes WHERE any(x IN nodes WHERE x.id = $id OR x.of = $id)
RETURN collect(DISTINCT coalesce(n.of, n.id)) AS reaching
""",
    ),
    NamedQuery(
        name="reach.from",
        doc="Everything $id reaches over the flow layer, both sides of a tool together. Answers 'what does X reach?' "
            "without a model.",
        mode="ro", targets=BOTH, timeout_ms=2_000,
        cypher="""
MATCH (n) WHERE n.id = $id OR n.of = $id
CALL algo.bfs(n, $max_depth, 'FLOWS_TO') YIELD nodes
UNWIND nodes AS x
RETURN collect(DISTINCT coalesce(x.of, x.id)) AS reached
""",
    ),
    NamedQuery(
        name="wf.needing",
        doc="The workflows that need a tool or a data source, with who runs them. Answers 'which workflows need X?'.",
        mode="ro", targets=BOTH, timeout_ms=2_000,
        cypher="""
MATCH (w:Workflow)-[r]->(x {id:$id}) WHERE type(r) IN ['NEEDS', 'NEEDS_DATA']
OPTIONAL MATCH (w)-[:RUN_BY]->(a:Agent)
RETURN w.id AS workflow, w.name AS name, w.mode AS mode, a.id AS run_by, type(r) AS how
ORDER BY w.id
""",
    ),
    NamedQuery(
        name="node.names",
        doc="Display names for the nodes that can appear on a path, and for the servers a drift finding names.",
        mode="ro", targets=BOTH, timeout_ms=2_000,
        cypher="""
MATCH (n) WHERE n:Agent OR n:Tool OR n:DataSource OR n:Resource OR n:MCPServer
RETURN n.id AS id, labels(n)[0] AS label, n.name AS name, n.server_id AS server_id, n.capability AS capability
""",
    ),
    NamedQuery(
        name="choke.betweenness",
        doc="Display only: betweenness centrality of agents and tools on the flow layer, fixed seed.",
        mode="ro", targets=BOTH, timeout_ms=5_000,
        cypher="""
CALL algo.betweenness({nodeLabels: ['DataSource','Tool','ToolAct','Agent','Resource'],
                       relationshipTypes: ['FLOWS_TO'], samplingSize: 64, samplingSeed: 42})
YIELD node, score
WITH node, score WHERE 'Agent' IN labels(node) OR 'Tool' IN labels(node) OR 'ToolAct' IN labels(node)
WITH coalesce(node.of, node.id) AS id, node.name AS name,
     CASE WHEN 'Agent' IN labels(node) THEN 'Agent' ELSE 'Tool' END AS label, sum(score) AS score
RETURN id, name, label, score ORDER BY score DESC LIMIT 5
""",
    ),
    NamedQuery(
        name="choke.maxflow",
        doc="Max flow from every untrusted source to every high-impact resource over the flow layer, where an "
            "edge's capacity is the cost of the cheapest fix that cuts it. Its value is the cost of the cheapest "
            "cut; the cut itself is read off the flows. A guide for the agent, never a verdict.",
        mode="ro", targets=BOTH, timeout_ms=5_000,
        cypher="""
MATCH (s:DataSource {trust:'untrusted'})
WITH collect(s) AS sources
WHERE size(sources) > 0
MATCH (t:Resource {impact:'high'})
WITH sources, collect(t) AS targets
CALL algo.maxFlow({sourceNodes: sources, targetNodes: targets, relationshipTypes: ['FLOWS_TO'], capacityProperty: 'capacity'})
YIELD maxFlow, edges, edgeFlows
RETURN maxFlow AS max_flow, [s IN sources | s.id] AS source_ids,
       [e IN edges | startNode(e).id] AS from_ids, [e IN edges | endNode(e).id] AS to_ids,
       [e IN edges | e.rule] AS rules, edgeFlows AS flows
""",
    ),
    NamedQuery(
        name="zones.wcc",
        doc="Trust zones: weakly connected components of the flow layer.",
        mode="ro", targets=BOTH, timeout_ms=2_000,
        cypher="""
CALL algo.WCC({nodeLabels: ['DataSource','Tool','ToolAct','Agent','Resource'], relationshipTypes: ['FLOWS_TO']})
YIELD node, componentId
RETURN componentId AS component_id, collect(DISTINCT coalesce(node.of, node.id)) AS members,
       sum(CASE WHEN node.trust = 'untrusted' THEN 1 ELSE 0 END) > 0 AS has_untrusted,
       sum(CASE WHEN node.impact = 'high' THEN 1 ELSE 0 END) > 0 AS has_high_impact
""",
    ),

    NamedQuery(
        name="zones.communities",
        doc="Communities of the config graph by label propagation: which agents, tools, sources and resources hang "
            "together. A community is a blast community when it holds an untrusted source and a high-impact resource.",
        mode="ro", targets=BOTH, timeout_ms=5_000,
        cypher="""
CALL algo.labelPropagation({nodeLabels: ['DataSource','Tool','Agent','Resource'],
                            relationshipTypes: ['CAN_CALL','DELEGATES_TO','READS','WRITES','FEEDS'], maxIterations: 50})
YIELD node, communityId
RETURN communityId AS component_id, collect(node.id) AS members,
       sum(CASE WHEN node.trust = 'untrusted' THEN 1 ELSE 0 END) > 0 AS has_untrusted,
       sum(CASE WHEN node.impact = 'high' THEN 1 ELSE 0 END) > 0 AS has_high_impact
""",
    ),
    NamedQuery(
        name="choke.pagerank",
        doc="PageRank over the flow layer: how much of what flows ends up passing through each node. A tool's two sides "
            "are summed. Context for a person; no verdict rests on it.",
        mode="ro", targets=BOTH, timeout_ms=5_000,
        cypher="""
CALL algo.pageRank(null, 'FLOWS_TO') YIELD node, score
WITH coalesce(node.of, node.id) AS id, sum(score) AS score
RETURN id, score ORDER BY score DESC, id
""",
    ),
    NamedQuery(
        name="reach.agents_from_sources",
        doc="For each agent, the data sources of one trust level whose content reaches it: one BFS per source. "
            "Property A (untrusted) and property B (private) of the Rule of Two.",
        mode="ro", targets=BOTH, timeout_ms=5_000,
        cypher="""
MATCH (s:DataSource {trust: $trust})
CALL algo.bfs(s, $max_depth, 'FLOWS_TO') YIELD nodes
UNWIND nodes AS n
WITH s, n WHERE 'Agent' IN labels(n)
RETURN n.id AS agent, collect(DISTINCT s.id) AS sources
""",
    ),
    NamedQuery(
        name="agent.acts_on",
        doc="For each agent, the resources it can act on, with whether any is external or high-impact: one BFS per agent. "
            "Property C of the Rule of Two.",
        mode="ro", targets=BOTH, timeout_ms=5_000,
        cypher="""
MATCH (a:Agent)
CALL algo.bfs(a, $max_depth, 'FLOWS_TO') YIELD nodes
UNWIND nodes AS n
WITH a, n WHERE 'Resource' IN labels(n)
RETURN a.id AS agent, collect(DISTINCT n.id) AS resources,
       sum(CASE WHEN n.external THEN 1 ELSE 0 END) > 0 AS external,
       sum(CASE WHEN n.impact = 'high' THEN 1 ELSE 0 END) > 0 AS high_impact
""",
    ),

    # ------------------------------------------------------------------ findings (audit nodes)
    NamedQuery(
        name="finding.upsert",
        doc="Create or update a finding by fingerprint; a mitigated or closed finding that holds again reopens.",
        mode="rw", targets=WORKING, timeout_ms=2_000, idempotent=True,
        cypher="""
MERGE (f:Finding {fingerprint: $fingerprint})
ON CREATE SET f.id = $id, f.kind = $kind, f.status = 'open', f.created_at = $now
WITH f, f.status IN ['mitigated', 'closed'] AS reopen
SET f.severity = $severity, f.source_id = $source_id, f.target_id = $target_id, f.agent_id = $agent_id,
    f.path_ids = $path_ids, f.evidence_json = $evidence_json, f.updated_at = $now,
    f.status = CASE WHEN reopen THEN 'open' ELSE f.status END,
    f.reopened_at = CASE WHEN reopen THEN $now ELSE f.reopened_at END
RETURN f.id AS id, f.status AS status, f.created_at AS created_at, reopen AS reopened
""",
    ),
    NamedQuery(
        name="finding.clear_via",
        doc="Drop a finding's VIA edges before they are rewritten.",
        mode="rw", targets=WORKING, timeout_ms=2_000, idempotent=True,
        cypher="""
MATCH (:Finding {fingerprint: $fingerprint})-[v:VIA]->()
DELETE v
RETURN count(*) AS removed
""",
    ),
    NamedQuery(
        name="finding.set_via",
        doc="Link a finding to the nodes of its evidence path, in order.",
        mode="rw", targets=WORKING, timeout_ms=2_000,
        cypher="""
MATCH (f:Finding {fingerprint: $fingerprint})
UNWIND range(0, size($path_ids) - 1) AS i
WITH f, i, $path_ids[i] AS node_id
MATCH (n {id: node_id})
CREATE (f)-[:VIA {i: i}]->(n)
RETURN count(*) AS linked
""",
    ),
    NamedQuery(
        name="finding.close_stale",
        doc="Close open findings whose fact no longer holds: mitigated if an applied mitigation fixes them.",
        mode="rw", targets=WORKING, timeout_ms=2_000, idempotent=True,
        cypher="""
MATCH (f:Finding {status: 'open'}) WHERE NOT f.fingerprint IN $present
OPTIONAL MATCH (m:Mitigation {status: 'applied'})-[:FIXES]->(f)
WITH f, count(m) AS fixes
SET f.status = CASE WHEN fixes > 0 THEN 'mitigated' ELSE 'closed' END, f.updated_at = $now
RETURN f.fingerprint AS fingerprint, f.status AS status
""",
    ),
    NamedQuery(
        name="drift.before",
        doc="Each server's manifest hash and the hash of every part of each of its tools, as loaded last time. "
            "Read before a reload, compared after it: a changed manifest is a drift finding.",
        mode="ro", targets=WORKING, timeout_ms=2_000,
        cypher="""
MATCH (s:MCPServer)
OPTIONAL MATCH (t:Tool)-[:PROVIDED_BY]->(s)
RETURN s.id AS server_id, s.manifest_hash AS manifest_hash,
       collect({id: t.id, description: t.h_description, schema: t.h_schema, annotations: t.h_annotations}) AS tools
""",
    ),
    NamedQuery(
        name="finding.accept",
        doc="A person accepts an open finding as it is: it stays, marked accepted, and no scan reopens it. "
            "No row means the finding was not open.",
        mode="rw", targets=WORKING, timeout_ms=2_000,
        cypher="""
MATCH (f:Finding {id: $id}) WHERE f.status = 'open'
SET f.status = 'accepted', f.accepted_by = $who, f.updated_at = $now
RETURN f.id AS id, f.status AS status
""",
    ),
    NamedQuery(
        name="finding.list",
        doc="All findings stored in a working graph.",
        mode="ro", targets=WORKING, timeout_ms=2_000,
        cypher="""
MATCH (f:Finding)
RETURN f.id AS id, f.fingerprint AS fingerprint, f.kind AS kind, f.severity AS severity, f.status AS status,
       f.source_id AS source_id, f.target_id AS target_id, f.agent_id AS agent_id,
       f.evidence_json AS evidence_json, f.created_at AS created_at, f.updated_at AS updated_at,
       f.reopened_at AS reopened_at, f.accepted_by AS accepted_by
ORDER BY f.created_at, f.id
""",
    ),
    NamedQuery(
        name="finding.via",
        doc="The VIA path of one finding, in order.",
        mode="ro", targets=WORKING, timeout_ms=2_000,
        cypher="""
MATCH (:Finding {fingerprint: $fingerprint})-[v:VIA]->(n)
RETURN v.i AS i, n.id AS id ORDER BY i
""",
    ),
    NamedQuery(
        name="scenario.summary",
        doc="Node and open-finding counts for the scenario list.",
        mode="ro", targets=WORKING, timeout_ms=2_000,
        cypher="""
MATCH (n) WHERE NOT n:Finding AND NOT n:Mitigation AND NOT n:Scan AND NOT n:ToolAct AND NOT n:Draft
WITH count(n) AS nodes
OPTIONAL MATCH (f:Finding {status: 'open'})
RETURN nodes, count(f) AS open_findings
""",
    ),

    NamedQuery(
        name="scan.record", mode="rw", targets=WORKING, timeout_ms=2_000, idempotent=True,
        doc="Remember the last scan of a working graph: when it ran, how long it took and what it found.",
        cypher="""
MERGE (s:Scan {id: 'last'})
SET s.scan_id = $scan_id, s.at = $at, s.duration_ms = $duration_ms,
    s.injection = $injection, s.trifecta = $trifecta, s.partial = $partial
RETURN s.at AS at
""",
    ),
    NamedQuery(
        name="scan.last", mode="ro", targets=WORKING, timeout_ms=1_000,
        doc="The last scan of a working graph, if there has been one.",
        cypher="""
MATCH (s:Scan {id: 'last'})
RETURN s.scan_id AS scan_id, s.at AS at, s.duration_ms AS duration_ms,
       s.injection AS injection, s.trifecta AS trifecta, s.partial AS partial
""",
    ),

    # ------------------------------------------------------------------ ingest (scenario loader)
    NamedQuery(
        name="ingest.servers", mode="rw", targets=BOTH, timeout_ms=10_000, idempotent=True,
        doc="Upsert MCP servers.",
        cypher="""
UNWIND $rows AS row
MERGE (n:MCPServer {id: row.id})
SET n.name = row.name, n.source_url = row.source_url, n.synthetic = row.synthetic, n.manifest_hash = row.manifest_hash
RETURN count(n) AS written
""",
    ),
    NamedQuery(
        name="ingest.tools", mode="rw", targets=BOTH, timeout_ms=10_000, idempotent=True,
        doc="Upsert tools and tie each to its server.",
        cypher="""
UNWIND $rows AS row
MERGE (t:Tool {id: row.id})
SET t.name = row.name, t.server_id = row.server_id, t.description = row.description,
    t.capability = row.capability, t.capability_source = row.capability_source,
    t.h_description = row.h_description, t.h_schema = row.h_schema, t.h_annotations = row.h_annotations,
    t.poison_flags = row.poison_flags
WITH t, row
MATCH (s:MCPServer {id: row.server_id})
MERGE (t)-[:PROVIDED_BY]->(s)
RETURN count(t) AS written
""",
    ),
    NamedQuery(
        name="ingest.data_sources", mode="rw", targets=BOTH, timeout_ms=10_000, idempotent=True,
        doc="Upsert data sources with their trust level.",
        cypher="""
UNWIND $rows AS row
MERGE (n:DataSource {id: row.id})
SET n.name = row.name, n.trust = row.trust
RETURN count(n) AS written
""",
    ),
    NamedQuery(
        name="ingest.resources", mode="rw", targets=BOTH, timeout_ms=10_000, idempotent=True,
        doc="Upsert resources with their impact and whether they leave the organisation.",
        cypher="""
UNWIND $rows AS row
MERGE (n:Resource {id: row.id})
SET n.name = row.name, n.impact = row.impact, n.external = row.external
RETURN count(n) AS written
""",
    ),
    NamedQuery(
        name="ingest.agents", mode="rw", targets=BOTH, timeout_ms=10_000, idempotent=True,
        doc="Upsert agents.",
        cypher="""
UNWIND $rows AS row
MERGE (n:Agent {id: row.id})
SET n.name = row.name, n.owner = row.owner
RETURN count(n) AS written
""",
    ),
    NamedQuery(
        name="ingest.workflows", mode="rw", targets=BOTH, timeout_ms=10_000, idempotent=True,
        doc="Upsert workflows with their mode.",
        cypher="""
UNWIND $rows AS row
MERGE (n:Workflow {id: row.id})
SET n.name = row.name, n.description = row.description, n.mode = row.mode
RETURN count(n) AS written
""",
    ),
    NamedQuery(
        name="ingest.can_call", mode="rw", targets=BOTH, timeout_ms=10_000, idempotent=True,
        doc="Upsert grants: which agent may call which tool, and whether a person must approve.",
        cypher="""
UNWIND $rows AS row
MATCH (a:Agent {id: row.from_id}), (t:Tool {id: row.to_id})
MERGE (a)-[c:CAN_CALL]->(t)
SET c.gate = row.gate, c.origin = row.origin
RETURN count(c) AS written
""",
    ),
    NamedQuery(
        name="ingest.delegates_to", mode="rw", targets=BOTH, timeout_ms=10_000, idempotent=True,
        doc="Upsert delegations between agents, and whether results come back quarantined.",
        cypher="""
UNWIND $rows AS row
MATCH (a:Agent {id: row.from_id}), (b:Agent {id: row.to_id})
MERGE (a)-[d:DELEGATES_TO]->(b)
SET d.gate = row.gate, d.origin = row.origin
RETURN count(d) AS written
""",
    ),
    NamedQuery(
        name="ingest.reads", mode="rw", targets=BOTH, timeout_ms=10_000, idempotent=True,
        doc="Upsert which data sources a tool reads.",
        cypher="""
UNWIND $rows AS row
MATCH (t:Tool {id: row.from_id}), (d:DataSource {id: row.to_id})
MERGE (t)-[r:READS]->(d)
RETURN count(r) AS written
""",
    ),
    NamedQuery(
        name="ingest.writes", mode="rw", targets=BOTH, timeout_ms=10_000, idempotent=True,
        doc="Upsert which resources a tool acts on.",
        cypher="""
UNWIND $rows AS row
MATCH (t:Tool {id: row.from_id}), (r:Resource {id: row.to_id})
MERGE (t)-[w:WRITES]->(r)
RETURN count(w) AS written
""",
    ),
    NamedQuery(
        name="ingest.feeds", mode="rw", targets=BOTH, timeout_ms=10_000, idempotent=True,
        doc="Upsert which data sources a resource feeds: what is written there is read back from here (rule 7).",
        cypher="""
UNWIND $rows AS row
MATCH (r:Resource {id: row.from_id}), (d:DataSource {id: row.to_id})
MERGE (r)-[f:FEEDS]->(d)
RETURN count(f) AS written
""",
    ),
    NamedQuery(
        name="ingest.run_by", mode="rw", targets=BOTH, timeout_ms=10_000, idempotent=True,
        doc="Upsert which agent runs a workflow.",
        cypher="""
UNWIND $rows AS row
MATCH (w:Workflow {id: row.from_id}), (a:Agent {id: row.to_id})
MERGE (w)-[r:RUN_BY]->(a)
RETURN count(r) AS written
""",
    ),
    NamedQuery(
        name="ingest.needs", mode="rw", targets=BOTH, timeout_ms=10_000, idempotent=True,
        doc="Upsert the tools a workflow must be able to call.",
        cypher="""
UNWIND $rows AS row
MATCH (w:Workflow {id: row.from_id}), (t:Tool {id: row.to_id})
MERGE (w)-[r:NEEDS]->(t)
RETURN count(r) AS written
""",
    ),
    NamedQuery(
        name="ingest.needs_data", mode="rw", targets=BOTH, timeout_ms=10_000, idempotent=True,
        doc="Upsert the data sources a workflow must still be able to read.",
        cypher="""
UNWIND $rows AS row
MATCH (w:Workflow {id: row.from_id}), (d:DataSource {id: row.to_id})
MERGE (w)-[r:NEEDS_DATA]->(d)
RETURN count(r) AS written
""",
    ),

    # ------------------------------------------------------------------ fixes and what-if changes
    NamedQuery(
        name="fix.gate_call", mode="rw", targets=BOTH, timeout_ms=2_000, guarded=True,
        doc="Fix: a person must approve each call of this tool by this agent. Cuts the rule-3 hop.",
        cypher="""
MATCH (:Agent {id:$agent_id})-[c:CAN_CALL]->(:Tool {id:$tool_id})
WHERE c.gate IS NULL
SET c.gate = 'human_approval', c.origin = 'fix'
RETURN count(c) AS changed
""",
    ),
    NamedQuery(
        name="fix.revoke_call", mode="rw", targets=BOTH, timeout_ms=2_000, guarded=True,
        doc="Fix: the agent loses the grant. Cuts the rule-2 and rule-3 hops through it.",
        cypher="""
MATCH (:Agent {id:$agent_id})-[c:CAN_CALL]->(:Tool {id:$tool_id})
DELETE c
RETURN count(*) AS changed
""",
    ),
    NamedQuery(
        name="fix.quarantine_delegation", mode="rw", targets=BOTH, timeout_ms=2_000, guarded=True,
        doc="Fix: the delegate returns only structured fields to its delegator. Cuts the rule-6 hop.",
        cypher="""
MATCH (:Agent {id:$from_agent_id})-[d:DELEGATES_TO]->(:Agent {id:$to_agent_id})
WHERE d.gate IS NULL
SET d.gate = 'quarantine', d.origin = 'fix'
RETURN count(d) AS changed
""",
    ),
    NamedQuery(
        name="fix.drop_read", mode="rw", targets=BOTH, timeout_ms=2_000, guarded=True,
        doc="Fix: the tool stops reading this data source. Cuts the rule-1 hop.",
        cypher="""
MATCH (:Tool {id:$tool_id})-[r:READS]->(:DataSource {id:$source_id})
DELETE r
RETURN count(*) AS changed
""",
    ),
    NamedQuery(
        name="fix.split_agent", mode="rw", targets=BOTH, timeout_ms=2_000, guarded=True,
        doc="Fix: the agent keeps its acting tools and delegates these reading tools to a new reader, quarantined. "
            "What the reader reads can no longer return to the agent (rule 6 is gated). It changes nothing unless "
            "the agent holds every one of the tools and has no reader yet.",
        cypher="""
MATCH (a:Agent {id:$agent_id})-[c:CAN_CALL]->(t:Tool)
WHERE t.id IN $reader_tool_ids
WITH a, collect(c) AS grants, collect(t) AS tools
OPTIONAL MATCH (a)-[already:DELEGATES_TO]->(:Agent {id:$reader_id})
WITH a, grants, tools, count(already) AS split
WHERE size(tools) = size($reader_tool_ids) AND split = 0
MERGE (r:Agent {id:$reader_id})
SET r.name = a.name + ' (reader)', r.owner = a.owner
MERGE (a)-[d:DELEGATES_TO]->(r)
SET d.gate = 'quarantine', d.origin = 'fix'
WITH r, grants, tools
UNWIND range(0, size(tools) - 1) AS i
WITH r, grants[i] AS c, tools[i] AS t
CREATE (r)-[:CAN_CALL {gate: c.gate, origin: 'fix'}]->(t)
DELETE c
RETURN count(t) AS changed
""",
    ),
    NamedQuery(
        name="whatif.drop_server", mode="rw", targets=SANDBOX, timeout_ms=2_000,
        doc="What-if: the server is removed, so every grant to its tools goes. Sandbox only: a question, never a fix.",
        cypher="""
MATCH (:Agent)-[c:CAN_CALL]->(:Tool)-[:PROVIDED_BY]->(:MCPServer {id:$server_id})
DELETE c
RETURN count(*) AS changed
""",
    ),
    NamedQuery(
        name="whatif.grant_call", mode="rw", targets=SANDBOX, timeout_ms=2_000,
        doc="What-if: give an agent a tool it does not have. Sandbox only.",
        cypher="""
MATCH (a:Agent {id:$agent_id}), (t:Tool {id:$tool_id})
WHERE NOT (a)-[:CAN_CALL]->(t)
CREATE (a)-[c:CAN_CALL {origin:'whatif'}]->(t)
RETURN count(c) AS changed
""",
    ),
    NamedQuery(
        name="whatif.add_delegation", mode="rw", targets=SANDBOX, timeout_ms=2_000,
        doc="What-if: let one agent delegate to another. Sandbox only.",
        cypher="""
MATCH (a:Agent {id:$from_agent_id}), (b:Agent {id:$to_agent_id})
WHERE NOT (a)-[:DELEGATES_TO]->(b)
CREATE (a)-[d:DELEGATES_TO {origin:'whatif'}]->(b)
RETURN count(d) AS changed
""",
    ),
    NamedQuery(
        name="config.edges", mode="ro", targets=BOTH, timeout_ms=2_000,
        doc="Every config edge with its gate: input to the config hash, and to clone by query.",
        cypher="""
MATCH (a)-[e]->(b)
WHERE type(e) IN ['CAN_CALL', 'DELEGATES_TO', 'READS', 'WRITES', 'FEEDS', 'RUN_BY', 'NEEDS', 'NEEDS_DATA', 'PROVIDED_BY']
RETURN type(e) AS rel, a.id AS from_id, b.id AS to_id, e.gate AS gate, e.origin AS origin
ORDER BY rel, from_id, to_id
""",
    ),
    NamedQuery(
        name="config.nodes", mode="ro", targets=BOTH, timeout_ms=2_000,
        doc="Every config node with the facts findings depend on: input to the config hash, and to clone by query.",
        cypher="""
MATCH (n) WHERE n:Agent OR n:Tool OR n:DataSource OR n:Resource OR n:Workflow OR n:MCPServer
RETURN labels(n)[0] AS label, n.id AS id, n.name AS name, n.trust AS trust, n.impact AS impact,
       n.external AS external, n.mode AS mode, n.owner AS owner, n.server_id AS server_id,
       n.description AS description, n.capability AS capability, n.capability_source AS capability_source,
       n.source_url AS source_url, n.synthetic AS synthetic
ORDER BY label, id
""",
    ),

    # ------------------------------------------------------------------ mitigations (audit nodes)
    NamedQuery(
        name="mitigation.record", mode="rw", targets=WORKING, timeout_ms=2_000, idempotent=True,
        doc="Store a plan with its sandbox verdict. The same plan for the same targets is the same node. "
            "An approved or rejected plan keeps its status; an applied one whose findings are open again is a proposal again.",
        cypher="""
MERGE (m:Mitigation {id: $id})
ON CREATE SET m.created_at = $now, m.status = $status
WITH m, m.status IN ['proposed', 'failed', 'applied'] AS open
SET m.fix_json = $fix_json, m.cost = $cost, m.target_fingerprints = $targets,
    m.source = CASE WHEN m.source = 'agent' THEN 'agent' ELSE $source END,
    m.config_hash = CASE WHEN open THEN $config_hash ELSE m.config_hash END,
    m.verdict_json = CASE WHEN open THEN $verdict_json ELSE m.verdict_json END,
    m.passed = CASE WHEN open THEN $passed ELSE m.passed END,
    m.reason = CASE WHEN open THEN $reason ELSE m.reason END,
    m.rationale = CASE WHEN $rationale IS NULL THEN m.rationale ELSE $rationale END,
    m.status = CASE WHEN open THEN $status ELSE m.status END,
    m.updated_at = $now
RETURN m.id AS id, m.status AS status
""",
    ),
    NamedQuery(
        name="mitigation.set_status", mode="rw", targets=WORKING, timeout_ms=2_000,
        doc="Move a mitigation from one of the allowed statuses to a new one; no row means it was not in one of them.",
        cypher="""
MATCH (m:Mitigation {id: $id}) WHERE m.status IN $allowed
SET m.status = $status, m.updated_at = $now,
    m.approved_by = CASE WHEN $approved_by IS NULL THEN m.approved_by ELSE $approved_by END,
    m.applied_at = CASE WHEN $applied_at IS NULL THEN m.applied_at ELSE $applied_at END,
    m.decision_reason = CASE WHEN $decision_reason IS NULL THEN m.decision_reason ELSE $decision_reason END
RETURN m.id AS id, m.status AS status
""",
    ),
    NamedQuery(
        name="mitigation.get", mode="ro", targets=WORKING, timeout_ms=2_000,
        doc="One mitigation with its plan and verdict.",
        cypher="""
MATCH (m:Mitigation {id: $id})
RETURN m.id AS id, m.status AS status, m.fix_json AS fix_json, m.cost AS cost, m.config_hash AS config_hash,
       m.target_fingerprints AS target_fingerprints, m.verdict_json AS verdict_json, m.passed AS passed,
       m.reason AS reason, m.rationale AS rationale, m.source AS source, m.approved_by AS approved_by,
       m.decision_reason AS decision_reason, m.created_at AS created_at, m.applied_at AS applied_at
""",
    ),
    NamedQuery(
        name="mitigation.list", mode="ro", targets=WORKING, timeout_ms=2_000,
        doc="Every mitigation stored in a working graph, newest first.",
        cypher="""
MATCH (m:Mitigation)
RETURN m.id AS id, m.status AS status, m.fix_json AS fix_json, m.cost AS cost, m.config_hash AS config_hash,
       m.target_fingerprints AS target_fingerprints, m.verdict_json AS verdict_json, m.passed AS passed,
       m.reason AS reason, m.rationale AS rationale, m.source AS source, m.approved_by AS approved_by,
       m.decision_reason AS decision_reason, m.created_at AS created_at, m.applied_at AS applied_at
ORDER BY m.created_at DESC, m.id
""",
    ),
    NamedQuery(
        name="mitigation.link_fixes", mode="rw", targets=WORKING, timeout_ms=2_000, idempotent=True,
        doc="Tie an applied mitigation to the findings it resolved, so a rescan closes them as mitigated.",
        cypher="""
MATCH (m:Mitigation {id: $id})
UNWIND $fingerprints AS fingerprint
MATCH (f:Finding {fingerprint: fingerprint})
MERGE (m)-[:FIXES]->(f)
RETURN count(f) AS linked
""",
    ),

    # ------------------------------------------------------------------ UI
    NamedQuery(
        name="ui.nodes", mode="ro", targets=WORKING, timeout_ms=2_000,
        doc="Nodes for a chart.",
        cypher="""
MATCH (n) WHERE n:Agent OR n:Tool OR n:DataSource OR n:Resource
RETURN ID(n) AS nid, labels(n)[0] AS label, n.id AS id, n.name AS name, n.trust AS trust, n.impact AS impact,
       n.external AS external, n.owner AS owner, n.capability AS capability, n.server_id AS server_id
ORDER BY nid
""",
    ),
    NamedQuery(
        name="ui.links", mode="ro", targets=WORKING, timeout_ms=2_000,
        doc="Links for a chart: the derived flow layer or the config layer, chosen by $types. An acting side is named by its tool.",
        cypher="""
MATCH (a)-[e]->(b)
WHERE type(e) IN $types AND (a:Agent OR a:Tool OR a:ToolAct OR a:DataSource OR a:Resource)
                        AND (b:Agent OR b:Tool OR b:ToolAct OR b:DataSource OR b:Resource)
RETURN ID(e) AS lid, type(e) AS rel, coalesce(a.of, a.id) AS from_id, coalesce(b.of, b.id) AS to_id,
       e.rule AS rule, e.gate AS gate
ORDER BY lid
""",
    ),

    NamedQuery(
        name="server.summary", mode="ro", targets=WORKING, timeout_ms=2_000,
        doc="Each MCP server with its tools, the agents that hold them, and the findings whose paths run through them.",
        cypher="""
MATCH (s:MCPServer)
OPTIONAL MATCH (t:Tool)-[:PROVIDED_BY]->(s)
OPTIONAL MATCH (a:Agent)-[:CAN_CALL]->(t)
OPTIONAL MATCH (f:Finding)-[:VIA]->(t) WHERE f.status IN ['open', 'accepted']
RETURN s.id AS id, s.name AS name, s.source_url AS source_url, s.synthetic AS synthetic, s.manifest_hash AS manifest_hash,
       collect(DISTINCT t.id) AS tools, collect(DISTINCT a.id) AS agents, collect(DISTINCT f.id) AS findings
ORDER BY id
""",
    ),
    NamedQuery(
        name="ui.workflows", mode="ro", targets=WORKING, timeout_ms=2_000,
        doc="Workflows with who runs them and what they need: what a fix must not break.",
        cypher="""
MATCH (w:Workflow)-[:RUN_BY]->(a:Agent)
OPTIONAL MATCH (w)-[:NEEDS]->(t:Tool)
WITH w, a, collect(DISTINCT t.id) AS needs
OPTIONAL MATCH (w)-[:NEEDS_DATA]->(d:DataSource)
RETURN w.id AS id, w.name AS name, w.description AS description, w.mode AS mode, a.id AS run_by,
       needs, collect(DISTINCT d.id) AS reads
ORDER BY id
""",
    ),

    # ------------------------------------------------------------------ the overview
    NamedQuery(
        name="overview.counts", mode="ro", targets=WORKING, timeout_ms=2_000,
        doc="The counts the one-picture overview opens with: sources by trust, agents, tools, resources by impact and "
            "whether they leave the organisation, workflows. One pass over the config nodes.",
        cypher="""
MATCH (n) WHERE n:Agent OR n:Tool OR n:DataSource OR n:Resource OR n:Workflow
RETURN sum(CASE WHEN n:DataSource AND n.trust = 'untrusted' THEN 1 ELSE 0 END) AS untrusted_sources,
       sum(CASE WHEN n:DataSource AND n.trust = 'private' THEN 1 ELSE 0 END) AS private_sources,
       sum(CASE WHEN n:DataSource THEN 1 ELSE 0 END) AS sources,
       sum(CASE WHEN n:Agent THEN 1 ELSE 0 END) AS agents,
       sum(CASE WHEN n:Tool THEN 1 ELSE 0 END) AS tools,
       sum(CASE WHEN n:Resource AND n.impact = 'high' THEN 1 ELSE 0 END) AS high_resources,
       sum(CASE WHEN n:Resource AND n.external = true THEN 1 ELSE 0 END) AS external_resources,
       sum(CASE WHEN n:Resource THEN 1 ELSE 0 END) AS resources,
       sum(CASE WHEN n:Workflow THEN 1 ELSE 0 END) AS workflows
""",
    ),

    # ------------------------------------------------------------------ drafts: a plan as the change to the real config
    NamedQuery(
        name="draft.record", mode="rw", targets=WORKING, timeout_ms=2_000, idempotent=True,
        doc="Store a plan compiled into the change it makes to the configuration it was imported from: the text that "
            "would be written, a diff a person can read, and a note on what the target can and cannot express. "
            "One draft per plan and target; a person's edit replaces the text.",
        cypher="""
MATCH (m:Mitigation {id: $mitigation_id})
MERGE (d:Draft {id: $id})
ON CREATE SET d.created_at = $now, d.status = 'drafted'
SET d.kind = $kind, d.path = $path, d.before_hash = $before_hash, d.after_hash = $after_hash, d.diff = $diff,
    d.note = $note, d.commands_json = $commands_json, d.after_text = $after_text, d.writable = $writable,
    d.edited = $edited, d.updated_at = $now
MERGE (m)-[:DRAFTS]->(d)
RETURN d.id AS id, d.status AS status
""",
    ),
    NamedQuery(
        name="draft.for_mitigation", mode="ro", targets=WORKING, timeout_ms=2_000,
        doc="The drafts of one plan, with their status and the receipt of a write, if there was one.",
        cypher="""
MATCH (:Mitigation {id: $mitigation_id})-[:DRAFTS]->(d:Draft)
RETURN d.id AS id, d.status AS status, d.kind AS kind, d.path AS path, d.before_hash AS before_hash, d.after_hash AS after_hash,
       d.diff AS diff, d.note AS note, d.commands_json AS commands_json, d.after_text AS after_text, d.writable AS writable,
       d.edited AS edited, d.created_at AS created_at, d.updated_at AS updated_at,
       d.written_at AS written_at, d.written_by AS written_by, d.receipt_json AS receipt_json
ORDER BY d.created_at
""",
    ),
    NamedQuery(
        name="draft.set_written", mode="rw", targets=WORKING, timeout_ms=2_000, idempotent=True,
        doc="Record that a person wrote a draft to its file: who, when, and the receipt (hashes before and after, "
            "what the rescan found). The one write to a person's file DeVries makes, and it is recorded here.",
        cypher="""
MATCH (d:Draft {id: $id})
SET d.status = $status, d.written_at = $written_at, d.written_by = $written_by, d.receipt_json = $receipt_json, d.updated_at = $written_at
RETURN d.id AS id, d.status AS status
""",
    ),

    # ------------------------------------------------------------------ canary
    NamedQuery(
        name="canary.build", mode="rw", targets=SANDBOX, timeout_ms=5_000,
        doc="A built-in graph with one known injection down a 16-hop chain and one known trifecta agent.",
        cypher="""
CREATE
 (u:DataSource {id:'src:canary-untrusted', name:'Canary untrusted', trust:'untrusted'}),
 (h:Resource {id:'res:canary-high', name:'Canary high impact', impact:'high', external:false}),
 (rt:Tool {id:'tool:canary.read', name:'read'}),
 (wt:Tool {id:'tool:canary.write', name:'write'}),
 (rt)-[:READS]->(u), (wt)-[:WRITES]->(h),
 (a0:Agent {id:'agent:canary-0', name:'Canary 0'}), (a1:Agent {id:'agent:canary-1', name:'Canary 1'}),
 (a2:Agent {id:'agent:canary-2', name:'Canary 2'}), (a3:Agent {id:'agent:canary-3', name:'Canary 3'}),
 (a4:Agent {id:'agent:canary-4', name:'Canary 4'}), (a5:Agent {id:'agent:canary-5', name:'Canary 5'}),
 (a6:Agent {id:'agent:canary-6', name:'Canary 6'}), (a7:Agent {id:'agent:canary-7', name:'Canary 7'}),
 (a8:Agent {id:'agent:canary-8', name:'Canary 8'}), (a9:Agent {id:'agent:canary-9', name:'Canary 9'}),
 (a10:Agent {id:'agent:canary-10', name:'Canary 10'}), (a11:Agent {id:'agent:canary-11', name:'Canary 11'}),
 (a12:Agent {id:'agent:canary-12', name:'Canary 12'}),
 (a0)-[:CAN_CALL]->(rt), (a12)-[:CAN_CALL]->(wt),
 (a0)-[:DELEGATES_TO]->(a1), (a1)-[:DELEGATES_TO]->(a2), (a2)-[:DELEGATES_TO]->(a3), (a3)-[:DELEGATES_TO]->(a4),
 (a4)-[:DELEGATES_TO]->(a5), (a5)-[:DELEGATES_TO]->(a6), (a6)-[:DELEGATES_TO]->(a7), (a7)-[:DELEGATES_TO]->(a8),
 (a8)-[:DELEGATES_TO]->(a9), (a9)-[:DELEGATES_TO]->(a10), (a10)-[:DELEGATES_TO]->(a11), (a11)-[:DELEGATES_TO]->(a12),
 (u2:DataSource {id:'src:canary-untrusted-2', name:'Canary untrusted 2', trust:'untrusted'}),
 (p:DataSource {id:'src:canary-private', name:'Canary private', trust:'private'}),
 (x:Resource {id:'res:canary-exit', name:'Canary exit', impact:'low', external:true}),
 (r2:Tool {id:'tool:canary.read2', name:'read2'}), (r3:Tool {id:'tool:canary.read3', name:'read3'}),
 (w2:Tool {id:'tool:canary.send', name:'send'}),
 (r2)-[:READS]->(u2), (r3)-[:READS]->(p), (w2)-[:WRITES]->(x),
 (t:Agent {id:'agent:canary-tri', name:'Canary trifecta'}),
 (t)-[:CAN_CALL]->(r2), (t)-[:CAN_CALL]->(r3), (t)-[:CAN_CALL]->(w2)
RETURN 1 AS built
""",
    ),
]

CATALOG: dict[str, NamedQuery] = {q.name: q for q in _QUERIES}
assert len(CATALOG) == len(_QUERIES), "duplicate query name in the catalog"
assert all(q.timeout_ms <= 10_000 for q in _QUERIES), "a timeout above TIMEOUT_MAX is rejected by the server"


def to_markdown() -> str:
    """The whole catalog as a document: docs/QUERIES.md is this, written by `make queries-doc`."""
    out = [
        "# Every query DeVries runs",
        "",
        "Generated from `devries/graph/catalog.py` by `make queries-doc`; edit the catalog, not this file. The running app",
        "serves the same list at `/api/queries`, and the UI shows it under Queries.",
        "",
        f"There are {len(_QUERIES)} statements, and no other Cypher anywhere in the product: a query is run by its name,",
        "and values only ever travel as parameters. `ro` statements are sent with `GRAPH.RO_QUERY`, so the server itself",
        "refuses a write in them. *Targets* says which kind of graph a statement may touch: a `working` graph is a scenario",
        "or a visitor's copy of one, a `sandbox` is a throwaway copy. The `fix.*` statements are guarded as well: outside a",
        "sandbox they run only when a person has approved the plan they belong to.",
        "",
        "| Query | Mode | Targets | Timeout | What it is for |", "| --- | --- | --- | --- | --- |",
    ]
    for q in _QUERIES:
        out.append(f"| `{q.name}` | {q.mode} | {', '.join(sorted(q.targets))} | {q.timeout_ms / 1000:g} s | {q.doc} |")
    out.append("")
    out += ["## The statements", ""]
    for q in _QUERIES:
        out += [f"### `{q.name}`", "", q.doc, "", "```cypher", q.cypher.strip(), "```", ""]
    return "\n".join(out)


if __name__ == "__main__":
    print(to_markdown())
