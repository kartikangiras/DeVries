# Every query DeVries runs

Generated from `devries/graph/catalog.py` by `make queries-doc`; edit the catalog, not this file. The running app
serves the same list at `/api/queries`, and the UI shows it under Queries.

There are 90 statements, and no other Cypher anywhere in the product: a query is run by its name,
and values only ever travel as parameters. `ro` statements are sent with `GRAPH.RO_QUERY`, so the server itself
refuses a write in them. *Targets* says which kind of graph a statement may touch: a `working` graph is a scenario
or a visitor's copy of one, a `sandbox` is a throwaway copy. The `fix.*` statements are guarded as well: outside a
sandbox they run only when a person has approved the plan they belong to.

| Query | Mode | Targets | Timeout | What it is for |
| --- | --- | --- | --- | --- |
| `schema.index.agent_id` | rw | sandbox, working | 10 s | Exact-match index on Agent.id. |
| `schema.index.tool_id` | rw | sandbox, working | 10 s | Exact-match index on Tool.id. |
| `schema.index.mcpserver_id` | rw | sandbox, working | 10 s | Exact-match index on MCPServer.id. |
| `schema.index.datasource_id` | rw | sandbox, working | 10 s | Exact-match index on DataSource.id. |
| `schema.index.resource_id` | rw | sandbox, working | 10 s | Exact-match index on Resource.id. |
| `schema.index.workflow_id` | rw | sandbox, working | 10 s | Exact-match index on Workflow.id. |
| `schema.index.finding_fingerprint` | rw | sandbox, working | 10 s | Exact-match index on Finding.fingerprint. |
| `schema.index.datasource_trust` | rw | sandbox, working | 10 s | Exact-match index on DataSource.trust. |
| `schema.index.resource_impact` | rw | sandbox, working | 10 s | Exact-match index on Resource.impact. |
| `schema.index.mitigation_id` | rw | sandbox, working | 10 s | Exact-match index on Mitigation.id. |
| `schema.index.draft_id` | rw | sandbox, working | 10 s | Exact-match index on Draft.id. |
| `schema.index.run_id` | rw | sandbox, working | 10 s | Exact-match index on Run.id. |
| `projection.rebuild` | rw | sandbox, working | 5 s | Rebuild the derived FLOWS_TO / GATED_FLOW layer from the config edges, atomically. Each flow edge carries as its capacity, for the min cut, the cost of the cheapest fix that cuts it without breaking a workflow that needs the hop: 1000 where no fix can cut it, where a workflow (run by the agent or by one that delegates to it) needs the tool a revoke would take, where that workflow is autonomous so a gate would stop it too, or where a workflow needs the data a dropped read would lose. The cut then lands on a plan a sandbox passes. A tool that acts has two sides in this layer: what it reads leaves the Tool node toward its callers (rules 1, 2), and a call enters a ToolAct node and leaves only toward the resource (rules 3, 5). With one node for both, one agent's context would flow into every other caller of a tool that reads and acts. The acting side is matched by an id computed in a WITH one clause earlier: on 6.0.2 an inline {id: t.id + '#act'} in the same clause matched nothing. |
| `flow.edges` | ro | sandbox, working | 2 s | Every derived FLOWS_TO edge with its rule. An acting side is named by its tool (from_id, to_id); from_key and to_key are the nodes themselves, for the walk that reads a cut off a max flow. |
| `flow.gated_edges` | ro | sandbox, working | 2 s | Every GATED_FLOW edge: a hop that a gate currently blocks. |
| `graph.node_count` | ro | sandbox, working | 1 s | The count of nodes a flow path can visit (config nodes and the acting sides of tools): the BFS depth for every verdict, and the hop limit for the evidence retry. Audit records (findings, plans, scans, runs, drafts) are not counted, so the depth does not grow with the history. |
| `reach.untrusted_to_high` | ro | sandbox, working | 2 s | Verdict: which high-impact resources each untrusted source reaches. $max_depth must be positive: 0 returns nothing on FalkorDB 4.22 and 6.0. |
| `reach.untrusted_nodes` | ro | sandbox, working | 2 s | Everything an untrusted source reaches over the flow layer: what a chart fills in. The sources themselves are not in the answer; BFS leaves its start out. |
| `find.trifecta` | ro | sandbox, working | 2 s | Verdict: agents reached by untrusted and by private data that can reach an external resource. |
| `wf.broken` | ro | sandbox, working | 2 s | Verdict: any row is something a workflow needs that the config no longer gives it. A supervised workflow can use a gated grant; an autonomous one cannot. `gated` says a grant exists but every one is gated. |
| `evidence.pair_paths` | ro | sandbox, working | 2 s | Up to $k paths between one source and one sink, fewest hops first. Never decides a verdict. |
| `evidence.pair_count` | ro | sandbox, working | 2 s | How many routes there are between one source and one sink, counted up to $k. Shown beside the routes kept. |
| `reach.into` | ro | sandbox, working | 5 s | Everything from which $id can be reached over the flow layer: one BFS from each node, kept where the node reaches the target. Answers 'what can reach X?' without a model. |
| `reach.from` | ro | sandbox, working | 2 s | Everything $id reaches over the flow layer, both sides of a tool together. Answers 'what does X reach?' without a model. |
| `wf.needing` | ro | sandbox, working | 2 s | The workflows that need a tool or a data source, with who runs them. Answers 'which workflows need X?'. |
| `node.names` | ro | sandbox, working | 2 s | Display names for the nodes that can appear on a path, and for the servers a drift finding names. |
| `choke.betweenness` | ro | sandbox, working | 5 s | Display only: betweenness centrality of agents and tools on the flow layer, fixed seed. |
| `choke.maxflow` | ro | sandbox, working | 5 s | Max flow from every untrusted source to every high-impact resource over the flow layer, where an edge's capacity is the cost of the cheapest fix that cuts it. Its value is the cost of the cheapest cut; the cut itself is read off the flows. A guide for the agent, never a verdict. |
| `zones.wcc` | ro | sandbox, working | 2 s | Trust zones: weakly connected components of the flow layer. |
| `zones.communities` | ro | sandbox, working | 5 s | Communities of the config graph by label propagation: which agents, tools, sources and resources hang together. A community is a blast community when it holds an untrusted source and a high-impact resource. |
| `choke.pagerank` | ro | sandbox, working | 5 s | PageRank over the flow layer: how much of what flows ends up passing through each node. A tool's two sides are summed. Context for a person; no verdict rests on it. |
| `reach.agents_from_sources` | ro | sandbox, working | 5 s | For each agent, the data sources of one trust level whose content reaches it: one BFS per source. Property A (untrusted) and property B (private) of the Rule of Two. |
| `agent.acts_on` | ro | sandbox, working | 5 s | For each agent, the resources it can act on, with whether any is external or high-impact: one BFS per agent. Property C of the Rule of Two. |
| `finding.upsert` | rw | working | 2 s | Create or update a finding by fingerprint; a mitigated or closed finding that holds again reopens. |
| `finding.clear_via` | rw | working | 2 s | Drop a finding's VIA edges before they are rewritten. |
| `finding.set_via` | rw | working | 2 s | Link a finding to the nodes of its evidence path, in order. |
| `finding.close_stale` | rw | working | 2 s | Close open findings whose fact no longer holds: mitigated if an applied mitigation fixes them. |
| `drift.before` | ro | working | 2 s | Each server's manifest hash and the hash of every part of each of its tools, as loaded last time. Read before a reload, compared after it: a changed manifest is a drift finding. |
| `finding.accept` | rw | working | 2 s | A person accepts an open finding as it is: it stays, marked accepted, and no scan reopens it. No row means the finding was not open. |
| `finding.list` | ro | working | 2 s | All findings stored in a working graph. |
| `finding.via` | ro | working | 2 s | The VIA path of one finding, in order. |
| `scenario.summary` | ro | working | 2 s | Node and open-finding counts for the scenario list. |
| `scan.record` | rw | working | 2 s | Remember the last scan of a working graph: when it ran, how long it took and what it found. |
| `scan.last` | ro | working | 1 s | The last scan of a working graph, if there has been one. |
| `scan.keep` | rw | working | 2 s | Keep one Scan node per scan, beside the 'last' record: when it ran, how long it took, what it found and how many findings were open afterwards. The history a posture page draws over time. |
| `scan.prune` | rw | working | 2 s | Delete the Scan nodes beyond the newest $keep, so the history a graph holds stays bounded. |
| `scan.history` | ro | working | 2 s | The last 50 scans of a working graph, newest first. A graph loaded before scans were kept has none. |
| `run.record` | rw | working | 5 s | Keep an auditor run on the graph it worked on, as one node holding the whole record as JSON: every step, who took it and why. Written as the run moves, so a restart loses nothing a person saw. |
| `run.list` | ro | working | 5 s | Every run kept on a working graph, oldest first. |
| `ingest.servers` | rw | sandbox, working | 10 s | Upsert MCP servers. |
| `ingest.tools` | rw | sandbox, working | 10 s | Upsert tools and tie each to its server. |
| `ingest.data_sources` | rw | sandbox, working | 10 s | Upsert data sources with their trust level. |
| `ingest.resources` | rw | sandbox, working | 10 s | Upsert resources with their impact and whether they leave the organisation. |
| `ingest.agents` | rw | sandbox, working | 10 s | Upsert agents. |
| `ingest.workflows` | rw | sandbox, working | 10 s | Upsert workflows with their mode. |
| `ingest.can_call` | rw | sandbox, working | 10 s | Upsert grants: which agent may call which tool, and whether a person must approve. |
| `ingest.delegates_to` | rw | sandbox, working | 10 s | Upsert delegations between agents, and whether results come back quarantined. |
| `ingest.reads` | rw | sandbox, working | 10 s | Upsert which data sources a tool reads. |
| `ingest.writes` | rw | sandbox, working | 10 s | Upsert which resources a tool acts on. |
| `ingest.feeds` | rw | sandbox, working | 10 s | Upsert which data sources a resource feeds: what is written there is read back from here (rule 7). |
| `ingest.run_by` | rw | sandbox, working | 10 s | Upsert which agent runs a workflow. |
| `ingest.needs` | rw | sandbox, working | 10 s | Upsert the tools a workflow must be able to call. |
| `ingest.needs_data` | rw | sandbox, working | 10 s | Upsert the data sources a workflow must still be able to read. |
| `fix.gate_call` | rw | sandbox, working | 2 s | Fix: a person must approve each call of this tool by this agent. Cuts the rule-3 hop. |
| `fix.revoke_call` | rw | sandbox, working | 2 s | Fix: the agent loses the grant. Cuts the rule-2 and rule-3 hops through it. |
| `fix.quarantine_delegation` | rw | sandbox, working | 2 s | Fix: the delegate returns only structured fields to its delegator. Cuts the rule-6 hop. |
| `fix.drop_read` | rw | sandbox, working | 2 s | Fix: the tool stops reading this data source. Cuts the rule-1 hop. |
| `fix.split_agent` | rw | sandbox, working | 2 s | Fix: the agent keeps its acting tools and delegates these reading tools to a new reader, quarantined. What the reader reads can no longer return to the agent (rule 6 is gated). It changes nothing unless the agent holds every one of the tools and has no reader yet. |
| `whatif.drop_server` | rw | sandbox | 2 s | What-if: the server is removed, so every grant to its tools goes. Sandbox only: a question, never a fix. |
| `whatif.grant_call` | rw | sandbox | 2 s | What-if: give an agent a tool it does not have. Sandbox only. |
| `whatif.add_delegation` | rw | sandbox | 2 s | What-if: let one agent delegate to another. Sandbox only. |
| `config.edges` | ro | sandbox, working | 2 s | Every config edge with its gate: input to the config hash, and to clone by query. |
| `config.nodes` | ro | sandbox, working | 2 s | Every config node with the facts findings depend on: input to the config hash, and to clone by query. |
| `mitigation.record` | rw | working | 2 s | Store a plan with its sandbox verdict. The same plan for the same targets is the same node. An approved or rejected plan keeps its status; an applied one whose findings are open again is a proposal again. |
| `mitigation.set_status` | rw | working | 2 s | Move a mitigation from one of the allowed statuses to a new one; no row means it was not in one of them. A decision records who made it and a hash of the session it came from. |
| `mitigation.get` | ro | working | 2 s | One mitigation with its plan and verdict. |
| `mitigation.progress` | rw | working | 2 s | How many of an approved plan's fixes have been applied so far. Written after each fix, so a process that dies mid-plan leaves a plan the next apply can finish instead of one it can never apply. |
| `mitigation.list` | ro | working | 2 s | Every mitigation stored in a working graph, newest first. |
| `mitigation.link_fixes` | rw | working | 2 s | Tie an applied mitigation to the findings it resolved, so a rescan closes them as mitigated. |
| `ui.nodes` | ro | working | 2 s | Nodes for a chart. |
| `ui.links` | ro | working | 2 s | Links for a chart: the derived flow layer or the config layer, chosen by $types. An acting side is named by its tool. |
| `inventory.rows` | ro | working | 2 s | Every agent, tool, data source and resource with its config-side counts in one pass: grants held and how many are gated, grants on a tool and how many are gated, delegations, what a tool reads and acts on, what reads a source, what acts on a resource, and the workflows an agent runs. Each relationship is counted in its own step, so one kind never multiplies another. |
| `server.summary` | ro | working | 2 s | Each MCP server with its tools, the agents that hold them, and the findings whose paths run through them. |
| `ui.workflows` | ro | working | 2 s | Workflows with who runs them and what they need: what a fix must not break. |
| `overview.counts` | ro | working | 2 s | The counts the one-picture overview opens with: sources by trust, agents, tools, resources by impact and whether they leave the organisation, workflows. One pass over the config nodes. |
| `draft.record` | rw | working | 2 s | Store a plan compiled into the change it makes to the configuration it was imported from: the text that would be written, a diff a person can read, and a note on what the target can and cannot express. One draft per plan and target; a person's edit replaces the text. |
| `draft.for_mitigation` | ro | working | 2 s | The drafts of one plan, with their status and the receipt of a write, if there was one. |
| `draft.list` | ro | working | 2 s | Every draft on a working graph with the plan it belongs to, for the activity list: one query, not one per plan. |
| `draft.set_written` | rw | working | 2 s | Record that a person wrote a draft to its file: who, when, and the receipt (hashes before and after, what the rescan found). The one write to a person's file DeVries makes, and it is recorded here. |
| `canary.build` | rw | sandbox | 5 s | A built-in graph with one known injection down a 16-hop chain and one known trifecta agent. |

