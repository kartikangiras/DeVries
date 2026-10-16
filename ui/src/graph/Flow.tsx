// DeVries's own chart, drawn with React Flow and laid out by ELK: every node a card in its lane, every hop a
// labelled arc, a finding's path lit, a plan's cuts marked, the most central ringed, communities coloured.
// What a card says is FalkorDB's answer (tainted, trust, impact, gates); the page only draws it.
//
// Motion says what the chart means: cards arrive lane by lane in the order text travels; a lit hop
// carries a spark along it, hop after hop, and the spark stops where a gate stops the text; a hovered
// card lifts its own arcs. All of it is off under prefers-reduced-motion.

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  BaseEdge, EdgeLabelRenderer, Handle, Position, ReactFlow, ReactFlowProvider, getBezierPath, useReactFlow,
  type Edge, type EdgeProps, type Node, type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { Graph } from "../api";
import { type Focus, type Series } from "../paths";
import { WithNames, plural } from "../text";
import { edgeFacts, edgeWord, factOf, LANES, lanesOf, markOf } from "./model";
import { textWidth } from "./layout";

export type FlowProps = {
  graph: Graph;
  names: Record<string, string>;
  /** What a finding lights up. Without one the whole graph is drawn evenly. */
  focus?: Focus | null;
  /** Draw the focus alone, not the system around it. */
  only?: boolean;
  /** Hops a plan would cut, as "from>to"; and what the key calls the mark on them. */
  cuts?: Set<string>;
  cutsMean?: string;
  /** Nodes to ring, with the rank to print: the most central, by betweenness. */
  rings?: Map<string, number>;
  /** Colour each card's edge by the community its node belongs to. */
  communities?: boolean;
  /** Footnote numbers to print beside names. */
  cites?: Map<string, number>;
  /** A short badge per node, such as an agent's Rule of Two letters. */
  badges?: Map<string, string>;
  picked?: string | null;
  onPick?: (id: string | null) => void;
  idle?: string;
  height?: number;
};

type CardData = {
  id: string; name: string; kind: string; fact: string; mark: "hot" | "private" | "plain"; code: boolean; lane: number;
  lit: boolean; dim: boolean; picked: boolean; cite?: number; badge?: string; rank?: number; community?: number;
};
/** Where a hop stands in its chain of lit hops: the i-th of n, so a spark can run them in order. */
type Link = { i: number; n: number };
type ArcData = { key: string; word: string; sentence: string; gated: boolean; gate: string | null; series: Series | null; onFocus: boolean; cut: boolean; dim: boolean; near: boolean; chain: Link | null };
type Card = Node<CardData, "card">;
type Arc = Edge<ArcData, "arc">;
type LaneNode = Node<{ label: string }, "lane">;

const SANS = '500 12.5px "Geist Sans", ui-sans-serif, system-ui, sans-serif';
const MONO = '400 11px "Geist Mono", ui-monospace, monospace';
const CARD_H = 46;

