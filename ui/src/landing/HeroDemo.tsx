// The showcase in the hero: one finding on the support desk, from the scan to its closing, in a
// run the visitor starts and nods through. The frame, its phases and its measurements follow
// Manthan's LandingHeroDemo (manthan-ui/src/components/landing/LandingHeroDemo.tsx, Apache-2.0;
// see ui/THIRD_PARTY_NOTICES.md). The content is Cistern's: the hops, the verdicts and the receipts
// are what the app shows on acme_support.

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Arrow, Check, Cross, PlayGlyph, Replay, Spinner, useInView } from "./bits";

const FINDING = {
  id: "dce0910d42",
  scenario: "Acme support desk",
  title: "Customer tickets",
  em: "can reach Payments API.",
  tldr:
    "Text an outsider writes can end in an action on Payments API, with no person in between. " +
    "The path is four hops: a ticket is read, what it says enters the support bot's context, and the " +
    "bot can issue a refund. Five candidate fixes were tested on a copy of the graph; two passed, and " +
    "the cheapest is a gate.",
};

type Hop = { rule: number; edge: string; words: string; line: string };
const HOPS: Hop[] = [
  { rule: 1, edge: "READS", words: "A tool returns what it reads", line: "get_ticket reads Customer tickets, which outsiders write" },
  { rule: 2, edge: "CAN_CALL", words: "What a tool returns enters the context of the agent that called it", line: "Support bot calls get_ticket, so the ticket enters its context" },
  { rule: 3, edge: "CAN_CALL", words: "An agent's context decides the calls it makes", line: "Support bot can call issue_refund, with no person in between" },
  { rule: 5, edge: "WRITES", words: "A tool acts on its resource", line: "issue_refund acts on Payments API, which is high impact" },
];

type Candidate = { kind: string; short: string; title: string; change: string; cost: number; passed: boolean; reason: string };
const CANDIDATES: Candidate[] = [
  { kind: "revoke", short: "revoke get_ticket", title: "Revoke get_ticket from Support bot", change: "DELETE (agent:support-bot)-[:CAN_CALL]->(tool:helpdesk.get_ticket)", cost: 2, passed: false, reason: "breaks wf:refund-request: nothing on its path can read src:customer-tickets any more" },
  { kind: "revoke", short: "revoke issue_refund", title: "Revoke issue_refund from Support bot", change: "DELETE (agent:support-bot)-[:CAN_CALL]->(tool:payments.issue_refund)", cost: 2, passed: false, reason: "breaks wf:refund-request: it needs tool:payments.issue_refund" },
  { kind: "drop_read", short: "stop reading tickets", title: "Stop get_ticket reading Customer tickets", change: "DELETE (tool:helpdesk.get_ticket)-[:READS]->(src:customer-tickets)", cost: 2, passed: false, reason: "breaks wf:refund-request: nothing on its path can read src:customer-tickets any more" },
  { kind: "gate", short: "gate issue_refund", title: "Gate issue_refund behind a person", change: "SET (agent:support-bot)-[:CAN_CALL {gate: 'human_approval'}]->(tool:payments.issue_refund)", cost: 2, passed: true, reason: "the finding is gone, nothing new opened, wf:refund-request still has what it needs" },
  { kind: "split", short: "split Support bot", title: "Split Support bot: a quarantined reader reads", change: "CREATE (agent:support-bot)-[:DELEGATES_TO {gate: 'quarantine'}]->(agent:support-bot-reader)", cost: 3, passed: true, reason: "the finding is gone, nothing new opened, wf:refund-request still has what it needs" },
];
const PASSED = CANDIDATES.filter((c) => c.passed);

