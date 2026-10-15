// The whole system in one picture, and a panel that reads whatever is clicked. The page opens on the
// overview: untrusted sources, the agents they reach, the actions those can take, with only the open
// paths drawn. "All nodes" draws everything, on DeVries's own chart or on FalkorDB's canvas; "More" adds
// the layers, the communities, the cheapest cut and the most central nodes, and the edges as a table.

import { useEffect, useMemo, useState } from "react";
import { api, type Central, type Graph, type GraphLink, type Layer } from "../api";
import { Chart, RendererSwitch, useRenderer } from "../graph/Chart";
import { OverviewCounts } from "../graph/Overview";
import { OverviewSankey } from "../graph/Sankey";
import { KIND_OF, nodeFacts, nodeIndex, nodesOn } from "../paths";
import { href } from "../route";
import type { DeVries } from "../state";
import { KIND_WORDS, WithNames, capital, findingTitle, plural } from "../text";
import { Eyebrow, Loading, PageBody, PageHeader } from "../ui";
import { CutBlock } from "./WhatIf";

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

/** Meta's Rule of Two for one agent: which of A, B and C it holds, read off the flow layer. */
function RuleOfTwo({ id, c, scenario }: { id: string; c: DeVries; scenario: string }) {
  const card = c.scorecard?.agents.find((a) => a.agent_id === id);
  if (!card) return null;
  const held = (p: string) => card.properties.includes(p);
  return (
    <>
      <Eyebrow>Rule of Two</Eyebrow>
      <p className="badges">
        <span className={`badge${held("A") ? " on" : ""}`} title={card.untrusted_in.join(", ") || "no untrusted source reaches it"}>A · untrusted in</span>
        <span className={`badge${held("B") ? " on" : ""}`} title={card.private_in.join(", ") || "no private source reaches it"}>B · private in</span>
        <span className={`badge${held("C") ? " on" : ""}`} title={card.acts_on.join(", ") || "it acts on nothing"}>C · acts{card.external ? ", externally" : ""}</span>
      </p>
      <p className="read-facts">
        {card.count === 3
          ? card.autonomous
            ? "All three, and it runs an autonomous workflow: by Meta's rule it should not be permitted to operate autonomously."
            : "All three; its workflows are supervised, which is the rule's minimum."
          : card.count === 2 && held("A") && held("C")
            ? "Untrusted input and action: the rule's diagram calls this pair safe, and it is the shape of an injection path."
            : `${capital(card.verdict)} of the three properties.`}{" "}
        <a href={href(scenario, "queries", "reach.agents_from_sources")}>How it is read</a>.
      </p>
    </>
  );
}

function Read({ id, graph, c, scenario }: { id: string | null; graph: Graph; c: DeVries; scenario: string }) {
  const node = id ? nodeIndex(graph).get(id) : undefined;
  if (!node) {
    return (
      <aside className="read" aria-label="What was clicked">
        <p className="read-idle">Click a card to read what reaches it, what it reaches, and the findings that pass through it.</p>
      </aside>
    );
  }
  const into = graph.links.filter((l) => l.data.to_id === id);
  const out = graph.links.filter((l) => l.data.from_id === id);
  const through = [...(c.findings?.findings ?? []), ...(c.findings?.past ?? [])].filter((f) => nodesOn(f).has(node.data.id));
  const flow = graph.layer === "flow";
  const tainted = flow && !!node.data.tainted;
  return (
    <aside className="read picked" aria-label="What was clicked">
      <Eyebrow>{KIND_OF[node.label]}</Eyebrow>
      <h2>{node.data.name ?? node.data.id}</h2>
      <p className="read-id">{node.data.id}</p>
      <p className="read-facts">
        {capital(nodeFacts(node))}.{" "}
        {flow && (tainted ? "Untrusted text reaches it." : "Untrusted text does not reach it.")}{" "}
        {node.data.blast ? "Its community holds an untrusted source and a high-impact resource." : ""}
        {flow && node.data.pagerank !== undefined ? ` PageRank ${node.data.pagerank}, #${node.data.pagerank_rank} of ${graph.nodes.length} on the flow layer.` : ""}
      </p>
      {node.label === "Agent" && <RuleOfTwo id={node.data.id} c={c} scenario={scenario} />}
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
    </aside>
  );
}

