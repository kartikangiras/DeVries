// Where everything goes on a lane chart. The lanes run left to right in the order text and data
// travel: what is read, the tools that read it, the agents, the tools they act through, what gets
// acted on. A node's lane comes from what it is; its height from what it is wired to.

import type { Graph, GraphLink, GraphNode } from "../api";
import { hopKey } from "../paths";

export type Placed = { id: string; node: GraphNode; col: number; first: boolean; last: boolean; x: number; y: number; r: number };
export type Wire = {
  key: string; link: GraphLink; from: Placed; to: Placed;
  /** The curve; where its arrowhead sits and which way it points, in degrees; its middle, for a label; and a point near its start, for a mark. */
  d: string; tip: { x: number; y: number; angle: number }; mid: { x: number; y: number }; early: { x: number; y: number; angle: number };
};
export type Layout = {
  width: number; height: number; spacing: number;
  nodes: Placed[]; byId: Map<string, Placed>; wires: Wire[]; lanes: { caption: string; x: number }[];
};

const TRUST = ["untrusted", "private", "internal"];
const IMPACT = ["high", "medium", "low"];
/** Before anything is wired: what matters most goes first, so it lands at the top. */
function rank(node: GraphNode): number {
  if (node.label === "DataSource") return TRUST.indexOf(node.data.trust ?? "internal");
  if (node.label === "Resource") return IMPACT.indexOf(node.data.impact ?? "low") - (node.data.external ? 0.5 : 0);
  return 0;
}

type Options = {
  /** Draw these nodes only. */
  only?: Set<string>;
  /** Ids to put first in their lanes, in this order: a finding's path then runs along the top. */
  first?: string[];
  top?: number; bottom?: number; rowGap?: number; side?: number;
};

const mean = (values: number[]) => values.reduce((sum, v) => sum + v, 0) / values.length;

