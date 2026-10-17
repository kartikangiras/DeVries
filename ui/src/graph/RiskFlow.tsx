// Where the risk is, as a live flow: the untrusted sources on the left, the agents their text reaches, the
// high-impact actions those agents can take on the right, each a card with its figure, and the open paths
// between them carrying tokens that run endlessly, the way text an outsider plants would. Drawn with React
// Flow on a dotted ground, panned and zoomed like a map; a hovered path reads its finding, a click opens it,
// a clicked card opens the Explorer on it. What a card says is FalkorDB's answer; the page only draws it.
// Motion is off under prefers-reduced-motion: the tokens then sit still, one per path.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Background, BackgroundVariant, BaseEdge, Handle, Position, ReactFlow, ReactFlowProvider, getBezierPath, useReactFlow,
  type Edge, type EdgeProps, type Node, type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { Overview, Posture, Ribbon } from "../api";
import { go } from "../route";
import { countWord, plural } from "../text";

type Series = "hot" | "private" | "exit";
type CardData = {
  id: string; kind: "source" | "private" | "agent" | "action"; eyebrow: string; name: string; sub: string;
  figure: { label: string; value: string; unit: string } | null; letters?: string[]; badge?: string;
  tone: "hot" | "private" | "accent" | "plain"; worst: boolean; dim: boolean; col: number;
};
type RiverData = { finding: string; kind: Ribbon["kind"]; series: Series; tokens: number; dim: boolean; lit: boolean };
type Card = Node<CardData, "rcard">;
type River = Edge<RiverData, "river">;
type LaneNode = Node<{ label: string }, "lane">;

const CARD_W = 222;
const CARD_H = 196;
const COL_GAP = 300;
const ROW_GAP = 26;
const FIT_ZOOM = 1.15;
const FIT_PAD = 0.08;

function CardView({ data }: NodeProps<Card>) {
  const cls = ["rcard", `rk-${data.kind}`, `t-${data.tone}`, data.worst ? "worst" : "", data.dim ? "dim" : ""].filter(Boolean).join(" ");
  return (
    <div className={cls} data-id={data.id} title={data.id} style={{ width: CARD_W, height: CARD_H }}>
      <Handle type="target" position={Position.Left} className="fport" />
      <span className="rcard-eyebrow">{data.eyebrow}</span>
      <span className="rcard-name">{data.name}</span>
      <span className="rcard-sub">{data.sub}</span>
      {data.letters ? (
        <span className="rcard-figure">
          <span className="lbl">holds</span>
          <span className="rcard-letters" aria-label={`holds ${data.letters.filter((l) => l).join(", ") || "none"}`}>
            {(["A", "B", "C"] as const).map((k) => <i key={k} className={`s-${k === "A" ? "hot" : k === "B" ? "private" : "exit"}${data.letters!.includes(k) ? " on" : ""}`}>{k}</i>)}
          </span>
          <span className="unit">{data.figure?.unit}</span>
        </span>
      ) : data.figure ? (
        <span className="rcard-figure">
          <span className="lbl">{data.figure.label}</span>
          <span className="val">{data.figure.value}</span>
          <span className="unit">{data.figure.unit}</span>
        </span>
      ) : null}
      {data.badge && <span className="rcard-badge">{data.badge}</span>}
      <Handle type="source" position={Position.Right} className="fport" />
    </div>
  );
}

function LaneView({ data }: NodeProps<LaneNode>) {
  return <div className="lane"><span>{data.label}</span></div>;
}

const still = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** One open hop: a faint line, and tokens running along it for as long as the path is open. */
function RiverView({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data }: EdgeProps<River>) {
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, curvature: 0.32 });
  const d = data!;
  const cls = ["river", `s-${d.series}`, d.lit ? "lit" : "", d.dim ? "dim" : ""].filter(Boolean).join(" ");
  const period = 3.6;
  return (
    <g className={cls} data-finding={d.finding}>
      <BaseEdge id={id} path={path} className="line" />
      {still() ? (
        <circle className="token" r={5} cx={labelX} cy={labelY} />
      ) : (
        Array.from({ length: d.tokens }, (_, k) => (
          <circle className="token" key={k} r={5}>
            <animateMotion dur={`${period}s`} begin={`${-(k * period) / d.tokens}s`} repeatCount="indefinite" path={path} calcMode="linear" />
          </circle>
        ))
      )}
    </g>
  );
}

