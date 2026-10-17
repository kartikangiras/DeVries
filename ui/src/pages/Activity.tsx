// What happened on this scenario, in order: scans, runs, plans tested and proposed, decisions, applications and
// writes, one line each, newest first. A run opens to its trace. The ask box at the top starts a question run.
// The day groups and the run rows are Manthan's audit log (see ui/THIRD_PARTY_NOTICES.md).

import { useEffect, useState } from "react";
import { api, type ActivityItem } from "../api";
import type { Tone } from "../desk";
import { useFetch } from "../fetch";
import { go, href } from "../route";
import type { DeVries } from "../state";
import { WithNames, capital, clock, day, plural } from "../text";
import { RunTrace } from "../Trace";
import { Button, Empty, Fold, Loading, PageBody, PageHeader, Status, Tabs } from "../ui";

type Filter = "all" | "runs" | "plans" | "decisions" | "scans" | "writes";
const FILTER: Record<Exclude<Filter, "all">, ActivityItem["kind"][]> = {
  runs: ["run"], plans: ["tested", "proposal"], decisions: ["decision", "applied"], scans: ["scan"], writes: ["written", "labelled", "import"],
};
const KIND_WORD: Record<ActivityItem["kind"], string> = {
  scan: "scan", run: "run", tested: "tested", proposal: "proposed", decision: "decision", applied: "applied", written: "written", labelled: "labelled", import: "import",
};
const TONE: Record<string, Tone> = {
  open: "danger", clean: "accent", failed: "danger", proposed: "amber", approved: "accent", rejected: "muted", applied: "accent", written: "accent",
  running: "info", awaiting_approval: "amber", done: "accent", "": "muted",
};

/** A question for the auditor. With a model it answers with its tools; without one the graph answers four kinds of
 *  question by itself (what can reach X, what X reaches, a path from A to B, which workflows need X). */
