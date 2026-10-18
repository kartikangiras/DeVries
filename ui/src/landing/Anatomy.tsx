// The eval block under "Every finding shows its work": the model beside the search, the same plan in
// fewer sandboxes, with the measurement's provenance on it. The figures are /api/about's, never typed in.

import { useState } from "react";
import type { About, Eval } from "../api";
import { capital, countWord } from "../text";
import { Reveal } from "./bits";

/** `about` names the model and carries the eval, or is null until it loads. */
export function Anatomy({ about }: { about: About | null }) {
  const model = about ? about.model ?? about.model_default : null;
  const ev = about?.eval ?? null;
  return (
    <Reveal as="article" className="l-eval" y={24} duration={0.55} margin="-60px">
      <div className="l-eval-copy">
        <h3 className="l-eval-title">Runs with a model, or without one</h3>
        <p className="l-eval-body">
          With a key, Claude{model && <> (<code className="la-code">{model}</code>)</>} drives the audit and picks the next tool call, saying why. Without one, a fixed search does the same job with the same tools, and the run says which it was.{" "}
          {ev
            ? <>{capital(countWord(ev.matched))} runs out of {countWord(ev.runs)}, the model proposed the plan the search found, in fewer sandboxes: it reads the verdict of a failed revoke and goes straight to the gate.</>
            : about ? "No model run has been measured on this machine; the figures fill in when one is." : null}
        </p>
      </div>
      <div className="l-eval-visual"><CompareVisual ev={ev} loaded={about !== null} /></div>
    </Reveal>
  );
}

/* ---- the model beside the search: the same plan, fewer sandboxes */

/** The model's sandboxes come as a range, "2–5"; the bar is drawn to its upper end. */
const upper = (range: string) => Number(range.match(/\d+(?!.*\d)/)?.[0] ?? 0);
/** "2026-10-13" in words, "13 October 2026"; anything else is shown as it came. */
function dateWords(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  return new Date(y, m - 1, d).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}

/** The measured eval, when there is one; the frame with its provenance either way. `loaded` says /api/about has answered. */
function CompareVisual({ ev, loaded }: { ev: Eval | null; loaded: boolean }) {
  const [hovered, setHovered] = useState<number | null>(null);
  const runs = ev?.scenarios ?? [];
  const max = Math.max(1, ...runs.map((s) => Math.max(s.search_total, upper(s.model_sandboxes))));
  const r = hovered === null ? null : runs[hovered] ?? null;
  const provenance = ev
    ? `measured ${dateWords(ev.measured_at)} with ${ev.model}, ${ev.runs_per_scenario} ${ev.runs_per_scenario === 1 ? "run" : "runs"} a scenario`
    : loaded ? "not measured with a model on this machine" : "reading the measurement…";
  return (
    <div className="la-compare">
      <div className="la-compare-head">
        <div>
          <div className="eyebrow">Sandboxes to a proposal</div>
          <div className="la-compare-metric">
            {ev ? (
              <>
                <span key={r ? r.scenario : "all"} className="la-compare-big l-fade-in">{r ? `${r.model_sandboxes} vs ${r.search_total}` : `${ev.matched} / ${ev.runs}`}</span>
                <span className="la-compare-delta">{r ? "model vs search" : "runs matched"}</span>
              </>
            ) : (
              <span className="la-compare-big faint">—</span>
            )}
          </div>
        </div>
        <div className="la-compare-right">
          <div>{ev ? (r ? r.scenario : `${countWord(runs.length)} scenarios`) : "no eval"}</div>
          {ev && <div className="la-accent"><span className="la-pulse" />{ev.matched === ev.runs ? "same plan every run" : `same plan ${ev.matched} of ${ev.runs}`}</div>}
        </div>
      </div>
      <div className="la-compare-chart" style={runs.length ? { gridTemplateColumns: `repeat(${runs.length}, 1fr)` } : undefined}>
        {runs.map((run, i) => (
          <div key={run.scenario} className={`la-group${hovered === i ? " on" : ""}`} onMouseEnter={() => setHovered(i)} onMouseLeave={() => setHovered(null)}>
            <div className="la-bars">
              <span className="la-bar search" style={{ height: `${(run.search_total / max) * 100}%` }} title={`search · ${run.search_total} sandboxes`} />
              <span className="la-bar model" style={{ height: `${(upper(run.model_sandboxes) / max) * 100}%` }} title={`model · ${run.model_sandboxes} sandboxes`} />
            </div>
            <div className="la-group-label">{run.scenario.replace("acme_", "")}</div>
          </div>
        ))}
        {!runs.length && <div className="la-compare-none">{loaded ? "The landing quotes figures only when `make agent-eval` has measured them here." : ""}</div>}
      </div>
      {ev && (
        <div className="la-compare-axis">
          <span><i className="la-swatch search" />search · {runs.map((s) => s.search_total).join(" · ")}</span>
          <span className="la-accent"><i className="la-swatch model" />model · {runs.map((s) => s.model_sandboxes).join(" · ")}</span>
        </div>
      )}
      <div className="la-compare-prov">{provenance}</div>
    </div>
  );
}