## The statements

### `schema.index.agent_id`

Exact-match index on Agent.id.

```cypher
CREATE INDEX FOR (n:Agent) ON (n.id)
```

### `schema.index.tool_id`

Exact-match index on Tool.id.

```cypher
CREATE INDEX FOR (n:Tool) ON (n.id)
```

### `schema.index.mcpserver_id`

Exact-match index on MCPServer.id.

```cypher
CREATE INDEX FOR (n:MCPServer) ON (n.id)
```

### `schema.index.datasource_id`

Exact-match index on DataSource.id.

```cypher
CREATE INDEX FOR (n:DataSource) ON (n.id)
```

### `schema.index.resource_id`

Exact-match index on Resource.id.

```cypher
CREATE INDEX FOR (n:Resource) ON (n.id)
```

### `schema.index.workflow_id`

Exact-match index on Workflow.id.

```cypher
CREATE INDEX FOR (n:Workflow) ON (n.id)
```

### `schema.index.finding_fingerprint`

Exact-match index on Finding.fingerprint.

```cypher
CREATE INDEX FOR (n:Finding) ON (n.fingerprint)
```

### `schema.index.datasource_trust`

Exact-match index on DataSource.trust.

```cypher
CREATE INDEX FOR (n:DataSource) ON (n.trust)
```

