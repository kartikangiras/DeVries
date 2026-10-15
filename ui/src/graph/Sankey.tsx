// The overview as a flow diagram, laid out by d3-sankey: untrusted sources on the left, the agents they
// reach, the high-impact actions on the right, and the open findings as ribbons whose width is the
// number of routes. d3-sankey orders the nodes to keep the ribbons from crossing and sizes each node
// by what flows through it; this file only maps the API's overview onto it and draws the result.

import { useMemo, useState } from "react";
import { sankey, sankeyJustify, sankeyLinkHorizontal, type SankeyLink, type SankeyNode } from "d3-sankey";
import type { Overview, Ribbon } from "../api";
import { href } from "../route";
import { plural } from "../text";

type N = { id: string; name: string; col: "source" | "agent" | "action"; fact: string; worst?: boolean; props?: string };
type L = { finding: string; kind: Ribbon["kind"]; value: number };
type SN = SankeyNode<N, L>;
type SL = SankeyLink<N, L>;

const WIDTH = 960;

export function OverviewSankey({ view, names, scenario }: { view: Overview; names: Record<string, string>; scenario: string }) {
  const [over, setOver] = useState<string | null>(null);
  const name = (id: string | null | undefined) => (id ? names[id] ?? id : "");

  const built = useMemo(() => {
    const { sources, agents, actions } = view.columns;
    const nodes: N[] = [
      ...sources.map((s) => ({ id: s.id, name: s.name, col: "source" as const, fact: s.trust ?? "untrusted" })),
      ...agents.map((a) => ({
        id: a.id, name: a.name, col: "agent" as const, fact: a.autonomous ? "unattended" : "",
        props: ["A", "B", "C"].map((p) => (a.properties.includes(p) ? p : "·")).join(" "), worst: a.autonomous && a.properties.length === 3,
      })),
      ...actions.map((t) => ({ id: t.id, name: t.name, col: "action" as const, fact: [t.impact ? `${t.impact} impact` : "", t.external ? "external" : ""].filter(Boolean).join(" · ") })),
    ];
    const known = new Set(nodes.map((n) => n.id));
    const links: (L & { source: string; target: string })[] = [];
    for (const r of view.ribbons) {
      const chain = [r.source_id, ...r.agent_ids, r.target_id].filter((id): id is string => !!id && known.has(id));
      for (let i = 0; i + 1 < chain.length; i++) {
        if (chain[i] === chain[i + 1]) continue;
        // a ribbon's width grows with its routes, but gently: one route is one unit, ten are four, fifty are seven
        links.push({ source: chain[i], target: chain[i + 1], finding: r.id, kind: r.kind, value: 1 + Math.log2(Math.max(1, r.routes)) });
      }
    }
    const rows = Math.max(sources.length, agents.length, actions.length, 1);
    const height = Math.max(240, 64 * rows + 90);
    if (!links.length) return { nodes: [] as SN[], links: [] as SL[], height };
    // a route is UNIT pixels wide, whatever else is on the page: d3-sankey would otherwise stretch one ribbon to fill the box
    const UNIT = 12, PAD = 46;
    const columnTotal = (col: N["col"]) => nodes.filter((n) => n.col === col).reduce((sum, n) => sum + links.filter((l) => (col === "source" ? l.source : l.target) === n.id).reduce((a, l) => a + l.value, 0), 0);
    const tallest = Math.max(columnTotal("source") * UNIT + (sources.length - 1) * PAD, columnTotal("agent") * UNIT + (agents.length - 1) * PAD, columnTotal("action") * UNIT + (actions.length - 1) * PAD, 24);
    const room = height - 84;
    const used = Math.min(tallest, room);
    const top = 48 + (room - used) / 2;
    const lay = sankey<N, L>().nodeId((d) => d.id).nodeWidth(12).nodePadding(PAD).nodeAlign(sankeyJustify).nodeSort(null)
      .extent([[170, top], [WIDTH - 170, top + used]]);
    const g = lay({ nodes: nodes.map((n) => ({ ...n })), links: links.map((l) => ({ ...l })) });
    return { nodes: g.nodes, links: g.links, height };
  }, [view]);

  const path = sankeyLinkHorizontal<N, L>();
  const lit = (finding: string) => !over || over === finding;
  const touched = (id: string) => !over || built.links.some((l) => l.finding === over && ((l.source as SN).id === id || (l.target as SN).id === id));
  const ribbon = over ? view.ribbons.find((r) => r.id === over) : null;

  return (
    <div className="overview sankey">
      <svg viewBox={`0 0 ${WIDTH} ${built.height}`} role="group" aria-label={`Overview: ${view.sentence}`} onMouseLeave={() => setOver(null)}>
        {[["untrusted sources", 190], ["agents", WIDTH / 2], ["high-impact actions", WIDTH - 190]].map(([caption, x]) => (
          <text key={String(caption)} className="ov-caption" x={Number(x)} y={22} textAnchor="middle">{String(caption).toUpperCase()}</text>
        ))}
        {built.links.map((l, i) => (
          <a key={`${l.finding}:${i}`} href={href(scenario, "finding", l.finding)} aria-label={`${l.kind} ${l.finding}`}>
            <g className={`ov-ribbon ${l.kind}${lit(l.finding) ? "" : " dim"}${over === l.finding ? " lit" : ""}`} data-finding={l.finding}
              onMouseEnter={() => setOver(l.finding)}>
              <path className="hit" d={path(l) ?? ""} style={{ strokeWidth: Math.max(14, l.width ?? 1) }} />
              <path className="line" d={path(l) ?? ""} style={{ strokeWidth: Math.max(2, l.width ?? 1) }} />
            </g>
          </a>
        ))}
        {built.nodes.map((n) => {
          const x0 = n.x0 ?? 0, x1 = n.x1 ?? 0, y0 = n.y0 ?? 0, y1 = n.y1 ?? 0;
          const cy = (y0 + y1) / 2;
          const dim = over && !touched(n.id) ? " dim" : "";
          if (n.col === "agent") {
            return (
              <g key={n.id} className={`ov-node agent${n.worst ? " worst" : ""}${dim}`} transform={`translate(${(x0 + x1) / 2} ${cy})`}>
                <rect x={-76} y={-19} width={152} height={38} rx={8} />
                <text className="ov-name" y={-3} textAnchor="middle">{n.name}</text>
                <text className="ov-sub" y={12} textAnchor="middle">{n.props}{n.fact ? ` · ${n.fact}` : ""}</text>
              </g>
            );
          }
          const left = n.col === "source";
          return (
            <g key={n.id} className={`ov-node ${n.col}${dim}`}>
              <rect className="bar" x={x0} y={y0} width={Math.max(4, x1 - x0)} height={Math.max(4, y1 - y0)} rx={2} />
              <text className="ov-name" x={left ? x0 - 12 : x1 + 12} y={cy + 1} textAnchor={left ? "end" : "start"}>{n.name}</text>
              <text className="ov-sub" x={left ? x0 - 12 : x1 + 12} y={cy + 16} textAnchor={left ? "end" : "start"}>{n.fact}</text>
            </g>
          );
        })}
        <text className="ov-fold" x={190} y={built.height - 12} textAnchor="middle">
          {view.folded.sources.length ? `+ ${plural(view.folded.sources.length, "source", "sources")} not on an open path` : "every source is on a path"}
        </text>
        <text className="ov-fold" x={WIDTH / 2} y={built.height - 12} textAnchor="middle">
          {`${plural(view.folded.tools.length, "tool", "tools")} between them`}{view.folded.agents.length ? ` · + ${plural(view.folded.agents.length, "agent", "agents")} off the paths` : ""}
        </text>
        <text className="ov-fold" x={WIDTH - 190} y={built.height - 12} textAnchor="middle">
          {view.folded.actions.length ? `+ ${plural(view.folded.actions.length, "resource", "resources")} not reached from outside` : "every resource is reached"}
        </text>
      </svg>
      <p className="chart-over" aria-live="polite">
        {ribbon ? (
          ribbon.kind === "injection"
            ? <><strong>{name(ribbon.source_id)}</strong> reaches <strong>{name(ribbon.target_id)}</strong> through {ribbon.agent_ids.map(name).join(", ")} in {plural(ribbon.hops, "hop", "hops")}{ribbon.routes > 1 ? `, by ${ribbon.routes} routes` : ""} · {ribbon.id} · click to open</>
            : <><strong>{name(ribbon.agent_ids[0])}</strong> holds untrusted input, private data and a way out · {ribbon.id} · click to open</>
        ) : built.links.length ? "Each ribbon is one open finding: hover it to read it, click it to open it. Its width grows with the number of routes." : "Nothing is drawn because nothing is open: no untrusted source reaches a high-impact action here."}
      </p>
    </div>
  );
}
