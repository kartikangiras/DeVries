// The Explorer: the whole system in one drawing, on DeVries's chart or on FalkorDB's canvas, and a reader for
// whatever is clicked. The lenses light what stands out: the open paths, the communities, the cheapest cut, the
// most central nodes; the layer switches between what flows and what is configured. It is the only place the
// whole graph is drawn. A finding's page lights its path here; the posture page sends its names here.

import { useEffect, useMemo, useState } from "react";
import { api, type Central, type Graph, type GraphLink, type Layer } from "../api";
import { Chart, RendererSwitch, useRenderer } from "../graph/Chart";
import { KIND_OF, focusOf, nodeFacts, nodeIndex, nodesOn, type Focus, type Series } from "../paths";
import { go, href } from "../route";
import type { DeVries } from "../state";
import { KIND_WORDS, WithNames, capital, findingTitle, plural } from "../text";
import { Eyebrow, Fold, Loading, PageBody, PageHeader } from "../ui";
import { WhatIfLine } from "./WhatIf";

const RELATION: Record<string, string> = { CAN_CALL: "can call", DELEGATES_TO: "delegates to", READS: "reads", WRITES: "acts on", FEEDS: "is read back as" };

/** An edge as a card: the sentence it stands for, and the rule or relation behind it. */
function Edge({ link, graph, names }: { link: GraphLink; graph: Graph; names: Record<string, string> }) {
  const flow = graph.layer === "flow";
  const blocked = link.rel === "GATED_FLOW";
  return (
    <li className={`card${blocked ? " blocked" : ""}`}>
      <p>
        <WithNames text={flow ? link.data.sentence.replace(/^(blocked by \w+: )?rule \d+: /, "") : `${link.data.from_id} ${RELATION[link.rel] ?? link.rel} ${link.data.to_id}`} names={names} />
      </p>
      <p className="card-meta">
        {flow ? `rule ${link.data.rule}` : link.rel}
        {blocked ? ` · blocked by ${link.data.gate === "quarantine" ? "a quarantine" : "an approval gate"}` : link.data.gate ? ` · gate: ${link.data.gate}` : ""}
      </p>
    </li>
  );
}

function Read({ id, graph, c, scenario }: { id: string | null; graph: Graph; c: DeVries; scenario: string }) {
  const node = id ? nodeIndex(graph).get(id) : undefined;
  if (!node) {
    return (
      <aside className="read" aria-label="What was clicked">
        <p className="read-idle">Click a card to read what reaches it, what it reaches, and the findings that pass through it. An agent can be asked what one more grant would open.</p>
      </aside>
    );
  }
  const into = graph.links.filter((l) => l.data.to_id === id);
  const out = graph.links.filter((l) => l.data.from_id === id);
  const through = [...(c.findings?.findings ?? []), ...(c.findings?.past ?? [])].filter((f) => nodesOn(f).has(node.data.id));
  const flow = graph.layer === "flow";
  const tainted = flow && !!node.data.tainted;
  const card = node.label === "Agent" ? c.scorecard?.agents.find((a) => a.agent_id === node.data.id) : undefined;
  return (
    <aside className="read picked" aria-label="What was clicked">
      <Eyebrow>{KIND_OF[node.label]}</Eyebrow>
      <h2>{node.data.name ?? node.data.id}</h2>
      <p className="read-id">{node.data.id}</p>
      <p className="read-facts">
        {capital(nodeFacts(node))}.{" "}
        {flow && (tainted ? "Untrusted text reaches it." : "Untrusted text does not reach it.")}{" "}
        {node.data.blast ? "Its community holds an untrusted source and a high-impact resource." : ""}
        {flow && node.data.pagerank !== undefined ? ` PageRank #${node.data.pagerank_rank} of ${graph.nodes.length} on the flow layer.` : ""}
      </p>
      {card && (
        <p className="badges" aria-label="Meta's Rule of Two">
          <span className={`badge${card.properties.includes("A") ? " on" : ""}`} title={card.untrusted_in.join(", ") || "no untrusted source reaches it"}>A · untrusted in</span>
          <span className={`badge${card.properties.includes("B") ? " on" : ""}`} title={card.private_in.join(", ") || "no private source reaches it"}>B · private in</span>
          <span className={`badge${card.properties.includes("C") ? " on" : ""}`} title={card.acts_on.join(", ") || "it acts on nothing"}>C · acts{card.external ? ", externally" : ""}</span>
          <a className="badge-link" href={href(scenario)}>the tally →</a>
        </p>
      )}
      <Eyebrow>{flow ? "What flows into it" : "What points at it"}</Eyebrow>
      {into.length ? <ul className="cards">{into.map((l) => <Edge key={l.id} link={l} graph={graph} names={c.names} />)}</ul> : <p className="read-none">Nothing.</p>}
      <Eyebrow>{flow ? "Where it flows on" : "What it points at"}</Eyebrow>
      {out.length ? <ul className="cards">{out.map((l) => <Edge key={l.id} link={l} graph={graph} names={c.names} />)}</ul> : <p className="read-none">Nothing.</p>}
      <Eyebrow>Findings through it</Eyebrow>
      {through.length ? (
        <ul className="cards">
          {through.map((f) => (
            <li className={`card finding-${f.status}`} key={f.id}>
              <p>{findingTitle(f, c.names)}</p>
              <p className="card-meta">{KIND_WORDS[f.kind]} · {f.status}</p>
              <a href={href(scenario, "finding", f.id)}>Open finding →</a>
            </li>
          ))}
        </ul>
      ) : <p className="read-none">None.</p>}
      {node.label === "Agent" && (
        <>
          <Eyebrow>Test a change</Eyebrow>
          <p className="read-none">One more grant or delegation for this agent, tried on a sandbox copy that is then deleted. Nothing changes.</p>
          <WhatIfLine c={c} scenario={scenario} agentId={node.data.id} head={false} />
        </>
      )}
      <p className="read-none"><a href={href(scenario, "inventory", node.label === "Agent" ? null : node.label === "Tool" ? "tools" : node.label === "DataSource" ? "sources" : "resources")}>In the inventory →</a></p>
    </aside>
  );
}