### `schema.index.resource_impact`

Exact-match index on Resource.impact.

```cypher
CREATE INDEX FOR (n:Resource) ON (n.impact)
```

### `schema.index.mitigation_id`

Exact-match index on Mitigation.id.

```cypher
CREATE INDEX FOR (n:Mitigation) ON (n.id)
```

### `schema.index.draft_id`

Exact-match index on Draft.id.

```cypher
CREATE INDEX FOR (n:Draft) ON (n.id)
```

### `schema.index.run_id`

Exact-match index on Run.id.

```cypher
CREATE INDEX FOR (n:Run) ON (n.id)
```

### `projection.rebuild`

Rebuild the derived FLOWS_TO / GATED_FLOW layer from the config edges, atomically. Each flow edge carries as its capacity, for the min cut, the cost of the cheapest fix that cuts it without breaking a workflow that needs the hop: 1000 where no fix can cut it, where a workflow (run by the agent or by one that delegates to it) needs the tool a revoke would take, where that workflow is autonomous so a gate would stop it too, or where a workflow needs the data a dropped read would lose. The cut then lands on a plan a sandbox passes. A tool that acts has two sides in this layer: what it reads leaves the Tool node toward its callers (rules 1, 2), and a call enters a ToolAct node and leaves only toward the resource (rules 3, 5). With one node for both, one agent's context would flow into every other caller of a tool that reads and acts. The acting side is matched by an id computed in a WITH one clause earlier: on 6.0.2 an inline {id: t.id + '#act'} in the same clause matched nothing.

```cypher
MATCH ()-[f:FLOWS_TO]->() DELETE f
WITH count(*) AS c0
MATCH ()-[g:GATED_FLOW]->() DELETE g
WITH count(*) AS c1
MATCH (t:Tool)-[:WRITES]->(:Resource)
WITH DISTINCT t
MERGE (x:ToolAct {id: t.id + '#act'}) SET x.of = t.id, x.name = t.name
WITH count(*) AS c2
MATCH (t:Tool)-[:READS]->(d:DataSource)
OPTIONAL MATCH (w:Workflow)-[:RUN_BY]->(:Agent)-[:DELEGATES_TO*0..]->(:Agent)-[:CAN_CALL]->(t) WHERE (w)-[:NEEDS_DATA]->(d)
WITH t, d, count(w) AS needed
MERGE (d)-[f1:FLOWS_TO {rule:1}]->(t) SET f1.capacity = CASE WHEN needed = 0 THEN 3 ELSE 1000 END
WITH count(*) AS c3
MATCH (a:Agent)-[:CAN_CALL]->(t:Tool)-[:READS]->(:DataSource)
WITH DISTINCT a, t
OPTIONAL MATCH (w:Workflow)-[:RUN_BY]->(:Agent)-[:DELEGATES_TO*0..]->(a) WHERE (w)-[:NEEDS]->(t) OR (w)-[:NEEDS_DATA]->(:DataSource)<-[:READS]-(t)
WITH a, t, count(w) AS needed
MERGE (t)-[f2:FLOWS_TO {rule:2}]->(a) SET f2.capacity = CASE WHEN needed = 0 THEN 1 ELSE 1000 END
WITH count(*) AS c4
MATCH (a:Agent)-[c:CAN_CALL]->(t:Tool)-[:WRITES]->(:Resource) WHERE c.gate IS NULL
WITH DISTINCT a, t, t.id + '#act' AS xid
OPTIONAL MATCH (w:Workflow)-[:RUN_BY]->(:Agent)-[:DELEGATES_TO*0..]->(a) WHERE (w)-[:NEEDS]->(t)
WITH a, xid, collect(w.mode) AS modes
MATCH (x:ToolAct {id: xid})
MERGE (a)-[f3:FLOWS_TO {rule:3}]->(x) SET f3.capacity = CASE WHEN size(modes) = 0 THEN 1 WHEN 'autonomous' IN modes THEN 1000 ELSE 2 END
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
```

### `flow.edges`

Every derived FLOWS_TO edge with its rule. An acting side is named by its tool (from_id, to_id); from_key and to_key are the nodes themselves, for the walk that reads a cut off a max flow.

```cypher
MATCH (x)-[f:FLOWS_TO]->(y)
RETURN coalesce(x.of, x.id) AS from_id, CASE WHEN labels(x)[0] = 'ToolAct' THEN 'Tool' ELSE labels(x)[0] END AS from_label,
       f.rule AS rule,
       coalesce(y.of, y.id) AS to_id, CASE WHEN labels(y)[0] = 'ToolAct' THEN 'Tool' ELSE labels(y)[0] END AS to_label,
       f.capacity AS capacity, x.id AS from_key, y.id AS to_key
ORDER BY from_id, rule, to_id
```

### `flow.gated_edges`

Every GATED_FLOW edge: a hop that a gate currently blocks.

