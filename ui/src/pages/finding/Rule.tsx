// The Rule step's blocks: what the rule needs and what supplies it, Meta's Rule of Two as a grid, and what it means for a fix.

import type { ReactNode } from "react";
import type { Finding, Path } from "../../api";
import { hopKey, linkIndex, nodeIndex } from "../../paths";
import type { DeVries } from "../../state";
import { WithNames, countWord, plural } from "../../text";
import { Block, Eyebrow } from "../../ui";
import { PROPERTIES, two, type Card } from "./shared";

/** What the rule needs, and what in this graph supplies each need: the rule's own checklist, with names. */
export function RuleNeeds({ finding, paths, cards, c }: { finding: Finding; paths: { label: string; path: Path }[]; cards: Card[]; c: DeVries }) {
  const name = (id?: string | null) => (id ? c.names[id] ?? id : "?");
  const nodes = nodeIndex(c.flow);
  const live = linkIndex(c.flow);
  const hops = (p?: { path: Path }) => plural(p?.path.rules.length ?? 0, "hop", "hops");
  const gatedNow = paths.some(({ path }) => path.node_ids.some((id, i) => i < path.node_ids.length - 1 && live.get(hopKey(id, path.node_ids[i + 1]))?.rel === "GATED_FLOW"));
  let rows: { need: string; have: ReactNode; sub?: ReactNode }[];
  if (finding.kind === "injection") {
    const path = paths[0]?.path;
    const target = nodes.get(finding.target_id ?? "");
    const rules = [...new Set(path?.rules ?? [])];
    rows = [
      { need: "a source outsiders write", have: name(finding.source_id), sub: `trust: ${nodes.get(finding.source_id ?? "")?.data.trust ?? "untrusted"}` },
      { need: "a route over the flow layer", have: hops(paths[0]), sub: `${rules.length ? `rules ${rules.join(", ")}` : "no rule"}${(finding.paths_found ?? paths.length) > 1 ? ` · ${finding.paths_capped ? `${finding.paths_found} or more` : finding.paths_found ?? paths.length} routes` : ""}` },
      { need: "a high-impact action", have: name(finding.target_id), sub: `impact: ${target?.data.impact ?? "high"}${target?.data.external ? " · leaves the organisation" : ""}` },
      { need: "no person in between", have: gatedNow ? "a hop is gated now, so the path no longer holds" : `none of the ${countWord(path?.rules.length ?? 0)} hops is gated`, sub: "a gate on a call (rule 3) or a quarantine on a delegation (rule 6) would stop it" },
    ];
  } else {
    const card = cards.find((a) => a.agent_id === finding.agent_id);
    const unattended = card?.workflows.filter((w) => w.mode === "autonomous") ?? [];
    const leaves = (finding.exit_ids ?? []).some((id) => nodes.get(id)?.data.external);
    rows = [
      { need: "A · untrusted input reaches the agent", have: (finding.untrusted_ids ?? []).map((id) => name(id)).join(", "), sub: `in ${hops(paths[0])}` },
      { need: "B · private data reaches it", have: (finding.private_ids ?? []).map((id) => name(id)).join(", "), sub: `in ${hops(paths[1])}` },
      { need: "C · it can reach a way out", have: (finding.exit_ids ?? []).map((id) => name(id)).join(", "), sub: `in ${hops(paths[2])}${leaves ? " · leaves the organisation" : ""}` },
      {
        need: "nobody between it and the action",
        have: unattended.length ? `${unattended.map((w) => name(w.id)).join(", ")} ${unattended.length === 1 ? "runs" : "run"} unattended` : card?.workflows.length ? "its workflows are supervised" : "no workflow is declared",
        sub: unattended.length ? "by Meta's rule, an agent that holds all three must not run autonomously" : "supervision is the rule's minimum for an agent that holds all three",
      },
    ];
  }
  return (
    <Block className="needs" eyebrow="What the rule needs, and what this finding supplies" aside="each need, and the name that meets it">
      <ol className="rule-needs">
        {rows.map((row, i) => (
          <li key={i} className="met">
            <span className="need"><b>{two(i + 1)}</b>{row.need}</span>
            <span className="have">
              <WithNames text={String(row.have)} names={c.names} />
              {row.sub && <span className="sub">{row.sub}</span>}
            </span>
          </li>
        ))}
      </ol>
    </Block>
  );
}

