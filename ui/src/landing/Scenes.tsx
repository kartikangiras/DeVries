// The three scenes beside the steps of "How it works": a scan sweeping the flow layer, four hops
// gathering into one finding, and candidate fixes going into sandboxes one by one. The staging
// follows Manthan's HowItWorksScenes (manthan-ui/src/components/marketing/HowItWorksScenes.tsx,
// Apache-2.0; see ui/THIRD_PARTY_NOTICES.md), redrawn for DeVries's graph with CSS transitions in
// place of GSAP. Each scene runs only while it is on screen.

import { useEffect, useState, type CSSProperties } from "react";
import { Check, Cross, useInView } from "./bits";

/** Seconds into a loop of `period`, ticking while `running`. */
function useLoop(running: boolean, period: number) {
  const [t, setT] = useState(0);
  useEffect(() => {
    if (!running) return;
    const t0 = performance.now();
    const id = window.setInterval(() => setT(((performance.now() - t0) / 1000) % period), 100);
    return () => window.clearInterval(id);
  }, [running, period]);
  return t;
}

/* ---- 01 · Scan: a breadth-first sweep from the untrusted source across five lanes */

const LANES = ["Data sources", "Tools that read", "Agents", "Tools that act", "Resources"];
type Node = { id: string; name: string; lane: number; y: number; depth: number; kind?: "untrusted" | "high" };
const NODES: Node[] = [
  { id: "tickets", name: "Customer tickets", lane: 0, y: 150, depth: 0, kind: "untrusted" },
  { id: "records", name: "Payment records", lane: 0, y: 270, depth: 9 },
  { id: "get_ticket", name: "get_ticket", lane: 1, y: 120, depth: 1 },
  { id: "list_tickets", name: "list_tickets", lane: 1, y: 200, depth: 1 },
  { id: "get_payment", name: "get_payment", lane: 1, y: 280, depth: 9 },
  { id: "bot", name: "Support bot", lane: 2, y: 200, depth: 2 },
  { id: "note", name: "add_internal_note", lane: 3, y: 120, depth: 3 },
  { id: "reply", name: "reply", lane: 3, y: 200, depth: 3 },
  { id: "refund", name: "issue_refund", lane: 3, y: 280, depth: 3 },
  { id: "notes", name: "Ticket notes", lane: 4, y: 120, depth: 4 },
  { id: "email", name: "Customer email", lane: 4, y: 200, depth: 4 },
  { id: "api", name: "Payments API", lane: 4, y: 280, depth: 4, kind: "high" },
];
const EDGES: [string, string][] = [
  ["tickets", "get_ticket"], ["tickets", "list_tickets"], ["records", "get_payment"],
  ["get_ticket", "bot"], ["list_tickets", "bot"], ["get_payment", "bot"],
  ["bot", "note"], ["bot", "reply"], ["bot", "refund"],
  ["note", "notes"], ["reply", "email"], ["refund", "api"],
];
const byId = Object.fromEntries(NODES.map((n) => [n.id, n]));
const laneX = (lane: number) => 70 + lane * 115;

export function ScanScene() {
  const [ref, inView] = useInView<HTMLDivElement>({ once: false, amount: 0.2 });
  const t = useLoop(inView, 5.6);
  const step = Math.min(7, Math.floor(t / 0.7));
  const reached = NODES.filter((n) => n.depth >= 1 && n.depth <= step).length;
  const chip =
    step === 0 ? "algo.bfs · src:customer-tickets · FLOWS_TO"
    : step <= 4 ? `depth ${step} · ${reached} reached`
    : "reach.untrusted_to_high · 1 high-impact resource";
  return (
    <div ref={ref} className="ls-frame">
      <span className="ls-live" aria-hidden />
      <div className="ls-chip-slot"><span key={chip} className="ls-chip">{chip}</span></div>
      <svg className="ls-svg" viewBox="0 0 600 400" aria-hidden>
        {LANES.map((name, i) => (
          <g key={name} className="ls-lane">
            <line x1={laneX(i)} x2={laneX(i)} y1={96} y2={320} />
            <text x={laneX(i)} y={84} textAnchor="middle">{name.toUpperCase()}</text>
          </g>
        ))}
        {EDGES.map(([a, b]) => {
          const from = byId[a];
          const to = byId[b];
          const x1 = laneX(from.lane) + 7;
          const x2 = laneX(to.lane) - 7;
          const lit = to.depth <= step && from.depth <= step && to.depth < 9;
          const cp = (x2 - x1) * 0.5;
          return <path key={`${a}-${b}`} className={`ls-edge${lit ? " on" : ""}`} d={`M ${x1} ${from.y} C ${x1 + cp} ${from.y}, ${x2 - cp} ${to.y}, ${x2} ${to.y}`} />;
        })}
        {NODES.map((n) => {
          const lit = n.depth === 0 || n.depth <= step;
          const hit = n.kind === "high" && step >= 4;
          return (
            <g key={n.id} className={`ls-node${lit ? " on" : ""}${n.kind === "untrusted" ? " src" : ""}${hit ? " hit" : ""}`}>
              {hit && <circle className="ls-ring" cx={laneX(n.lane)} cy={n.y} r={5} />}
              <circle cx={laneX(n.lane)} cy={n.y} r={5} />
              <text x={laneX(n.lane)} y={n.y + 20} textAnchor="middle">{n.name}</text>
            </g>
          );
        })}
      </svg>
      <div className="ls-legend"><span className="ls-key src">untrusted</span><span className="ls-key on">reached</span><span className="ls-key hit">high impact</span></div>
    </div>
  );
}