```cypher
MATCH (x)-[g:GATED_FLOW]->(y)
RETURN coalesce(x.of, x.id) AS from_id, CASE WHEN labels(x)[0] = 'ToolAct' THEN 'Tool' ELSE labels(x)[0] END AS from_label,
       g.rule AS rule, g.gate AS gate,
       coalesce(y.of, y.id) AS to_id, CASE WHEN labels(y)[0] = 'ToolAct' THEN 'Tool' ELSE labels(y)[0] END AS to_label
ORDER BY from_id, rule, to_id
```

### `graph.node_count`

The count of nodes a flow path can visit (config nodes and the acting sides of tools): the BFS depth for every verdict, and the hop limit for the evidence retry. Audit records (findings, plans, scans, runs, drafts) are not counted, so the depth does not grow with the history.

```cypher
MATCH (n) WHERE n:Agent OR n:Tool OR n:ToolAct OR n:DataSource OR n:Resource OR n:Workflow OR n:MCPServer RETURN count(n) AS nodes
```

### `reach.untrusted_to_high`

Verdict: which high-impact resources each untrusted source reaches. $max_depth must be positive: 0 returns nothing on FalkorDB 4.22 and 6.0.

```cypher
MATCH (s:DataSource {trust:'untrusted'})
CALL algo.bfs(s, $max_depth, 'FLOWS_TO') YIELD nodes
UNWIND nodes AS n
WITH s, n WHERE 'Resource' IN labels(n) AND n.impact = 'high'
RETURN s.id AS source, collect(DISTINCT n.id) AS targets
```

### `reach.untrusted_nodes`

Everything an untrusted source reaches over the flow layer: what a chart fills in. The sources themselves are not in the answer; BFS leaves its start out.

```cypher
MATCH (s:DataSource {trust:'untrusted'})
CALL algo.bfs(s, $max_depth, 'FLOWS_TO') YIELD nodes
UNWIND nodes AS n
RETURN collect(DISTINCT coalesce(n.of, n.id)) AS reached
```

### `find.trifecta`

Verdict: agents reached by untrusted and by private data that can reach an external resource.

```cypher
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
```

### `wf.broken`

Verdict: any row is something a workflow needs that the config no longer gives it. A supervised workflow can use a gated grant; an autonomous one cannot. `gated` says a grant exists but every one is gated.

```cypher
MATCH (w:Workflow)-[:RUN_BY]->(a:Agent), (w)-[:NEEDS]->(t:Tool)
OPTIONAL MATCH (a)-[:DELEGATES_TO*0..]->(:Agent)-[c:CAN_CALL]->(t)
WITH w, t, count(c) AS grants, sum(CASE WHEN c IS NOT NULL AND c.gate IS NULL THEN 1 ELSE 0 END) AS ungated
WHERE grants = 0 OR (w.mode = 'autonomous' AND ungated = 0)
RETURN w.id AS workflow, 'tool' AS kind, t.id AS missing, w.mode AS mode, grants > 0 AS gated
UNION
MATCH (w:Workflow)-[:RUN_BY]->(a:Agent), (w)-[:NEEDS_DATA]->(d:DataSource)
OPTIONAL MATCH p = (a)-[:DELEGATES_TO*0..]->(:Agent)-[:CAN_CALL]->(:Tool)-[:READS]->(d)
WITH w, d, count(p) AS ways
WHERE ways = 0
RETURN w.id AS workflow, 'data' AS kind, d.id AS missing, w.mode AS mode, false AS gated
```

### `evidence.pair_paths`

Up to $k paths between one source and one sink, fewest hops first. Never decides a verdict.

```cypher
MATCH (s {id:$source_id}), (t {id:$target_id})
CALL algo.SPpaths({sourceNode: s, targetNode: t, relTypes: ['FLOWS_TO'],
                   relDirection: 'outgoing', maxLen: $max_len, pathCount: $k})
YIELD path
WITH path ORDER BY length(path)
RETURN [n IN nodes(path) | coalesce(n.of, n.id)] AS node_ids,
       [r IN relationships(path) | r.rule] AS rules
```

### `evidence.pair_count`

How many routes there are between one source and one sink, counted up to $k. Shown beside the routes kept.

```cypher
MATCH (s {id:$source_id}), (t {id:$target_id})
CALL algo.SPpaths({sourceNode: s, targetNode: t, relTypes: ['FLOWS_TO'],
                   relDirection: 'outgoing', maxLen: $max_len, pathCount: $k})
YIELD path
RETURN count(path) AS routes
```

### `reach.into`

Everything from which $id can be reached over the flow layer: one BFS from each node, kept where the node reaches the target. Answers 'what can reach X?' without a model.

```cypher
MATCH (n) WHERE (n:Agent OR n:Tool OR n:ToolAct OR n:DataSource OR n:Resource) AND n.id <> $id AND (n.of IS NULL OR n.of <> $id)
CALL algo.bfs(n, $max_depth, 'FLOWS_TO') YIELD nodes
WITH n, nodes WHERE any(x IN nodes WHERE x.id = $id OR x.of = $id)
RETURN collect(DISTINCT coalesce(n.of, n.id)) AS reaching
```

### `reach.from`

Everything $id reaches over the flow layer, both sides of a tool together. Answers 'what does X reach?' without a model.

```cypher
MATCH (n) WHERE n.id = $id OR n.of = $id
CALL algo.bfs(n, $max_depth, 'FLOWS_TO') YIELD nodes
UNWIND nodes AS x
RETURN collect(DISTINCT coalesce(x.of, x.id)) AS reached
```

### `wf.needing`

The workflows that need a tool or a data source, with who runs them. Answers 'which workflows need X?'.

```cypher
MATCH (w:Workflow)-[r]->(x {id:$id}) WHERE type(r) IN ['NEEDS', 'NEEDS_DATA']
OPTIONAL MATCH (w)-[:RUN_BY]->(a:Agent)
RETURN w.id AS workflow, w.name AS name, w.mode AS mode, a.id AS run_by, type(r) AS how
ORDER BY w.id
```

### `node.names`

Display names for the nodes that can appear on a path, and for the servers a drift finding names.

```cypher
MATCH (n) WHERE n:Agent OR n:Tool OR n:DataSource OR n:Resource OR n:MCPServer
RETURN n.id AS id, labels(n)[0] AS label, n.name AS name, n.server_id AS server_id, n.capability AS capability
```

### `choke.betweenness`

Display only: betweenness centrality of agents and tools on the flow layer, fixed seed.

```cypher
CALL algo.betweenness({nodeLabels: ['DataSource','Tool','ToolAct','Agent','Resource'],
                       relationshipTypes: ['FLOWS_TO'], samplingSize: 64, samplingSeed: 42})
YIELD node, score
WITH node, score WHERE 'Agent' IN labels(node) OR 'Tool' IN labels(node) OR 'ToolAct' IN labels(node)
WITH coalesce(node.of, node.id) AS id, node.name AS name,
     CASE WHEN 'Agent' IN labels(node) THEN 'Agent' ELSE 'Tool' END AS label, sum(score) AS score
RETURN id, name, label, score ORDER BY score DESC LIMIT 5
```

### `choke.maxflow`

