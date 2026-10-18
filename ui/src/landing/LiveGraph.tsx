// The graph, doing the work: the support desk's flow layer as FalkorDB holds it, drawn by the app's own renderer
// and read under the Explorer's lenses in turn. Each lens is one catalog query, and the caption names it. The
// data is read from the running app once the section is near the screen; nothing here is typed in.

import { useEffect, useMemo, useState } from "react";
import { api, type Central, type Cut, type Findings, type Graph } from "../api";
import { Chart, RendererSwitch, type Renderer } from "../graph/Chart";
import { focusOf, type Focus, type Series } from "../paths";
import { useInView } from "./bits";

const SCENARIO = "acme_support";
type Lens = "paths" | "cut" | "central" | "zones";
const LENSES: { id: Lens; word: string; says: string; queries: string[] }[] = [
  { id: "paths", word: "Open paths", says: "Every node untrusted text reaches, and the hops it takes to a high-impact action.", queries: ["reach.untrusted_to_high", "evidence.pair_paths", "algo.bfs"] },
  { id: "cut", word: "Cheapest cut", says: "The hops max flow picks to close everything open while every workflow keeps what it needs.", queries: ["choke.maxflow", "algo.maxFlow"] },
  { id: "central", word: "Choke points", says: "The agents and tools most paths run through, ranked by betweenness.", queries: ["choke.betweenness", "algo.betweenness"] },
  { id: "zones", word: "Communities", says: "Who talks to whom, as label propagation groups the graph.", queries: ["zones.communities", "algo.labelPropagation"] },
];
const DWELL_MS = 4500;
const IDLE = "Hover a card to read it. In the app a click picks it, and the tables and the what-if line follow.";

/** What every open finding lights up, as one focus: their nodes and hops together. */
function openFocus(findings: Findings | null): Focus | null {
  const open = (findings?.findings ?? []).filter((f) => f.status === "open" && (f.kind === "injection" || f.kind === "trifecta"));
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

export function LiveGraph() {
  const [ref, inView] = useInView<HTMLDivElement>({ once: true, amount: 0.05, margin: "240px" });
  const [graph, setGraph] = useState<Graph | null>(null);
  const [findings, setFindings] = useState<Findings | null>(null);
  const [cut, setCut] = useState<Cut | null>(null);
  const [central, setCentral] = useState<Central | null>(null);
  const [failed, setFailed] = useState(false);
  const [lens, setLens] = useState<Lens>("paths");
  const [held, setHeld] = useState(false);                 // the pointer is on it, or a lens was picked: the cycle waits
  const [renderer, setRenderer] = useState<Renderer>("devries");
  const [layout, setLayout] = useState<"force" | "tree">("tree");
  // on a phone the whole system fits the box, small; on a wider screen the type stays legible and the chart pans
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    const read = () => setNarrow(mq.matches);
    mq.addEventListener("change", read);
    return () => mq.removeEventListener("change", read);
  }, []);

  useEffect(() => {
    if (!inView) return;
    let wanted = true;
    Promise.all([api.graph(SCENARIO, "flow"), api.findings(SCENARIO), api.cut(SCENARIO), api.central(SCENARIO)])
      .then(([g, f, c, n]) => {
        if (!wanted) return;
        setGraph(g);
        setFindings(f);
        setCut(c);
        setCentral(n);
      })
      .catch(() => wanted && setFailed(true));
    return () => {
      wanted = false;
    };
  }, [inView]);

  useEffect(() => {
    if (!graph || held) return;
    const id = window.setInterval(() => setLens((l) => LENSES[(LENSES.findIndex((x) => x.id === l) + 1) % LENSES.length].id), DWELL_MS);
    return () => window.clearInterval(id);
  }, [graph, held]);

  const names = useMemo(
    () => ({ ...(findings?.names ?? {}), ...Object.fromEntries((graph?.nodes ?? []).map((n) => [n.data.id, n.data.name ?? n.data.id])) }),
    [graph, findings],
  );
  const focus = useMemo(() => (lens === "paths" ? openFocus(findings) : null), [lens, findings]);
  const cuts = useMemo(() => (lens === "cut" && cut ? new Set(cut.hops.map((h) => `${h.from_id}>${h.to_id}`)) : undefined), [lens, cut]);
  const rings = useMemo(() => (lens === "central" && central ? new Map(central.nodes.map((n, i) => [n.id, i + 1])) : undefined), [lens, central]);
  const now = LENSES.find((l) => l.id === lens)!;

  return (
    <div ref={ref} className="l-live" onMouseEnter={() => setHeld(true)} onMouseLeave={() => setHeld(false)}>
      <div className="l-live-bar">
        <div className="pills" role="tablist" aria-label="Lens">
          {LENSES.map((l) => (
            <button key={l.id} role="tab" aria-selected={lens === l.id} className={lens === l.id ? "on" : ""} onClick={() => { setLens(l.id); setHeld(true); }}>
              {l.word}
            </button>
          ))}
        </div>
        <RendererSwitch value={renderer} onChange={setRenderer} layout={layout} onLayout={setLayout} />
      </div>
      <figure className="figure l-live-figure">
        {graph ? (
          <Chart renderer={renderer} layout={layout} graph={graph} names={names} focus={focus} only={false} communities={lens === "zones"}
            cuts={cuts} cutsMean="on the cheapest cut" rings={rings} idle={IDLE} heightRange={narrow ? [180, 260] : [320, 460]} fitZoom={2.1} minZoom={narrow ? 0.3 : 0.9} />
        ) : (
          <div className="l-live-wait">{failed ? "The graph could not be read; it is drawn once the app is running." : inView ? "Reading the support desk from FalkorDB…" : ""}</div>
        )}
      </figure>
      <p className="l-live-caption">
        <strong>{now.word}.</strong> {now.says} <span className="l-live-queries">{now.queries.join(" · ")}</span>
      </p>
    </div>
  );
}
