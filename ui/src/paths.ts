// A finding as paths, and what of the graph it lights up.

import type { Finding, Graph, GraphLink, GraphNode, Mitigation, Path } from "./api";

/** The evidence of a finding as paths: every route of an injection, or the three legs of a trifecta. */
export function pathsOf(finding: Finding): { label: string; path: Path }[] {
  if (finding.kind === "injection") {
    return (finding.paths ?? []).map((path, i) => ({ label: `Path ${i + 1}`, path }));
  }
  const legs = finding.legs;
  return [
    { label: "Untrusted input reaches the agent", path: legs?.untrusted_in },
    { label: "Private data reaches the agent", path: legs?.private_in },
    { label: "The agent can reach a way out", path: legs?.exit_out },
  ].filter((leg): leg is { label: string; path: Path } => !!leg.path);
}

export const hopKey = (a: string, b: string) => `${a}>${b}`;
const hopsOfPath = (path: Path) => path.node_ids.slice(0, -1).map((a, i) => hopKey(a, path.node_ids[i + 1]));

/** Every node id on any path of a finding. */
export function nodesOn(finding: Finding): Set<string> {
  return new Set(pathsOf(finding).flatMap((p) => p.path.node_ids));
}

/** The live flow links by "from>to": what the graph says about a hop right now. */
export function linkIndex(flow: Graph | undefined): Map<string, GraphLink> {
  return new Map((flow?.links ?? []).map((l) => [hopKey(l.data.from_id, l.data.to_id), l]));
}

export function nodeIndex(graph: Graph | undefined): Map<string, GraphNode> {
  return new Map((graph?.nodes ?? []).map((n) => [n.data.id, n]));
}

/** Which line of a chart a hop belongs to: the untrusted route, the private one, or the way out. */
export type Series = "hot" | "private" | "exit";

/** What a finding lights up on a chart: its nodes in reading order, and each of its hops with its series. */
export type Focus = { order: string[]; nodes: Set<string>; hops: Map<string, Series>; holder: string | null };

export function focusOf(finding: Finding, pathIndex = 0): Focus {
  const hops = new Map<string, Series>();
  let shown: Path[];
  if (finding.kind === "injection") {
    const all = finding.paths ?? [];
    shown = [all[pathIndex] ?? all[0]].filter(Boolean);
    shown.forEach((p) => hopsOfPath(p).forEach((h) => hops.set(h, "hot")));
  } else {
    const legs: [Path | null | undefined, Series][] = [[finding.legs?.untrusted_in, "hot"], [finding.legs?.private_in, "private"], [finding.legs?.exit_out, "exit"]];
    shown = legs.flatMap(([p]) => (p ? [p] : []));
    legs.forEach(([p, series]) => p && hopsOfPath(p).forEach((h) => hops.set(h, series)));
  }
  const order = [...new Set(shown.flatMap((p) => p.node_ids))];
  return { order, nodes: new Set(order), hops, holder: finding.kind === "trifecta" ? finding.agent_id ?? null : null };
}

/** A focus widened by the readers a plan's splits add, where the graph has them. A reader is not on the
 *  finding's path, but it is where the reading went, so a chart of the path draws it too. */
export function withReaders(focus: Focus, plan: Mitigation | null | undefined, graph: Pick<Graph, "nodes"> | null | undefined): Focus {
  const there = new Set((graph?.nodes ?? []).map((n) => n.data.id));
  const added = (plan?.plan.fixes ?? []).filter((fix) => fix.kind === "split_agent").map((fix) => `${fix.agent_id}.reader`)
    .filter((id) => there.has(id) && !focus.nodes.has(id));
  return added.length ? { ...focus, order: [...focus.order, ...added], nodes: new Set([...focus.nodes, ...added]) } : focus;
}

/** The queries a finding rests on, in the order its page lists them. */
export function findingQueries(finding: Finding): string[] {
  if (finding.kind === "drift") return ["drift.before", "finding.accept"];
  if (finding.kind === "poisoned_description") return ["ingest.tools", "finding.accept"];
  return [finding.kind === "injection" ? "reach.untrusted_to_high" : "find.trifecta", "evidence.pair_paths"];
}

/** What a node is, in a few words: the facts a footnote or a chart label carries. */
export function nodeFacts(node: GraphNode): string {
  const d = node.data;
  if (node.label === "Agent") return d.owner ? `owner ${d.owner}` : "agent";
  if (node.label === "Tool") return [d.capability && d.capability !== "unknown" ? d.capability : "capability unknown", d.server_id].filter(Boolean).join(" · ");
  if (node.label === "DataSource") return `${d.trust ?? "internal"} data`;
  return [`${d.impact ?? "low"} impact`, d.external ? "leaves the organisation" : "inside the organisation"].join(" · ");
}

export const KIND_OF: Record<GraphNode["label"], string> = { Agent: "Agent", Tool: "Tool", DataSource: "Data source", Resource: "Resource" };