Max flow from every untrusted source to every high-impact resource over the flow layer, where an edge's capacity is the cost of the cheapest fix that cuts it. Its value is the cost of the cheapest cut; the cut itself is read off the flows. A guide for the agent, never a verdict.

```cypher
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
```

### `zones.wcc`

Trust zones: weakly connected components of the flow layer.

```cypher
CALL algo.WCC({nodeLabels: ['DataSource','Tool','ToolAct','Agent','Resource'], relationshipTypes: ['FLOWS_TO']})
YIELD node, componentId
RETURN componentId AS component_id, collect(DISTINCT coalesce(node.of, node.id)) AS members,
       sum(CASE WHEN node.trust = 'untrusted' THEN 1 ELSE 0 END) > 0 AS has_untrusted,
       sum(CASE WHEN node.impact = 'high' THEN 1 ELSE 0 END) > 0 AS has_high_impact
```

### `zones.communities`

Communities of the config graph by label propagation: which agents, tools, sources and resources hang together. A community is a blast community when it holds an untrusted source and a high-impact resource.

```cypher
CALL algo.labelPropagation({nodeLabels: ['DataSource','Tool','Agent','Resource'],
                            relationshipTypes: ['CAN_CALL','DELEGATES_TO','READS','WRITES','FEEDS'], maxIterations: 50})
YIELD node, communityId
RETURN communityId AS component_id, collect(node.id) AS members,
       sum(CASE WHEN node.trust = 'untrusted' THEN 1 ELSE 0 END) > 0 AS has_untrusted,
       sum(CASE WHEN node.impact = 'high' THEN 1 ELSE 0 END) > 0 AS has_high_impact
```

### `choke.pagerank`

PageRank over the flow layer: how much of what flows ends up passing through each node. A tool's two sides are summed. Context for a person; no verdict rests on it.

```cypher
CALL algo.pageRank(null, 'FLOWS_TO') YIELD node, score
WITH coalesce(node.of, node.id) AS id, sum(score) AS score
RETURN id, score ORDER BY score DESC, id
```

### `reach.agents_from_sources`

For each agent, the data sources of one trust level whose content reaches it: one BFS per source. Property A (untrusted) and property B (private) of the Rule of Two.

```cypher
MATCH (s:DataSource {trust: $trust})
CALL algo.bfs(s, $max_depth, 'FLOWS_TO') YIELD nodes
UNWIND nodes AS n
WITH s, n WHERE 'Agent' IN labels(n)
RETURN n.id AS agent, collect(DISTINCT s.id) AS sources
```

### `agent.acts_on`

For each agent, the resources it can act on, with whether any is external or high-impact: one BFS per agent. Property C of the Rule of Two.

```cypher
MATCH (a:Agent)
CALL algo.bfs(a, $max_depth, 'FLOWS_TO') YIELD nodes
UNWIND nodes AS n
WITH a, n WHERE 'Resource' IN labels(n)
RETURN a.id AS agent, collect(DISTINCT n.id) AS resources,
       sum(CASE WHEN n.external THEN 1 ELSE 0 END) > 0 AS external,
       sum(CASE WHEN n.impact = 'high' THEN 1 ELSE 0 END) > 0 AS high_impact
```

### `finding.upsert`

Create or update a finding by fingerprint; a mitigated or closed finding that holds again reopens.

```cypher
MERGE (f:Finding {fingerprint: $fingerprint})
ON CREATE SET f.id = $id, f.kind = $kind, f.status = 'open', f.created_at = $now
WITH f, f.status IN ['mitigated', 'closed'] AS reopen
SET f.severity = $severity, f.source_id = $source_id, f.target_id = $target_id, f.agent_id = $agent_id,
    f.path_ids = $path_ids, f.evidence_json = $evidence_json, f.updated_at = $now,
    f.status = CASE WHEN reopen THEN 'open' ELSE f.status END,
    f.reopened_at = CASE WHEN reopen THEN $now ELSE f.reopened_at END
RETURN f.id AS id, f.status AS status, f.created_at AS created_at, reopen AS reopened
```

### `finding.clear_via`

Drop a finding's VIA edges before they are rewritten.

```cypher
MATCH (:Finding {fingerprint: $fingerprint})-[v:VIA]->()
DELETE v
RETURN count(*) AS removed
```

### `finding.set_via`

Link a finding to the nodes of its evidence path, in order.

```cypher
MATCH (f:Finding {fingerprint: $fingerprint})
UNWIND range(0, size($path_ids) - 1) AS i
WITH f, i, $path_ids[i] AS node_id
MATCH (n {id: node_id})
CREATE (f)-[:VIA {i: i}]->(n)
RETURN count(*) AS linked
```

### `finding.close_stale`

Close open findings whose fact no longer holds: mitigated if an applied mitigation fixes them.

```cypher
MATCH (f:Finding {status: 'open'}) WHERE NOT f.fingerprint IN $present
OPTIONAL MATCH (m:Mitigation {status: 'applied'})-[:FIXES]->(f)
WITH f, count(m) AS fixes
SET f.status = CASE WHEN fixes > 0 THEN 'mitigated' ELSE 'closed' END, f.updated_at = $now
RETURN f.fingerprint AS fingerprint, f.status AS status
```

### `drift.before`

Each server's manifest hash and the hash of every part of each of its tools, as loaded last time. Read before a reload, compared after it: a changed manifest is a drift finding.

```cypher
MATCH (s:MCPServer)
OPTIONAL MATCH (t:Tool)-[:PROVIDED_BY]->(s)
RETURN s.id AS server_id, s.manifest_hash AS manifest_hash,
       collect({id: t.id, description: t.h_description, schema: t.h_schema, annotations: t.h_annotations}) AS tools
```

### `finding.accept`

A person accepts an open finding as it is: it stays, marked accepted, and no scan reopens it. No row means the finding was not open.

```cypher
MATCH (f:Finding {id: $id}) WHERE f.status = 'open'
SET f.status = 'accepted', f.accepted_by = $who, f.accepted_session = $session, f.updated_at = $now
RETURN f.id AS id, f.status AS status
```

### `finding.list`

All findings stored in a working graph.

```cypher
MATCH (f:Finding)
RETURN f.id AS id, f.fingerprint AS fingerprint, f.kind AS kind, f.severity AS severity, f.status AS status,
       f.source_id AS source_id, f.target_id AS target_id, f.agent_id AS agent_id,
       f.evidence_json AS evidence_json, f.created_at AS created_at, f.updated_at AS updated_at,
       f.reopened_at AS reopened_at, f.accepted_by AS accepted_by
ORDER BY f.created_at, f.id
```

### `finding.via`

The VIA path of one finding, in order.

```cypher
MATCH (:Finding {fingerprint: $fingerprint})-[v:VIA]->(n)
RETURN v.i AS i, n.id AS id ORDER BY i
```

### `scenario.summary`

Node and open-finding counts for the scenario list.

```cypher
MATCH (n) WHERE NOT n:Finding AND NOT n:Mitigation AND NOT n:Scan AND NOT n:ToolAct AND NOT n:Draft AND NOT n:Run
WITH count(n) AS nodes
OPTIONAL MATCH (f:Finding {status: 'open'})
RETURN nodes, count(f) AS open_findings
```

