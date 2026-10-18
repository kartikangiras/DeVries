// Where the risk is, as a live flow: the untrusted sources on the left, the agents their text reaches, the
// high-impact actions those agents can take on the right, each a card with its figure, and the open paths
// between them carrying tokens that run endlessly, the way text an outsider plants would. Drawn with React
// Flow on a dotted ground, panned and zoomed like a map; a hovered path reads its finding, a click opens it,
// a clicked card opens the Explorer on it. The keyboard does the same: Tab reads, Enter opens. The map never
// shrinks its cards below reading size; a graph too wide for the box is panned instead. What a card says is
// FalkorDB's answer; the page only draws it. Motion is off under prefers-reduced-motion: the tokens then sit still.

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FocusEvent, type KeyboardEvent } from "react";
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
  /** The card's height, which follows the type (see TYPE_MAX). */
  h: number;
};
type RiverData = { finding: string; kind: Ribbon["kind"]; series: Series; tokens: number; dim: boolean; lit: boolean };
type Card = Node<CardData, "rcard">;
type River = Edge<RiverData, "river">;
type LaneNode = Node<{ label: string; align?: "first" | "last" }, "lane">;

const CARD_W = 208;
const CARD_H = 232;
const COL_GAP = 256;
const ROW_GAP = 26;
const FIT_ZOOM = 1.15;
/** The margin the map keeps from the edge of its box, and the band across the top where the zoom buttons stand. */
const GUTTER = 12;
const TOP = GUTTER + 34;
/** The map is fitted to its width once. Down to LEGIBLE its labels, set at 12.5 px, still render at 11 px or more; fitted
 *  below that, the cards set their type larger to make up the difference (--rf-type), by up to TYPE_MAX. MIN_ZOOM is
 *  where that runs out: a map wider than the box at it starts at its left edge and pans. */
const LEGIBLE = 0.88;
const TYPE_MAX = 1.2;
const MIN_ZOOM = LEGIBLE / TYPE_MAX;

