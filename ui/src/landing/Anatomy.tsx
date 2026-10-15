// Six cards, each a small working surface: how a finding is cited, how fixes are judged, what a
// brief looks like, the rules as switches, the model beside the search, and the trail a run
// leaves. The cards and their visuals follow Manthan's CaseAnatomy and its six visuals
// (manthan-ui/src/pages/Landing.tsx, Apache-2.0; see ui/THIRD_PARTY_NOTICES.md), rewritten for
// what DeVries shows.

import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Check, Reveal } from "./bits";

export function Anatomy() {
  return (
    <div className="l-bento">
      <Card
        delay={0}
        title="Every hop cites its rule"
        body="A finding is a path, and each hop on it was made by one of seven rules from one config edge. The brief says it in a paragraph with numbered evidence; the table under it names the rule and the edge. Hover a number to see where the claim came from. Nothing is hidden behind a tooltip in the app either."
        visual={<CitesVisual />}
      />
      <Card
        delay={0.08}
        title="Fixes tested before you see them"
        body="Five kinds of fix: gate a call behind a person, revoke a grant, quarantine what a delegate returns, stop a tool reading a source, split an agent. Each candidate is applied to a copy of the scenario and judged by the same three queries. A plan that fails says why, naming the workflow it would break."
        visual={<GatesVisual />}
      />
      <Card
        delay={0.16}
        title="A brief your reviewer will sign"
        body="Every finding lands as a plain-English memo, not a model dump. The paragraph, the plans that passed and the evidence are on one page, each claim ending in a numbered citation to the rule and the edge behind it. The cheapest plan that passed waits for a nod. No tool can approve, and the trace says so."
        visual={<BriefVisual />}
      />
      <Card
        delay={0.24}
        title="Rules you can read"
        body="The flow layer is seven rules, and a gate removes a flow, not a grant. Gate a call, quarantine a delegation, cap what a fix may cost, and the what-if line says what opens or closes before anything is written. Every query the product runs is listed, in Cypher, on the Queries page."
        visual={<PolicyVisual />}
      />
      <Card
        delay={0.32}
        title="Runs with a model, or without one"
        body="With a key, Claude Opus 5.5 drives the audit and picks the next tool call, saying why. Without one, a fixed search does the same job with the same tools, and the run says which it was. Nine runs out of nine, the model proposed the plan the search found, in fewer sandboxes: it reads the verdict of a failed revoke and goes straight to the gate."
        visual={<CompareVisual />}
      />
      <Card
        delay={0.4}
        title="An audit trail on every run"
        body="Every scan, every sandbox, every verdict, every nod is recorded on the graph with who decided it: model, loop, scripted or person. The trace of a run reads like prose, each step naming the query it came from, and the ledger keeps every plan that was tested, passed or not."
        visual={<AuditVisual />}
      />
    </div>
  );
}

function Card({ delay, title, body, visual }: { delay: number; title: string; body: string; visual: ReactNode }) {
  return (
    <Reveal as="article" className="l-card" y={24} delay={delay} duration={0.55} margin="-60px">
      <div className="l-card-visual">{visual}</div>
      <div className="l-card-rule" />
      <div className="l-card-copy">
        <h3 className="l-card-title">{title}</h3>
        <p className="l-card-body">{body}</p>
      </div>
    </Reveal>
  );
}

/* ---- 1. the paragraph, with a number on every claim */

type N = 1 | 2 | 3 | 4;
const LINEAGE: Record<N, { rule: number; edge: string; record: string; finding: string }> = {
  1: { rule: 1, edge: "READS", record: "tool:helpdesk.get_ticket → src:customer-tickets", finding: "A tool returns what it reads. Customer tickets are untrusted: people outside the organisation write them." },
  2: { rule: 2, edge: "CAN_CALL", record: "agent:support-bot → tool:helpdesk.get_ticket", finding: "What a tool returns enters the context of the agent that called it. The bot holds a grant for get_ticket." },
  3: { rule: 3, edge: "CAN_CALL", record: "agent:support-bot → tool:payments.issue_refund", finding: "An agent's context decides the calls it makes, and this grant is not gated behind a person." },
  4: { rule: 5, edge: "WRITES", record: "tool:payments.issue_refund → res:payments-api", finding: "A tool acts on its resource. Payments API is high impact, so this is where the path ends." },
};