type Step = { doing: string; done: string; title: string; target: string; ref: string };
const APPLY: Step[] = [
  { doing: "Applying", done: "Applied", title: "Gate issue_refund behind a person.", target: "MATCH (a:Agent {id:'agent:support-bot'})-[c:CAN_CALL]->(:Tool {id:'tool:payments.issue_refund'}) SET c.gate = 'human_approval'", ref: "mit:b68c44c5ab" },
  { doing: "Rebuilding", done: "Rebuilt", title: "The flow layer, in one statement.", target: "projection.rebuild · every FLOWS_TO and GATED_FLOW edge rewritten · 3 ms", ref: "GATED_FLOW {rule: 3}" },
  { doing: "Rescanning", done: "Rescanned", title: "No path from an outsider to a payment.", target: "reach.untrusted_to_high · find.trifecta · 0 injection · 0 trifecta · 8 ms", ref: "scan:9c2e01f4" },
];

const RECEIPTS: { label: string; text: string; ref: string }[] = [
  { label: "MITIGATION", text: "Gate issue_refund behind a person, approved by you and applied", ref: "mit:b68c44c5ab" },
  { label: "FINDING", text: "Customer tickets can no longer reach Payments API: closed", ref: "fnd:dce0910d42" },
  { label: "WORKFLOW", text: "Refund request still has every tool and source it needs", ref: "wf:refund-request" },
];

// ---- the phase machine

type Phase = "scan" | "explaining" | "testing" | "brief" | "applying" | "closed";
const ORDER: Phase[] = ["scan", "explaining", "testing", "brief", "applying", "closed"];
const DUR: Record<Phase, number> = { scan: 4, explaining: 14, testing: 15, brief: 5, applying: 9, closed: 6 };
const LABEL: Record<Phase, string> = { scan: "Scanning", explaining: "Explaining", testing: "Testing fixes", brief: "Brief", applying: "Applying", closed: "Closed" };
const TOTAL = ORDER.reduce((s, p) => s + DUR[p], 0);
const PRE = DUR.scan + DUR.explaining + DUR.testing + DUR.brief;

/** idle: the poster and a play button. pre: scan to brief. awaiting: the brief, until the visitor nods. post: applying to closed. */
type Playback = "idle" | "pre" | "awaiting" | "post" | "finished";

function startOf(p: Phase): number {
  let acc = 0;
  for (const x of ORDER) {
    if (x === p) return acc;
    acc += DUR[x];
  }
  return 0;
}

const pad = (n: number) => String(n).padStart(2, "0");