function CardView({ data }: NodeProps<Card>) {
  const cls = ["rcard", `rk-${data.kind}`, `t-${data.tone}`, data.worst ? "worst" : "", data.dim ? "dim" : ""].filter(Boolean).join(" ");
  return (
    <div className={cls} data-id={data.id} title={data.id} style={{ width: CARD_W, height: data.h }}>
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
  return <div className={`lane${data.align ? ` ${data.align}` : ""}`}><span>{data.label}</span></div>;
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
    const cardsOf = new Map<string, Omit<CardData, "dim" | "h">>();
    // how deep an agent sits: the furthest place it takes in any chain
    const depth = new Map<string, number>();
    for (const r of view.ribbons) r.agent_ids.forEach((a, i) => depth.set(a, Math.max(depth.get(a) ?? 1, i + 1)));
    const agentCols = Math.max(1, ...[...depth.values()]);
    const lastCol = agentCols + 1;
    // the zoom follows from the width alone, so the type, and the card height with it, can follow the zoom
    const width = lastCol * COL_GAP + CARD_W;
    const zoom = Math.max(MIN_ZOOM, Math.min(FIT_ZOOM, (boxWidth - 2 * GUTTER) / width));
    const typeScale = Math.min(TYPE_MAX, Math.max(1, LEGIBLE / zoom));
    const cardH = Math.round(CARD_H * typeScale);
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
    const tallest = rows * cardH + (rows - 1) * ROW_GAP;
    const positions = new Map<string, { x: number; y: number }>();
    for (const [col, ids] of byCol) {
      const height = ids.length * cardH + (ids.length - 1) * ROW_GAP;
      ids.forEach((id, i) => positions.set(id, { x: col * COL_GAP, y: (tallest - height) / 2 + i * (cardH + ROW_GAP) }));
    }
    // one caption a column, each said once: what the sources are, how deep the agents stand, what the actions are
    const hasPrivate = [...cardsOf.values()].some((c) => c.kind === "private");
    const hasExternal = actions.some((t) => t.external), hasHigh = actions.some((t) => !t.external);
    const caption = (col: number) =>
      col === 0 ? (hasPrivate ? "untrusted and private sources" : "untrusted sources")
        : col === lastCol ? (hasExternal && hasHigh ? "actions and ways out" : hasExternal ? "ways out" : "high-impact actions")
          : col === 1 ? "agents" : col === 2 ? "delegates" : col === 3 ? "sub-delegates" : `delegates, ${col - 1} deep`;
    // the first caption reads from its card's left edge and the last ends at its card's right edge, so neither leaves the map
    const lanes = [...byCol.keys()].sort((a, b) => a - b).map((col) => ({ col, label: caption(col), align: col === 0 ? "first" as const : col === lastCol ? "last" as const : undefined }));
    // the lanes stand 40 above the cards, so the drawing runs from -40 to the bottom of the tallest column
    return { cards: [...cardsOf.values()], rivers, positions, lanes, zoom, typeScale, cardH, extent: { w: width, h: tallest + 40 } };
  }, [view, posture, names, boxWidth]);

  const overFinding = over?.kind === "river" ? over.id : null;
  const overCard = over?.kind === "card" ? model.cards.find((c) => c.id === over.id) ?? null : null;
  const touched = useMemo(() => new Set(model.rivers.filter((r) => r.finding === overFinding).flatMap((r) => [r.from, r.to])), [model, overFinding]);

  const nodes = useMemo((): (Card | LaneNode)[] => {
    const cards: Card[] = model.cards.map((c) => ({
      id: c.id, type: "rcard", position: model.positions.get(c.id) ?? { x: 0, y: 0 }, width: CARD_W, height: model.cardH,
      draggable: false, connectable: false, selectable: false, data: { ...c, h: model.cardH, dim: !!overFinding && !touched.has(c.id) },
    }));
    const lanes: LaneNode[] = model.lanes.map((l) => ({
      id: `lane:${l.col}`, type: "lane", position: { x: l.col * COL_GAP, y: -40 }, width: CARD_W, height: 20,
      draggable: false, selectable: false, connectable: false, focusable: false, data: { label: l.label, align: l.align },
    }));
    return [...lanes, ...cards];
  }, [model, overFinding, touched]);

  const edges = useMemo((): River[] => model.rivers.map((r, i) => ({
    id: `r${i}`, type: "river", source: r.from, target: r.to, selectable: false, focusable: true,
    data: { finding: r.finding, kind: r.kind, series: r.series, tokens: r.tokens, dim: !!overFinding && overFinding !== r.finding, lit: overFinding === r.finding },
    zIndex: overFinding === r.finding ? 2 : 1,
  })), [model, overFinding]);

  // the map is fitted to its width once, down to MIN_ZOOM and no further: a map too wide for that is drawn at
  // MIN_ZOOM from its left edge, where the sources are, and the rest is reached by panning
  const zoom = model.zoom;
  const drawnH = Math.round(model.extent.h * zoom);
  const areaHeight = model.cards.length ? Math.max(300, Math.min(820, drawnH + TOP + GUTTER + 8)) : 220;
  const wide = model.extent.w * zoom > boxWidth - 2 * GUTTER + 1;
  const tall = drawnH > areaHeight - TOP - GUTTER + 1;
  const overflowing = wide || tall;
  // the map sits centred in its box, under the zoom row; one larger than the box starts at its top left corner, where
  // the lane captions and the sources are
  const fit = useCallback((duration: number) => {
    const x = wide ? GUTTER : (boxWidth - model.extent.w * zoom) / 2;
    const y = (tall ? TOP : TOP + (areaHeight - TOP - GUTTER - model.extent.h * zoom) / 2) + 40 * zoom;
    flow.setViewport({ x, y, zoom }, { duration });
  }, [flow, wide, tall, boxWidth, model.extent, areaHeight, zoom]);
  // a card the keyboard lands on is panned into view; the browser must not scroll the pane for it (overflow: clip, app.css)
  const reveal = useCallback((id: string) => {
    const p = model.positions.get(id);
    const area = box.current?.querySelector<HTMLElement>(".flow-area");
    if (!p || !area) return;
    const vp = flow.getViewport();
    const left = p.x * vp.zoom + vp.x, right = (p.x + CARD_W) * vp.zoom + vp.x, top = p.y * vp.zoom + vp.y, bottom = (p.y + model.cardH) * vp.zoom + vp.y;
    const dx = left < GUTTER ? GUTTER - left : right > area.clientWidth - GUTTER ? area.clientWidth - GUTTER - right : 0;
    const dy = top < TOP ? TOP - top : bottom > area.clientHeight - GUTTER ? area.clientHeight - GUTTER - bottom : 0;
    if (dx || dy) flow.setViewport({ x: vp.x + dx, y: vp.y + dy, zoom: vp.zoom }, { duration: 150 });
  }, [flow, model]);
  useEffect(() => {
    if (!nodes.length) return;
    let frame = window.requestAnimationFrame(() => {
      frame = window.requestAnimationFrame(() => fit(0));
    });
    return () => window.cancelAnimationFrame(frame);
  }, [nodes, fit]);

  // the keyboard reaches what the pointer does: Tab moves between cards and paths and reads each under the map, Enter opens it
  const focused = (e: FocusEvent | KeyboardEvent) => {
    const el = (e.target as HTMLElement).closest?.(".react-flow__node, .react-flow__edge");
    return el ? { edge: el.classList.contains("react-flow__edge"), id: el.getAttribute("data-id") } : null;
  };
  const findingOf = (edgeId: string) => model.rivers[Number(edgeId.slice(1))]?.finding ?? null;
  const onFocus = (e: FocusEvent) => {
    const f = focused(e);
    if (!f?.id || f.id.startsWith("lane:")) return;
    if (f.edge) { const id = findingOf(f.id); if (id) setOver({ kind: "river", id }); } else { setOver({ kind: "card", id: f.id }); reveal(f.id); }
  };
  const onBlur = (e: FocusEvent) => { if (!box.current?.contains(e.relatedTarget as globalThis.Node | null)) setOver(null); };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const f = focused(e);
    if (!f?.id || f.id.startsWith("lane:")) return;
    e.preventDefault();
    if (f.edge) { const id = findingOf(f.id); if (id) go(scenario, "finding", id); } else go(scenario, "graph", f.id);
  };

  const ribbon = overFinding ? view.ribbons.find((r) => r.id === overFinding) : null;
  const folded = view.folded;
  return (
    <div className={`chart riskflow${overFinding ? " reading" : ""}`} ref={box} style={{ "--rf-type": model.typeScale } as CSSProperties}>
      <div className="flow-area" style={{ height: areaHeight }} onFocus={onFocus} onBlur={onBlur} onKeyDown={onKeyDown}>
        <ReactFlow
          nodes={nodes} edges={edges} nodeTypes={NODE_TYPES} edgeTypes={EDGE_TYPES}
          fitView fitViewOptions={{ padding: 0.05, maxZoom: FIT_ZOOM, minZoom: MIN_ZOOM }} minZoom={0.5} maxZoom={2.2}
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
            <button className="fit" onClick={() => fit(200)} title="Fit the chart to the box" aria-label="Fit">⤢</button>
          </div>
        </ReactFlow>
        {!model.cards.length && <p className="riskflow-empty">Nothing is drawn because nothing is open: no untrusted source reaches a high-impact action here.</p>}
      </div>
      <div className="chart-key" role="note" aria-label="Key">
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
        ) : model.cards.length ? `Each path is one open finding. Hover it to read it, click it to open it; click a card to open it in the Explorer.${overflowing ? " The map is larger than its box: drag it to pan, or zoom with + and −." : ""}`
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