type View = "overview" | "all" | "more";
type Show = "all" | "zones" | "cut" | "central";

/** An agent's Rule of Two letters, to print on its card. */
export function badgesOf(c: DeVries): Map<string, string> {
  return new Map((c.scorecard?.agents ?? []).map((a) => [a.agent_id, ["A", "B", "C"].filter((p) => a.properties.includes(p)).join("·") || "·"]));
}

export function GraphPage({ c, scenario }: { c: DeVries; scenario: string }) {
  const [view, setView] = useState<View>("overview");
  const [renderer, setRenderer] = useRenderer();
  const [canvasLayout, setCanvasLayout] = useState<"force" | "tree">("force");
  const [layer, setLayer] = useState<Layer>("flow");
  const [show, setShow] = useState<Show>("all");
  const [central, setCentral] = useState<Central | null>(null);
  const [cutHops, setCutHops] = useState<Set<string> | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const { needConfig } = c;
  useEffect(() => {
    if (layer === "config") needConfig();
  }, [layer, needConfig]);
  const graph = layer === "config" ? c.config : c.flow;
  const flow = layer === "flow";
  const zones = show === "zones";
  const cutting = show === "cut" && flow;
  const centring = show === "central" && flow;
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
  const zoneCount = new Set((graph?.nodes ?? []).map((n) => n.data.zone)).size;
  const communityCount = new Set((graph?.nodes ?? []).map((n) => n.data.community)).size;
  const inZone = graph?.nodes.filter((n) => n.data.blast).length ?? 0;
  const total = graph?.nodes.length ?? 0;
  const overview = c.overview?.scenario === scenario ? c.overview : null;

  return (
    <PageBody width="wide">
      <PageHeader
        eyebrow="Graph"
        title={overview ? overview.sentence : graph ? `${capital(plural(graph.nodes.length, "node", "nodes"))}, ${plural(graph.links.length, flow ? "flow" : "config edge", flow ? "flows" : "config edges")}.` : "The graph."}
        meta={view === "overview"
          ? "Only the open paths are drawn: what outsiders write, the agents it reaches, the actions those agents can take. Everything else is folded into the counts. A path means text can flow, not that it did."
          : flow
            ? "Where text and data can travel. Every arc is derived from the config by one of seven rules, and a path means it can flow, not that it did."
            : "What is configured: which agent can call which tool, who delegates to whom, and what each tool reads and acts on."}
      />
      <div className="chart-controls">
        <span className="control">View</span>
        <div className="pills" role="tablist" aria-label="View">
          <button role="tab" aria-selected={view === "overview"} className={view === "overview" ? "on" : ""} onClick={() => setView("overview")}>Overview</button>
          <button role="tab" aria-selected={view === "all"} className={view === "all" ? "on" : ""} onClick={() => { setView("all"); setShow("all"); setLayer("flow"); }}>All nodes</button>
          <button role="tab" aria-selected={view === "more"} className={view === "more" ? "on" : ""} onClick={() => setView("more")}>More</button>
        </div>
        {view !== "overview" && <RendererSwitch value={renderer} onChange={setRenderer} layout={canvasLayout} onLayout={setCanvasLayout} />}
      </div>

      {view === "overview" && (
        overview ? (
          <figure className="figure">
            <OverviewCounts view={overview} />
            <OverviewSankey view={overview} names={c.names} scenario={scenario} />
            <figcaption className="chart-note">
              Source: {scenario}{overview.own_copy ? " (your sandbox copy)" : ""} in FalkorDB, read by{" "}
              {overview.queries.map((q, i) => <span key={q}>{i > 0 && ", "}<a href={href(scenario, "queries", q)}>{q}</a></span>)}.{" "}
              A ribbon is one open finding; its width is the number of routes; d3-sankey orders the columns so the ribbons cross least. An agent's line reads A · B · C for Meta's Rule of Two.
              {overview.counts.cut_cost != null && ` The cheapest cut costs ${overview.counts.cut_cost}, by max flow.`}
            </figcaption>
          </figure>
        ) : <Loading label={c.ready ? "Reading the graph" : "Connecting"} />
      )}

      {view !== "overview" && (
        <div className="graph-split">
          <figure className="figure">
            {view === "more" && (
              <div className="chart-controls">
                <span className="control">Layer</span>
                <div className="pills" role="tablist" aria-label="Layer">
                  <button role="tab" aria-selected={flow} className={flow ? "on" : ""} onClick={() => { setLayer("flow"); setPicked(null); }}>Flow</button>
                  <button role="tab" aria-selected={!flow} className={!flow ? "on" : ""} onClick={() => { setLayer("config"); setPicked(null); }}>Config</button>
                </div>
                {renderer === "devries" && (
                  <>
                    <span className="control">Show</span>
                    <div className="pills" role="tablist" aria-label="How much">
                      <button role="tab" aria-selected={show === "all"} className={show === "all" ? "on" : ""} onClick={() => setShow("all")}>Everything</button>
                      <button role="tab" aria-selected={zones} className={zones ? "on" : ""} onClick={() => setShow("zones")}
                        title="Communities by label propagation over the config edges; a blast community holds both an untrusted source and a high-impact resource">
                        Communities · {communityCount}
                      </button>
                      {flow && (
                        <button role="tab" aria-selected={cutting} className={cutting ? "on" : ""} onClick={() => setShow("cut")}
                          title="The least that has to be cut to separate every untrusted source from every high-impact resource, by max flow">
                          Cheapest cut
                        </button>
                      )}
                      {flow && (
                        <button role="tab" aria-selected={centring} className={centring ? "on" : ""} onClick={() => setShow("central")}
                          title="The five agents and tools that the most flow passes through, by betweenness centrality">
                          Most central
                        </button>
                      )}
                    </div>
                  </>
                )}
              </div>
            )}
            {graph ? (
              <Chart renderer={renderer} layout={canvasLayout} graph={graph} names={c.names} communities={zones} cuts={cutting ? cutHops ?? undefined : undefined} cutsMean="on the cheapest cut"
                rings={rings} badges={badges} picked={picked} onPick={setPicked} idle="Hover a card to read it. Click it to read about it beside the chart." />
            ) : <Loading label={c.ready ? "Reading the graph" : "Connecting"} />}
            {cutting && <CutBlock c={c} scenario={scenario} compact />}
            {centring && central?.scenario === scenario && (
              <div className="chart-note cut-note central-note">
                <p><strong>Most central.</strong> The agents and tools the most flow passes through, by betweenness centrality on the flow layer: where a change would touch the most paths. Context for a person; no verdict rests on it.</p>
                <ol className="cut-list">
                  {central.nodes.map((n) => <li key={n.id}><WithNames text={n.id} names={c.names} /><span> · {n.label.toLowerCase()} · {n.score}</span></li>)}
                </ol>
                <p>Worked out by <a href={href(scenario, "queries", "choke.betweenness")}>choke.betweenness</a>, which runs FalkorDB's <code>algo.betweenness</code> with a fixed sampling seed.</p>
              </div>
            )}
            {zones && graph && (
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
            {graph && (
              <figcaption className="chart-note">
                Source: the {layer} layer of {scenario}{c.current?.own_copy ? " (your sandbox copy)" : ""} in FalkorDB, read by{" "}
                {graph.queries.map((q, i) => <span key={q}>{i > 0 && ", "}<a href={href(scenario, "queries", q)}>{q}</a></span>)}.{" "}
                {renderer === "falkordb"
                  ? "Drawn by FalkorDB's canvas component on the database's own node ids; the colours are DeVries's facts."
                  : "Laid out by ELK in lanes, drawn with React Flow; a card is filled when untrusted text reaches it, which FalkorDB works out (reach.untrusted_nodes)."}
                {flow ? " A path means text can flow, not that it did." : " Config edges are what a person set up; the flow layer is derived from them."}
                {c.health?.canary && <> Self-check: {c.health.canary.ok ? "passed" : "FAILED"} ({c.health.canary.detail}).</>}
              </figcaption>
            )}
            {graph && view === "more" && (
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
      )}
    </PageBody>
  );
}