function CitesVisual() {
  const [hovered, setHovered] = useState<N | null>(null);
  const Cite = ({ n }: { n: N }) => (
    <button
      type="button"
      className={`la-cite${hovered === n ? " on" : ""}`}
      onMouseEnter={() => setHovered(n)}
      onMouseLeave={() => setHovered(null)}
      onFocus={() => setHovered(n)}
      onBlur={() => setHovered(null)}
      aria-label={`Evidence ${n}: rule ${LINEAGE[n].rule}`}
    >
      [{n}]
    </button>
  );
  const l = hovered ? LINEAGE[hovered] : null;
  return (
    <div className="la-cites">
      <div className="la-eyebrow-row">
        <span className="eyebrow">Brief · fnd:dce0910d42</span>
        <span className="la-hint">{hovered ? `Evidence [${hovered}]` : "Hover [n] to trace"}</span>
      </div>
      <div className="la-head-row">
        <span className="la-strong">Customer tickets</span>
        <span className="la-mono">4 hops · critical</span>
      </div>
      <div className="la-body">
        {l === null ? (
          <p key="brief" className="la-para l-fade-in">
            Customer tickets are written by outsiders and read by get_ticket<Cite n={1} />. What it returns enters Support bot's context<Cite n={2} />, and that context decides whether the bot calls issue_refund<Cite n={3} />, which acts on Payments API<Cite n={4} />.
          </p>
        ) : (
          <div key={`l-${hovered}`} className="la-lineage l-fade-in">
            <span className="la-rule-badge">R{l.rule}</span>
            <div className="min0">
              <div className="la-lineage-head">
                <span className="la-accent">[{hovered}]</span>
                <span className="la-ink">rule {l.rule} · {l.edge}</span>
                <span>·</span>
                <span className="la-trunc">{l.record}</span>
              </div>
              <div className="la-lineage-text">{l.finding}</div>
            </div>
          </div>
        )}
      </div>
      <div className="la-foot">
        <span className="la-accent">→</span>
        <span>gate · split passed in a sandbox; revoke · drop_read failed</span>
      </div>
    </div>
  );
}

/* ---- 2. one finding, three kinds of plan, the sandbox's verdict on each */

const BRANCHES = [
  { label: "gate", cost: "cost 2", verdict: "Passed", tone: "accent" },
  { label: "split", cost: "cost 3", verdict: "Passed", tone: "amber" },
  { label: "revoke", cost: "cost 2", verdict: "Breaks wf", tone: "muted" },
];

