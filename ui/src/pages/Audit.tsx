// What the auditor did, run by run, grouped by the day it happened. One run is open at a time and
// shows every step. The page is Manthan's audit log (see ui/THIRD_PARTY_NOTICES.md).

import { useEffect, useState } from "react";
import type { Run } from "../api";
import type { Tone } from "../desk";
import { go } from "../route";
import { runState } from "../runs";
import type { Cistern } from "../state";
import { capital, clock, day, plural } from "../text";
import { RunTrace } from "../Trace";
import { Button, Empty, Loading, PageBody, PageHeader, Status } from "../ui";

const TONE: Record<string, Tone> = { failed: "danger", waiting: "amber", done: "accent", running: "info", "": "muted" };

/** A question for the auditor. With a model it answers with its tools; without one the graph answers four kinds of
 *  question by itself (what can reach X, what X reaches, a path from A to B, which workflows need X). */
function AskBox({ c }: { c: Cistern }) {
  const [question, setQuestion] = useState("");
  const model = c.session?.model;
  const withModel = !!model?.configured && !model.budget_spent && model.questions_left > 0;
  const can = withModel || !model?.configured;
  const nodes = c.flow?.nodes ?? [];
  const nameOf = (n: { data: { id: string; name?: string } } | undefined) => n?.data.name ?? n?.data.id;
  const high = nodes.find((n) => n.label === "Resource" && n.data.impact === "high") ?? nodes.find((n) => n.label === "Resource");
  const untrusted = nodes.find((n) => n.label === "DataSource" && n.data.trust === "untrusted") ?? nodes.find((n) => n.label === "DataSource");
  const agent = nodes.find((n) => n.label === "Agent");
  const tool = nodes.find((n) => n.label === "Tool");
  const examples = [
    high && `What can reach ${nameOf(high)}?`,
    agent && `What does ${nameOf(agent)} reach?`,
    untrusted && high && `Is there a path from ${nameOf(untrusted)} to ${nameOf(high)}?`,
    tool && `Which workflows need ${nameOf(tool)}?`,
  ].filter((q): q is string => !!q);
  return (
    <form className="ask" onSubmit={(e) => { e.preventDefault(); if (can && question.trim().length >= 3) { c.ask(question.trim()); setQuestion(""); } }}>
      <div className="ask-line">
        <input type="text" value={question} onChange={(e) => setQuestion(e.target.value)} maxLength={2000} disabled={!can || c.busy}
          placeholder={withModel ? "Ask about this scenario: which agents can reach the payments API?" : "What can reach …? What does … reach? Is there a path from … to …? Which workflows need …?"} aria-label="Ask the auditor" />
        <Button size="lg" type="submit" disabled={!can || c.busy || question.trim().length < 3}>Ask</Button>
      </div>
      {can && examples.length > 0 && (
        <p className="ask-examples">
          {examples.map((q) => <button type="button" key={q} disabled={c.busy} onClick={() => c.ask(q)}>{q}</button>)}
        </p>
      )}
      <p className="ask-note">
        {withModel ? "The auditor answers with its tools. Anything it tests, it tests in a sandbox: a question changes nothing."
          : !model?.configured ? "No model is configured, so the graph answers four kinds of question by itself, each by one query: what can reach a thing, what a thing reaches, whether there is a path from one thing to another, and which workflows need a tool or a data source. Name things by their id or their name."
          : model.budget_spent ? "Today's model budget is spent, so questions are closed until tomorrow."
          : "This session has used its questions."}
      </p>
    </form>
  );
}

export function Audit({ c, scenario, runId }: { c: Cistern; scenario: string; runId: string | null }) {
  const { showRun } = c;
  useEffect(() => {
    if (runId) showRun(runId);
  }, [runId, showRun]);

  const runs = c.runList;
  const open = c.run;
  const active = runs.some((r) => r.status === "running" || r.status === "awaiting_approval");
  const canAudit = (c.findings?.findings.some((f) => f.status === "open") ?? false) && !active;
  const model = c.session?.model;
  const audits = runs.filter((r) => r.kind === "audit").length;
  const days = new Map<string, Run[]>();
  for (const r of runs) days.set(day(r.started_at), [...(days.get(day(r.started_at)) ?? []), r]);

  return (
    <PageBody>
      <PageHeader
        eyebrow="Audit"
        title={!runs.length ? "No audit has run yet."
          : `${capital([audits && plural(audits, "audit run", "audit runs"), runs.length - audits && plural(runs.length - audits, "question", "questions")].filter(Boolean).join(" and "))}.`}
        meta={model?.configured
          ? <>Runs are driven by {model.name}, which picks the tools; each step says who decided it.</>
          : <>No model is configured, so a run is scripted: it scans, then tries the candidate fixes in sandbox graphs, cheapest first. Each step says who decided it.</>}
        actions={canAudit && <Button variant="primary" size="lg" onClick={c.startAudit} disabled={c.busy}>Run audit</Button>}
      />
      <AskBox c={c} />
      {!c.findings ? <Loading /> : runs.length ? (
        [...days].map(([name, list]) => (
          <section className="day" key={name}>
            <h2 className="day-name">{name}</h2>
            {list.map((r) => {
              if (open?.id === r.id) return <RunTrace key={r.id} run={open} names={c.names} mitigations={c.mitigations} scenario={scenario} />;
              const state = runState(r);
              return (
                <button className="run-row" key={r.id} onClick={() => go(scenario, "audit", r.id)}>
                  <span className="trace-at">{clock(r.started_at)}</span>
                  <span className="run-row-name">{r.kind === "ask" ? "A question" : "Audit run"} <code>{r.id}</code></span>
                  <span className="run-row-mode">{r.mode === "scripted" ? "scripted" : r.model}</span>
                  <Status tone={TONE[state.cls]}>{state.word}</Status>
                </button>
              );
            })}
          </section>
        ))
      ) : (
        <Empty>
          {c.findings.findings.some((f) => f.status === "open")
            ? "Run the audit: it scans the graph, reads the findings, tests fixes in sandbox graphs, and stops for a person before anything changes."
            : "Nothing is open in this scenario, so there is nothing to audit."}
        </Empty>
      )}
    </PageBody>
  );
}