### `scan.record`

Remember the last scan of a working graph: when it ran, how long it took and what it found.

```cypher
MERGE (s:Scan {id: 'last'})
SET s.scan_id = $scan_id, s.at = $at, s.duration_ms = $duration_ms,
    s.injection = $injection, s.trifecta = $trifecta, s.partial = $partial
RETURN s.at AS at
```

### `scan.last`

The last scan of a working graph, if there has been one.

```cypher
MATCH (s:Scan {id: 'last'})
RETURN s.scan_id AS scan_id, s.at AS at, s.duration_ms AS duration_ms,
       s.injection AS injection, s.trifecta AS trifecta, s.partial AS partial
```

### `scan.keep`

Keep one Scan node per scan, beside the 'last' record: when it ran, how long it took, what it found and how many findings were open afterwards. The history a posture page draws over time.

```cypher
MERGE (s:Scan {id: $scan_id})
SET s.scan_id = $scan_id, s.at = $at, s.duration_ms = $duration_ms,
    s.injection = $injection, s.trifecta = $trifecta, s.open = $open, s.partial = $partial
RETURN s.at AS at
```

### `scan.prune`

Delete the Scan nodes beyond the newest $keep, so the history a graph holds stays bounded.

```cypher
MATCH (s:Scan) WHERE s.id <> 'last'
WITH s ORDER BY s.at DESC SKIP $keep
DELETE s
RETURN count(*) AS removed
```

### `scan.history`

The last 50 scans of a working graph, newest first. A graph loaded before scans were kept has none.

```cypher
MATCH (s:Scan) WHERE s.id <> 'last'
RETURN s.scan_id AS scan_id, s.at AS at, s.duration_ms AS duration_ms,
       s.injection AS injection, s.trifecta AS trifecta, s.open AS open, s.partial AS partial
ORDER BY s.at DESC LIMIT 50
```

### `run.record`

Keep an auditor run on the graph it worked on, as one node holding the whole record as JSON: every step, who took it and why. Written as the run moves, so a restart loses nothing a person saw.

```cypher
MERGE (r:Run {id: $id})
SET r.kind = $kind, r.status = $status, r.started_at = $started_at, r.json = $json
RETURN r.id AS id
```

### `run.list`

Every run kept on a working graph, oldest first.

```cypher
MATCH (r:Run)
RETURN r.id AS id, r.kind AS kind, r.status AS status, r.started_at AS started_at, r.json AS json
ORDER BY r.started_at, r.id
```

### `ingest.servers`

Upsert MCP servers.

```cypher
UNWIND $rows AS row
MERGE (n:MCPServer {id: row.id})
SET n.name = row.name, n.source_url = row.source_url, n.synthetic = row.synthetic, n.manifest_hash = row.manifest_hash
RETURN count(n) AS written
```

### `ingest.tools`

Upsert tools and tie each to its server.

```cypher
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
```

### `ingest.data_sources`

Upsert data sources with their trust level.

```cypher
UNWIND $rows AS row
MERGE (n:DataSource {id: row.id})
SET n.name = row.name, n.trust = row.trust
RETURN count(n) AS written
```

### `ingest.resources`

Upsert resources with their impact and whether they leave the organisation.

```cypher
UNWIND $rows AS row
MERGE (n:Resource {id: row.id})
SET n.name = row.name, n.impact = row.impact, n.external = row.external
RETURN count(n) AS written
```

### `ingest.agents`

Upsert agents.

```cypher
UNWIND $rows AS row
MERGE (n:Agent {id: row.id})
SET n.name = row.name, n.owner = row.owner
RETURN count(n) AS written
```

### `ingest.workflows`

Upsert workflows with their mode.

```cypher
UNWIND $rows AS row
MERGE (n:Workflow {id: row.id})
SET n.name = row.name, n.description = row.description, n.mode = row.mode
RETURN count(n) AS written
```

### `ingest.can_call`

Upsert grants: which agent may call which tool, and whether a person must approve.

```cypher
UNWIND $rows AS row
MATCH (a:Agent {id: row.from_id}), (t:Tool {id: row.to_id})
MERGE (a)-[c:CAN_CALL]->(t)
SET c.gate = row.gate, c.origin = row.origin
RETURN count(c) AS written
```

### `ingest.delegates_to`

Upsert delegations between agents, and whether results come back quarantined.

```cypher
UNWIND $rows AS row
MATCH (a:Agent {id: row.from_id}), (b:Agent {id: row.to_id})
MERGE (a)-[d:DELEGATES_TO]->(b)
SET d.gate = row.gate, d.origin = row.origin
RETURN count(d) AS written
```

### `ingest.reads`

Upsert which data sources a tool reads.

```cypher
UNWIND $rows AS row
MATCH (t:Tool {id: row.from_id}), (d:DataSource {id: row.to_id})
MERGE (t)-[r:READS]->(d)
RETURN count(r) AS written
```

### `ingest.writes`

Upsert which resources a tool acts on.

```cypher
UNWIND $rows AS row
MATCH (t:Tool {id: row.from_id}), (r:Resource {id: row.to_id})
MERGE (t)-[w:WRITES]->(r)
RETURN count(w) AS written
```

### `ingest.feeds`

Upsert which data sources a resource feeds: what is written there is read back from here (rule 7).

```cypher
UNWIND $rows AS row
MATCH (r:Resource {id: row.from_id}), (d:DataSource {id: row.to_id})
MERGE (r)-[f:FEEDS]->(d)
RETURN count(f) AS written
```

### `ingest.run_by`

Upsert which agent runs a workflow.

```cypher
UNWIND $rows AS row
MATCH (w:Workflow {id: row.from_id}), (a:Agent {id: row.to_id})
MERGE (w)-[r:RUN_BY]->(a)
RETURN count(r) AS written
```

### `ingest.needs`

Upsert the tools a workflow must be able to call.

```cypher
UNWIND $rows AS row
MATCH (w:Workflow {id: row.from_id}), (t:Tool {id: row.to_id})
MERGE (w)-[r:NEEDS]->(t)
RETURN count(r) AS written
```

### `ingest.needs_data`

Upsert the data sources a workflow must still be able to read.

```cypher
UNWIND $rows AS row
MATCH (w:Workflow {id: row.from_id}), (d:DataSource {id: row.to_id})
MERGE (w)-[r:NEEDS_DATA]->(d)
RETURN count(r) AS written
```

### `fix.gate_call`

Fix: a person must approve each call of this tool by this agent. Cuts the rule-3 hop.

```cypher
MATCH (:Agent {id:$agent_id})-[c:CAN_CALL]->(:Tool {id:$tool_id})
WHERE c.gate IS NULL
SET c.gate = 'human_approval', c.origin = 'fix'
RETURN count(c) AS changed
```

### `fix.revoke_call`

Fix: the agent loses the grant. Cuts the rule-2 and rule-3 hops through it.