export function HeroDemo({ appHref }: { appHref: string }) {
  const [wrap, inView] = useInView<HTMLDivElement>({ amount: 0.15, once: false });
  const [playback, setPlayback] = useState<Playback>("idle");
  const [phase, setPhase] = useState<Phase>("scan");
  const [elapsed, setElapsed] = useState(0);

  // The clock runs only through the two automatic stretches, and only on screen.
  useEffect(() => {
    const auto = playback === "pre" || playback === "post";
    if (!auto || !inView) return;
    const t0 = performance.now();
    const from = startOf(phase) + elapsed;
    const id = window.setInterval(() => {
      const t = from + (performance.now() - t0) / 1000;
      if (playback === "pre" && t >= PRE) {
        setPhase("brief");
        setElapsed(DUR.brief);
        setPlayback("awaiting");
        return;
      }
      if (playback === "post" && t >= TOTAL) {
        setPhase("closed");
        setElapsed(DUR.closed);
        setPlayback("finished");
        return;
      }
      let cum = 0;
      for (const p of ORDER) {
        if (t < cum + DUR[p]) {
          setPhase(p);
          setElapsed(t - cum);
          break;
        }
        cum += DUR[p];
      }
    }, 100);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playback, inView]);

  const start = () => {
    setPhase("scan");
    setElapsed(0);
    setPlayback("pre");
  };
  const approve = () => {
    setPhase("applying");
    setElapsed(0);
    setPlayback("post");
  };

  const stamp = useMemo(() => {
    const base = 14 * 3600 + 21 * 60;
    const offset = playback === "idle" ? startOf("brief") + 2 : Math.floor(startOf(phase) + elapsed);
    const total = base + offset;
    return `${pad(Math.floor(total / 3600) % 24)}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)} UTC`;
  }, [playback, phase, elapsed]);

  const glass = playback === "idle" || playback === "finished";
  const live = playback === "pre" || playback === "awaiting" || playback === "post";

  const progress = (() => {
    if (playback === "idle") return "Tap to play";
    if (playback === "awaiting") return "Click Approve to apply";
    if (playback === "finished") return "Nothing changed until you said so";
    if (phase === "explaining") return `Hop ${pad(Math.min(HOPS.length, Math.floor(elapsed / (DUR.explaining / HOPS.length)) + 1))} of ${pad(HOPS.length)}`;
    if (phase === "testing") return `Sandbox ${pad(Math.min(CANDIDATES.length, Math.floor(elapsed / (DUR.testing / CANDIDATES.length)) + 1))} of ${pad(CANDIDATES.length)}`;
    if (phase === "applying") return `Step ${pad(Math.min(APPLY.length, Math.floor(elapsed / (DUR.applying / APPLY.length)) + 1))} of ${pad(APPLY.length)}`;
    if (phase === "brief") return "Awaiting your nod";
    if (phase === "closed") return "Finding closed";
    return "Scanning…";
  })();

  const tone = playback === "awaiting" ? " amber" : glass || phase === "closed" ? " quiet" : " accent";
  const headWord = playback === "awaiting" ? "Awaiting your nod" : playback === "idle" ? "Tap to play" : playback === "finished" ? "Closed" : LABEL[phase];

  return (
    <div ref={wrap} className={`ld${glass ? " glass" : ""}`}>
      <header className="ld-head">
        <span className="ld-lights" aria-hidden><i /><i /><i /></span>
        <span className="ld-id">FINDING&nbsp;{FINDING.id}</span>
        <span className="ld-dot" aria-hidden>·</span>
        <span className="ld-scn">{FINDING.scenario}</span>
        <span className={`ld-phase${tone}`}>{headWord}</span>
      </header>

      <div className="ld-canvas">
        <div className={`ld-content${live ? "" : " dim"}`}>
          {live ? (
            <div key={phase} className="ld-pane">
              {phase === "scan" && <ScanCanvas elapsed={elapsed} />}
              {phase === "explaining" && <ExplainingCanvas elapsed={elapsed} />}
              {phase === "testing" && <TestingCanvas elapsed={elapsed} />}
              {phase === "brief" && <BriefCanvas elapsed={elapsed} awaiting={playback === "awaiting"} onApprove={approve} />}
              {phase === "applying" && <ApplyingCanvas elapsed={elapsed} />}
              {phase === "closed" && <ClosedCanvas appHref={appHref} />}
            </div>
          ) : playback === "idle" ? (
            <div key="poster" className="ld-pane"><Poster /></div>
          ) : null}
        </div>
        {playback === "idle" && (
          <button type="button" className="ld-overlay ld-play" onClick={start} aria-label="Play the demo">
            <span className="ld-play-glyph"><PlayGlyph /></span>
            <span className="ld-play-say">Watch a finding close</span>
            <span className="ld-play-sub">60 seconds · scan → your nod → closed</span>
          </button>
        )}
        {playback === "finished" && (
          <div className="ld-overlay ld-done">
            <span className="ld-done-eyebrow">Finding closed</span>
            <h3 className="ld-done-h">Now open the app.</h3>
            <p className="ld-done-p">Four scenarios are loaded. Run the audit on the dev team and watch seven findings close in two rounds.</p>
            <a href={appHref} className="ld-done-cta">Open the app <Arrow size={14} /></a>
            <button type="button" className="ld-done-again" onClick={start}><Replay /> Watch again</button>
          </div>
        )}
      </div>

      <footer className="ld-foot">
        <span className="ld-stamp">{stamp}</span>
        <span className="ld-progress">{progress}</span>
      </footer>
    </div>
  );
}

