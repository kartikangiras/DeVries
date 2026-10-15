// The words of a finding's brief. Every sentence is put together here from what the graph returned:
// ids stay in the text, and the page shows them as names with a footnote each. No model writes any of it.

import type { Finding, Graph, GraphLink, Mitigation } from "./api";
import { hopKey, linkIndex, nodeIndex, pathsOf } from "./paths";
import { capital, plural } from "./text";

/** A finding's two-part headline: who it is about, and the line that says what is wrong. */
export function headline(finding: Finding, names: Record<string, string>): { title: string; line: string } {
  const name = (id?: string) => (id ? names[id] ?? id : "?");
  if (finding.kind === "injection") return { title: name(finding.source_id), line: `can reach ${name(finding.target_id)}.` };
  if (finding.kind === "drift") return { title: name(finding.server_id), line: "changed its tool definitions." };
  if (finding.kind === "poisoned_description") return { title: name(finding.tool_id), line: "carries instructions in its description." };
  return { title: name(finding.agent_id), line: "holds untrusted input, private data and a way out." };
}

/** One hop as a clause, by the rule that derived it. `a` is where the flow comes from, `b` where it goes. */
const HOP: Record<number, (a: string, b: string) => string> = {
  1: (_, b) => `${b} reads it`,
  2: (a, b) => `what ${a} returns enters the context of ${b}`,
  3: (a, b) => `${a} can call ${b}`,
  4: (a, b) => `${a} passes its context down to ${b}`,
  5: (a, b) => `${a} acts on ${b}`,
  6: (a, b) => `${a} returns its results to ${b}`,
  7: (a, b) => `what is written to ${a} is read back from ${b}`,
};

/** Meta's Rule of Two, said once on a trifecta's brief: all three properties in one agent. */
export const RULE_OF_TWO = "That is all three properties of Meta's Agents Rule of Two in one context, which the rule says must not run unattended.";

/** The first hop of a finding that a gate blocks now, if any: where a fix cut it. */
export function blockedHop(finding: Finding, flow: Graph | undefined): GraphLink | null {
  const live = linkIndex(flow);
  for (const { path } of pathsOf(finding)) {
    for (let i = 0; i < path.node_ids.length - 1; i++) {
      const link = live.get(hopKey(path.node_ids[i], path.node_ids[i + 1]));
      if (link?.rel === "GATED_FLOW") return link;
    }
  }
  return null;
}

const gateWords = (gate: string | null | undefined) => (gate === "quarantine" ? "a quarantine" : "an approval gate");

/** The brief's paragraph, with ids in it. */
/** How many tools a drift finding touches. */
export function driftCount(finding: Finding): number {
  const d = finding.drift;
  return d ? d.added.length + d.removed.length + Object.keys(d.changed).length : 0;
}