export function layout(graph: Graph, width: number, { only, first = [], top = 96, bottom = 84, rowGap = 72, side = 88 }: Options = {}): Layout {
  const label = new Map(graph.nodes.map((n) => [n.data.id, n.label]));
  const shown = graph.nodes.filter((n) => !only || only.has(n.data.id));
  const here = new Set(shown.map((n) => n.data.id));
  const links = graph.links.filter((l) => here.has(l.data.from_id) && here.has(l.data.to_id));

  // a tool's lane depends on what it touches: one that acts on a resource is on the way out, one that only reads is on the way in
  const reads = new Set<string>();
  const acts = new Set<string>();
  for (const l of graph.links) {
    for (const [tool, other] of [[l.data.from_id, l.data.to_id], [l.data.to_id, l.data.from_id]]) {
      if (label.get(tool) !== "Tool") continue;
      if (label.get(other) === "DataSource") reads.add(tool);
      if (label.get(other) === "Resource") acts.add(tool);
    }
  }

  // agents get a lane for each level of delegation: a delegate stands left of the agent it reports
  // to, so what it returns flows rightward like everything else
  const depth = new Map(shown.filter((n) => n.label === "Agent").map((n) => [n.data.id, 0]));
  const delegations = new Set<string>();
  for (const l of links) {
    const config = graph.layer === "flow" ? l.data.config : { rel: l.rel, from_id: l.data.from_id, to_id: l.data.to_id };
    if (config?.rel === "DELEGATES_TO" && depth.has(config.from_id) && depth.has(config.to_id)) delegations.add(hopKey(config.from_id, config.to_id));
  }
  for (let round = 0; round < depth.size; round++) {
    for (const pair of delegations) {
      const [boss, delegate] = pair.split(">");
      if (depth.get(delegate)! <= depth.get(boss)! && depth.get(boss)! < depth.size - 1) depth.set(delegate, depth.get(boss)! + 1);
    }
  }
  const deepest = Math.max(0, ...depth.values());

  // lane slots, left to right: sources, reading tools, delegates (deepest first), agents, acting tools, resources
  const slot = (node: GraphNode): number => {
    if (node.label === "DataSource") return 0;
    if (node.label === "Agent") return 2 + deepest - depth.get(node.data.id)!;
    if (node.label === "Resource") return 4 + deepest;
    if (acts.has(node.data.id)) return 3 + deepest;
    if (reads.has(node.data.id)) return 1;
    return node.data.capability === "read" ? 1 : 3 + deepest;
  };
  const caption = (s: number) => (s === 0 ? "data sources" : s === 1 ? "tools that read" : s < 2 + deepest ? "delegates" : s === 2 + deepest ? "agents" : s === 3 + deepest ? "tools that act" : "resources");

  const slotOf = new Map(shown.map((n) => [n.data.id, slot(n)]));
  const near = new Map<string, string[]>(shown.map((n) => [n.data.id, []]));
  for (const l of links) {
    if (label.get(l.data.from_id) === "Resource" && label.get(l.data.to_id) === "DataSource") continue; // a loop back: drawn under the chart, it pulls nothing
    near.get(l.data.from_id)!.push(l.data.to_id);
    near.get(l.data.to_id)!.push(l.data.from_id);
  }

  // order within a lane: pinned ids first, then by what they are; a few sweeps pull each node toward what it is wired to
  const slots = 5 + deepest;
  const pin = new Map(first.map((id, i) => [id, i]));
  const order: string[][] = Array.from({ length: slots }, () => []);
  [...shown]
    .sort((a, b) => (pin.get(a.data.id) ?? 1e6) - (pin.get(b.data.id) ?? 1e6) || rank(a) - rank(b) || a.data.id.localeCompare(b.data.id))
    .forEach((n) => order[slotOf.get(n.data.id)!].push(n.data.id));
  const spot = () => new Map(order.flatMap((col) => col.map((id, i) => [id, col.length > 1 ? i / (col.length - 1) : 0.5] as const)));
  for (let sweep = 0; sweep < 4; sweep++) {
    for (const dir of [1, -1]) {
      for (let at = dir === 1 ? 1 : slots - 2; at >= 0 && at < slots; at += dir) {
        const where = spot();
        const pull = (id: string) => {
          const others = near.get(id)!.filter((n) => (dir === 1 ? slotOf.get(n)! < at : slotOf.get(n)! > at));
          return others.length ? mean(others.map((n) => where.get(n)!)) : where.get(id)!;
        };
        const keyed = order[at].map((id, i) => ({ id, i, pinned: pin.has(id) ? 0 : 1, pull: pull(id) }));
        order[at] = keyed.sort((a, b) => a.pinned - b.pinned || (a.pinned ? a.pull - b.pull : 0) || a.i - b.i).map((k) => k.id);
      }
    }
  }

  // heights: the fullest lane is the grid; each other lane lines its nodes up with what feeds them
  // (to the right of the grid) or what they feed (to its left), keeping its order and its spacing.
  // A node takes the height of one of its feeders when the lane beside it is empty there, so the
  // wire between them runs straight and their names do not meet; otherwise it sits between them.
  const used = order.map((col, s) => ({ col, s })).filter(({ col }) => col.length);
  const most = Math.max(1, ...used.map(({ col }) => col.length));
  const y = new Map<string, number>();
  used.forEach(({ col }) => col.forEach((id, i) => y.set(id, top + ((most - col.length) * rowGap) / 2 + i * rowGap)));
  const pivot = used.findIndex(({ col }) => col.length === most);
  const settle = (at: number, dir: 1 | -1) => {
    const { col, s } = used[at];
    if (col.length === most) return;
    const beside = (used[at - dir]?.col ?? []).map((id) => y.get(id)!);
    const want = col.map((id) => {
      const feeders = near.get(id)!.filter((n) => (dir === 1 ? slotOf.get(n)! < s : slotOf.get(n)! > s)).map((n) => y.get(n)!);
      if (!feeders.length) return y.get(id)!;
      const middle = mean(feeders);
      const clear = feeders.filter((h) => beside.every((b) => Math.abs(b - h) >= rowGap * 0.7)).sort((a, b) => Math.abs(a - middle) - Math.abs(b - middle));
      return clear.length ? clear[0] : middle;
    });
    const low = top;
    const high = top + (most - 1) * rowGap;
    for (let i = 0; i < col.length; i++) want[i] = Math.max(want[i], i ? want[i - 1] + rowGap : low);
    for (let i = col.length - 1; i >= 0; i--) want[i] = Math.min(want[i], i < col.length - 1 ? want[i + 1] - rowGap : high);
    col.forEach((id, i) => y.set(id, want[i]));
  };
  for (let at = pivot + 1; at < used.length; at++) settle(at, 1);
  for (let at = pivot - 1; at >= 0; at--) settle(at, -1);

  const inner = Math.max(0, width - side * 2);
  const spacing = used.length > 1 ? inner / (used.length - 1) : width;
  const byNode = new Map(shown.map((n) => [n.data.id, n]));
  const nodes: Placed[] = used.flatMap(({ col }, c) =>
    col.map((id, i) => {
      const node = byNode.get(id)!;
      return { id, node, col: c, first: i === 0, last: i === col.length - 1, x: used.length > 1 ? side + c * spacing : width / 2, y: y.get(id)!, r: node.label === "Agent" ? 8 : 6 };
    }),
  );
  const byId = new Map(nodes.map((n) => [n.id, n]));

  const hops = new Set(links.map((l) => hopKey(l.data.from_id, l.data.to_id)));
  const met = new Map<string, number>();
  const gap = 3;
  const lowest = Math.max(top, ...nodes.map((n) => n.y));
  let floor = 0;        // how far down the lowest line goes: a loop back runs under everything
  const wires: Wire[] = links.map((link) => {
    const from = byId.get(link.data.from_id)!;
    const to = byId.get(link.data.to_id)!;
    // keyed by its ends, not by the link's id: a fix replaces a flow with a gated flow, and the arc should change colour in place
    const hop = hopKey(link.data.from_id, link.data.to_id);
    met.set(hop, (met.get(hop) ?? 0) + 1);
    const key = met.get(hop) === 1 ? hop : `${hop}#${met.get(hop)}`;
    const degrees = (dy: number, dx: number) => (Math.atan2(dy, dx) * 180) / Math.PI;
    // a cubic at t, and its slope there
    const at = (t: number, a: number, b: number, c: number, e: number) => (1 - t) ** 3 * a + 3 * (1 - t) ** 2 * t * b + 3 * (1 - t) * t * t * c + t ** 3 * e;
    const slope = (t: number, a: number, b: number, c: number, e: number) => 3 * (1 - t) ** 2 * (b - a) + 6 * (1 - t) * t * (c - b) + 3 * t * t * (e - c);

    if (from.node.label === "Resource" && to.node.label === "DataSource" && from.x - to.x > spacing) {
      // A loop back: what is written on the far right is read again on the far left. Like every way
      // back it leaves low on the left and arrives low on the right; between the two it drops through
      // the gap beside the resources, runs under every node, and rises through the gap beside the sources.
      const lean = 0.5;
      const reach = 0.87;
      const x1 = from.x - (from.r + gap) * reach;
      const y1 = from.y + (from.r + gap) * lean;
      const x2 = to.x + (to.r + gap) * reach;
      const y2 = to.y + (to.r + gap) * lean;
      // a little past the middle of each gap: the middle is where the arcs crossing it carry their labels
      const aside = Math.min(26, spacing * 0.22);
      const down = from.x - spacing / 2 - aside;
      const up = to.x + spacing / 2 + aside;
      const corner = 18;
      const base = lowest + 68;                  // under the lowest name, fact and note
      floor = Math.max(floor, base);
      const bend = (yEnd: number) => Math.min(yEnd + 60, base - corner);   // where a bend out of a dot has become vertical
      const b1 = bend(y1);
      const b2 = bend(y2);
      const pull = (down - x1) * 0.55;           // negative: the gap is to the left of the resource
      const d = [
        `M${x1} ${y1}`,
        `C${x1 + pull} ${y1 - pull * 0.577} ${down} ${b1 - 28} ${down} ${b1}`,
        `L${down} ${base - corner}`,
        `Q${down} ${base} ${down - corner} ${base}`,
        `L${up + corner} ${base}`,
        `Q${up} ${base} ${up} ${base - corner}`,
        `L${up} ${b2}`,
        `C${up} ${b2 - 28} ${x2 - pull} ${y2 - pull * 0.577} ${x2} ${y2}`,
      ].join(" ");
      return {
        key, link, from, to, d,
        tip: { x: x2, y: y2, angle: degrees(pull * 0.577, pull) },
        mid: { x: (down + up) / 2, y: base },
        early: { x: down, y: (b1 + base - corner) / 2, angle: 90 },
      };
    }

    let p: [number, number, number, number, number, number, number, number]; // start, two control points, end
    if (from.col === to.col) {
      // inside a lane: a flow going down bows out to the right, one going up to the left, so a pair never overlaps
      const out = to.y >= from.y ? 1 : -1;
      const bow = 40 + (Math.abs(to.y - from.y) / rowGap) * 6;
      const x1 = from.x + out * (from.r + gap);
      const x2 = to.x + out * (to.r + gap);
      p = [x1, from.y, x1 + out * bow, from.y, x2 + out * bow, to.y, x2, to.y];
    } else if (to.col < from.col && hops.has(hopKey(to.id, from.id))) {
      // the way back of a pair: an arc slung under the straight one, so the two can be told apart
      const lean = 0.5; // sin 30°
      const reach = 0.87;
      const x1 = from.x - (from.r + gap) * reach;
      const y1 = from.y + (from.r + gap) * lean;
      const x2 = to.x + (to.r + gap) * reach;
      const y2 = to.y + (to.r + gap) * lean;
      const pull = Math.abs(x1 - x2) * 0.28;
      p = [x1, y1, x1 - pull, y1 + 26, x2 + pull, y2 + 26, x2, y2];
    } else {
      const dir = to.x > from.x ? 1 : -1;
      const x1 = from.x + dir * (from.r + gap);
      const x2 = to.x - dir * (to.r + gap);
      p = [x1, from.y, (x1 + x2) / 2, from.y, (x1 + x2) / 2, to.y, x2, to.y];
      // An arc that skips a lane must not run through a dot standing in it. It takes the clear strip
      // between two rows instead: under that dot's line of text, or over its name.
      const between = nodes.filter((n) => n.id !== from.id && n.id !== to.id && (n.x - from.x) * (n.x - to.x) < 0);
      const hits = (q: typeof p) => between.some((n) => {
        for (let t = 0.02; t < 1; t += 0.02) {
          if (Math.hypot(at(t, q[0], q[2], q[4], q[6]) - n.x, at(t, q[1], q[3], q[5], q[7]) - n.y) < n.r + 9) return true;
        }
        return false;
      });
      if (between.length && hits(p)) {
        const strip = (by: number): typeof p => [x1, from.y, x1 + (x2 - x1) * 0.3, from.y + by, x1 + (x2 - x1) * 0.7, to.y + by, x2, to.y];
        const under = strip(rowGap * 0.67);    // three quarters of this is how far the arc dips: half a row
        const over = strip(-rowGap * 0.67);
        p = !hits(under) ? under : !hits(over) ? over : under;
      }
    }
    const t = 0.2;
    return {
      key, link, from, to,
      d: `M${p[0]} ${p[1]} C${p[2]} ${p[3]} ${p[4]} ${p[5]} ${p[6]} ${p[7]}`,
      tip: { x: p[6], y: p[7], angle: degrees(p[7] - p[5], p[6] - p[4]) },
      mid: { x: at(0.5, p[0], p[2], p[4], p[6]), y: at(0.5, p[1], p[3], p[5], p[7]) },
      early: { x: at(t, p[0], p[2], p[4], p[6]), y: at(t, p[1], p[3], p[5], p[7]), angle: degrees(slope(t, p[1], p[3], p[5], p[7]), slope(t, p[0], p[2], p[4], p[6])) },
    };
  });

  return { width, height: Math.max(top + (most - 1) * rowGap + bottom, floor + 36), spacing, nodes, byId, wires, lanes: used.map(({ s }, c) => ({ caption: caption(s), x: used.length > 1 ? side + c * spacing : width / 2 })) };
}

let pen: CanvasRenderingContext2D | null | undefined;
/** How wide a piece of text is in a font, measured, not guessed. */
export function textWidth(text: string, font: string): number {
  if (pen === undefined) pen = document.createElement("canvas").getContext("2d");
  if (!pen) return text.length * 6.6;
  pen.font = font;
  return pen.measureText(text).width;
}

/** A label cut to the room it has. */
export function fit(text: string, room: number, font: string): string {
  if (textWidth(text, font) <= room) return text;
  let keep = text.length - 1;
  while (keep > 3 && textWidth(text.slice(0, keep).trimEnd() + "…", font) > room) keep--;
  return text.slice(0, keep).trimEnd() + "…";
}