```cypher
MATCH (:Agent {id:$agent_id})-[c:CAN_CALL]->(:Tool {id:$tool_id})
DELETE c
RETURN count(*) AS changed
```

### `fix.quarantine_delegation`

Fix: the delegate returns only structured fields to its delegator. Cuts the rule-6 hop.

```cypher
MATCH (:Agent {id:$from_agent_id})-[d:DELEGATES_TO]->(:Agent {id:$to_agent_id})
WHERE d.gate IS NULL
SET d.gate = 'quarantine', d.origin = 'fix'
RETURN count(d) AS changed
```

### `fix.drop_read`

Fix: the tool stops reading this data source. Cuts the rule-1 hop.

```cypher
MATCH (:Tool {id:$tool_id})-[r:READS]->(:DataSource {id:$source_id})
DELETE r
RETURN count(*) AS changed
```

### `fix.split_agent`

Fix: the agent keeps its acting tools and delegates these reading tools to a new reader, quarantined. What the reader reads can no longer return to the agent (rule 6 is gated). It changes nothing unless the agent holds every one of the tools and has no reader yet.

```cypher
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
```

### `whatif.drop_server`

What-if: the server is removed, so every grant to its tools goes. Sandbox only: a question, never a fix.

```cypher
MATCH (:Agent)-[c:CAN_CALL]->(:Tool)-[:PROVIDED_BY]->(:MCPServer {id:$server_id})
DELETE c
RETURN count(*) AS changed
```

### `whatif.grant_call`

What-if: give an agent a tool it does not have. Sandbox only.

```cypher
MATCH (a:Agent {id:$agent_id}), (t:Tool {id:$tool_id})
WHERE NOT (a)-[:CAN_CALL]->(t)
CREATE (a)-[c:CAN_CALL {origin:'whatif'}]->(t)
RETURN count(c) AS changed
```

### `whatif.add_delegation`

What-if: let one agent delegate to another. Sandbox only.

```cypher
MATCH (a:Agent {id:$from_agent_id}), (b:Agent {id:$to_agent_id})
WHERE NOT (a)-[:DELEGATES_TO]->(b)
CREATE (a)-[d:DELEGATES_TO {origin:'whatif'}]->(b)
RETURN count(d) AS changed
```

### `config.edges`

Every config edge with its gate: input to the config hash, and to clone by query.

```cypher
MATCH (a)-[e]->(b)
WHERE type(e) IN ['CAN_CALL', 'DELEGATES_TO', 'READS', 'WRITES', 'FEEDS', 'RUN_BY', 'NEEDS', 'NEEDS_DATA', 'PROVIDED_BY']
RETURN type(e) AS rel, a.id AS from_id, b.id AS to_id, e.gate AS gate, e.origin AS origin
ORDER BY rel, from_id, to_id
```

### `config.nodes`

Every config node with the facts findings depend on: input to the config hash, and to clone by query.

```cypher
MATCH (n) WHERE n:Agent OR n:Tool OR n:DataSource OR n:Resource OR n:Workflow OR n:MCPServer
RETURN labels(n)[0] AS label, n.id AS id, n.name AS name, n.trust AS trust, n.impact AS impact,
       n.external AS external, n.mode AS mode, n.owner AS owner, n.server_id AS server_id,
       n.description AS description, n.capability AS capability, n.capability_source AS capability_source,
       n.source_url AS source_url, n.synthetic AS synthetic
ORDER BY label, id
```

### `mitigation.record`

Store a plan with its sandbox verdict. The same plan for the same targets is the same node. An approved or rejected plan keeps its status; an applied one whose findings are open again is a proposal again.

```cypher
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
```

### `mitigation.set_status`

Move a mitigation from one of the allowed statuses to a new one; no row means it was not in one of them. A decision records who made it and a hash of the session it came from.

```cypher
MATCH (m:Mitigation {id: $id}) WHERE m.status IN $allowed
SET m.status = $status, m.updated_at = $now,
    m.approved_by = CASE WHEN $approved_by IS NULL THEN m.approved_by ELSE $approved_by END,
    m.approved_session = CASE WHEN $approved_session IS NULL THEN m.approved_session ELSE $approved_session END,
    m.applied_at = CASE WHEN $applied_at IS NULL THEN m.applied_at ELSE $applied_at END,
    m.decision_reason = CASE WHEN $decision_reason IS NULL THEN m.decision_reason ELSE $decision_reason END
RETURN m.id AS id, m.status AS status
```

### `mitigation.get`

One mitigation with its plan and verdict.

```cypher
MATCH (m:Mitigation {id: $id})
RETURN m.id AS id, m.status AS status, m.fix_json AS fix_json, m.cost AS cost, m.config_hash AS config_hash,
       m.target_fingerprints AS target_fingerprints, m.verdict_json AS verdict_json, m.passed AS passed,
       m.reason AS reason, m.rationale AS rationale, m.source AS source, m.approved_by AS approved_by,
       m.approved_session AS approved_session, m.applied_fixes AS applied_fixes,
       m.decision_reason AS decision_reason, m.created_at AS created_at, m.applied_at AS applied_at,
       m.updated_at AS updated_at
```

### `mitigation.progress`

How many of an approved plan's fixes have been applied so far. Written after each fix, so a process that dies mid-plan leaves a plan the next apply can finish instead of one it can never apply.

```cypher
MATCH (m:Mitigation {id: $id})
SET m.applied_fixes = $n, m.updated_at = $now
RETURN m.id AS id, m.applied_fixes AS applied_fixes
```

### `mitigation.list`

Every mitigation stored in a working graph, newest first.

```cypher
MATCH (m:Mitigation)
RETURN m.id AS id, m.status AS status, m.fix_json AS fix_json, m.cost AS cost, m.config_hash AS config_hash,
       m.target_fingerprints AS target_fingerprints, m.verdict_json AS verdict_json, m.passed AS passed,
       m.reason AS reason, m.rationale AS rationale, m.source AS source, m.approved_by AS approved_by,
       m.approved_session AS approved_session, m.applied_fixes AS applied_fixes,
       m.decision_reason AS decision_reason, m.created_at AS created_at, m.applied_at AS applied_at,
       m.updated_at AS updated_at
ORDER BY m.created_at DESC, m.id
```

### `mitigation.link_fixes`

Tie an applied mitigation to the findings it resolved, so a rescan closes them as mitigated.

```cypher
MATCH (m:Mitigation {id: $id})
UNWIND $fingerprints AS fingerprint
MATCH (f:Finding {fingerprint: fingerprint})
MERGE (m)-[:FIXES]->(f)
RETURN count(f) AS linked
```

### `ui.nodes`

Nodes for a chart.

```cypher
MATCH (n) WHERE n:Agent OR n:Tool OR n:DataSource OR n:Resource
RETURN ID(n) AS nid, labels(n)[0] AS label, n.id AS id, n.name AS name, n.trust AS trust, n.impact AS impact,
       n.external AS external, n.owner AS owner, n.capability AS capability, n.server_id AS server_id
ORDER BY nid
```

