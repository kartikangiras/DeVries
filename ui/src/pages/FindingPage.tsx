// One finding, worked through in order: the problem, read off the graph; the fix a sandbox passed, with
// the change it makes to the configuration; and every other option, tested the same way. The trace of
// the run that did the work is one step further. The page is Manthan's case workspace (strip, brief,
// drafted actions, the rail, the approval bar), holding a finding instead of a case (see
// ui/THIRD_PARTY_NOTICES.md).

import { useEffect, useMemo, useState } from "react";
import { api, type Finding, type Mitigation, type Path, type RunWithSteps } from "../api";
import { ApprovalBar } from "../ApprovalBar";
import { citations, headline, tldr, verdictSentence } from "../brief";
import { FIX_VERB, deskOf, exposure, patchText, recommendation, verdictLine, type Desk } from "../desk";
import { Chart, RendererSwitch, useRenderer } from "../graph/Chart";
import { KIND_OF, cutsOf, findingQueries, focusOf, hopKey, linkIndex, nodeFacts, nodeIndex, pathsOf, withReaders } from "../paths";
import { href } from "../route";
import type { DeVries } from "../state";
import { KIND_WORDS, WithNames, capital, clock, plural, short } from "../text";
import { RunTrace } from "../Trace";
import { Button, Empty, Eyebrow, KV, Loading } from "../ui";
import { After } from "./Fixes";
import { badgesOf } from "./GraphPage";
import { ServerTable } from "./Servers";
import { CutBlock, WhatIfLine } from "./WhatIf";

const two = (n: number) => String(n).padStart(2, "0");
type Step = "problem" | "fix" | "options" | "trace";

