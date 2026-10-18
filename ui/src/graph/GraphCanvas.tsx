// FalkorDB's own canvas component, fed the same graph the other charts draw: the database's node ids,
// our facts on each node, a force or a tree layout. It is the second renderer on every chart, so a
// visitor can see the graph the way FalkorDB's own tools show it, beside the chart DeVries draws.

import { useEffect, useMemo, useRef, useState } from "react";
import "@falkordb/canvas";
import type { Data, FalkorDBCanvas, GraphLink as CanvasLink, GraphNode as CanvasNode } from "@falkordb/canvas";
import type { Graph } from "../api";
import type { Focus } from "../paths";
import { WithNames } from "../text";
import { edgeFacts, edgeWord, factOf, markOf } from "./model";

type Props = {
  graph: Graph;
  names: Record<string, string>;
  focus?: Focus | null;
  only?: boolean;
  layout?: "force" | "tree";
  picked?: string | null;
  onPick?: (id: string | null) => void;
  height?: number;
};

const FONT = '"Geist Sans", ui-sans-serif, system-ui, sans-serif';
const DIM = 0.18;

/** The page's colours, read from the tokens so the canvas matches the chart beside it. */
function palette() {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return {
    background: v("--surface", "#17161a"), foreground: v("--ink-strong", "#f5f4f6"), muted: v("--ink-faint", "#8b8a90"),
    line: v("--rule-strong", "#4a484f"), hot: v("--chart-hot", v("--danger", "#e5533d")), accent: v("--accent", "#847ce2"),
    bone: v("--chart-bone", "#d8d3c8"), amber: v("--amber", "#e0b35a"),
  };
}

function toData(graph: Graph, names: Record<string, string>, focus: Focus | null | undefined, only: boolean, p: ReturnType<typeof palette>): Data {
  const wanted = new Set<string>(only && focus ? focus.nodes : graph.nodes.map((n) => n.data.id));
  const colour = (label: string, mark: string) => (mark === "hot" ? p.hot : label === "Agent" ? p.accent : mark === "private" ? p.amber : p.bone);
  return {
    nodes: graph.nodes.filter((n) => wanted.has(n.data.id)).map((n) => {
      const mark = markOf(n);
      return {
        id: n.id, labels: [n.label], color: colour(n.label, mark), visible: true, size: n.label === "Agent" ? 11 : 8, shape: n.label === "Agent" ? "square" : "circle",
        data: { id: n.data.id, name: names[n.data.id] ?? n.data.name ?? n.data.id, kind: n.label, fact: factOf(n), mark, lit: !!focus?.nodes.has(n.data.id) },
      };
    }),
    links: graph.links.filter((l) => wanted.has(l.data.from_id) && wanted.has(l.data.to_id)).map((l) => {
      const f = edgeFacts(l, focus);
      return {
        id: l.id, relationship: edgeWord(l), color: f.series ? (f.series === "hot" ? p.hot : f.series === "private" ? p.amber : p.accent) : p.line,
        source: graph.nodes.find((n) => n.data.id === l.data.from_id)!.id, target: graph.nodes.find((n) => n.data.id === l.data.to_id)!.id,
        visible: true, width: f.onFocus ? 2 : 1, fontSize: 11, data: { key: f.key, sentence: f.sentence, gated: f.gated, gate: f.gate, onFocus: f.onFocus },
      };
    }),
  };
}

/** World units per CSS pixel right now, read from the context: the component does not pass the zoom in. */
function unit(ctx: CanvasRenderingContext2D): number {
  return (window.devicePixelRatio || 1) / (ctx.getTransform().a || 1);
}

function shapePath(node: CanvasNode, ctx: CanvasRenderingContext2D, grow = 0) {
  const x = node.x ?? 0, y = node.y ?? 0, r = node.size + grow;
  ctx.beginPath();
  if (node.shape === "square") ctx.roundRect(x - r, y - r, 2 * r, 2 * r, r * 0.25);
  else ctx.arc(x, y, r, 0, 2 * Math.PI);
}