/* ---- 02 · Explain: four hops at the corners gather into one finding */

const CARDS = [
  { n: 1, rule: 1, edge: "READS", text: "get_ticket reads Customer tickets", x: 20, y: 22 },
  { n: 2, rule: 2, edge: "CAN_CALL", text: "Support bot calls get_ticket", x: 80, y: 22 },
  { n: 3, rule: 3, edge: "CAN_CALL", text: "Support bot can call issue_refund", x: 20, y: 78 },
  { n: 4, rule: 5, edge: "WRITES", text: "issue_refund acts on Payments API", x: 80, y: 78 },
];

export function ExplainScene() {
  const [ref, inView] = useInView<HTMLDivElement>({ once: false, amount: 0.2 });
  const t = useLoop(inView, 4.9);
  const gather = t >= 0.3 && t < 3.1;
  const brief = t >= 0.8 && t < 3.1;
  const check = t >= 1.3 && t < 3.1;
  const back = t >= 3.1;
  return (
    <div ref={ref} className="ls-frame">
      {CARDS.map((c, i) => (
        <div key={c.n} className={`lx-card${gather ? " gather" : ""}${back ? " back" : ""}`} style={{ "--x": `${c.x}%`, "--y": `${c.y}%`, "--i": i } as CSSProperties}>
          <div className="lx-card-head">
            <span className="lx-card-rule">RULE {c.rule} · {c.edge}</span>
            <span className="lx-card-n">[{c.n}]</span>
          </div>
          <div className="lx-card-text">{c.text}</div>
        </div>
      ))}
      <div className={`lx-brief${brief ? " show" : ""}`}>
        <div className="lx-brief-eyebrow">FINDING · fnd:dce0910d42</div>
        <div className="lx-brief-line"><span className="lx-brief-cites">[1][2][3][4]</span><span>4 hops, 4 rules, 1 path</span></div>
      </div>
      <div className={`lx-check${check ? " show" : ""}`}><Check size={14} width={3.5} /></div>
    </div>
  );
}

/* ---- 03 · Fix: candidates go into sandboxes one by one and come back with a verdict */

const FIXES = [
  { label: "Revoke get_ticket", passed: false },
  { label: "Stop reading tickets", passed: false },
  { label: "Gate issue_refund", passed: true },
  { label: "Split Support bot", passed: true },
];

export function FixScene() {
  const [ref, inView] = useInView<HTMLDivElement>({ once: false, amount: 0.2 });
  const t = useLoop(inView, 5.8);
  const passed = FIXES.filter((f, i) => f.passed && t >= 1 + i * 0.55 + 0.9 && t < 4.6).length;
  return (
    <div ref={ref} className="ls-frame">
      <div className="lf-rows">
        {FIXES.map((f, i) => {
          const on = t >= 1 + i * 0.55 && t < 4.6;
          return (
            <div key={f.label} className={`lf-row${on ? " on" : ""}${f.passed ? " pass" : " fail"}`}>
              <span className="lf-toggle"><span className="lf-knob" /></span>
              <span className="lf-label">{f.label}</span>
              <span className="lf-line"><span className="lf-signal" /></span>
              <span className="lf-box"><span className="lf-box-back" /><span className="lf-box-front">COPY</span></span>
              <span className="lf-verdict">{f.passed ? <Check size={9} /> : <Cross size={9} />}{f.passed ? "passed" : "breaks a workflow"}</span>
            </div>
          );
        })}
      </div>
      <div className="lf-count">{passed} of {FIXES.length} passed · the cheapest waits for your nod</div>
    </div>
  );
}
