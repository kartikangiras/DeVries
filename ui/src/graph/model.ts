// What every renderer shares: which lane a node stands in, what mark it carries, and what an edge is called.
// The facts come from the API (tainted from reach.untrusted_nodes, trust, impact, gates); this file only
// reads them, so the three renderers draw the same truth.

import type { Graph, GraphLink, GraphNode } from "../api";
import { hopKey, type Focus, type Series } from "../paths";

export const LANES = ["Data sources", "Tools that read", "Delegates", "Agents", "Tools that act", "Resources"] as const;

/** Which lane each node stands in, left to right, read off the graph's own edges. */
export function lanesOf(graph: Graph): Map<string, number> {
  const byId = new Map(graph.nodes.map((n) => [n.data.id, n]));
  const touches = (id: string, label: GraphNode["label"]) =>
    graph.links.some((l) => (l.data.from_id === id && byId.get(l.data.to_id)?.label === label) || (l.data.to_id === id && byId.get(l.data.from_id)?.label === label));
  // a delegate is an agent another agent hands work to: the target of DELEGATES_TO, or of a rule-4 hop
  const delegates = new Set<string>();
  for (const l of graph.links) {
    if (l.rel === "DELEGATES_TO" || l.data.rule === 4) delegates.add(l.data.to_id);
  }
  const lanes = new Map<string, number>();
  for (const n of graph.nodes) {
    const id = n.data.id;
    let lane = 3;
    if (n.label === "DataSource") lane = 0;
    else if (n.label === "Resource") lane = 5;
    else if (n.label === "Agent") lane = delegates.has(id) && !graph.links.some((l) => l.data.from_id === id && byId.get(l.data.to_id)?.label === "Agent" && delegates.has(l.data.to_id)) ? 2 : 3;
    else lane = touches(id, "DataSource") ? 1 : touches(id, "Resource") ? 4 : 1;
    lanes.set(id, lane);
  }
  return lanes;
}

/** The mark a node carries: untrusted text reaches it (hot), it is private data, or neither. */
export function markOf(node: GraphNode): "hot" | "private" | "plain" {
  if (node.data.tainted) return "hot";
  if (node.label === "DataSource" && node.data.trust === "private") return "private";
  return "plain";
}

/** One line under a name: what the node is, in the scenario's own words. */
export function factOf(node: GraphNode): string {
  const d = node.data;
  switch (node.label) {
    case "DataSource": return d.trust ?? "";
    case "Resource": return [d.impact ? `${d.impact} impact` : "", d.external ? "external" : ""].filter(Boolean).join(" · ");
    case "Agent": return d.owner ? d.owner : "";
    default: return d.server_id ? d.server_id.replace(/^srv:/, "") : d.capability ?? "";
  }
}

export type EdgeFacts = { key: string; rule: number | null; rel: string; sentence: string; gated: boolean; gate: string | null; series: Series | null; onFocus: boolean };

/** What an edge means, and whether a finding's focus runs along it. */
export function edgeFacts(link: GraphLink, focus?: Focus | null): EdgeFacts {
  const key = hopKey(link.data.from_id, link.data.to_id);
  const series = focus?.hops.get(key) ?? null;
  return {
    key, rule: link.data.rule, rel: link.rel, sentence: link.data.sentence.replace(/^(blocked by \w+: )?(rule \d+: )?/, ""),
    gated: link.rel === "GATED_FLOW" || !!link.data.gate, gate: link.data.gate, series, onFocus: !!series,
  };
}

/** The label an edge wears: the rule number on the flow layer, the relation on the config layer. */
export function edgeWord(link: GraphLink): string {
  if (link.data.rule != null) return `rule ${link.data.rule}`;
  return { CAN_CALL: "can call", DELEGATES_TO: "delegates to", READS: "reads", WRITES: "acts on", FEEDS: "feeds" }[link.rel] ?? link.rel.toLowerCase();
}
