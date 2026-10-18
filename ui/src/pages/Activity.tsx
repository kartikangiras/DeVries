// What happened on this scenario, in order: scans, runs, plans tested and proposed, decisions, applications and
// writes, one line each, newest first. Scans that follow one another are one line, so the runs and the decisions
// stay in view; the Scans tab lists them one by one. A run opens to its trace. The ask box at the top starts a
// question run. The lines are grouped by day.

import { useEffect, useState } from "react";
import { api, type ActivityItem, type ScanRow } from "../api";
import type { Tone } from "../desk";
import { useFetch } from "../fetch";
import { go, href } from "../route";
import type { DeVries } from "../state";
import { WithNames, capital, clock, countWord, day, plural } from "../text";
import { RunTrace } from "../Trace";
import { Button, Empty, Loading, PageBody, PageHeader, Status, Tabs } from "../ui";

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

/** A line of the feed, or several scans that followed one another folded into one line. */
type Row = ActivityItem & { scans?: ActivityItem[] };

/** Consecutive scans become one row; everything else stays a row of its own. The list is newest first. */
function collapseScans(list: ActivityItem[]): Row[] {
  const out: Row[] = [];
  for (const item of list) {
    const last = out[out.length - 1];
    if (item.kind === "scan" && last?.kind === "scan") {
      (last.scans ??= [{ ...last }]).push(item);
      continue;
    }
    out.push({ ...item });
  }
  return out;
}

/** Several scans in one sentence: how many, what each left open, how long they took. Falls back to the latest's own line. */
function scansSentence(scans: ActivityItem[], rows: Map<string, ScanRow>): string {
  const facts = scans.map((s) => (s.refs.scan_id ? rows.get(s.refs.scan_id) : undefined));
  const n = plural(scans.length, "scan", "scans");
  if (!facts.every((f): f is ScanRow => !!f)) return `${capital(n)}; the latest: ${scans[0].sentence}`;
  const opens = facts.map((f) => f.open), ms = facts.map((f) => f.duration_ms);
  const lo = Math.min(...opens), hi = Math.max(...opens), fast = Math.min(...ms), slow = Math.max(...ms);
  const open = lo === hi ? `${plural(lo, "open finding", "open findings")} each` : `${countWord(lo)} to ${countWord(hi)} open findings`;
  return `${capital(n)}, ${open}, ${fast === slow ? `${fast} ms` : `${fast} to ${slow} ms`}`;
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
  const scanRows = useFetch(() => api.scans(scenario), [scenario, c.scannedAt]);
  const byScan = new Map((scanRows.data ?? []).map((s) => [s.scan_id, s]));
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
  // what drove the runs on this page, read from the runs themselves; a configured model only speaks for the next one
  const runIds = new Set(items.filter((i) => i.kind === "run").map((i) => i.refs.run_id));
  const shownRuns = c.runList.filter((r) => runIds.has(r.id));
  const driven = shownRuns.filter((r) => r.mode === "agent");
  const modelName = driven[0]?.model ?? model?.name ?? "a model";
  const runsNote = !shownRuns.length
    ? (model?.configured ? `${model.name ?? "A model"} is configured for the next run.` : "Runs are scripted: no model is configured.")
    : !driven.length
      ? (model?.configured ? "The runs here were scripted; a model is configured for the next one." : "Runs are scripted: no model is configured.")
      : driven.length === shownRuns.length
        ? `The runs here were driven by ${modelName}.`
        : `${capital(countWord(driven.length))} of the ${plural(shownRuns.length, "run", "runs")} here ${driven.length === 1 ? "was" : "were"} driven by ${modelName}; the rest were scripted.`;
  const link = (id: string) => (id.startsWith("fnd:") ? href(scenario, "finding", id) : id.startsWith("mit:") ? (c.mitigations[id]?.targets[0] ? href(scenario, "finding", c.mitigations[id].targets[0], "fix") : null) : null);

  return (
    <PageBody>
      <PageHeader
        eyebrow="Activity"
        title={feed.loading && !feed.data ? "Reading the record." : items.length
          ? `${capital(plural(runs, "run", "runs"))}, ${plural(decisions, "decision", "decisions")}, ${plural(items.length, "line", "lines")} in all.`
          : "Nothing has happened here yet."}
        meta={<>Every scan, run, plan, decision and write on this scenario, newest first. {runsNote}</>}
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
                {(filter === "all" ? collapseScans(list) : list).map((item: Row, i) => {
                  const to = target(scenario, item);
                  const isRun = item.kind === "run" && !!item.refs.run_id;
                  const expanded = isRun && openRun === item.refs.run_id;
                  const folded = item.scans && item.scans.length > 1 ? item.scans : null;
                  return (
                    <li key={`${item.kind}-${item.at}-${i}`} className={`activity-row kind-${item.kind}${expanded ? " open" : ""}${folded ? " collapsed" : ""}`}>
                      <span className="trace-at">{clock(item.at)}</span>
                      <span className="activity-kind">{folded ? "scans" : KIND_WORD[item.kind]}</span>
                      <div className="activity-body">
                        <p className="activity-main">
                          {folded ? (
                            <>{scansSentence(folded, byScan)} · <button className="link" onClick={() => setFilter("scans")}>see each under Scans</button></>
                          ) : isRun ? (
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