/** Hop by hop: the rule that derived each one, the config edge behind it, and whether a fix can cut it. */
function Hops({ path, c }: { path: Path; c: DeVries }) {
  const live = linkIndex(c.flow);
  return (
    <ol className="steps hops">
      {path.hops.map((hop, i) => {
        const [rule, ...rest] = hop.split(": ");
        const link = live.get(hopKey(path.node_ids[i], path.node_ids[i + 1]));
        const blocked = link?.rel === "GATED_FLOW";
        const behind = link?.data.config;
        const fixes = link?.data.fixes ?? [];
        return (
          <li key={i} className={blocked ? "blocked" : ""}>
            <span className="num">{two(i + 1)}.</span>
            <div>
              <p>
                <span className="source-word">{rule}</span>
                <WithNames text={rest.join(": ")} names={c.names} />
              </p>
              <p className="behind">
                {behind ? (
                  <>
                    {behind.rel} {behind.from_id} → {behind.to_id} ·{" "}
                    {blocked ? (
                      <span className="gate">blocked by {link?.data.gate === "quarantine" ? "a quarantine" : "an approval gate"} now</span>
                    ) : fixes.length ? (
                      <span className="cut">cut by {fixes.join(", ")}</span>
                    ) : (
                      <>cannot be cut</>
                    )}
                  </>
                ) : (
                  <>this hop is no longer in the graph</>
                )}
              </p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** The plan on the table, change by change, each with the literal edit to the configuration. */
function Drafted({ plan, c, applying }: { plan: Mitigation; c: DeVries; applying: boolean }) {
  const n = plan.plan.fixes.length;
  return (
    <section className="block drafted">
      <div className="block-head">
        <Eyebrow>{applying ? "Applying" : "Drafted change"}</Eyebrow>
        <span>{plural(n, "change", "changes")} · {applying ? "approved, being applied" : "awaiting approval"}</span>
      </div>
      <ol className="steps">
        {plan.plan.fixes.map((fix, i) => (
          <li key={i}>
            <span className="num">{two(i + 1)}.</span>
            <div>
              <p className="step-title">
                <span className="source-word">{FIX_VERB[fix.kind] ?? fix.kind}</span>
                <WithNames text={capital(plan.summary[i] ?? plan.summary.join(", and "))} names={c.names} />
              </p>
              {plan.patch[i] && <p className="patch">{patchText(plan.patch[i])}</p>}
            </div>
          </li>
        ))}
      </ol>
      <p className="provenance">
        {plan.source === "agent"
          ? <>Proposed by the model. Its reason: <em>{plan.rationale ?? "none given"}</em></>
          : <>Proposed by the scripted search, not by a model: the cheapest plan that passed in a sandbox.</>}
      </p>
    </section>
  );
}

/** After Approve: what happened, in order. Applied by a run, each line comes from the step that did it; by a click, from what apply always does. */
function Applied({ plan, run, c }: { plan: Mitigation; run: RunWithSteps | null; c: DeVries }) {
  const mine = run && run.mitigation_id === plan.id ? run.steps : [];
  const person = mine.find((s) => s.by === "person");
  const apply = mine.find((s) => s.tool === "apply_fix");
  const rescan = apply ? mine.find((s) => s.tool === "scan" && s.n > apply.n) : undefined;
  const fixQueries = apply?.queries.filter((q) => q.startsWith("fix.")) ?? [];
  const rows: { title: string; target: string; at: number | null | undefined; ms?: number | null }[] = [
    { title: `Approved by ${plan.approved_by ?? "a person"}`, target: plan.id, at: person?.at ?? plan.applied_at },
    { title: capital(plan.summary.join(", and ")), target: [fixQueries.join(", "), ...plan.patch.map(patchText)].filter(Boolean).join(" · "), at: apply?.at ?? plan.applied_at, ms: apply?.ms },
    ...(apply
      ? apply.queries.includes("projection.rebuild") ? [{ title: "Flow layer rebuilt from the config", target: "projection.rebuild", at: apply.at }] : []
      : [{ title: "Flow layer rebuilt from the config", target: "projection.rebuild", at: plan.applied_at }]),
    ...(rescan
      ? [{ title: `Rescanned: ${rescan.headline ?? "done"}`, target: rescan.queries.filter((q) => q.startsWith("reach.") || q.startsWith("find.")).join(", ") || "scan", at: rescan.at, ms: rescan.ms }]
      : !apply && plan.applied_at ? [{ title: "Rescanned after the change", target: "reach.untrusted_to_high, find.trifecta", at: c.scannedAt ?? plan.applied_at }] : []),
  ];
  return (
    <section className="block applied">
      <div className="block-head">
        <Eyebrow tone="accent">Change applied</Eyebrow>
        <span>{plan.id}{plan.applied_at ? ` · ${clock(plan.applied_at)}` : ""}</span>
      </div>
      <ol className="steps fired">
        {rows.map((row, i) => (
          <li key={i} style={{ animationDelay: `${i * 380}ms` }}>
            <span className="num tick" aria-hidden>✓</span>
            <div>
              <p className="step-title"><WithNames text={row.title} names={c.names} /></p>
              <p className="patch">
                {row.target}
                {row.at ? ` · ${clock(row.at)}` : ""}
                {row.ms != null ? ` · ${row.ms} ms` : ""}
              </p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** Every plan a sandbox was asked about for this finding, passed or not, with the reason; a passing one can be previewed. */
function Tested({ desk, c, picked, onPick }: { desk: Desk; c: DeVries; picked: string | null; onPick: (id: string | null) => void }) {
  if (!desk.tested.length) return <Empty>No plan has been tested for this finding yet.</Empty>;
  const ms = desk.tested.reduce((sum, m) => sum + (m.sandbox_ms ?? 0), 0);
  return (
    <section className="block tested">
      <div className="block-head">
        <Eyebrow>Tested in sandbox graphs</Eyebrow>
        <span>{plural(desk.tested.length, "plan", "plans")} · {ms} ms · cheapest first</span>
      </div>
      <ul className="verdicts">
        {desk.tested.map((m) => (
          <li key={m.id} className={`verdict ${m.passed ? "pass" : "fail"}${picked === m.id ? " on" : ""}`}>
            <span className="verdict-mark" aria-label={m.passed ? "passes" : "fails"}>{m.passed ? "✓" : "✕"}</span>
            <span className="verdict-plan"><WithNames text={m.summary.join(", and ")} names={c.names} /></span>
            <span className="verdict-cost">cost {m.cost}</span>
            <span className="verdict-why">
              {m.passed ? verdictLine(m) : <WithNames text={m.reason ?? "it did not pass"} names={c.names} />}
              {m.status === "rejected" && ` · rejected by ${m.approved_by ?? "a person"}${m.decision_reason ? `: ${m.decision_reason}` : ""}`}
              {m.status === "applied" && " · applied"}
              {m.passed && <> · <button className="link" onClick={() => onPick(picked === m.id ? null : m.id)}>{picked === m.id ? "hide the preview" : "preview it"}</button></>}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Why the path is a problem: the agents on it against Meta's Rule of Two, the workflows that constrain a fix, the class in OWASP's list. */
function Analysis({ finding, agentIds, c, scenario }: { finding: Finding; agentIds: string[]; c: DeVries; scenario: string }) {
  const cards = agentIds.map((id) => c.scorecard?.agents.find((a) => a.agent_id === id)).filter((a): a is NonNullable<typeof a> => !!a);
  const workflows = (c.flow?.workflows ?? []).filter((w) => agentIds.includes(w.run_by));
  return (
    <section className="block analysis">
      <div className="block-head">
        <Eyebrow>Why it is a problem</Eyebrow>
        <span>read off the flow layer</span>
      </div>
      <ul className="analysis-rows">
        {cards.map((a) => (
          <li key={a.agent_id}>
            <strong>{c.names[a.agent_id] ?? a.agent_id}</strong> holds {a.count === 3 ? "all three" : a.count === 2 ? "two" : a.count === 1 ? "one" : "none"} of Meta's Rule of Two properties
            {a.properties.length ? ` (${a.properties.map((p) => (p === "A" ? "untrusted input" : p === "B" ? "private data" : "a way to act")).join(", ")})` : ""}
            {a.autonomous ? ", and runs unattended: nobody is there to catch a call" : ""}.
          </li>
        ))}
        {workflows.map((w) => (
          <li key={w.id}>
            <strong>{w.name}</strong> is {w.mode === "autonomous" ? "an unattended" : "a supervised"} workflow that needs <WithNames text={w.needs.join(", ") || "no tool"} names={c.names} />
            {w.mode === "autonomous" ? ", so a gate on one of those breaks it: a fix has to go around it" : ", so a gate on one of those is a fix a person can live with"}.
          </li>
        ))}
        {finding.kind === "injection" && (
          <li>
            Text an outsider writes into <strong>{c.names[finding.source_id ?? ""] ?? finding.source_id}</strong> can end in an action on <strong>{c.names[finding.target_id ?? ""] ?? finding.target_id}</strong> with no person in between:
            {finding.paths_found ? ` ${finding.paths_capped ? `${finding.paths_found} or more routes` : plural(finding.paths_found, "route", "routes")}` : " one route"}, found by <a href={href(scenario, "queries", findingQueries(finding)[0])}>{findingQueries(finding)[0]}</a>.
          </li>
        )}
        {finding.taxonomy && finding.taxonomy.length > 0 && (
          <li>In the OWASP Top 10 for Agentic Applications it is {finding.taxonomy.map((t, i) => <span key={t.code}>{i > 0 && " and "}<strong>{t.code}</strong> {t.name}</span>)}.</li>
        )}
      </ul>
    </section>
  );
}

function Rail({ finding, cites, picked, onPick, c, scenario }: { finding: Finding; cites: Map<string, number>; picked: string | null; onPick: (id: string | null) => void; c: DeVries; scenario: string }) {
  const nodes = nodeIndex(c.flow);
  const paths = pathsOf(finding);
  const catalog = new Map(c.catalog.map((q) => [q.name, q]));
  const name = (id?: string) => (id ? c.names[id] ?? id : "none");
  useEffect(() => {
    if (picked) document.getElementById(`evidence-${cites.get(picked)}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [picked, cites]);
  return (
    <aside className="rail" aria-label="Evidence">
      <section>
        <Eyebrow>Finding</Eyebrow>
        <dl>
          <KV k="Kind">{KIND_WORDS[finding.kind]}</KV>
          <KV k="Severity">{finding.severity}</KV>
          {finding.kind === "injection" ? (
            <>
              <KV k="From" title={finding.source_id}>{name(finding.source_id)}</KV>
              <KV k="Reaches" title={finding.target_id}>{name(finding.target_id)}</KV>
              <KV k="Routes">{finding.paths_capped ? `${finding.paths_found} or more` : `${finding.paths_found ?? paths.length} found`}{(finding.paths_found ?? 0) > paths.length ? `, ${paths.length} shown` : ""}</KV>
            </>
          ) : (
            <>
              <KV k="Agent" title={finding.agent_id}>{name(finding.agent_id)}</KV>
              <KV k="Untrusted in">{(finding.untrusted_ids ?? []).map(name).join(", ")}</KV>
              <KV k="Private in">{(finding.private_ids ?? []).map(name).join(", ")}</KV>
              <KV k="Way out">{(finding.exit_ids ?? []).map(name).join(", ")}</KV>
            </>
          )}
          <KV k="Status">{finding.status}</KV>
        </dl>
      </section>
      <section>
        <div className="block-head">
          <Eyebrow>Evidence</Eyebrow>
          <span>{cites.size} cited</span>
        </div>
        <ol className="evidence">
          {[...cites].map(([id, n]) => {
            const node = nodes.get(id);
            return (
              <li key={id} id={`evidence-${n}`} className={picked === id ? "lit" : ""}>
                <button onClick={() => onPick(picked === id ? null : id)} title={id}>
                  <span className="ref">[{n}]</span>
                  <span className="evidence-what">
                    <span className="evidence-kind">{node ? KIND_OF[node.label] : "Node"}</span>
                    <i>·</i>
                    <span className={node?.label === "Tool" ? "code" : ""}>{c.names[id] ?? id}</span>
                  </span>
                  <span className="evidence-facts">{node ? nodeFacts(node) : "no longer in the graph"}</span>
                </button>
              </li>
            );
          })}
        </ol>
      </section>
      {c.flow && (
        <section>
          <Eyebrow>Must keep working</Eyebrow>
          {c.flow.workflows.length ? (
            <ul className="constraints">
              {c.flow.workflows.map((w) => (
                <li key={w.id} className="constraint">
                  <p className="head">
                    <strong>{w.name}</strong> <code>{w.mode === "autonomous" ? "unattended" : w.mode}</code>
                  </p>
                  <p>
                    <WithNames text={`Run by ${w.run_by}. Needs ${w.needs.join(", ") || "no tool"}; reads ${w.reads.join(", ") || "nothing"}.`} names={c.names} />
                    {w.mode === "autonomous" && " Nobody is there to approve a call, so a gate on a tool it needs breaks it."}
                  </p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="rail-note">No workflow is declared, so nothing constrains a fix.</p>
          )}
        </section>
      )}
      <section>
        <Eyebrow>Take it with you</Eyebrow>
        <p className="rail-note takeaway">
          <a href={api.briefUrl(scenario, finding.id)} target="_blank" rel="noopener">The brief as Markdown</a> · <a href={api.figureUrl(scenario, finding.id)} target="_blank" rel="noopener">the path as a picture</a>
          {finding.taxonomy && finding.taxonomy.length > 0 && <> · OWASP {finding.taxonomy.map((t) => `${t.code} ${t.name}`).join(", ")}</>}
        </p>
      </section>
      <section>
        <Eyebrow>Queries</Eyebrow>
        <ul className="rests-on">
          {findingQueries(finding).map((q) => {
            const entry = catalog.get(q);
            const algos = entry ? [...new Set(entry.cypher.match(/algo\.\w+/g) ?? [])] : [];
            return (
              <li key={q}>
                <a href={href(scenario, "queries", q)}>{q}</a>
                {algos.map((a) => <span className="algo" key={a}>{a}</span>)}
                {entry && <p>{entry.doc}</p>}
              </li>
            );
          })}
        </ul>
      </section>
    </aside>
  );
}

/** What an attacker would plant: the model's rehearsal of the finding, asked for from here and answered as a question run. */
function Rehearsal({ finding, c, scenario }: { finding: Finding; c: DeVries; scenario: string }) {
  const model = c.session?.model;
  const runs = c.runList.filter((r) => r.kind === "ask" && (r.question ?? "").startsWith(`Rehearse ${finding.id}:`));
  const latest = runs[0];
  const shown = latest && c.run?.id === latest.id ? c.run : null;
  const canAsk = !!model?.configured && !model.budget_spent && model.questions_left > 0 && finding.status === "open";
  return (
    <section className="block rehearsal">
      <div className="block-head">
        <Eyebrow>What an attacker would plant</Eyebrow>
        {canAsk && !latest && <button className="link" onClick={() => c.ask(api.rehearsal(finding.id))} disabled={c.busy}>Ask the model to rehearse it</button>}
      </div>
      {!latest ? (
        <p className="rail-note">{model?.configured
          ? "The model reads the path and writes the text an outsider would put into the source so that the agent at the end makes the call. Nothing is sent anywhere; it is for the person deciding on the fix."
          : "Rehearsing a finding needs a model; none is configured here."}</p>
      ) : latest.status === "running" ? (
        <Loading label="The model is reading the path" />
      ) : (
        <>
          <p className="tldr-text"><WithNames text={(shown?.answer ?? latest.answer) ?? "No answer."} names={c.names} link={(id) => (id.startsWith("fnd:") ? href(scenario, "finding", id) : null)} /></p>
          <p className="rail-note">
            {latest.answer_by === "model" ? `Written by ${latest.model}; every id in it came from a tool result of the run.` : "The model did not answer; this is a template."}{" "}
            <a href={href(scenario, "audit", latest.id)}>The run</a>.{" "}
            {canAsk && <button className="link" onClick={() => c.ask(api.rehearsal(finding.id))} disabled={c.busy}>Ask again</button>}
          </p>
        </>
      )}
    </section>
  );
}

/** A standing finding (drift, a poisoned description): what was found, and the one decision a person can take, to accept it. */
function StandingPage({ c, scenario, finding }: { c: DeVries; scenario: string; finding: Finding }) {
  const poisoned = finding.kind === "poisoned_description";
  const [approver, setApprover] = useState(() => localStorage.getItem("devries.approver") ?? "");
  const desk = deskOf(finding, c.plans, c.run, c.openIds);
  const head = headline(finding, c.names);
  const d = finding.drift ?? { added: [], removed: [], changed: {} };
  const rows = poisoned
    ? (finding.flags ?? []).map((f) => ({ id: f.detail, what: f.span ? `“${f.span}”` : f.kind }))
    : [
      ...Object.entries(d.changed).map(([id, parts]) => ({ id, what: `changed: ${parts.join(", ")}` })),
      ...d.added.map((id) => ({ id, what: "added" })),
      ...d.removed.map((id) => ({ id, what: "removed" })),
    ];
  return (
    <div className="workspace">
      <header className="strip">
        <a className="strip-id" href={href(scenario, finding.status === "open" ? "inbox" : "done")} title="Back to the list">Finding {short(finding.id)}</a>
        <i>·</i>
        <span className="strip-name">{KIND_WORDS[finding.kind]}</span>
        <i>·</i>
        <span className="strip-fact"><span>severity</span> {finding.severity}</span>
        <div className="strip-right">
          <span className={`phase t-${desk.tone}`}>{desk.word}</span>
        </div>
      </header>
      <div className="spread">
        <div className="brief scroll">
          <div className="brief-inner">
          <Eyebrow>Brief</Eyebrow>
          <h1 className="brief-title">{head.title} <em>{head.line}</em></h1>
          <div className="claim">
            <div className="claim-row">
              <span className="claim-part">
                <Eyebrow>{poisoned ? "Found" : "Changed"}</Eyebrow>
                <span className="claim-from">{exposure(finding)}</span>
              </span>
              <span className="claim-arrow" aria-hidden>→</span>
              <span className="claim-part">
                <Eyebrow tone={finding.status === "accepted" ? "accent" : undefined}>{desk.nextLabel}</Eyebrow>
                <span className="claim-to">{desk.next}</span>
              </span>
            </div>
            <p className="claim-sub">{poisoned
              ? "Every description is read for the marks of tool poisoning when its manifest is loaded: instructions to the model, hidden text, the names of other servers' tools. No scan closes this, and no fix applies to it."
              : "A manifest is hashed part by part when it is loaded; a reload compares the hashes and names what changed. No scan closes this, and no fix applies to it."}</p>
          </div>
          <Eyebrow>TL;DR</Eyebrow>
          <div className="tldr">
            <p><WithNames text={tldr(finding, c.flow)} names={c.names} /></p>
            <p className="note">{poisoned ? "Found by pattern in the description at load; no model read it to say so." : "Read from the hashes of each tool's definition, stored at load; no model wrote this brief."}</p>
          </div>
          <Eyebrow>{poisoned ? "What was found" : "What changed"}</Eyebrow>
          <ol className="hops">
            {rows.map((r, i) => (
              <li key={r.id}>
                <span className="num">{two(i + 1)}.</span>
                <div><p>{poisoned ? <>{capital(r.id)} · <span className="span">{r.what}</span></> : <><code>{r.id}</code> · {r.what}</>}</p></div>
              </li>
            ))}
          </ol>
          {finding.status === "open" && (
            <form className="accept" onSubmit={(e) => { e.preventDefault(); localStorage.setItem("devries.approver", approver.trim()); c.acceptFinding(finding.id, approver.trim() || "a visitor"); }}>
              <Eyebrow>Your decision</Eyebrow>
              <p className="rail-note">{poisoned
                ? "Accepting says you have read the description and will run the tool as it is. It changes nothing in the graph; the next scan keeps the finding, marked accepted. No tool can do this."
                : "Accepting says the new definitions are the ones you meant to run. It changes nothing in the graph; the next scan keeps the finding, marked accepted. No tool can do this."}</p>
              <p className="ask-line">
                <input type="text" value={approver} onChange={(e) => setApprover(e.target.value)} placeholder="your name" maxLength={60} aria-label="Your name" />
                <Button variant="accent" size="lg" type="submit" disabled={c.busy}>{poisoned ? "Accept the description" : "Accept the new definitions"}</Button>
              </p>
            </form>
          )}
          </div>
        </div>
        <aside className="rail" aria-label="Details">
          <section>
            <Eyebrow>Finding</Eyebrow>
            <dl>
              <KV k="Kind">{KIND_WORDS[finding.kind]}</KV>
              <KV k="Severity">{finding.severity}</KV>
              {poisoned
                ? <KV k="Tool" title={finding.tool_id}>{c.names[finding.tool_id ?? ""] ?? finding.tool_id}</KV>
                : <KV k="Server" title={finding.server_id}>{c.names[finding.server_id ?? ""] ?? finding.server_id}</KV>}
              <KV k={poisoned ? "Marks" : "Tools"}>{exposure(finding)}</KV>
              <KV k="Status">{finding.status}</KV>
              {finding.accepted_by && <KV k="Accepted by">{finding.accepted_by}</KV>}
            </dl>
          </section>
          <section>
            <Eyebrow>Queries</Eyebrow>
            <p className="rail-note">
              {findingQueries(finding).map((q, i) => <span key={q}>{i > 0 && ", "}<a href={href(scenario, "queries", q)}>{q}</a></span>)}
            </p>
          </section>
        </aside>
      </div>
    </div>
  );
}

export function FindingPage({ c, scenario, finding }: { c: DeVries; scenario: string; finding: Finding }) {
  if (finding.kind === "drift" || finding.kind === "poisoned_description") return <StandingPage c={c} scenario={scenario} finding={finding} />;
  return <FindingBody c={c} scenario={scenario} finding={finding} />;
}

function FindingBody({ c, scenario, finding }: { c: DeVries; scenario: string; finding: Finding }) {
  const [step, setStep] = useState<Step>("problem");
  const [scope, setScope] = useState<"finding" | "system">("finding");
  const [renderer, setRenderer] = useRenderer();
  const [canvasLayout, setCanvasLayout] = useState<"force" | "tree">("tree");
  const [pathIndex, setPathIndex] = useState(0);
  const [picked, setPicked] = useState<string | null>(null);
  const [option, setOption] = useState<string | null>(null);

  const desk = deskOf(finding, c.plans, c.run, c.openIds);
  const cites = useMemo(() => citations(finding), [finding]);
  // once a split has closed the finding, the reader it added is drawn beside the path it was cut out of
  const focus = useMemo(() => withReaders(focusOf(finding, pathIndex), desk.applied, c.flow), [finding, pathIndex, desk.applied, c.flow]);
  const cuts = useMemo(() => cutsOf(desk.proposal), [desk.proposal]);
  const byNumber = useMemo(() => new Map([...cites].map(([id, n]) => [n, id])), [cites]);
  const badges = useMemo(() => badgesOf(c), [c.scorecard]);
  const head = headline(finding, c.names);
  const paths = pathsOf(finding);
  const shown = finding.kind === "injection" ? paths.slice(pathIndex, pathIndex + 1) : paths;
  const plan = desk.proposal ?? desk.applied;
  const approved = desk.tested.find((m) => m.status === "approved") ?? null;
  const canAudit = finding.status === "open" && !plan && !approved && !(c.run && (c.run.status === "running" || c.run.status === "awaiting_approval"));
  const queries = findingQueries(finding);
  const agentIds = useMemo(() => {
    const ids = new Set<string>();
    for (const { path } of paths) for (const id of path.node_ids) if (id.startsWith("agent:")) ids.add(id);
    if (finding.agent_id) ids.add(finding.agent_id);
    return [...ids];
  }, [paths, finding.agent_id]);
  const optionPlan = option ? c.mitigations[option] ?? null : null;

  const steps: { id: Step; n: string; label: string; sub: string }[] = [
    { id: "problem", n: "1", label: "Problem", sub: "what the graph shows" },
    { id: "fix", n: "2", label: "Fix", sub: desk.applied ? "applied" : desk.proposal ? "awaiting your nod" : "none yet" },
    { id: "options", n: "3", label: "Options", sub: `${plural(desk.tested.length, "plan", "plans")} tested` },
    { id: "trace", n: "", label: "Trace", sub: c.run ? c.run.id : "no run" },
  ];

  return (
    <div className={`workspace${desk.proposal ? " deciding" : ""}`}>
      <header className="strip">
        <a className="strip-id" href={href(scenario, finding.status === "open" ? "inbox" : "done")} title="Back to the list">Finding {short(finding.id)}</a>
        <i>·</i>
        <span className="strip-name">{KIND_WORDS[finding.kind]}</span>
        <i>·</i>
        <span className="strip-fact"><span>severity</span> {finding.severity}</span>
        {finding.taxonomy && finding.taxonomy.length > 0 && (
          <span className="owasp" title={`OWASP Top 10 for Agentic Applications: ${finding.taxonomy.map((t) => `${t.code} ${t.name}`).join("; ")}`}>
            {finding.taxonomy.map((t) => t.code).join(" · ")}
          </span>
        )}
        <div className="strip-right">
          <span className={`phase t-${desk.tone}${desk.pulse ? " pulse" : ""}`}>{desk.word}</span>
        </div>
      </header>
      <nav className="workflow" role="tablist" aria-label="The work, in order">
        {steps.map((s) => (
          <button key={s.id} role="tab" aria-selected={step === s.id} className={`workflow-step${step === s.id ? " on" : ""}${s.id === "trace" ? " aside" : ""}`} onClick={() => setStep(s.id)}>
            {s.n && <span className="workflow-n">{s.n}</span>}
            <span className="workflow-text"><span className="workflow-label">{s.label}</span><span className="workflow-sub">{s.sub}</span></span>
          </button>
        ))}
      </nav>

      <div className="spread">
        <div className="brief scroll">
          {step === "trace" ? (
            <div className="brief-inner">
              <Eyebrow>Trace</Eyebrow>
              {c.run ? <RunTrace run={c.run} names={c.names} mitigations={c.mitigations} scenario={scenario} /> : (
                <Empty>
                  No audit has run on this scenario yet.{" "}
                  {canAudit && <button className="link" onClick={c.startAudit} disabled={c.busy}>Run the audit</button>}
                </Empty>
              )}
            </div>
          ) : step === "problem" ? (
            <div className="brief-inner">
              <Eyebrow>The problem</Eyebrow>
              <h1 className="brief-title">
                {head.title} <em>{head.line}</em>
              </h1>
              <div className="claim">
                <div className="claim-row">
                  <span className="claim-part">
                    <Eyebrow>Exposure</Eyebrow>
                    <span className="claim-from">{exposure(finding)}</span>
                  </span>
                  <span className="claim-arrow" aria-hidden>→</span>
                  <span className="claim-part">
                    <Eyebrow tone={plan ? "accent" : undefined}>{desk.applied ? "Applied" : "Recommended"}</Eyebrow>
                    {plan ? <button className="claim-to link-plain" onClick={() => setStep("fix")}>{recommendation(plan)}</button> : <span className="claim-none">{desk.tone === "info" ? "testing fixes" : "nothing yet"}</span>}
                  </span>
                </div>
                <p className="claim-sub">
                  {desk.applied ? (
                    <>approved by {desk.applied.approved_by ?? "a person"}{desk.applied.applied_at ? ` at ${clock(desk.applied.applied_at)}` : ""} · {verdictLine(desk.applied)}</>
                  ) : desk.proposal ? (
                    <>cost {desk.proposal.cost} · {verdictLine(desk.proposal)} · {plural(desk.tested.length, "plan", "plans")} tested · <button className="link" onClick={() => setStep("fix")}>read the fix →</button></>
                  ) : canAudit ? (
                    <>
                      No fix has been tested for this finding.{" "}
                      <button className="link" onClick={c.startAudit} disabled={c.busy}>Run the audit</button> to try the candidate fixes on a sandbox copy of the graph.
                    </>
                  ) : (
                    <>{desk.nextLabel === "Next" ? desk.next : `${desk.nextLabel.toLowerCase()} ${desk.next}`}</>
                  )}
                </p>
              </div>

              <section className="tldr">
                <Eyebrow>TL;DR</Eyebrow>
                <p>
                  <WithNames text={tldr(finding, c.flow)} names={c.names} cites={cites} onCite={(n) => setPicked(byNumber.get(n) ?? null)} />
                </p>
                {finding.note && <p className="note">{finding.note}</p>}
                <p className="note">Put together from what the graph queries returned. No model wrote this brief.</p>
              </section>

              <figure className="figure">
                <div className="chart-controls">
                  <span className="control">Show</span>
                  <div className="pills" role="tablist" aria-label="How much of the graph">
                    <button role="tab" aria-selected={scope === "finding"} className={scope === "finding" ? "on" : ""} onClick={() => setScope("finding")}>This finding</button>
                    <button role="tab" aria-selected={scope === "system"} className={scope === "system" ? "on" : ""} onClick={() => setScope("system")}>Whole system</button>
                  </div>
                  {finding.kind === "injection" && paths.length > 1 && (
                    <>
                      <span className="control">Route</span>
                      <div className="pills" role="tablist" aria-label="Evidence paths">
                        {paths.map((p, i) => (
                          <button key={i} role="tab" aria-selected={i === pathIndex} className={i === pathIndex ? "on" : ""} onClick={() => setPathIndex(i)}>{p.label}</button>
                        ))}
                      </div>
                    </>
                  )}
                  <RendererSwitch value={renderer} onChange={setRenderer} layout={canvasLayout} onLayout={setCanvasLayout} />
                </div>
                {c.flow ? (
                  <Chart renderer={renderer} layout={canvasLayout} graph={c.flow} names={c.names} focus={focus} only={scope === "finding"} cuts={cuts} cites={cites} badges={badges}
                    picked={picked} onPick={setPicked} idle="Hover a card to read it. Click it to find it in the evidence." />
                ) : <Loading label="Reading the graph" />}
                <figcaption className="chart-note">
                  Source: the flow layer of {scenario}{c.current?.own_copy ? " (your sandbox copy)" : ""} in FalkorDB, found by{" "}
                  <a href={href(scenario, "queries", queries[0])}>{queries[0]}</a> and traced by <a href={href(scenario, "queries", queries[1])}>{queries[1]}</a>.
                  A card is filled when untrusted text reaches it, which FalkorDB works out (reach.untrusted_nodes); the page only colours it. A path means text can flow, not that it did.
                </figcaption>
              </figure>

              {shown.map(({ label, path }) => (
                <details className="block as-table hops-fold" key={label} open={finding.kind !== "injection"}>
                  <summary>
                    <span className="eyebrow">{finding.kind === "injection" ? "The path in detail" : label}</span>
                    <span className="fold-count">{plural(path.rules.length, "hop", "hops")} · each with its rule and the config edge behind it</span>
                  </summary>
                  <Hops path={path} c={c} />
                </details>
              ))}
              {!paths.length && <Empty>No evidence path was stored for this finding.</Empty>}
              <Analysis finding={finding} agentIds={agentIds} c={c} scenario={scenario} />
              <p className="step-next"><button className="link" onClick={() => setStep("fix")}>Next: the fix →</button></p>
            </div>
          ) : step === "fix" ? (
            <div className="brief-inner">
              <Eyebrow>The fix</Eyebrow>
              <h1 className="brief-title">
                {plan ? <>{recommendation(plan)} <em>{desk.applied ? "is applied." : "passed its sandbox."}</em></> : desk.tone === "info" ? <>Testing fixes <em>in sandbox graphs.</em></> : <>No fix <em>has been tested yet.</em></>}
              </h1>
              {plan && (
                <p className="claim-sub">
                  <em className="voice"><WithNames text={capital(plan.summary.join(", and "))} names={c.names} />.</em>{" "}
                  {verdictSentence(plan)} {desk.proposal ? "It is held for your nod: no tool can approve a change to the graph." : ""}
                </p>
              )}
              {desk.applied ? <Applied plan={desk.applied} run={c.run} c={c} /> : approved ? <Drafted plan={approved} c={c} applying /> : desk.proposal ? <Drafted plan={desk.proposal} c={c} applying={false} /> : (
                <Empty>
                  {canAudit ? <>No fix has been tested for this finding. <button className="link" onClick={c.startAudit} disabled={c.busy}>Run the audit</button> to try the candidate fixes on a sandbox copy of the graph.</> : desk.tone === "info" ? "The audit is testing candidate fixes now; the first that passes lands here." : `${desk.nextLabel}: ${desk.next}`}
                </Empty>
              )}
              {plan && <After m={plan} c={c} scenario={scenario} renderer={renderer} layout={canvasLayout} />}
              {desk.proposal && (
                <p className="rail-note">
                  The change to your configuration, as a diff you can edit, is in the bar below: see the change, then Approve. {desk.tested.length > 1 ? <>{plural(desk.tested.length - 1, "other plan was", "other plans were")} tested; they are under <button className="link" onClick={() => setStep("options")}>Options</button>.</> : ""}
                </p>
              )}
              <p className="step-next"><button className="link" onClick={() => setStep("options")}>Next: every other option →</button></p>
            </div>
          ) : (
            <div className="brief-inner">
              <Eyebrow>The options</Eyebrow>
              <h1 className="brief-title">
                {desk.tested.length ? <>{capital(plural(desk.tested.length, "plan", "plans"))} <em>tested in sandbox graphs.</em></> : <>Nothing else <em>has been tried yet.</em></>}
              </h1>
              <p className="claim-sub">Every plan the search or the model asked a sandbox about, cheapest first, with the verdict; a plan that passed can be previewed. Under them, what else a sandbox can answer.</p>
              <Tested desk={desk} c={c} picked={option} onPick={setOption} />
              {optionPlan && <After m={optionPlan} c={c} scenario={scenario} renderer={renderer} layout={canvasLayout} />}
              <WhatIfLine c={c} scenario={scenario} agentId={agentIds[agentIds.length - 1] ?? null} />
              <CutBlock c={c} scenario={scenario} compact />
              <section className="block">
                <div className="block-head">
                  <Eyebrow>Servers on the path</Eyebrow>
                  <span>what taking one out would do</span>
                </div>
                <ServerTable c={c} scenario={scenario} />
              </section>
              <Rehearsal finding={finding} c={c} scenario={scenario} />
            </div>
          )}
        </div>
        <Rail finding={finding} cites={cites} picked={picked} onPick={setPicked} c={c} scenario={scenario} />
      </div>

      {desk.proposal && (
        <ApprovalBar mitigation={desk.proposal} names={c.names} busy={c.busy} scenario={scenario} canWrite={!!c.session?.can_write}
          onApprove={(who, write) => c.approve(desk.proposal!.id, who, write)} onReject={(who, why) => c.reject(desk.proposal!.id, who, why)} />
      )}
    </div>
  );
}