### `ui.links`

Links for a chart: the derived flow layer or the config layer, chosen by $types. An acting side is named by its tool.

```cypher
MATCH (a)-[e]->(b)
WHERE type(e) IN $types AND (a:Agent OR a:Tool OR a:ToolAct OR a:DataSource OR a:Resource)
                        AND (b:Agent OR b:Tool OR b:ToolAct OR b:DataSource OR b:Resource)
RETURN ID(e) AS lid, type(e) AS rel, coalesce(a.of, a.id) AS from_id, coalesce(b.of, b.id) AS to_id,
       e.rule AS rule, e.gate AS gate
ORDER BY lid
```

### `inventory.rows`

Every agent, tool, data source and resource with its config-side counts in one pass: grants held and how many are gated, grants on a tool and how many are gated, delegations, what a tool reads and acts on, what reads a source, what acts on a resource, and the workflows an agent runs. Each relationship is counted in its own step, so one kind never multiplies another.

```cypher
MATCH (n) WHERE n:Agent OR n:Tool OR n:DataSource OR n:Resource
OPTIONAL MATCH (n)-[g:CAN_CALL]->(:Tool)
WITH n, count(g) AS grants, toInteger(sum(CASE WHEN g.gate IS NULL THEN 0 ELSE 1 END)) AS gated_grants
OPTIONAL MATCH (:Agent)-[h:CAN_CALL]->(n)
WITH n, grants, gated_grants, count(h) AS held_by, toInteger(sum(CASE WHEN h.gate IS NULL THEN 0 ELSE 1 END)) AS gated_holds
OPTIONAL MATCH (n)-[d:DELEGATES_TO]->(:Agent)
WITH n, grants, gated_grants, held_by, gated_holds, count(d) AS delegates_to
OPTIONAL MATCH (n)-[r:READS]->(:DataSource)
WITH n, grants, gated_grants, held_by, gated_holds, delegates_to, count(r) AS reads
OPTIONAL MATCH (n)-[w:WRITES]->(:Resource)
WITH n, grants, gated_grants, held_by, gated_holds, delegates_to, reads, count(w) AS acts_on
OPTIONAL MATCH (:Tool)-[rb:READS]->(n)
WITH n, grants, gated_grants, held_by, gated_holds, delegates_to, reads, acts_on, count(rb) AS read_by
OPTIONAL MATCH (:Tool)-[wb:WRITES]->(n)
WITH n, grants, gated_grants, held_by, gated_holds, delegates_to, reads, acts_on, read_by, count(wb) AS acted_on_by
OPTIONAL MATCH (wf:Workflow)-[:RUN_BY]->(n)
RETURN labels(n)[0] AS label, n.id AS id, n.name AS name, n.owner AS owner, n.trust AS trust, n.impact AS impact,
       n.external AS external, n.server_id AS server_id, n.capability AS capability,
       grants, gated_grants, held_by, gated_holds, delegates_to, reads, acts_on, read_by, acted_on_by, count(wf) AS workflows
ORDER BY label, id
```

### `server.summary`

Each MCP server with its tools, the agents that hold them, and the findings whose paths run through them.

```cypher
MATCH (s:MCPServer)
OPTIONAL MATCH (t:Tool)-[:PROVIDED_BY]->(s)
OPTIONAL MATCH (a:Agent)-[:CAN_CALL]->(t)
OPTIONAL MATCH (f:Finding)-[:VIA]->(t) WHERE f.status IN ['open', 'accepted']
RETURN s.id AS id, s.name AS name, s.source_url AS source_url, s.synthetic AS synthetic, s.manifest_hash AS manifest_hash,
       collect(DISTINCT t.id) AS tools, collect(DISTINCT a.id) AS agents, collect(DISTINCT f.id) AS findings
ORDER BY id
```

### `ui.workflows`

Workflows with who runs them and what they need: what a fix must not break.

```cypher
MATCH (w:Workflow)-[:RUN_BY]->(a:Agent)
OPTIONAL MATCH (w)-[:NEEDS]->(t:Tool)
WITH w, a, collect(DISTINCT t.id) AS needs
OPTIONAL MATCH (w)-[:NEEDS_DATA]->(d:DataSource)
RETURN w.id AS id, w.name AS name, w.description AS description, w.mode AS mode, a.id AS run_by,
       needs, collect(DISTINCT d.id) AS reads
ORDER BY id
```

### `overview.counts`

The counts the one-picture overview opens with: sources by trust, agents, tools, resources by impact and whether they leave the organisation, workflows. One pass over the config nodes.

```cypher
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
```

### `draft.record`

Store a plan compiled into the change it makes to the configuration it was imported from: the text that would be written, a diff a person can read, and a note on what the target can and cannot express. One draft per plan and target; a person's edit replaces the text.

```cypher
MATCH (m:Mitigation {id: $mitigation_id})
MERGE (d:Draft {id: $id})
ON CREATE SET d.created_at = $now, d.status = 'drafted'
SET d.kind = $kind, d.path = $path, d.before_hash = $before_hash, d.after_hash = $after_hash, d.diff = $diff,
    d.note = $note, d.commands_json = $commands_json, d.after_text = $after_text, d.writable = $writable,
    d.edited = $edited, d.updated_at = $now
MERGE (m)-[:DRAFTS]->(d)
RETURN d.id AS id, d.status AS status
```

### `draft.for_mitigation`

The drafts of one plan, with their status and the receipt of a write, if there was one.

```cypher
MATCH (:Mitigation {id: $mitigation_id})-[:DRAFTS]->(d:Draft)
RETURN d.id AS id, d.status AS status, d.kind AS kind, d.path AS path, d.before_hash AS before_hash, d.after_hash AS after_hash,
       d.diff AS diff, d.note AS note, d.commands_json AS commands_json, d.after_text AS after_text, d.writable AS writable,
       d.edited AS edited, d.created_at AS created_at, d.updated_at AS updated_at,
       d.written_at AS written_at, d.written_by AS written_by, d.receipt_json AS receipt_json
ORDER BY d.created_at
```

### `draft.list`

Every draft on a working graph with the plan it belongs to, for the activity list: one query, not one per plan.

```cypher
MATCH (m:Mitigation)-[:DRAFTS]->(d:Draft)
RETURN m.id AS mitigation_id, d.id AS id, d.status AS status, d.kind AS kind, d.path AS path, d.written_at AS written_at,
       d.written_by AS written_by, d.receipt_json AS receipt_json
ORDER BY d.created_at
```

### `draft.set_written`

Record that a person wrote a draft to its file: who, when, and the receipt (hashes before and after, what the rescan found). The one write to a person's file DeVries makes, and it is recorded here.

```cypher
MATCH (d:Draft {id: $id})
SET d.status = $status, d.written_at = $written_at, d.written_by = $written_by, d.receipt_json = $receipt_json, d.updated_at = $written_at
RETURN d.id AS id, d.status AS status
```

### `canary.build`

A built-in graph with one known injection down a 16-hop chain and one known trifecta agent.

```cypher
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
```