function CardView({ data }: NodeProps<Card>) {
  const cls = ["dot", "fcard", `k-${data.kind}`, data.mark, data.lit ? "lit" : "", data.dim ? "dim" : "", data.picked ? "picked" : "",
    data.rank != null ? "central" : "", data.community != null ? `c${data.community % 6}` : ""].filter(Boolean).join(" ");
  return (
    <div className={cls} data-id={data.id} title={data.id} style={{ "--lane": data.lane } as CSSProperties}>
      <Handle type="target" position={Position.Left} className="fport" />
      <span className="mark" aria-hidden />
      <span className="fcard-text">
        <span className={`name${data.code ? " code" : ""}`}>
          {data.name}
          {data.cite != null && <sup className="cite">[{data.cite}]</sup>}
        </span>
        {data.fact && <span className="fact">{data.fact}</span>}
      </span>
      {data.badge && <span className="fbadge">{data.badge}</span>}
      {data.rank != null && <span className="rank">#{data.rank}</span>}
      <Handle type="source" position={Position.Right} className="fport" />
    </div>
  );
}

function LaneView({ data }: NodeProps<LaneNode>) {
  return <div className="lane"><span>{data.label}</span></div>;
}

/** When the spark is on this hop: the i-th slot of n in one period, as SMIL key times without repeated stamps. */
function sparkTiming({ i, n }: Link) {
  const s = i / n, e = (i + 1) / n;
  const motion: [number, number][] = [[0, 0], [s, 0], [e, 1], [1, 1]];
  const shown: [number, number][] = [[0, 0], [s, 1], [e, 0]];
  const dedupe = (pairs: [number, number][]) => pairs.filter(([t], k) => k === 0 || t > pairs[k - 1][0]);
  const m = dedupe(motion), o = dedupe(shown);
  return {
    period: `${Math.max(1.6, n * 0.75)}s`,
    keyTimes: m.map(([t]) => t).join(";"), keyPoints: m.map(([, p]) => p).join(";"),
    showTimes: o.map(([t]) => t).join(";"), showValues: o.map(([, v]) => v).join(";"),
  };
}

function ArcView({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, markerEnd }: EdgeProps<Arc>) {
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, curvature: 0.35 });
  const d = data!;
  const cls = ["wire", d.series ? `s-${d.series}` : "", d.gated ? "gated" : "", d.onFocus ? "traced" : "", d.dim ? "dim" : "", d.cut ? "cut" : "", d.near ? "near" : ""].filter(Boolean).join(" ");
  // the spark runs along a lit hop that is open; a gate is where the text stops, so the spark stops before it
  const spark = d.chain && d.series && !d.gated ? sparkTiming(d.chain) : null;
  return (
    <g className={cls} data-hop={d.key}>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} className="line" />
      <EdgeLabelRenderer>
        <div className={`wire-label${d.dim ? " dim" : ""}${d.near ? " near" : ""}`} style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY - 11}px)` }}>
          {d.word}
      {spark && (
        <circle className="spark" r={3.2} opacity={0}>
          <animateMotion dur={spark.period} repeatCount="indefinite" path={path} calcMode="linear" keyPoints={spark.keyPoints} keyTimes={spark.keyTimes} />
          <animate attributeName="opacity" dur={spark.period} repeatCount="indefinite" calcMode="discrete" values={spark.showValues} keyTimes={spark.showTimes} />
        </circle>
      )}
          {d.cut && <span className="cut-mark" aria-label="where the plan cuts">‖</span>}
        </div>
      </EdgeLabelRenderer>
    </g>
  );
}

const NODE_TYPES = { card: CardView, lane: LaneView };
const EDGE_TYPES = { arc: ArcView };

/** Places the cards with ELK, in lanes, left to right. Loaded on first use so the page's own bundle stays small. */
async function place(cards: { id: string; width: number; height: number; lane: number }[], arcs: { id: string; source: string; target: string }[]) {
  const { default: ELK } = await import("elkjs/lib/elk.bundled.js");
  const elk = new ELK();
  const laid = await elk.layout({
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.partitioning.activate": "true",
      "elk.spacing.nodeNode": "20",
      "elk.layered.spacing.nodeNodeBetweenLayers": "84",
      "elk.layered.spacing.edgeNodeBetweenLayers": "30",
      "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
      "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
      "elk.layered.nodePlacement.bk.fixedAlignment": "BALANCED",
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
    },
    children: cards.map((c) => ({ id: c.id, width: c.width, height: c.height, layoutOptions: { "elk.partitioning.partition": String(c.lane) } })),
    edges: arcs.map((a) => ({ id: a.id, sources: [a.source], targets: [a.target] })),
  });
  return new Map((laid.children ?? []).map((c) => [c.id, { x: c.x ?? 0, y: c.y ?? 0 }]));
}

function Inner(props: FlowProps) {
  const { graph, names, focus, only, cuts, cutsMean, rings, communities, cites, badges, picked, onPick, idle, height } = props;
  const [positions, setPositions] = useState<Map<string, { x: number; y: number }> | null>(null);
type Hop = { key: string; from: string; to: string; series: Series | null; gated: boolean };

/** The lit hops in the order the text travels, one chain per series. A chain ends at a gate, where the text does. */
function chainsOf(hops: Hop[]): Map<string, Link> {
  const out = new Map<string, Link>();
  for (const series of ["hot", "private", "exit"] as Series[]) {
    const mine = hops.filter((h) => h.series === series);
    if (!mine.length) continue;
    const tos = new Set(mine.map((h) => h.to));
    const byFrom = new Map(mine.map((h) => [h.from, h]));
    const chain: Hop[] = [];
    const seen = new Set<string>();
    let at: Hop | undefined = mine.find((h) => !tos.has(h.from)) ?? mine[0];
    while (at && !seen.has(at.key)) {
      seen.add(at.key);
      chain.push(at);
      if (at.gated) break;
      at = byFrom.get(at.to);
    }
    chain.forEach((h, i) => out.set(h.key, { i, n: chain.length }));
  }
  return out;
}

  const [over, setOver] = useState<string | null>(null);
  const [boxWidth, setBoxWidth] = useState(900);
  const box = useRef<HTMLDivElement>(null);
  const flow = useReactFlow();
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const read = () => setBoxWidth(Math.max(320, el.clientWidth - 2));
    read();
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // which nodes and edges are drawn, and what each says
  const model = useMemo(() => {
    const lanes = lanesOf(graph);
    const wanted = new Set<string>(only && focus ? focus.nodes : graph.nodes.map((n) => n.data.id));
    const nodes = graph.nodes.filter((n) => wanted.has(n.data.id));
    const links = graph.links.filter((l) => wanted.has(l.data.from_id) && wanted.has(l.data.to_id));
    const cards = nodes.map((n) => {
      const id = n.data.id;
      const name = names[id] ?? n.data.name ?? id;
      const fact = factOf(n);
      const width = Math.max(128, Math.round(Math.max(textWidth(name, SANS) + 16, textWidth(fact, MONO)) + 58 + (badges?.get(id) ? 44 : 0)));
      return { id, lane: lanes.get(id) ?? 3, width, height: fact ? CARD_H + 14 : CARD_H, node: n, name, fact };
    });
    return { cards, links, lanes };
  }, [graph, names, focus, only, badges]);

  useEffect(() => {
    let wanted = true;
    const m = latest.current;
  // The layout is asked for again only when what is drawn changes: which cards, how wide, which arcs. A page that
  // rebuilds its graph object on every render, or hovers, or picks, must not cancel a layout that is under way.
  const layoutKey = useMemo(
    () => `${graph.scenario}/${graph.layer}/${model.cards.map((c) => `${c.id}:${c.width}:${c.height}`).join(",")}/${model.links.map((l) => `${l.data.from_id}>${l.data.to_id}`).join(",")}`,
    [graph.scenario, graph.layer, model],
  );
  const latest = useRef(model);
  latest.current = model;
    place(m.cards.map(({ id, width, height, lane }) => ({ id, width, height, lane })), m.links.map((l) => ({ id: String(l.id), source: l.data.from_id, target: l.data.to_id })))
      .then((laid) => { if (wanted) setPositions(laid); })
      .catch(() => { if (wanted) setPositions(new Map(m.cards.map((c, i) => [c.id, { x: c.lane * 220, y: i * 64 }]))); });
    return () => { wanted = false; };
  }, [layoutKey]);

  const overCard = over && model.cards.some((c) => c.id === over) ? over : null;

  const { nodes, extent } = useMemo(() => {
    if (!positions) return { nodes: [] as (Card | LaneNode)[], extent: { w: 900, h: 320 } };
    const lit = focus?.nodes ?? null;
    const cards: Card[] = model.cards.map(({ id, node, name, fact, width, height, lane }) => ({
      id, type: "card", position: positions.get(id) ?? { x: 0, y: 0 }, width, height, draggable: false, connectable: false, selectable: false,
      data: {
        id, name, fact, kind: node.label, mark: markOf(node), code: node.label === "Tool", lane,
        lit: !!lit?.has(id), dim: !!lit && !lit.has(id) && !only, picked: picked === id, cite: cites?.get(id), badge: badges?.get(id), rank: rings?.get(id),
        community: communities ? node.data.community : undefined,
      },
    }));
    const arcs: Arc[] = model.links.map((l) => {
      const f = edgeFacts(l, focus);
      return {
        id: String(l.id), type: "arc", source: l.data.from_id, target: l.data.to_id, selectable: false, focusable: false,
        data: { key: f.key, word: edgeWord(l), sentence: f.sentence, gated: f.gated, gate: f.gate, series: f.series, onFocus: f.onFocus, cut: !!cuts?.has(f.key), dim: !!focus && !f.onFocus && !only },
        zIndex: f.onFocus ? 2 : 1,
      };
    });
    // one caption per lane that has a card in it, above the cards
    let minY = Infinity, maxY = -Infinity, maxX = 0;
    for (const c of cards) { minY = Math.min(minY, c.position.y); maxY = Math.max(maxY, c.position.y + (c.height ?? CARD_H)); maxX = Math.max(maxX, c.position.x + (c.width ?? 120)); }
    const byLane = new Map<number, number[]>();
    for (const c of model.cards) { const p = positions.get(c.id); if (p) byLane.set(c.lane, [...(byLane.get(c.lane) ?? []), p.x + c.width / 2]); }
    const laneNodes: LaneNode[] = [...byLane].map(([lane, xs]) => ({
      id: `lane:${lane}`, type: "lane", position: { x: xs.reduce((a, b) => a + b, 0) / xs.length - 70, y: minY - 38 }, width: 140, height: 20,
      draggable: false, selectable: false, connectable: false, data: { label: LANES[lane] },
    }));
    return { nodes: [...laneNodes, ...cards], extent: { w: maxX, h: maxY - minY + 44 } };
  }, [positions, model, focus, only, rings, communities, cites, badges, picked]);

  useEffect(() => {
    if (nodes.length) window.requestAnimationFrame(() => flow.fitView({ padding: 0.06, maxZoom: 1, duration: 0 }));
  }, [nodes, flow]);

  // the chart is drawn at the scale the box's width allows, never larger than life, and the box is as tall as that needs
  const scale = Math.min(1, (boxWidth - 24) / Math.max(extent.w, 1));
  const boxHeight = height ?? Math.max(300, Math.min(760, Math.round(extent.h * scale + 76)));
  const overNode = over ? model.cards.find((c) => c.id === over) : null;
  const overEdge = over && !overNode ? model.links.find((l) => String(l.id) === over) : null;
  const anyPrivate = model.cards.some((c) => markOf(c.node) === "private");
  const anyGated = model.links.some((l) => edgeFacts(l).gated);

  // The layout is asked for again only when what is drawn changes: which cards, how wide, which arcs. A page that
  // rebuilds its graph object on every render, or hovers, or picks, must not cancel a layout that is under way.
  const layoutKey = useMemo(
    () => `${graph.scenario}/${graph.layer}/${model.cards.map((c) => `${c.id}:${c.width}:${c.height}`).join(",")}/${model.links.map((l) => `${l.data.from_id}>${l.data.to_id}`).join(",")}`,
    [graph.scenario, graph.layer, model],
  );
  const latest = useRef(model);
  latest.current = model;
  return (
    <div className={`chart flowchart${positions ? "" : " laying-out"}`} style={{ height: boxHeight }} ref={box}>
      <ReactFlow
        nodes={nodes} edges={edges} nodeTypes={NODE_TYPES} edgeTypes={EDGE_TYPES}
        fitView fitViewOptions={{ padding: 0.06, maxZoom: 1 }} minZoom={0.3} maxZoom={1.8}
        nodesDraggable={false} nodesConnectable={false} elementsSelectable={false} zoomOnScroll={false} zoomOnDoubleClick={false} preventScrolling={false} panOnScroll={false}
        proOptions={{ hideAttribution: true }} colorMode="dark"
        onNodeMouseEnter={(_, n) => n.type === "card" && setOver(n.id)} onNodeMouseLeave={() => setOver(null)}
        onEdgeMouseEnter={(_, e) => setOver(e.id)} onEdgeMouseLeave={() => setOver(null)}
        onNodeClick={(_, n) => n.type === "card" && onPick?.(picked === n.id ? null : n.id)}
        onEdgeClick={() => undefined}                                  /* with a click handler the arcs take the pointer, so they can be hovered */
        onPaneClick={() => onPick?.(null)}
      >
        <button className="fit" onClick={() => flow.fitView({ padding: 0.06, maxZoom: 1, duration: 200 })} title="Fit the chart to the box" aria-label="Fit">⤢</button>
      </ReactFlow>
      <div className="chart-key" aria-hidden>
        <span><i className="k-hot" />reached by untrusted text</span>
        {anyPrivate && <span><i className="k-private" />private data</span>}
        <span><i className="k-plain" />not reached</span>
        {anyGated && <span><i className="k-gate" />blocked by a gate</span>}
        {cuts && cuts.size > 0 && <span><i className="k-cut" />{cutsMean ?? "where the fix cuts"}</span>}
        {rings && rings.size > 0 && <span><i className="k-ring" />#n: most central</span>}
        {communities && [...new Set(model.cards.map((c) => c.node.data.community).filter((n): n is number => n != null))].sort((a, b) => a - b).map((n) => (
          <span key={n}><i className={`k-c${n % 6}`} />community {n}</span>
        ))}
        <span className="reads">text and data flow this way →</span>
      </div>
      <p className="chart-over" aria-live="polite">
        {overNode ? (
          <><strong>{overNode.name}</strong> <code>{overNode.id}</code>
            {markOf(overNode.node) === "hot" ? "untrusted text reaches it" : markOf(overNode.node) === "private" ? "private data" : "untrusted text does not reach it"}
            {overNode.fact ? ` · ${overNode.fact}` : ""} · {plural(model.links.filter((l) => l.data.from_id === overNode.id || l.data.to_id === overNode.id).length, "arc", "arcs")}</>
        ) : overEdge ? (
          <><strong>{edgeWord(overEdge)}:</strong> <WithNames text={edgeFacts(overEdge).sentence} names={names} />{edgeFacts(overEdge).gated ? ` · blocked by ${overEdge.data.gate === "quarantine" ? "a quarantine" : "an approval gate"}` : ""}</>
        ) : positions ? idle ?? "Hover a card to read it. Click it to pick it." : "Laying the chart out…"}
      </p>
    </div>
  );
}

/** The chart in its own React Flow scope, so several can sit on one page. */
export function Flow(props: FlowProps) {
  return (
    <ReactFlowProvider>
      <Inner {...props} />
    </ReactFlowProvider>
  );
}
