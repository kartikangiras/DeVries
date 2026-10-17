// The scenario's standing, all of it read from FalkorDB: how exposed it is, where the risk is, what stands in its
// way, and whether it is getting better. Numbers, bars and the one picture; the finding draws its own path, the
// Explorer draws the system. Every block names the query it rests on.

import { useState } from "react";
import { api, type Mitigation, type Posture } from "../api";
import { useFetch } from "../fetch";
import { RiskFlow } from "../graph/RiskFlow";
import { href } from "../route";
import type { DeVries } from "../state";
import { WithNames, capital, clock, countWord, plural } from "../text";
import { Block, Button, Empty, Figures, Fold, Loading, PageBody, PageHeader } from "../ui";
import { CutBlock } from "./WhatIf";

const OWASP_ABOUT: Record<string, string> = {
  ASI01: "an injection path or a poisoned description", ASI02: "an injection path or a trifecta", ASI03: "a trifecta", ASI04: "manifest drift or a poisoned description",
};

/** One row a thing, a bar for its figure against the largest, a second thinner bar for the part that matters most. */
function Bars({ rows, max, label }: { rows: { id: string; name: string; sub: string; value: number; accent?: number; href?: string }[]; max: number; label: string }) {
  if (!rows.length) return <p className="rail-note">Nothing to measure.</p>;
  const top = Math.max(1, max);
  return (
    <ol className="bars" aria-label={label}>
      {rows.map((r) => (
        <li key={r.id}>
          <span className="bar-label">
            {r.href ? <a href={r.href} title={r.id}>{r.name}</a> : <span title={r.id}>{r.name}</span>}
            <span className="bar-sub">{r.sub}</span>
          </span>
          <span className="bar-track">
            <i className="bar-fill" style={{ width: `${Math.round((r.value / top) * 100)}%` }} />
            {r.accent != null && r.accent > 0 && <i className="bar-accent" style={{ width: `${Math.round((r.accent / top) * 100)}%` }} />}
          </span>
          <span className="bar-n">{r.value}</span>
        </li>
      ))}
    </ol>
  );
}

/** Open findings after each scan, as one bar a scan; the latest is lit, so a fix shows as a drop. */
function Scans({ scans }: { scans: Posture["scans"] }) {
  if (!scans.length) return <p className="rail-note">No scan has been recorded on this graph yet; the next one starts the history.</p>;
  const max = Math.max(1, ...scans.map((s) => s.open));
  const shown = scans.slice(-24);
  return (
    <ol className="scans" aria-label="Open findings after each scan">
      {shown.map((s, i) => (
        <li key={s.scan_id} className={`scan${i === shown.length - 1 ? " lit" : ""}${s.open ? "" : " clean"}`} title={`${s.scan_id} · ${clock(s.at)} · ${plural(s.open, "open finding", "open findings")} · ${s.duration_ms} ms`}>
          <span className="scan-n">{s.open}</span>
          <i className="scan-bar" style={{ height: `${Math.max(4, Math.round((s.open / max) * 100))}%` }} />
          <span className="scan-at">{clock(s.at)}</span>
        </li>
      ))}
    </ol>
  );
}

/** Propose the cheapest cut as one plan: the sandbox verifies it like any other, and the answer is the plan or the refusal. */
function ProposeCut({ c, scenario, cut }: { c: DeVries; scenario: string; cut: Posture["cut"] }) {
  const [state, setState] = useState<{ busy?: boolean; plan?: Mitigation | null; verdict?: Record<string, unknown> | null; error?: string } | null>(null);
  const hasInjection = (c.findings?.findings ?? []).some((f) => f.status === "open" && f.kind === "injection");
  if (!cut.hops.length || !cut.cuttable || !hasInjection) return null;
  const propose = async () => {
    setState({ busy: true });
    try {
      const answer = await api.proposeCut(scenario);
      setState({ plan: answer.proposed, verdict: answer.verdict });
    } catch (e) {
      setState({ error: e instanceof Error ? e.message : "The sandbox could not answer." });
    }
  };
  const target = state?.plan?.targets[0];
  return (
    <div className="propose-cut">
      {!state || state.error ? (
        <p className="rail-note">
          <Button size="sm" onClick={propose} disabled={c.busy}>Propose the cut as one plan</Button>{" "}
          The sandbox verifies it like any other plan; it lands on the finding's fix step if it passes.
          {state?.error && <span className="whatif-error"> {state.error}</span>}
        </p>
      ) : state.busy ? <Loading label="Asking a sandbox" /> : state.plan ? (
        <p className="rail-note">
          Passed: <WithNames text={capital(state.plan.summary.join(", and "))} names={c.names} />.{" "}
          {target && <a href={href(scenario, "finding", target, "fix")}>Read it on the fix step →</a>}
        </p>
      ) : (
        <p className="whatif-error">The sandbox refused it: <WithNames text={String((state.verdict as { reason?: string } | null)?.reason ?? "it did not pass")} names={c.names} />.</p>
      )}
    </div>
  );
}