// ---- pieces

function Eyebrow({ children, accent }: { children: ReactNode; accent?: boolean }) {
  return <span className={`ld-eyebrow${accent ? " accent" : ""}`}>{children}</span>;
}

function Word({ label }: { label: string }) {
  return <span className="ld-word">{label}</span>;
}

function CiteChip({ n, label }: { n: number; label: string }) {
  return (
    <span className="ld-cite" title={label}>
      <span>[{n}]</span>
      <span className="ld-cite-l">{label}</span>
      <i aria-hidden>↗</i>
    </span>
  );
}

function ActionBar({ awaiting, pulse, firing, onClick }: { awaiting?: boolean; pulse?: boolean; firing?: boolean; onClick?: () => void }) {
  return (
    <div className="ld-bar">
      <div className="ld-verbs">
        <span className="danger">Reject</span>
        <span>Hold</span>
      </div>
      <button
        type="button"
        className={`ld-approve${firing ? " firing" : awaiting ? " hot" : pulse ? " pulse" : ""}`}
        disabled={!awaiting || firing}
        onClick={onClick}
      >
        {firing && <Spinner />}
        {firing ? "Applying…" : "Approve · Apply"}
      </button>
    </div>
  );
}

const PATH = ["tickets", "get_ticket", "support-bot", "issue_refund", "payments-api"];

/** The path as five dots in a row; the hop being explained is lit. */
function PathGlyph({ lit }: { lit: number }) {
  return (
    <svg className="ld-path" viewBox="0 0 340 84" aria-hidden>
      {PATH.slice(0, -1).map((_, i) => (
        <line key={i} x1={30 + i * 70 + 8} y1={30} x2={30 + (i + 1) * 70 - 8} y2={30} className={i === lit ? "on" : i < lit ? "done" : ""} />
      ))}
      {PATH.map((name, i) => (
        <g key={name} className={`${i <= lit + 1 ? "on" : ""}${i === 0 ? " src" : i === PATH.length - 1 ? " sink" : ""}`}>
          <circle cx={30 + i * 70} cy={30} r={5} />
          <text x={30 + i * 70} y={58} textAnchor="middle">{name}</text>
        </g>
      ))}
    </svg>
  );
}

/** A copy of the graph, with the verdict on it once there is one. */
function SandboxGlyph({ verdict }: { verdict: boolean | null }) {
  return (
    <div className={`ld-sandbox${verdict === null ? "" : verdict ? " ok" : " bad"}`}>
      <span className="ld-sandbox-back" />
      <span className="ld-sandbox-front"><span>GRAPH.COPY</span></span>
      {verdict !== null && <span className="ld-sandbox-mark">{verdict ? <Check size={10} /> : <Cross size={10} />}</span>}
    </div>
  );
}

// ---- canvases, one per phase

function Poster() {
  return (
    <div className="ld-grid ld-grid-brief">
      <div className="ld-col">
        <Eyebrow>Brief</Eyebrow>
        <h2 className="ld-title">{FINDING.title} <em>{FINDING.em}</em></h2>
      </div>
      <div className="ld-col ld-col-rail">
        <Eyebrow>Plans that passed</Eyebrow>
        <ol className="ld-list">
          {PASSED.map((c, i) => (
            <li key={c.kind} className="ld-item">
              <span className="ld-n">{i + 1}.</span>
              <div className="min0">
                <Word label={`${c.kind} · cost ${c.cost}`} />
                <div className="ld-item-title">{c.title}</div>
              </div>
            </li>
          ))}
        </ol>
        <ActionBar />
      </div>
    </div>
  );
}