const NODE_TYPES = { rcard: CardView, lane: LaneView };
const EDGE_TYPES = { river: RiverView };

export type RiskFlowProps = { view: Overview; posture?: Posture | null; names: Record<string, string>; scenario: string };

function Inner({ view, posture, names, scenario }: RiskFlowProps) {
  const [over, setOver] = useState<{ kind: "card" | "river"; id: string } | null>(null);
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
  const name = (id: string | null | undefined) => (id ? names[id] ?? id : "");

  // the cards, their columns, and the hops of every open finding
  const model = useMemo(() => {
    const { sources, agents, actions } = view.columns;
    const blast = new Map((posture?.blast ?? []).map((b) => [b.id, b]));
    const targets = new Map((posture?.targets ?? []).map((t) => [t.id, t]));
    const cardsOf = new Map<string, Omit<CardData, "dim">>();
    // how deep an agent sits: the furthest place it takes in any chain
    const depth = new Map<string, number>();
    for (const r of view.ribbons) r.agent_ids.forEach((a, i) => depth.set(a, Math.max(depth.get(a) ?? 1, i + 1)));
    const agentCols = Math.max(1, ...[...depth.values()]);
    const lastCol = agentCols + 1;
    for (const s of sources) {
      const b = blast.get(s.id);
      const routes = view.ribbons.filter((r) => r.source_id === s.id || r.untrusted_ids?.includes(s.id)).reduce((n, r) => n + Math.max(1, r.routes), 0);
      cardsOf.set(s.id, {
        id: s.id, kind: "source", eyebrow: "untrusted source", name: s.name, sub: "outsiders write it", col: 0, tone: "hot", worst: false,
        figure: b ? { label: "its text reaches", value: String(b.reached), unit: `${plural(b.agents, "agent", "agents")}${b.high ? ` · ${countWord(b.high)} high-impact` : ""}${b.external ? ` · ${countWord(b.external)} way${b.external === 1 ? "" : "s"} out` : ""}` }
          : { label: "open routes", value: String(routes), unit: routes === 1 ? "route from it" : "routes from it" },
        badge: s.trust ?? "untrusted",
      });
    }
    for (const r of view.ribbons) {
      for (const p of r.private_ids ?? []) {
        if (cardsOf.has(p)) continue;
        cardsOf.set(p, { id: p, kind: "private", eyebrow: "private source", name: name(p), sub: "data that must not leak", col: 0, tone: "private", worst: false,
          figure: { label: "feeds", value: String(view.ribbons.filter((x) => x.private_ids?.includes(p)).length), unit: "agents on an open path" }, badge: "private" });
      }
    }
    for (const a of agents) {
      const count = a.properties.length;
      cardsOf.set(a.id, {
        id: a.id, kind: "agent", eyebrow: "agent", name: a.name, sub: a.autonomous ? "runs unattended" : "supervised by a person", col: depth.get(a.id) ?? 1,
        tone: count === 3 ? "hot" : "accent", worst: a.autonomous && count === 3, letters: a.properties,
        figure: { label: "holds", value: "", unit: count === 3 ? "all three" : `${countWord(count)} of three` },
        badge: a.autonomous ? "unattended" : "supervised",
      });
    }
    for (const t of actions) {
      const x = targets.get(t.id);
      cardsOf.set(t.id, {
        id: t.id, kind: "action", eyebrow: t.external ? "way out" : "high-impact action", name: t.name, col: lastCol, tone: "hot", worst: false,
        sub: [t.impact ? `${t.impact} impact` : "", t.external ? "leaves the organisation" : "inside the organisation"].filter(Boolean).join(" · "),
        figure: x ? { label: "reached by", value: String(x.reaching), unit: plural(x.reaching, "untrusted source", "untrusted sources").replace(/^\S+ /, "") }
          : { label: "reached by", value: String(view.ribbons.filter((r) => r.target_id === t.id || r.exit_ids?.includes(t.id)).length), unit: "open findings" },
        badge: t.external ? "external" : t.impact ?? undefined,
      });
    }
    // the hops, one per finding and pair, each carrying tokens with the number of routes
    const rivers: { from: string; to: string; finding: string; kind: Ribbon["kind"]; series: Series; tokens: number }[] = [];
    const seen = new Set<string>();
    const add = (from: string, to: string, r: Ribbon, series: Series) => {
      const key = `${r.id}|${from}>${to}`;
      if (from === to || !cardsOf.has(from) || !cardsOf.has(to) || seen.has(key)) return;
      seen.add(key);
      rivers.push({ from, to, finding: r.id, kind: r.kind, series, tokens: Math.min(4, 1 + Math.round(Math.log2(Math.max(1, r.routes)))) });
    };
    for (const r of view.ribbons) {
      if (r.kind === "injection") {
        const chain = [r.source_id, ...r.agent_ids, r.target_id].filter((id): id is string => !!id);
        for (let i = 0; i + 1 < chain.length; i++) add(chain[i], chain[i + 1], r, "hot");
      } else {
        const agent = r.agent_ids[0];
        for (const u of r.untrusted_ids ?? []) add(u, agent, r, "hot");
        for (const p of r.private_ids ?? []) add(p, agent, r, "private");
        for (const e of r.exit_ids ?? []) add(agent, e, r, "exit");
      }
    }
    // columns: sources, then agents by depth, then the actions; each column stacked and centred
    const byCol = new Map<number, string[]>();
    for (const c of cardsOf.values()) byCol.set(c.col, [...(byCol.get(c.col) ?? []), c.id]);
    const rows = Math.max(1, ...[...byCol.values()].map((ids) => ids.length));
    const tallest = rows * CARD_H + (rows - 1) * ROW_GAP;
    const positions = new Map<string, { x: number; y: number }>();
    for (const [col, ids] of byCol) {
      const height = ids.length * CARD_H + (ids.length - 1) * ROW_GAP;
      ids.forEach((id, i) => positions.set(id, { x: col * COL_GAP, y: (tallest - height) / 2 + i * (CARD_H + ROW_GAP) }));
    }
    const lanes = [...byCol.keys()].sort((a, b) => a - b).map((col) => ({
      col, label: col === 0 ? "untrusted and private sources" : col === lastCol ? "high-impact actions and ways out" : agentCols === 1 ? "agents" : col === 1 ? "agents" : "delegates",
    }));
    return { cards: [...cardsOf.values()], rivers, positions, lanes, extent: { w: lastCol * COL_GAP + CARD_W, h: tallest + 44 } };
  }, [view, posture, names]);

  const overFinding = over?.kind === "river" ? over.id : null;
  const overCard = over?.kind === "card" ? model.cards.find((c) => c.id === over.id) ?? null : null;
  const touched = useMemo(() => new Set(model.rivers.filter((r) => r.finding === overFinding).flatMap((r) => [r.from, r.to])), [model, overFinding]);

  const nodes = useMemo((): (Card | LaneNode)[] => {
    const cards: Card[] = model.cards.map((c) => ({
      id: c.id, type: "rcard", position: model.positions.get(c.id) ?? { x: 0, y: 0 }, width: CARD_W, height: CARD_H,
      draggable: false, connectable: false, selectable: false, data: { ...c, dim: !!overFinding && !touched.has(c.id) },
    }));
    const lanes: LaneNode[] = model.lanes.map((l) => ({
      id: `lane:${l.col}`, type: "lane", position: { x: l.col * COL_GAP + CARD_W / 2 - 110, y: -40 }, width: 220, height: 20,
      draggable: false, selectable: false, connectable: false, data: { label: l.label },
    }));
    return [...lanes, ...cards];
  }, [model, overFinding, touched]);

  const edges = useMemo((): River[] => model.rivers.map((r, i) => ({
    id: `r${i}`, type: "river", source: r.from, target: r.to, selectable: false, focusable: false,
    data: { finding: r.finding, kind: r.kind, series: r.series, tokens: r.tokens, dim: !!overFinding && overFinding !== r.finding, lit: overFinding === r.finding },
    zIndex: overFinding === r.finding ? 2 : 1,
  })), [model, overFinding]);

  const zoom = Math.min(FIT_ZOOM, (boxWidth - 40) / Math.max(model.extent.w, 1));
  const areaHeight = model.cards.length ? Math.max(300, Math.min(640, Math.round(model.extent.h * zoom) + 56)) : 220;
  useEffect(() => {
    if (!nodes.length) return;
    let frame = window.requestAnimationFrame(() => {
      frame = window.requestAnimationFrame(() => flow.fitView({ padding: FIT_PAD, maxZoom: FIT_ZOOM, duration: 0 }));
    });
    return () => window.cancelAnimationFrame(frame);
  }, [nodes, areaHeight, flow]);

  const ribbon = overFinding ? view.ribbons.find((r) => r.id === overFinding) : null;
  const folded = view.folded;
  return (
    <div className={`chart riskflow${overFinding ? " reading" : ""}`} ref={box}>
      <div className="flow-area" style={{ height: areaHeight }}>
        <ReactFlow
          nodes={nodes} edges={edges} nodeTypes={NODE_TYPES} edgeTypes={EDGE_TYPES}
          fitView fitViewOptions={{ padding: FIT_PAD, maxZoom: FIT_ZOOM }} minZoom={0.3} maxZoom={2.2}
          nodesDraggable={false} nodesConnectable={false} elementsSelectable={false} zoomOnScroll={false} zoomOnDoubleClick={false} preventScrolling={false} panOnScroll={false}
          proOptions={{ hideAttribution: true }} colorMode="dark"
          onNodeMouseEnter={(_, n) => n.type === "rcard" && setOver({ kind: "card", id: n.id })} onNodeMouseLeave={() => setOver(null)}
          onEdgeMouseEnter={(_, e) => setOver({ kind: "river", id: (e.data as RiverData).finding })} onEdgeMouseLeave={() => setOver(null)}
          onNodeClick={(_, n) => n.type === "rcard" && go(scenario, "graph", n.id)}
          onEdgeClick={(_, e) => go(scenario, "finding", (e.data as RiverData).finding)}
        >
          <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="rgb(181 209 204 / 0.14)" />
          <div className="zoom" role="group" aria-label="Zoom">
            <button onClick={() => flow.zoomIn({ duration: 200 })} title="Zoom in" aria-label="Zoom in">+</button>
            <button onClick={() => flow.zoomOut({ duration: 200 })} title="Zoom out" aria-label="Zoom out">−</button>
            <button className="fit" onClick={() => flow.fitView({ padding: FIT_PAD, maxZoom: FIT_ZOOM, duration: 200 })} title="Fit the chart to the box" aria-label="Fit">⤢</button>
          </div>
        </ReactFlow>
        {!model.cards.length && <p className="riskflow-empty">Nothing is drawn because nothing is open: no untrusted source reaches a high-impact action here.</p>}
      </div>
      <div className="chart-key" aria-hidden>
        <span><i className="k-hot" />untrusted text, running the open paths</span>
        {model.rivers.some((r) => r.series === "private") && <span><i className="k-private" />private data</span>}
        {model.rivers.some((r) => r.series === "exit") && <span><i className="k-exit" />the way out</span>}
        <span className="reads">
          {folded.sources.length ? `+ ${plural(folded.sources.length, "source", "sources")} not on an open path` : "every source is on a path"} · {plural(folded.tools.length, "tool", "tools")} between them
          {folded.agents.length ? `, ${plural(folded.agents.length, "agent", "agents")} off the paths` : ""} · {folded.actions.length ? `+ ${plural(folded.actions.length, "resource", "resources")} not reached from outside` : "every resource is reached"}
        </span>
      </div>
      <p className="chart-over" aria-live="polite">
        {ribbon ? (
          ribbon.kind === "injection"
            ? <><strong>{name(ribbon.source_id)}</strong> reaches <strong>{name(ribbon.target_id)}</strong> through {ribbon.agent_ids.map(name).join(", ")} in {plural(ribbon.hops, "hop", "hops")}{ribbon.routes > 1 ? `, by ${plural(ribbon.routes, "route", "routes")}` : ""} · {ribbon.id} · click to open</>
            : <><strong>{name(ribbon.agent_ids[0])}</strong> holds untrusted input, private data and a way out · {ribbon.id} · click to open</>
        ) : overCard ? (
          <><strong>{overCard.name}</strong> <code>{overCard.id}</code>{overCard.eyebrow} · {overCard.sub}{overCard.figure && overCard.figure.value ? ` · ${overCard.figure.label} ${overCard.figure.value} ${overCard.figure.unit}` : overCard.figure ? ` · ${overCard.figure.unit}` : ""} · click to open it in the Explorer</>
        ) : model.cards.length ? "Each path is one open finding: the tokens are the text an outsider plants, running it endlessly. Hover a path to read it, click it to open it; click a card to open it in the Explorer."
          : "Nothing is drawn because nothing is open: no untrusted source reaches a high-impact action here."}
      </p>
    </div>
  );
}

/** The flow in its own React Flow scope, so it can sit beside the other charts. */
export function RiskFlow(props: RiskFlowProps) {
  return (
    <ReactFlowProvider>
      <Inner {...props} />
    </ReactFlowProvider>
  );
}