/** A node with its name underneath at a size that stays readable at any zoom; the component's own renderer fits the name inside the node. */
function drawNode(node: CanvasNode, ctx: CanvasRenderingContext2D, p: ReturnType<typeof palette>, dimmed: boolean, picked: boolean) {
  const px = unit(ctx);
  ctx.save();
  ctx.globalAlpha = dimmed ? DIM : 1;
  if (picked) {
    shapePath(node, ctx, 4 * px);
    ctx.strokeStyle = p.accent;
    ctx.lineWidth = 2 * px;
    ctx.stroke();
  }
  shapePath(node, ctx);
  if (node.data.mark === "plain" && node.labels[0] !== "Agent") {
    ctx.fillStyle = p.background;
    ctx.fill();
    ctx.lineWidth = 1.6 * px;
    ctx.strokeStyle = node.color;
    ctx.stroke();
  } else {
    ctx.fillStyle = node.color;
    ctx.fill();
    ctx.lineWidth = 1.2 * px;
    ctx.strokeStyle = p.background;
    ctx.stroke();
  }
  if (px < 3.2) {
    const label = String(node.data.name ?? node.data.id);
    const y = (node.y ?? 0) + node.size + 4 * px;
    ctx.font = `${node.labels[0] === "Agent" ? 600 : 500} ${11.5 * px}px ${FONT}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.lineJoin = "round";
    ctx.lineWidth = 3.5 * px;
    ctx.strokeStyle = p.background;
    ctx.strokeText(label, node.x ?? 0, y);
    ctx.fillStyle = node.data.lit ? p.foreground : p.muted;
    ctx.fillText(label, node.x ?? 0, y);
  }
  ctx.restore();
}

export function GraphCanvas({ graph, names, focus, only = false, layout = "force", picked, onPick, height = 460 }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<FalkorDBCanvas>(null);
  const shownKey = useRef<string | null>(null);
  const handlers = useRef({ onPick });
  handlers.current = { onPick };
  const [over, setOver] = useState<{ title: string; detail: string } | null>(null);
  const p = useMemo(palette, []);
  const data = useMemo(() => toData(graph, names, focus, only, p), [graph, names, focus, only, p]);
  const graphKey = `${graph.scenario}/${graph.layer}/${only ? "focus" : "all"}/${data.nodes.length}`;

  useEffect(() => {
    const element = canvas.current, container = box.current;
    if (!element || !container) return;
    const fit = () => { element.setWidth(Math.max(container.clientWidth, 200)); element.setHeight(Math.max(container.clientHeight, 200)); };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    canvas.current?.setConfig({
      backgroundColor: p.background, foregroundColor: p.foreground,
      captionsKeys: [["name", true]],
      nodeStyle: { fontFamily: FONT }, linkStyle: { fontFamily: FONT },
      node: {
        nodeCanvasObject: (node: CanvasNode, ctx: CanvasRenderingContext2D) => drawNode(node, ctx, p, !!focus && !only && !node.data.lit, picked === node.data.id),
        nodePointerAreaPaint: (node: CanvasNode, color: string, ctx: CanvasRenderingContext2D) => { shapePath(node, ctx, 3); ctx.fillStyle = color; ctx.fill(); },
      },
      linkLineDash: (link: CanvasLink) => (link.data.gated ? [5, 4] : []),
      eventHandlers: {
        onNodeHover: (node: CanvasNode | null) => setOver(node ? { title: String(node.data.name), detail: `${node.data.id} · ${node.data.mark === "hot" ? "untrusted text reaches it" : node.data.mark === "private" ? "private data" : "untrusted text does not reach it"}${node.data.fact ? ` · ${node.data.fact}` : ""}` } : null),
        onLinkHover: (link: CanvasLink | null) => setOver(link ? { title: link.relationship, detail: String(link.data.sentence) } : null),
        onNodeClick: (node: CanvasNode) => handlers.current.onPick?.(String(node.data.id)),
        onBackgroundClick: () => handlers.current.onPick?.(null),
      },
    });
  }, [p, focus, only, picked]);

  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    if (shownKey.current === graphKey) {
      element.setData(data);            // same graph, new facts
      return;
    }
    shownKey.current = graphKey;
    element.setConfig({ layoutMode: layout, layoutOptions: { tree: { direction: "lr", levelDistance: 170, nodeSpacing: 90 } } });
    element.setData(data);
  }, [data, graphKey, layout]);

  useEffect(() => {
    canvas.current?.setLayout(layout);
  }, [layout]);

  return (
    <div className="chart canvas-chart">
      <div className="canvas-box" ref={box} style={{ height }}>
        <falkordb-canvas ref={canvas} />
      </div>
      <p className="chart-over" aria-live="polite">
        {over ? <><strong>{over.title}</strong> <WithNames text={over.detail} names={names} /></> : "FalkorDB's canvas component, on the same nodes and arcs. Drag to pan, scroll to zoom, click a node to pick it."}
      </p>
    </div>
  );
}