function AskBox({ c }: { c: DeVries }) {
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

/** Where a line leads: a plan to its finding's fix step, a run to its trace, a finding to its page. */
function target(scenario: string, item: ActivityItem): string | null {
  const f = item.refs.finding_ids?.[0];
  if (item.kind === "run" && item.refs.run_id) return href(scenario, "audit", item.refs.run_id);
  if (f && (item.kind === "proposal" || item.kind === "decision" || item.kind === "applied" || item.kind === "written")) return href(scenario, "finding", f, "fix");
  if (f && item.kind === "tested") return href(scenario, "finding", f, "options");
  return null;
}

export function ActivityPage({ c, scenario, runId }: { c: DeVries; scenario: string; runId: string | null }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [openRun, setOpenRun] = useState<string | null>(runId);
  const { showRun } = c;
  useEffect(() => {
    if (runId) {
      setOpenRun(runId);
      showRun(runId);
    }
  }, [runId, showRun]);
  // the run the page holds opens by itself: the latest one on arrival, and a question asked here as it is answered
  const heldRun = c.run?.id ?? null;
  useEffect(() => {
    if (heldRun) setOpenRun(heldRun);
  }, [heldRun]);
  // ask again when a run, a plan, a decision or a scan has moved
  const feed = useFetch(() => api.activity(scenario), [scenario, c.runList, c.plans, c.scannedAt, c.configHash]);
  const items = feed.data?.items ?? [];
  const shown = filter === "all" ? items : items.filter((i) => FILTER[filter].includes(i.kind));
  const count = (f: Exclude<Filter, "all">) => items.filter((i) => FILTER[f].includes(i.kind)).length;
  const active = c.runList.some((r) => r.status === "running" || r.status === "awaiting_approval");
  const canAudit = (c.findings?.findings.some((f) => f.status === "open") ?? false) && !active;
  const model = c.session?.model;
  const days = new Map<string, ActivityItem[]>();
  for (const item of shown) days.set(day(item.at), [...(days.get(day(item.at)) ?? []), item]);
  const runs = items.filter((i) => i.kind === "run").length;
  const decisions = items.filter((i) => i.kind === "decision").length;
  const link = (id: string) => (id.startsWith("fnd:") ? href(scenario, "finding", id) : id.startsWith("mit:") ? (c.mitigations[id]?.targets[0] ? href(scenario, "finding", c.mitigations[id].targets[0], "fix") : null) : null);

  return (
    <PageBody>
      <PageHeader
        eyebrow="Activity"
        title={feed.loading && !feed.data ? "Reading the record." : items.length
          ? `${capital(plural(runs, "run", "runs"))}, ${plural(decisions, "decision", "decisions")}, ${plural(items.length, "line", "lines")} in all.`
          : "Nothing has happened here yet."}
        meta={<>Every scan, run, plan, decision and write on this scenario, newest first. {model?.configured ? `Runs are driven by ${model.name}.` : "Runs are scripted: no model is configured."}</>}
        actions={canAudit && <Button variant="primary" size="lg" onClick={c.startAudit} disabled={c.busy}>Run audit</Button>}
      />
      <AskBox c={c} />
      {feed.error && <p className="whatif-error">{feed.error}</p>}
      {!c.findings || (feed.loading && !feed.data) ? <Loading label="Reading the record" /> : items.length ? (
        <>
          <Tabs label="Kind" value={filter} onChange={setFilter} options={[
            { value: "all", label: "All", count: items.length },
            { value: "runs", label: "Runs", count: count("runs") },
            { value: "plans", label: "Plans", count: count("plans") },
            { value: "decisions", label: "Decisions", count: count("decisions") },
            { value: "scans", label: "Scans", count: count("scans") },
            ...(count("writes") ? [{ value: "writes" as Filter, label: "Writes", count: count("writes") }] : []),
          ]} />
          {[...days].map(([name, list]) => (
            <section className="day" key={name}>
              <h2 className="day-name">{name}</h2>
              <ol className="activity">
                {list.map((item, i) => {
                  const to = target(scenario, item);
                  const isRun = item.kind === "run" && !!item.refs.run_id;
                  const expanded = isRun && openRun === item.refs.run_id;
                  return (
                    <li key={`${item.kind}-${item.at}-${i}`} className={`activity-row kind-${item.kind}${expanded ? " open" : ""}`}>
                      <span className="trace-at">{clock(item.at)}</span>
                      <span className="activity-kind">{KIND_WORD[item.kind]}</span>
                      <div className="activity-body">
                        <p className="activity-main">
                          {isRun ? (
                            <button className="link-plain" onClick={() => { const id = item.refs.run_id!; if (expanded) setOpenRun(null); else { setOpenRun(id); showRun(id); go(scenario, "audit", id); } }}>
                              <WithNames text={item.sentence} names={c.names} />
                            </button>
                          ) : to ? (
                            <a className="link-plain" href={to}><WithNames text={item.sentence} names={c.names} link={link} /></a>
                          ) : (
                            <WithNames text={item.sentence} names={c.names} link={link} />
                          )}
                        </p>
                        {item.reason && <p className="because">reason given: {item.reason}</p>}
                        {expanded && c.run && c.run.id === item.refs.run_id && (
                          <div className="activity-trace">
                            <RunTrace run={c.run} names={c.names} mitigations={c.mitigations} scenario={scenario} />
                          </div>
                        )}
                        {expanded && c.run?.id !== item.refs.run_id && <Loading label="Reading the run" />}
                      </div>
                      <span className="activity-who">{item.who ?? ""}</span>
                      <Status tone={TONE[item.status ?? ""] ?? "muted"}>{(item.status ?? "").replace("_", " ")}</Status>
                    </li>
                  );
                })}
              </ol>
            </section>
          ))}
          {!shown.length && <Empty>Nothing of this kind has happened here.</Empty>}
          <Fold className="source" summary="Source and method" sub={`${plural(feed.data?.queries.length ?? 0, "FalkorDB query", "FalkorDB queries")} · the run registry`}>
            <p className="chart-note">
              Scans, plans, decisions and writes are records in the scenario's graph in FalkorDB, read by{" "}
              {(feed.data?.queries ?? []).map((q, i) => <span key={q}>{i > 0 && ", "}<a href={href(scenario, "queries", q)}>{q}</a></span>)}.
              Runs are kept by the app for as long as it runs; each step of a run says who decided it: model, loop, scripted or person.
            </p>
          </Fold>
        </>
      ) : (
        <Empty>
          {c.findings.findings.some((f) => f.status === "open")
            ? "Run the audit: it scans the graph, reads the findings, tests fixes in sandbox graphs, and stops for a person before anything changes."
            : "Nothing is open in this scenario, and nothing has been recorded yet."}
        </Empty>
      )}
    </PageBody>
  );
}