export function PosturePage({ c, scenario }: { c: DeVries; scenario: string }) {
  // ask again when the config, a scan or a plan has moved
  const posture = useFetch(() => api.posture(scenario), [scenario, c.configHash, c.scannedAt, c.plans.length, c.findings?.findings.length]);
  const p = posture.data?.scenario === scenario ? posture.data : null;
  const overview = c.overview?.scenario === scenario ? c.overview : null;
  const open = c.findings?.findings.filter((f) => f.status === "open") ?? [];
  const active = c.run && (c.run.status === "running" || c.run.status === "awaiting_approval");
  const canAudit = open.length > 0 && !active;
  const name = (id: string) => c.names[id] ?? id;
  const untrustedTotal = p?.counts.untrusted_sources ?? 0;
  const facts = p && (
    <>
      {p.facts.nodes} nodes · {plural(p.facts.flows, "flow", "flows")} · {plural(p.facts.workflows, "workflow", "workflows")} a fix must not break
      {p.facts.last_scan ? ` · last scanned ${clock(p.facts.last_scan.at)} in ${p.facts.last_scan.duration_ms} ms` : " · not scanned yet"}
      {c.health?.falkordb_version ? ` · FalkorDB ${c.health.falkordb_version}` : ""}
      {p.own_copy ? " · your sandbox copy" : ""}
    </>
  );
  const three = p?.rule_of_two.agents.filter((a) => a.count === 3) ?? [];

  return (
    <PageBody width="wide">
      <PageHeader
        eyebrow="Posture"
        title={p?.sentence ?? overview?.sentence ?? (c.ready ? "Reading the graph." : "Connecting.")}
        meta={<>
          {c.current?.description ? `${c.current.description}. ` : ""}
          {facts}
          {c.current?.imported && !open.length && <> Label the sources and resources under <a href={href(scenario, "inbox")}>Open</a> for the scan to find anything.</>}
        </>}
        actions={canAudit && <Button variant="primary" size="lg" onClick={c.startAudit} disabled={c.busy}>Run audit</Button>}
      />
      {posture.error && <p className="whatif-error">{posture.error}</p>}
      {!p ? <Loading label={c.ready ? "Reading the posture" : "Connecting"} /> : (
        <>
          <Figures items={[
            { n: p.counts.open_findings, label: p.counts.open_findings === 1 ? "open finding" : "open findings", tone: p.counts.open_findings ? "bad" : "good" },
            { n: `${p.exposure.high_reached} / ${p.exposure.high_total}`, label: "high-impact actions reached", tone: p.exposure.high_reached ? "bad" : undefined },
            { n: `${p.exposure.external_reached} / ${p.exposure.external_total}`, label: "ways out reached", tone: p.exposure.external_reached ? "bad" : undefined },
            { n: `${p.exposure.agents_reached} / ${p.exposure.agents_total}`, label: "agents untrusted text reaches" },
            { n: p.rule_of_two.tally["3"] ?? 0, label: "agents holding all three", tone: (p.rule_of_two.tally["3"] ?? 0) ? "bad" : undefined },
            { n: p.rule_of_two.unattended_three, label: "of them unattended", tone: p.rule_of_two.unattended_three ? "bad" : undefined },
            { n: p.cut.cost ?? "—", label: "cheapest cut, cost" },
          ]} />

          <Block className="posture-picture" eyebrow="Where the risk is" aside="only the open paths are drawn: what outsiders write, the agents it reaches, the actions those agents can take · pan and zoom it like a map">
            {overview ? (
              <figure className="figure">
                <RiskFlow view={overview} posture={p} names={c.names} scenario={scenario} />
                <figcaption>
                  <Fold className="source" summary="Source and method" sub={`${plural(overview.queries.length, "FalkorDB query", "FalkorDB queries")} · React Flow`}>
                    <p className="chart-note">
                      Source: {scenario}{overview.own_copy ? " (your sandbox copy)" : ""} in FalkorDB, read by{" "}
                      {overview.queries.map((q, i) => <span key={q}>{i > 0 && ", "}<a href={href(scenario, "queries", q)}>{q}</a></span>)}.{" "}
                      Each path is one open finding, read from its evidence; the tokens running along it are the text an outsider can plant, one per route up to four, and they run for as long as the path is open. A card's figure is a BFS answer: what a source's text reaches, how many untrusted sources reach an action, which of Meta's three properties an agent holds. The columns are the order the text travels.
                      The whole system, every node and every flow, is in the <a href={href(scenario, "graph")}>Explorer</a>.
                    </p>
                  </Fold>
                </figcaption>
              </figure>
            ) : <Loading label="Reading the picture" />}
          </Block>

          <Block className="posture-tally" eyebrow="Meta's Rule of Two" aside={`${plural(p.rule_of_two.agents.length, "agent", "agents")} · ${three.length ? `${countWord(three.length)} ${three.length === 1 ? "holds" : "hold"} all three` : "none holds all three"}${p.rule_of_two.unattended_three ? `, ${countWord(p.rule_of_two.unattended_three)} unattended` : ""}`}>
            {p.rule_of_two.agents.length ? (
              <ul className="tally">
                {p.rule_of_two.agents.map((a) => (
                  <li key={a.agent_id} className={`tally-card${a.count === 3 ? " all" : ""}${a.count === 3 && a.autonomous ? " unattended" : ""}`}>
                    <a href={href(scenario, "graph", a.agent_id)} title={a.agent_id}><strong>{name(a.agent_id)}</strong></a>
                    <span className="tally-dots" aria-label={`holds ${a.properties.join(", ") || "none"}`}>
                      {(["A", "B", "C"] as const).map((k) => <i key={k} className={`s-${k === "A" ? "hot" : k === "B" ? "private" : "exit"}${a.properties.includes(k) ? " on" : ""}`}>{k}</i>)}
                    </span>
                    <span className="tally-sub">{a.count === 3 ? (a.autonomous ? "all three · runs unattended" : "all three · supervised") : a.count ? `${countWord(a.count)} of three` : "none of the three"}</span>
                  </li>
                ))}
              </ul>
            ) : <Empty>No agent in this scenario.</Empty>}
            <Fold className="source" summary="Source and method" sub="reach.agents_from_sources · agent.acts_on · three BFS passes">
              <p className="chart-note">
                A, untrusted input reaches the agent; B, private data reaches it; C, it can reach a resource. Each is one BFS over the flow layer, by{" "}
                <a href={href(scenario, "queries", "reach.agents_from_sources")}>reach.agents_from_sources</a> and <a href={href(scenario, "queries", "agent.acts_on")}>agent.acts_on</a>.
                Meta's rule: at most two of the three in a session; an agent that needs all three must not run unattended. The findings are the verdicts; this is the tally.
              </p>
            </Fold>
          </Block>

          <div className="posture-pair">
            <Block className="posture-blast" eyebrow="Blast radius" aside="what text planted in each untrusted source can reach">
              <Bars label="Blast radius" max={Math.max(1, ...p.blast.map((b) => b.reached))}
                rows={p.blast.map((b) => ({
                  id: b.id, name: b.name, value: b.reached, accent: b.high + b.external, href: href(scenario, "graph", b.id),
                  sub: [plural(b.agents, "agent", "agents"), plural(b.tools, "tool", "tools"), b.high ? `${countWord(b.high)} high-impact` : null, b.external ? `${countWord(b.external)} way${b.external === 1 ? "" : "s"} out` : null].filter(Boolean).join(" · "),
                }))} />
              <Fold className="source" summary="Source and method" sub="reach.from · algo.bfs from each untrusted source">
                <p className="chart-note">
                  One BFS from each source marked untrusted, over the flow layer, by <a href={href(scenario, "queries", "reach.from")}>reach.from</a>: the bar is how many nodes it reaches; the lit part is the high-impact resources and the ways out among them.
                </p>
              </Fold>
            </Block>
            <Block className="posture-targets" eyebrow="Exposure" aside="how many untrusted sources reach each high-impact action or way out">
              <Bars label="Exposure" max={Math.max(1, untrustedTotal)}
                rows={p.targets.map((t) => ({
                  id: t.id, name: t.name, value: t.reaching, href: href(scenario, "graph", t.id),
                  sub: [t.impact ? `${t.impact} impact` : null, t.external ? "leaves the organisation" : null, t.reaching ? `reached by ${t.sources.map(name).join(", ")}` : "reached by no untrusted source"].filter(Boolean).join(" · "),
                }))} />
              <Fold className="source" summary="Source and method" sub="reach.into · algo.bfs from every node">
                <p className="chart-note">
                  For each resource with high impact or a way out of the organisation, <a href={href(scenario, "queries", "reach.into")}>reach.into</a> runs a BFS from every node and keeps the untrusted sources among those that reach it; the bar is their count against the {plural(untrustedTotal, "untrusted source", "untrusted sources")} in the scenario.
                </p>
              </Fold>
            </Block>
          </div>

          <Block className="posture-chokes" eyebrow="Choke points" aside="the agents and tools the most open routes pass through: where one change cuts the most">
            {p.chokes.length ? (
              <ol className="chokes">
                {p.chokes.map((n, i) => (
                  <li key={n.id}>
                    <span className="choke-rank">{i + 1}</span>
                    <span className="choke-name"><a href={href(scenario, "graph", n.id)} title={n.id}>{n.name ?? name(n.id)}</a><span className="choke-kind">{n.label.toLowerCase()}</span></span>
                    <span className="bar-track"><i className="bar-fill" style={{ width: `${Math.round((n.routes / Math.max(1, p.chokes[0].routes)) * 100)}%` }} /></span>
                    <span className="choke-n">{plural(n.routes, "route", "routes")} · {plural(n.findings, "finding", "findings")}{n.betweenness != null ? ` · betweenness ${n.betweenness}` : ""}</span>
                  </li>
                ))}
              </ol>
            ) : <p className="rail-note">No open route passes through any agent or tool: nothing is a choke point.</p>}
            <CutBlock c={c} scenario={scenario} compact head={false} />
            <ProposeCut c={c} scenario={scenario} cut={p.cut} />
            <Fold className="source" summary="Source and method" sub="evidence.pair_paths · choke.betweenness · choke.maxflow">
              <p className="chart-note">
                Routes are the evidence paths of the open findings (<a href={href(scenario, "queries", "evidence.pair_paths")}>evidence.pair_paths</a>, by <code>algo.SPpaths</code>), counted per node they pass through; betweenness is FalkorDB's <code>algo.betweenness</code> over the flow layer (<a href={href(scenario, "queries", "choke.betweenness")}>choke.betweenness</a>), shown where a node is among its top five.
                The cheapest cut is <a href={href(scenario, "queries", "choke.maxflow")}>choke.maxflow</a>, <code>algo.maxFlow</code> with each hop's capacity set to the cost of the cheapest fix that cuts it. Context for a person; the sandbox decides what is safe.
              </p>
            </Fold>
          </Block>

          <div className="posture-pair">
            <Block className="posture-scans" eyebrow="Over time" aside={`${plural(p.scans.length, "scan", "scans")} recorded · open findings after each`}>
              <Scans scans={p.scans} />
              <Fold className="source" summary="Source and method" sub="scan.history">
                <p className="chart-note">
                  Every scan of this graph is a record in it, read by <a href={href(scenario, "queries", "scan.history")}>scan.history</a>: when it ran, how long it took, and how many findings were open after it. A fix that is applied shows as the next bar's drop.
                </p>
              </Fold>
            </Block>
            <Block className="posture-owasp" eyebrow="OWASP Top 10 for Agentic Applications" aside="which classes the open findings fall in, and which DeVries does not look for">
              <ul className="owasp-row">
                {p.owasp.map((o) => (
                  <li key={o.code} className={`owasp-code${o.checked ? "" : " off"}${o.open ? " hot" : ""}`} title={`${o.code} ${o.name}${o.checked ? ` · ${OWASP_ABOUT[o.code] ?? "checked"}` : " · not checked by DeVries"}`}>
                    <b>{o.code}</b>
                    <span className="owasp-name">{o.name}</span>
                    <span className="owasp-n">{o.checked ? plural(o.open, "open", "open") : "not checked"}</span>
                  </li>
                ))}
              </ul>
              <Fold className="source" summary="Source and method" sub="finding.list · the mapping in views.py">
                <p className="chart-note">
                  An injection path is ASI01 and ASI02; a trifecta ASI03 and ASI02; manifest drift ASI04; a poisoned description ASI04 and ASI01. The other six classes are about memory, code execution, inter-agent messaging, cascades, people and rogue agents, which a configuration graph does not see.
                </p>
              </Fold>
            </Block>
          </div>
          <p className="rail-note posture-foot">
            Every figure on this page is one named query's answer, {plural(p.queries.length, "query", "queries")} in all: <a href={href(scenario, "queries")}>the catalogue</a>.
          </p>
        </>
      )}
    </PageBody>
  );
}