export function tldr(finding: Finding, flow: Graph | undefined): string {
  if (finding.kind === "poisoned_description") {
    const flags = finding.flags ?? [];
    const kinds = [...new Set(flags.map((f) => f.detail))];
    const head = `The description of ${finding.tool_id} is not only a description: it ${kinds.join("; it ")}.`;
    const why = " A tool description reaches the model with every call, so text in it that reads as an instruction is a prompt injection planted by whoever wrote the manifest, which the scanners call tool poisoning. DeVries already shows descriptions to the model inside an untrusted block; this is the first time it tells a person.";
    const path = finding.severity === "high" ? " The tool sits on an open finding's path, which is why this is high." : "";
    const now = finding.status === "accepted" ? ` ${finding.accepted_by ?? "A person"} read it and accepted it.` : " It stands until a person reads the description and accepts it; no scan closes it and no fix applies to it.";
    return head + why + path + now;
  }
  if (finding.kind === "drift") {
    const d = finding.drift ?? { added: [], removed: [], changed: {} };
    const parts = [
      Object.keys(d.changed).length ? `${plural(Object.keys(d.changed).length, "tool", "tools")} changed definition (${Object.entries(d.changed).map(([t, p]) => `${t}: ${p.join(", ")}`).join("; ")})` : "",
      d.added.length ? `${plural(d.added.length, "tool", "tools")} added (${d.added.join(", ")})` : "",
      d.removed.length ? `${plural(d.removed.length, "tool", "tools")} removed (${d.removed.join(", ")})` : "",
    ].filter(Boolean).join("; ");
    const head = `The manifest of ${finding.server_id} is not the one loaded before: ${parts}.`;
    const why = " A tool approved under one definition is running under another, which is what the scanners call a rug pull: a description can gain an instruction, a schema a field, an annotation can turn a reading tool into an acting one.";
    const now = finding.status === "accepted" ? ` ${finding.accepted_by ?? "A person"} accepted the new definitions.` : " It stands until a person accepts the new definitions; no scan closes it and no fix applies to it.";
    return head + why + now;
  }
  const paths = pathsOf(finding);
  const blocked = finding.status === "open" ? null : blockedHop(finding, flow);
  const closed = finding.status === "open" ? "" : blocked
    ? `This no longer holds: the hop from ${blocked.data.from_id} to ${blocked.data.to_id} is blocked by ${gateWords(blocked.data.gate)}. Before the fix: `
    : "This no longer holds in the graph. Before it closed: ";

  if (finding.kind === "injection") {
    const path = paths[0]?.path;
    if (!path) return `${closed}No evidence path was stored for this finding.`;
    const clauses = path.rules.map((rule, i) => (HOP[rule] ?? (() => path.hops[i].replace(/^rule \d+: /, "")))(path.node_ids[i], path.node_ids[i + 1]));
    const chain = clauses.length > 1 ? `${clauses.slice(0, -1).join("; ")}; and ${clauses[clauses.length - 1]}` : clauses[0];
    const first = `whatever an outsider writes into ${finding.source_id} can end up acting on ${finding.target_id}.`;
    // the chain starts with an id, so it is led in by a word: capitalising an id would stop it being one
    return `${closed ? closed + first : capital(first)} The route: ${chain}. That is ${plural(path.rules.length, "hop", "hops")} with no person in between.`;
  }

  const leg = (p: (typeof paths)[number] | undefined) => plural(p?.path.rules.length ?? 0, "hop", "hops");
  const exits = nodeIndex(flow);
  const leaves = (finding.exit_ids ?? []).some((id) => exits.get(id)?.data.external);
  const first = `${finding.agent_id} holds all three at once.`;
  return [
    closed ? closed + first : first,
    `Untrusted text from ${(finding.untrusted_ids ?? []).join(" and ")} reaches it in ${leg(paths[0])}.`,
    `Private data from ${(finding.private_ids ?? []).join(" and ")} reaches it in ${leg(paths[1])}.`,
    `It can reach ${(finding.exit_ids ?? []).join(" and ")}${leaves ? ", which leaves the organisation," : ""} in ${leg(paths[2])}.`,
    "So whoever writes the untrusted text can ask for the private data to be sent out.",
    RULE_OF_TWO,
  ].join(" ");
}

/** What a sandbox found for the plan that is on the table, as a sentence. */
export function verdictSentence(m: Mitigation): string {
  const resolved = m.resolved?.length ?? 0;
  const introduced = m.introduced?.length ?? 0;
  const broken = m.newly_broken?.length ?? 0;
  return `Tested on a sandbox copy of the graph${m.sandbox_ms != null ? ` in ${m.sandbox_ms} ms` : ""}: it resolves ${plural(resolved, "finding", "findings")}, introduces ${introduced ? plural(introduced, "new one", "new ones") : "none"} and breaks ${broken ? plural(broken, "workflow", "workflows") : "no workflow"}.`;
}

/** Every path node of a finding gets a footnote number, in the order the chart reads: left to right. */
export function citations(finding: Finding): Map<string, number> {
  const ids = [...new Set(pathsOf(finding).flatMap((p) => p.path.node_ids))];
  return new Map(ids.map((id, i) => [id, i + 1]));
}