/** Meta's Rule of Two as a grid: each agent on the path against the three properties, with what gives it each one. */
export function RuleOfTwo({ cards, c }: { cards: Card[]; c: DeVries }) {
  const name = (id: string) => c.names[id] ?? id;
  const few = (ids: string[]) => (ids.length <= 3 ? ids.map(name).join(", ") : `${ids.slice(0, 2).map(name).join(", ")} and ${ids.length - 2} more`);
  return (
    <section className="block rule">
      <div className="block-head">
        <Eyebrow>Meta's Rule of Two</Eyebrow>
        <span>an agent may hold two of the three at once; holding all three, it must not run unattended</span>
      </div>
      <div className="rot" role="table" aria-label="Meta's Rule of Two, for each agent on the path">
        <div className="rot-row rot-head" role="row">
          <span role="columnheader" className="rot-agent">Agent on the path</span>
          {PROPERTIES.map((p) => <span role="columnheader" key={p.key} className={`s-${p.series}`}><b>{p.key}</b>{p.word}</span>)}
        </div>
        {cards.map((a) => (
          <div className={`rot-row${a.count === 3 ? " all" : ""}`} role="row" key={a.agent_id} data-agent={a.agent_id}>
            <span role="rowheader" className="rot-agent">
              <strong>{name(a.agent_id)}</strong>
              <span className="rot-sub">{a.count === 3 ? "all three" : `${countWord(a.count)} of three`} · {a.autonomous ? "runs unattended" : a.workflows.length ? "supervised" : "no workflow"}</span>
            </span>
            {PROPERTIES.map((p) => {
              const ids = p.of(a);
              const held = a.properties.includes(p.key);
              return (
                <span role="cell" key={p.key} className={`rot-cell s-${p.series}${held ? " on" : ""}`} title={ids.join(", ") || `no ${p.word}`}>
                  <i aria-hidden />
                  <span className="rot-what">{held ? few(ids) : "—"}</span>
                </span>
              );
            })}
          </div>
        ))}
      </div>
    </section>
  );
}

/** What this means for a fix: each agent's verdict under the rule, the workflows a fix must not break, the class in OWASP's list. */
export function Analysis({ finding, cards, c }: { finding: Finding; cards: Card[]; c: DeVries }) {
  const agentIds = cards.map((a) => a.agent_id);
  const workflows = (c.flow?.workflows ?? []).filter((w) => agentIds.includes(w.run_by));
  return (
    <Block className="analysis" eyebrow="What it means for a fix" aside="the workflows a fix must not break, and the class in OWASP's list">
      <ul className="analysis-rows">
        {workflows.map((w) => (
          <li key={w.id}>
            <strong>{w.name}</strong> is {w.mode === "autonomous" ? "an unattended" : "a supervised"} workflow that needs <WithNames text={w.needs.join(", ") || "no tool"} names={c.names} />
            {w.mode === "autonomous" ? ", so a gate on one of those breaks it: a fix has to go around it" : ", so a gate on one of those is a fix a person can live with"}.
          </li>
        ))}
        {!workflows.length && <li>No declared workflow runs through these agents, so nothing constrains the fix.</li>}
        {finding.taxonomy && finding.taxonomy.length > 0 && (
          <li>In the OWASP Top 10 for Agentic Applications it is {finding.taxonomy.map((t, i) => <span key={t.code}>{i > 0 && " and "}<strong>{t.code}</strong> {t.name}</span>)}.</li>
        )}
      </ul>
    </Block>
  );
}
