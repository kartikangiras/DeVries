// One audit run, step by step: when, in which phase, which tool, what came back, and who decided.

import { useEffect, useState, type ReactNode } from "react";
import type { Mitigation, RunUsage, RunWithSteps, Step } from "./api";
import type { Tone } from "./desk";
import { href } from "./route";
import { OUTCOME_SENTENCE, citeRun, mainLine, runState, verdictsOf } from "./runs";
import { WithNames, clock } from "./text";
import { Eyebrow, Status } from "./ui";

type Shared = { names: Record<string, string>; mitigations: Record<string, Mitigation>; scenario: string };

const RUN_TONE: Record<string, Tone> = { failed: "danger", waiting: "amber", done: "accent", running: "info", "": "muted" };

/** Where an id in a step leads: findings and plans have pages. */
const linker = (scenario: string, mitigations: Record<string, Mitigation>) => (id: string) =>
  id.startsWith("fnd:") ? href(scenario, "finding", id)
    : id.startsWith("mit:") && mitigations[id]?.targets[0] ? href(scenario, "finding", mitigations[id].targets[0], "fix") : null;

/** The sandbox verdicts of a step, one row a plan. They are never folded away. */
export function Verdicts({ rows, names }: { rows: ReturnType<typeof verdictsOf>; names: Record<string, string> }) {
  return (
    <ul className="verdicts" aria-label="Sandbox verdicts">
      {rows.map((v, i) => (
        <li key={i} className={`verdict ${v.ok ? "pass" : "fail"}`}>
          <span className="verdict-mark" aria-label={v.ok ? "passes" : "fails"}>{v.ok ? "✓" : "✕"}</span>
          <span className="verdict-plan"><WithNames text={v.plan} names={names} /></span>
          <span className="verdict-cost">{v.cost != null ? `cost ${v.cost}` : ""}</span>
          <span className="verdict-why"><WithNames text={v.why} names={names} /></span>
        </li>
      ))}
    </ul>
  );
}

function StepRow({ step, lit, names, mitigations, scenario }: Shared & { step: Step; lit: boolean }) {
  const verdicts = verdictsOf(step, mitigations);
  const link = linker(scenario, mitigations);
  return (
    <li className={`trace-row by-${step.by}${step.error ? " failed" : ""}${lit ? " lit" : ""}`} id={`step-${step.n}`}>
      <span className="trace-at">{clock(step.at)}</span>
      <span className="trace-type">{step.phase}</span>
      <div className="trace-body">
        <p className="trace-main">
          {step.kind === "tool" && <code className="tool">{step.tool}</code>}
          <WithNames text={mainLine(step)} names={names} link={link} />
        </p>
        {step.because && (
          <p className="because">
            because <WithNames text={step.because.replace(/^[A-Z]/, (ch) => ch.toLowerCase())} names={names} link={link} />
          </p>
        )}
        {step.error && <p className="trace-error">{step.error}</p>}
        {verdicts.length > 0 && <Verdicts rows={verdicts} names={names} />}
        {step.kind === "tool" && (step.queries.length > 0 || step.result) && (
          <details className="trace-more">
            <summary>
              {step.queries.length ? `${step.queries.length} graph ${step.queries.length === 1 ? "query" : "queries"}` : "what it returned"}
            </summary>
            {step.queries.length > 0 && (
              <p className="trace-queries">
                {step.queries.map((q) => <a key={q} href={href(scenario, "method", "queries", q)}>{q}</a>)}
              </p>
            )}
            {step.arguments && <pre>{JSON.stringify(step.arguments, null, 1)}</pre>}
            {step.result && <pre>{JSON.stringify(step.result, null, 1)}</pre>}
          </details>
        )}
      </div>
      <span className="trace-meta">
        <span className="who" title={`decided by: ${step.by}`}>{step.by}</span>
        {step.ms != null && <span>{step.ms} ms</span>}
      </span>
    </li>
  );
}

export const CEILING_NOTE = "the model is not in the price table, so this is the dearest known rate";
/** What a run cost in dollars; a ceiling, when the model's own rate is not known, is marked as one. */
export function Cost({ usage, digits = 2 }: { usage: RunUsage; digits?: number }) {
  const amount = `$${usage.cost_usd.toFixed(digits)}`;
  return usage.cost_is_ceiling ? <span className="cost-ceiling" title={CEILING_NOTE}>≤ {amount}</span> : <>{amount}</>;
}

/** How a run was driven, said plainly: by a model, or by the scripted search when no model could be used. */
function driver(run: RunWithSteps): ReactNode {
  if (run.mode === "scripted") return `scripted, not a model: ${run.scripted_reason ?? "no model was used"}`;
  return <>model {run.model ?? "unknown"} · {run.usage.model_steps} model {run.usage.model_steps === 1 ? "step" : "steps"} · <Cost usage={run.usage} /></>;
}

export function RunTrace({ run, ...shared }: Shared & { run: RunWithSteps }) {
  const [lit, setLit] = useState<number | null>(null);
  const state = runState(run);
  const cited = citeRun(run);
  useEffect(() => setLit(null), [run.id]);
  const cite = (n: number) => {
    const row = cited.rows.find((r) => r.n === n);
    if (!row) return;
    setLit(row.step.n);
    document.getElementById(`step-${row.step.n}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  };
  return (
    <section className="run" aria-label={`Audit run ${run.id}`}>
      <header className="run-head">
        <div>
          <h2>
            {run.kind === "ask" ? "A question" : "Audit run"} <code>{run.id}</code>
          </h2>
          {run.kind === "ask" && run.question && <p className="run-question">{run.question}</p>}
          <p className="run-meta">
            started {clock(run.started_at)} · <span className="run-driver">{driver(run)}</span> · {run.usage.simulations} sandbox {run.usage.simulations === 1 ? "graph" : "graphs"}
          </p>
        </div>
        <Status tone={RUN_TONE[state.cls]} pulse={run.status === "running" || run.status === "awaiting_approval"} wide>{state.word}</Status>
      </header>
      <ol className="trace">
        {run.steps.map((step) => <StepRow key={step.n} step={step} lit={lit === step.n} {...shared} />)}
      </ol>
      {run.error && <p className="trace-error">{run.error}</p>}
      {(run.answer || (run.outcome && OUTCOME_SENTENCE[run.outcome])) && (
        <section className="report">
          <Eyebrow>{run.kind === "ask" ? "Answer" : "Report"}</Eyebrow>
          {run.answer ? (
            <p className="report-text"><WithNames text={run.answer} names={shared.names} cites={cited.cites} onCite={cite} link={linker(shared.scenario, shared.mitigations)} /></p>
          ) : (
            <p className="report-text">{OUTCOME_SENTENCE[run.outcome!]}</p>
          )}
          {run.answer && (
            <p className="byline">
              {run.answer_by === "model" ? `Written by ${run.model}.` : "Put together from a template, not written by a model."} Every id in it was returned by a step above.
            </p>
          )}
          {cited.rows.length > 0 && (
            <ol className="report-cites">
              {cited.rows.map(({ n, step }) => (
                <li key={n}>
                  <button className="ref" onClick={() => cite(n)}>[{n}]</button>
                  <code>{step.tool}</code>
                  <span>step {step.n} · {clock(step.at)}</span>
                </li>
              ))}
            </ol>
          )}
        </section>
      )}
    </section>
  );
}