type Lens = "paths" | "all" | "zones" | "cut" | "central";

/** An agent's Rule of Two letters, to print on its card. */
export function badgesOf(c: DeVries): Map<string, string> {
  return new Map((c.scorecard?.agents ?? []).map((a) => [a.agent_id, ["A", "B", "C"].filter((p) => a.properties.includes(p)).join("·") || "·"]));
}

/** What every open finding lights up, as one focus: their nodes and hops together. */
function openFocus(c: DeVries): Focus | null {
  const open = (c.findings?.findings ?? []).filter((f) => f.status === "open" && (f.kind === "injection" || f.kind === "trifecta"));
  if (!open.length) return null;
  const hops = new Map<string, Series>();
  const order: string[] = [];
  for (const f of open) {
    const one = focusOf(f);
    one.hops.forEach((s, k) => hops.set(k, s));
    one.order.forEach((id) => !order.includes(id) && order.push(id));
  }
  return { order, nodes: new Set(order), hops, holder: null };
}

export function ExplorerPage({ c, scenario, id }: { c: DeVries; scenario: string; id: string | null }) {
  const litFinding = id?.startsWith("fnd:") ? [...(c.findings?.findings ?? []), ...(c.findings?.past ?? [])].find((f) => f.id === id) ?? null : null;
  const picked = id && !id.startsWith("fnd:") ? id : null;
  const [lens, setLens] = useState<Lens>("paths");
  const [renderer, setRenderer] = useRenderer();
  const [canvasLayout, setCanvasLayout] = useState<"force" | "tree">("force");
  const [layer, setLayer] = useState<Layer>("flow");
  const [central, setCentral] = useState<Central | null>(null);
  const [cutHops, setCutHops] = useState<Set<string> | null>(null);
  const { needConfig } = c;
  useEffect(() => {
    if (layer === "config") needConfig();
  }, [layer, needConfig]);
  // a finding lit from its page is read on the flow layer with the paths lens, whatever lens was on before
  const litId = litFinding?.id ?? null;
  useEffect(() => {
    if (litId) {
      setLens("paths");
      setLayer("flow");
    }
  }, [litId]);
  const graph = layer === "config" ? c.config : c.flow;
  const flow = layer === "flow";
  const cutting = lens === "cut" && flow;
  const centring = lens === "central" && flow;
  useEffect(() => {
    if (!cutting) return;
    let wanted = true;
    api.cut(scenario).then((found) => wanted && setCutHops(new Set(found.hops.map((h) => `${h.from_id}>${h.to_id}`)))).catch(() => wanted && setCutHops(null));
    return () => { wanted = false; };
  }, [cutting, scenario, c.flow]);
  useEffect(() => {
    if (!centring) return;
    let wanted = true;
    api.central(scenario).then((found) => wanted && setCentral(found)).catch(() => wanted && setCentral(null));
    return () => { wanted = false; };
  }, [centring, scenario, c.flow]);
  const rings = useMemo(() => (centring && central?.scenario === scenario ? new Map(central.nodes.map((n, i) => [n.id, i + 1])) : undefined), [centring, central, scenario]);
  const badges = useMemo(() => badgesOf(c), [c.scorecard]);
  const everyOpen = useMemo(() => openFocus(c), [c.findings]);
  const focus = useMemo(() => (litFinding ? focusOf(litFinding) : lens === "paths" && flow ? everyOpen : null), [litFinding, lens, flow, everyOpen]);
  const communityCount = new Set((graph?.nodes ?? []).map((n) => n.data.community)).size;
  const zoneCount = new Set((graph?.nodes ?? []).map((n) => n.data.zone)).size;
  const inZone = graph?.nodes.filter((n) => n.data.blast).length ?? 0;
  const total = graph?.nodes.length ?? 0;
  const openCount = c.findings?.findings.filter((f) => f.status === "open").length ?? 0;
  const pick = (node: string | null) => go(scenario, "graph", node);
  const idle = litFinding ? `The path of ${findingTitle(litFinding, c.names)} is lit; the rest of the system is around it.` : lens === "paths" && focus ? "The open findings' paths are lit; everything else is drawn quiet. Click a card to read about it." : "Hover a card to read it. Click it to read about it beside the chart.";

  return (
    <PageBody width="wide">
      <PageHeader
        eyebrow="Explorer"
        title={graph ? `${capital(plural(graph.nodes.length, "node", "nodes"))}, ${plural(graph.links.length, flow ? "flow" : "config edge", flow ? "flows" : "config edges")}${flow && openCount ? `, ${plural(openCount, "open path", "open paths")} lit` : ""}.` : "The whole system."}
        meta={flow
          ? "Where text and data can travel. Every arc is derived from the config by one of seven rules, and a path means it can flow, not that it did. Lenses light what stands out; the reader says what a card is."
          : "What is configured: which agent can call which tool, who delegates to whom, and what each tool reads and acts on."}
      />
      <div className="chart-controls">
        <span className="control">Lens</span>
        <div className="pills" role="tablist" aria-label="Lens">
          <button role="tab" aria-selected={lens === "paths"} className={lens === "paths" ? "on" : ""} onClick={() => { setLens("paths"); setLayer("flow"); if (litFinding) pick(null); }} title="The open findings' paths lit over the whole system">Open paths{openCount ? ` · ${openCount}` : ""}</button>
          <button role="tab" aria-selected={lens === "all"} className={lens === "all" ? "on" : ""} onClick={() => { setLens("all"); if (litFinding) pick(null); }}>Everything</button>
          <button role="tab" aria-selected={lens === "zones"} className={lens === "zones" ? "on" : ""} onClick={() => { setLens("zones"); if (litFinding) pick(null); }}
            title="Communities by label propagation over the config edges; a blast community holds both an untrusted source and a high-impact resource">Communities{graph ? ` · ${communityCount}` : ""}</button>
          <button role="tab" aria-selected={lens === "cut"} className={lens === "cut" ? "on" : ""} onClick={() => { setLens("cut"); setLayer("flow"); if (litFinding) pick(null); }}
            title="The least that has to be cut to separate every untrusted source from every high-impact resource, by max flow">Cheapest cut</button>
          <button role="tab" aria-selected={lens === "central"} className={lens === "central" ? "on" : ""} onClick={() => { setLens("central"); setLayer("flow"); if (litFinding) pick(null); }}
            title="The five agents and tools that the most flow passes through, by betweenness centrality">Most central</button>
        </div>
        <span className="control">Layer</span>
        <div className="pills" role="tablist" aria-label="Layer">
          <button role="tab" aria-selected={flow} className={flow ? "on" : ""} onClick={() => setLayer("flow")}>Flow</button>
          <button role="tab" aria-selected={!flow} className={!flow ? "on" : ""} onClick={() => { setLayer("config"); if (lens !== "all" && lens !== "zones") setLens("all"); }}>Config</button>
        </div>
        <RendererSwitch value={renderer} onChange={setRenderer} layout={canvasLayout} onLayout={setCanvasLayout} />
      </div>

      <div className="graph-split">
        <figure className="figure">
          {graph ? (
            <Chart renderer={renderer} layout={canvasLayout} graph={graph} names={c.names} focus={focus} only={false} communities={lens === "zones"}
              cuts={cutting ? cutHops ?? undefined : undefined} cutsMean="on the cheapest cut" rings={rings} badges={badges} picked={picked} onPick={pick} idle={idle} />
          ) : <Loading label={c.ready ? "Reading the graph" : "Connecting"} />}
          {cutting && (
            <p className="chart-note">
              <strong>Cheapest cut.</strong> The marked hops are the least that separates every untrusted source from every high-impact resource, by max flow.
              The hops, their cost and the rules they would become are on <a href={href(scenario)}>Posture</a>.
            </p>
          )}
          {centring && central?.scenario === scenario && (
            <div className="chart-note cut-note central-note">
              <p><strong>Most central.</strong> The agents and tools the most flow passes through, by betweenness centrality on the flow layer: where a change would touch the most paths. Context for a person; no verdict rests on it.</p>
              <ol className="cut-list">
                {central.nodes.map((n) => <li key={n.id}><button className="link-plain" onClick={() => pick(n.id)}><WithNames text={n.id} names={c.names} /></button><span> · {n.label.toLowerCase()} · {n.score}</span></li>)}
              </ol>
              <p>Worked out by <a href={href(scenario, "queries", "choke.betweenness")}>choke.betweenness</a>, which runs FalkorDB's <code>algo.betweenness</code> with a fixed sampling seed.</p>
            </div>
          )}
          {lens === "zones" && graph && (
            <p className="chart-note">
              {capital(plural(communityCount, "community", "communities"))} by label propagation over the config edges, coloured on the cards' edges: what hangs together, and which of it holds untrusted input.
              Worked out by <a href={href(scenario, "queries", "zones.communities")}>zones.communities</a> (FalkorDB's <code>algo.labelPropagation</code>).{" "}
              {zoneCount === 1 && inZone === total
                ? "Connected at all, the graph is one zone, and a blast zone: it holds both an untrusted source and a high-impact resource."
                : inZone === 0
                  ? `Connected at all, it is ${plural(zoneCount, "zone", "zones")}, none a blast zone: no connected part holds both an untrusted source and a high-impact resource.`
                  : `Connected at all, it is ${plural(zoneCount, "zone", "zones")}; ${plural(inZone, "node", "nodes")} sit in a blast zone, one that holds both an untrusted source and a high-impact resource.`}{" "}
              Neither looks at direction, so either can prove a source cannot reach a resource, never that it can.
            </p>
          )}
          {litFinding && (
            <p className="chart-note">
              Lit: the path of <a href={href(scenario, "finding", litFinding.id, "path")}>{findingTitle(litFinding, c.names)}</a>. <button className="link" onClick={() => pick(null)}>Show every open path</button>.
            </p>
          )}
          {graph && (
            <figcaption>
              <Fold className="source" summary="Source and method" sub={`the ${layer} layer · ${plural(graph.queries.length, "FalkorDB query", "FalkorDB queries")} · ${renderer === "falkordb" ? "FalkorDB canvas" : "ELK and React Flow"}`}>
                <p className="chart-note">
                  Source: the {layer} layer of {scenario}{c.current?.own_copy ? " (your sandbox copy)" : ""} in FalkorDB, read by{" "}
                  {graph.queries.map((q, i) => <span key={q}>{i > 0 && ", "}<a href={href(scenario, "queries", q)}>{q}</a></span>)}.{" "}
                  {renderer === "falkordb"
                    ? "Drawn by FalkorDB's canvas component on the database's own node ids; the colours are DeVries's facts."
                    : "Laid out by ELK in lanes, drawn with React Flow; a card is filled when untrusted text reaches it, which FalkorDB works out (reach.untrusted_nodes)."}
                  {flow ? " A path means text can flow, not that it did." : " Config edges are what a person set up; the flow layer is derived from them."}
                  {c.health?.canary && <> Self-check: {c.health.canary.ok ? "passed" : "FAILED"} ({c.health.canary.detail}).</>}
                </p>
              </Fold>
            </figcaption>
          )}
          {graph && (
            <details className="as-table">
              <summary>The {graph.links.length} {flow ? "flow" : "config"} edges, as a table</summary>
              <table className="table">
                <thead>
                  <tr><th>From</th><th>{flow ? "Rule" : "Relation"}</th><th>To</th><th>What it means</th></tr>
                </thead>
                <tbody>
                  {graph.links.map((link) => (
                    <tr key={link.id}>
                      <td className="mono">{link.data.from_id}</td>
                      <td className="mono">{flow ? `${link.data.rule}${link.rel === "GATED_FLOW" ? " · blocked" : ""}` : `${link.rel}${link.data.gate ? " · gated" : ""}`}</td>
                      <td className="mono">{link.data.to_id}</td>
                      <td><WithNames text={link.data.sentence.replace(/rule \d+: /, "")} names={c.names} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          )}
        </figure>
        {graph && <Read id={picked} graph={graph} c={c} scenario={scenario} />}
      </div>
    </PageBody>
  );
}