function ScanCanvas({ elapsed }: { elapsed: number }) {
  return (
    <div className="ld-center">
      <Eyebrow>Scan</Eyebrow>
      <h2 className="ld-h ld-in">The support desk was scanned.</h2>
      <div className="ld-row first ld-in d1">
        <Word label="Scenario" />
        <span className="ld-mono">acme_support · 15 nodes · 14 config edges · 7 rules</span>
      </div>
      <div className="ld-row ld-in d2">
        <Word label="Queries" />
        <span className="ld-mono">projection.rebuild → reach.untrusted_to_high → find.trifecta · 8 ms</span>
      </div>
      {elapsed > 1.9 && (
        <div className="ld-routed ld-in">
          <Eyebrow accent>↳ Found</Eyebrow>
          <span className="ld-serif">
            Finding <span className="ld-mono-inline">fnd:{FINDING.id}</span> opened. Customer tickets can reach Payments API.
          </span>
        </div>
      )}
    </div>
  );
}

function ExplainingCanvas({ elapsed }: { elapsed: number }) {
  const per = DUR.explaining / HOPS.length;
  const idx = Math.min(HOPS.length - 1, Math.floor(elapsed / per));
  const local = elapsed - idx * per;
  const show = local > per - 1.0;
  const hop = HOPS[idx];
  const done = HOPS.slice(0, idx + (show ? 1 : 0));
  return (
    <div className="ld-grid ld-grid-work">
      <div className="ld-col">
        <Eyebrow>Explaining</Eyebrow>
        <div className="ld-statement">
          Cistern is tracing <span key={hop.rule} className="ld-subject ld-in">rule {hop.rule}</span>
        </div>
        <div className="ld-question"><span key={hop.rule} className="ld-in">{hop.words}.</span></div>
        <div className="ld-glyph"><PathGlyph lit={idx} /></div>
        <div className="ld-thinking-slot">
          {!show && (
            <div className="ld-thinking"><span className="ld-blink">reading</span><span>evidence.pair_paths · hop {idx + 1}</span></div>
          )}
        </div>
      </div>
      <div className="ld-col ld-col-rail">
        <Eyebrow>Hops</Eyebrow>
        <ol className="ld-margin">
          {done.map((h, i) => (
            <li key={h.rule} className={`ld-margin-row ld-in${i === done.length - 1 ? " latest" : ""}`}>
              <Word label={`Rule ${h.rule}`} />
              <span>{h.line}</span>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

function TestingCanvas({ elapsed }: { elapsed: number }) {
  const per = DUR.testing / CANDIDATES.length;
  const idx = Math.min(CANDIDATES.length - 1, Math.floor(elapsed / per));
  const local = elapsed - idx * per;
  const show = local > per - 1.0;
  const c = CANDIDATES[idx];
  const done = CANDIDATES.slice(0, idx + (show ? 1 : 0));
  return (
    <div className="ld-grid ld-grid-work">
      <div className="ld-col">
        <Eyebrow>Testing fixes</Eyebrow>
        <div className="ld-statement">
          Cistern is testing <span key={idx} className="ld-subject ld-in">{c.short}</span>
        </div>
        <div className="ld-question"><span key={idx} className="ld-in">on a copy of the graph, with the same three queries.</span></div>
        <div className="ld-glyph"><SandboxGlyph verdict={show ? c.passed : null} /></div>
        <div className="ld-thinking-slot">
          {!show && (
            <div className="ld-thinking"><span className="ld-blink">running</span><span>reach.untrusted_to_high · find.trifecta · wf.intact</span></div>
          )}
        </div>
      </div>
      <div className="ld-col ld-col-rail">
        <Eyebrow>Verdicts</Eyebrow>
        <ol className="ld-margin">
          {done.map((d, i) => (
            <li key={i} className={`ld-margin-row ld-in${i === done.length - 1 ? " latest" : ""}`}>
              <Word label={`Sandbox ${i + 1}`} />
              <span><b className={d.passed ? "ok" : "bad"}>{d.passed ? "passed" : "failed"}</b> · {d.reason}</span>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

function BriefCanvas({ elapsed, awaiting, onApprove }: { elapsed: number; awaiting: boolean; onApprove: () => void }) {
  const settled = elapsed > 2.4;
  const [firing, setFiring] = useState(false);
  const click = () => {
    if (firing || !awaiting) return;
    setFiring(true);
    window.setTimeout(() => {
      onApprove();
      setFiring(false);
    }, 380);
  };
  return (
    <div className="ld-grid ld-grid-brief">
      <div className="ld-col">
        <Eyebrow>Brief</Eyebrow>
        <h2 className="ld-title">{FINDING.title} <em>{FINDING.em}</em></h2>
        <p className="ld-tldr">{FINDING.tldr}</p>
        <div className="ld-sub"><Eyebrow>Evidence in detail</Eyebrow></div>
        <ol className="ld-list">
          {HOPS.map((h, i) => (
            <li key={h.rule} className="ld-item">
              <span className="ld-n">{i + 1}.</span>
              <p className="ld-item-text">
                {h.line}
                <CiteChip n={i + 1} label={`rule ${h.rule} · ${h.edge}`} />
              </p>
            </li>
          ))}
        </ol>
      </div>
      <div className="ld-col ld-col-rail">
        <Eyebrow>Plans that passed</Eyebrow>
        <ol className="ld-list ld-list-rules">
          {PASSED.map((c, i) => (
            <li key={c.kind} className="ld-item">
              <span className="ld-n">{i + 1}.</span>
              <div className="min0">
                <Word label={`${c.kind} · cost ${c.cost}`} />
                <div className="ld-item-title">{c.title}</div>
                <div className="ld-item-target">{c.change}</div>
              </div>
            </li>
          ))}
        </ol>
        <ActionBar awaiting={awaiting} pulse={settled || awaiting} firing={firing} onClick={click} />
      </div>
    </div>
  );
}

function ApplyingCanvas({ elapsed }: { elapsed: number }) {
  const per = DUR.applying / APPLY.length;
  const idx = Math.min(APPLY.length - 1, Math.floor(elapsed / per));
  const local = elapsed - idx * per;
  const fired = local > per - 1.4;
  const step = APPLY[idx];
  return (
    <div className="ld-center wide">
      <Eyebrow accent={fired}>{fired ? step.done : step.doing}</Eyebrow>
      <div key={`${idx}-${fired}`} className="ld-in">
        <div className="ld-fired-row">
          <Word label={step.ref} />
          {fired && <span className="ld-fired-mark"><Check size={9} /></span>}
        </div>
        <h2 className="ld-h">{step.title}</h2>
        <div className="ld-target">{step.target}</div>
      </div>
      <div className={`ld-thinking${fired ? " accent" : ""}`}>
        {fired ? <span className="ld-mono-inline">ref · {step.ref}</span> : <Spinner size={12} />}
      </div>
    </div>
  );
}

function ClosedCanvas({ appHref }: { appHref: string }) {
  return (
    <div className="ld-grid ld-grid-closed">
      <div className="ld-col">
        <Eyebrow>Closed</Eyebrow>
        <h2 className="ld-h big">Finding closed.</h2>
        <p className="ld-closing">
          One config edge changed: the support bot's call to issue_refund is now gated by a person. The refund
          workflow kept everything it needs. Nothing was written until you said so.
        </p>
        <a href={appHref} className="ld-link">Now try one of yours <Arrow size={14} /></a>
      </div>
      <div className="ld-col ld-col-rail">
        <Eyebrow>Receipts</Eyebrow>
        <ol className="ld-receipts">
          {RECEIPTS.map((r) => (
            <li key={r.ref}>
              <Word label={r.label} />
              <span className="ld-receipt-text">{r.text}</span>
              <span className="ld-receipt-ref">{r.ref}</span>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