function GatesVisual() {
  const [active, setActive] = useState(0);
  const container = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLDivElement>(null);
  const outputs = useRef<(HTMLButtonElement | null)[]>([null, null, null]);
  const [curves, setCurves] = useState<{ sx: number; sy: number; ex: number; ey: number; d: string }[]>([]);
  const [box, setBox] = useState({ w: 0, h: 0 });

  useEffect(() => {
    const measure = () => {
      const c = container.current;
      const i = input.current;
      if (!c || !i) return;
      const cr = c.getBoundingClientRect();
      const ir = i.getBoundingClientRect();
      const sx = ir.right - cr.left;
      const sy = ir.top - cr.top + ir.height / 2;
      const next: typeof curves = [];
      outputs.current.forEach((o) => {
        if (!o) return;
        const or = o.getBoundingClientRect();
        const ex = or.left - cr.left;
        const ey = or.top - cr.top + or.height / 2;
        const cp = Math.max(28, Math.abs(ex - sx) * 0.55);
        next.push({ sx, sy, ex, ey, d: `M ${sx.toFixed(2)} ${sy.toFixed(2)} C ${(sx + cp).toFixed(2)} ${sy.toFixed(2)}, ${(ex - cp).toFixed(2)} ${ey.toFixed(2)}, ${ex.toFixed(2)} ${ey.toFixed(2)}` });
      });
      setCurves(next);
      setBox({ w: cr.width, h: cr.height });
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (container.current) ro.observe(container.current);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);

  return (
    <div ref={container} className="la-gates">
      {box.w > 0 && (
        <svg className="la-gates-svg" width={box.w} height={box.h} viewBox={`0 0 ${box.w} ${box.h}`}>
          {curves.map((c, i) => {
            const on = active === i;
            const tone = BRANCHES[i].tone;
            return (
              <g key={i} className={`la-curve t-${tone}${on ? " on" : ""}`}>
                <path d={c.d} />
                {on && (
                  <circle r="3">
                    <animateMotion dur="1.4s" repeatCount="indefinite" path={c.d} rotate="auto" />
                    <animate attributeName="opacity" values="0;1;1;0" dur="1.4s" repeatCount="indefinite" />
                  </circle>
                )}
                <circle className="la-cap" cx={c.sx} cy={c.sy} r="1.6" />
                <circle className="la-cap" cx={c.ex} cy={c.ey} r={on ? 2.4 : 1.6} />
              </g>
            );
          })}
        </svg>
      )}
      <div className="la-gates-grid">
        <div ref={input} className="la-gates-in">
          <div className="eyebrow">Finding</div>
          <div className="la-gates-in-id">dce0910d42</div>
          <div className="la-gates-in-sub">4 hops</div>
        </div>
        <div />
        <div className="la-gates-out">
          {BRANCHES.map((b, i) => (
            <button
              key={b.label}
              ref={(el) => { outputs.current[i] = el; }}
              type="button"
              className={`la-branch t-${b.tone}${active === i ? " on" : ""}`}
              onMouseEnter={() => setActive(i)}
              onFocus={() => setActive(i)}
            >
              <span className="la-branch-label">{b.label}</span>
              <span className="la-branch-right">
                <span className="la-branch-cost">{b.cost}</span>
                <span className="la-branch-verdict">{b.verdict}</span>
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ---- 3. a brief, as a small document */

function BriefVisual() {
  return (
    <div className="la-brief-wrap">
      <Reveal className="la-brief" y={8} duration={0.5} margin="-60px">
        <div className="la-brief-head">
          <div>
            <div className="la-brief-eyebrow">Finding brief · dce0910d42</div>
            <div className="la-brief-title">Customer tickets <span>· → Payments API</span></div>
          </div>
          <span className="la-brief-badge">Awaiting</span>
        </div>
        <div className="la-brief-tldr">
          Four hops, critical. Text an outsider writes<b>[1]</b> can end in a refund<b>[2]</b> with no person in between.
        </div>
        <div className="la-brief-actions">
          {[["01", "Gate issue_refund", "passed"], ["02", "Split Support bot", "passed"], ["03", "Revoke get_ticket", "failed"]].map(([n, t, v], i) => (
            <Reveal key={n} className="la-brief-action" x={-4} y={0} delay={0.3 + i * 0.1} duration={0.3} margin="0px">
              <span className="la-brief-n">{n}</span>
              <span className="la-brief-t">{t}</span>
              <span className={`la-brief-v ${v}`}>{v}</span>
            </Reveal>
          ))}
        </div>
        <div className="la-brief-notes">
          <div><b>[1]</b><span>rule 1 · get_ticket reads Customer tickets</span></div>
          <div><b>[2]</b><span>rule 3 · Support bot can call issue_refund</span></div>
        </div>
        <div className="la-brief-sign">
          <span className="la-mono">#mit-b68c44c5ab</span>
          <span className="la-accent">✓ tested on a copy of the graph</span>
        </div>
      </Reveal>
    </div>
  );
}

/* ---- 4. the rules as switches, with the what-if answer at the bottom */

const COSTS = [2, 2, 2, 2, 3];

function PolicyVisual() {
  const [gate, setGate] = useState(true);
  const [cost, setCost] = useState(2);
  const [quarantine, setQuarantine] = useState(true);
  const open = gate ? 0 : 1;
  const inBudget = COSTS.filter((c) => c <= cost).length - (quarantine ? 0 : 1);
  return (
    <div className="la-policy">
      <div className="la-eyebrow-row tight">
        <span className="eyebrow">Fixes on the desk</span>
        <span className="la-mono small">what-if · live</span>
      </div>
      <div className="la-row">
        <span>Gate issue_refund behind a person</span>
        <button type="button" className={`la-toggle${gate ? " on" : ""}`} onClick={() => setGate(!gate)} aria-pressed={gate} aria-label="Gate issue_refund behind a person"><span /></button>
      </div>
      <div className="la-row la-row-slider">
        <span>Max fix cost</span>
        <input type="range" min={1} max={5} step={1} value={cost} onChange={(e) => setCost(parseInt(e.target.value))} className="la-range" style={{ "--fill": `${((cost - 1) / 4) * 100}%` } as CSSProperties} aria-label="Max fix cost" />
        <span className="la-row-value">{cost}</span>
      </div>
      <button type="button" className="la-row la-row-check" onClick={() => setQuarantine(!quarantine)} aria-pressed={quarantine}>
        <span>Quarantine what delegates return</span>
        <span className={`la-checkbox${quarantine ? " on" : ""}`}>{quarantine && <Check size={10} />}</span>
      </button>
      <div className="la-impact">
        <span>Impact · this scenario</span>
        <span key={`${open}-${inBudget}`} className="la-impact-value l-fade-in">{open} / 1 open · {Math.max(0, inBudget)} / 5 plans in budget</span>
      </div>
    </div>
  );
}

/* ---- 5. the model beside the search: the same plan, fewer sandboxes */

const RUNS = [
  { scn: "acme_support", search: 5, model: 3, modelText: "2–3" },
  { scn: "acme_exec", search: 8, model: 5, modelText: "2–5" },
  { scn: "acme_dev", search: 7, model: 2, modelText: "2" },
];

function CompareVisual() {
  const [hovered, setHovered] = useState<number | null>(null);
  const max = 8;
  const r = hovered === null ? null : RUNS[hovered];
  return (
    <div className="la-compare">
      <div className="la-compare-head">
        <div>
          <div className="eyebrow">Sandboxes to a proposal</div>
          <div className="la-compare-metric">
            <span key={r ? r.scn : "all"} className="la-compare-big l-fade-in">{r ? `${r.modelText} vs ${r.search}` : "9 / 9"}</span>
            <span className="la-compare-delta">{r ? "model vs search" : "runs matched"}</span>
          </div>
        </div>
        <div className="la-compare-right">
          <div>{r ? r.scn : "three scenarios"}</div>
          <div className="la-accent"><span className="la-pulse" />same plan every run</div>
        </div>
      </div>
      <div className="la-compare-chart">
        {RUNS.map((run, i) => (
          <div key={run.scn} className={`la-group${hovered === i ? " on" : ""}`} onMouseEnter={() => setHovered(i)} onMouseLeave={() => setHovered(null)}>
            <div className="la-bars">
              <span className="la-bar search" style={{ height: `${(run.search / max) * 100}%` }} title={`search · ${run.search} sandboxes`} />
              <span className="la-bar model" style={{ height: `${(run.model / max) * 100}%` }} title={`model · ${run.modelText} sandboxes`} />
            </div>
            <div className="la-group-label">{run.scn.replace("acme_", "")}</div>
          </div>
        ))}
      </div>
      <div className="la-compare-axis">
        <span><i className="la-swatch search" />search · 5 · 8 · 7</span>
        <span className="la-accent"><i className="la-swatch model" />model · 2–3 · 2–5 · 2</span>
      </div>
    </div>
  );
}

/* ---- 6. the trail: a feed of what the auditor and the person did */

type Event = { who: "you" | "auditor"; verb: string; object: string; via: string; minsAgo: number };
const EVENTS: Event[] = [
  { who: "auditor", verb: "rescanned", object: "acme_support · 0 open", via: "reach.untrusted_to_high", minsAgo: 1 },
  { who: "auditor", verb: "applied", object: "mit:7d04e1c2aa", via: "apply_fix, after your nod", minsAgo: 1 },
  { who: "you", verb: "approved", object: "split Support bot", via: "the approval bar", minsAgo: 2 },
  { who: "you", verb: "rejected the gate:", object: "“refunds must stay automatic”", via: "the approval bar", minsAgo: 3 },
  { who: "auditor", verb: "proposed", object: "gate issue_refund · cost 2", via: "the cheapest plan that passed", minsAgo: 5 },
  { who: "auditor", verb: "tested in a sandbox", object: "mit:b68c44c5ab · passed", via: "GRAPH.COPY", minsAgo: 5 },
  { who: "auditor", verb: "tested in a sandbox", object: "mit:3f1c9a7d20 · breaks wf:refund-request", via: "GRAPH.COPY", minsAgo: 6 },
  { who: "auditor", verb: "scanned", object: "acme_support · 1 injection", via: "find.trifecta · 8 ms", minsAgo: 6 },
];

function AuditVisual() {
  const [filter, setFilter] = useState<"all" | "you" | "auditor">("all");
  const filtered = useMemo(() => (filter === "all" ? EVENTS : EVENTS.filter((e) => e.who === filter)), [filter]);
  const [cursor, setCursor] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setCursor((c) => (c + 1) % Math.max(1, filtered.length)), 2800);
    return () => window.clearInterval(id);
  }, [filtered.length]);
  const visible = useMemo(() => {
    const list = filtered.length ? filtered : EVENTS;
    return Array.from({ length: 5 }, (_, i) => ({ e: list[(cursor + i) % list.length], key: cursor * 100 + i }));
  }, [cursor, filtered]);
  const ago = (m: number) => (m < 1 ? "just now" : m === 1 ? "1 min ago" : `${m} min ago`);
  const counts = { all: EVENTS.length, you: EVENTS.filter((e) => e.who === "you").length, auditor: EVENTS.filter((e) => e.who === "auditor").length };
  return (
    <div className="la-audit">
      <div className="la-eyebrow-row tight">
        <span className="eyebrow">Activity</span>
        <div className="la-filters">
          {(["all", "you", "auditor"] as const).map((f) => (
            <button key={f} type="button" className={`la-filter${filter === f ? " on" : ""}`} onClick={() => setFilter(f)}>
              {f}<span>{counts[f]}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="la-feed">
        {visible.map((v, i) => (
          <div key={v.key} className={`la-event${v.e.who === "you" ? " you" : ""}${i === 0 ? " newest" : ""} l-fade-in`} style={{ opacity: i === 0 ? 1 : Math.max(0.36, 0.92 - i * 0.16) }}>
            <span className="la-event-dot" />
            <div className="min0">
              <div className="la-event-line">
                <b>{v.e.who === "you" ? "You" : "The auditor"}</b> <span className="la-event-verb">{v.e.verb}</span>{" "}
                <span className={`la-event-obj${/^(mit|fnd|scan):/.test(v.e.object) ? " mono" : ""}`}>{v.e.object}</span>
                <span className="la-event-ago"> · {ago(v.e.minsAgo)}</span>
              </div>
              <div className="la-event-via">via {v.e.via}</div>
            </div>
          </div>
        ))}
      </div>
      <div className="la-audit-foot">
        <span>every step records who decided it: model, loop, scripted or person</span>
        <span className="la-live"><span className="la-pulse" />live</span>
      </div>
    </div>
  );
}
