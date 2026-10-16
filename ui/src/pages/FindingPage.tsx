// One finding, worked through in five steps, each about one thing: the summary, the path hop by hop, why it is a
// problem, the fix a sandbox passed (and only there, the approval), and every other option tested the same way.
// The trace of the run that did the work stands beside them. The rail holds what the step at hand needs. The page
// is Manthan's case workspace (strip, brief, drafted actions, the rail, the approval bar), holding a finding
// instead of a case (see ui/THIRD_PARTY_NOTICES.md).

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { api, type Finding, type Mitigation, type Path, type RunWithSteps, type Scorecard } from "../api";
import { ApprovalBar } from "../ApprovalBar";
import { citations, headline, tldr, verdictSentence } from "../brief";
import { FIX_VERB, deskOf, exposure, patchText, recommendation, verdictLine, type Desk } from "../desk";
import { Chart, RendererSwitch, useRenderer } from "../graph/Chart";
import { KIND_OF, cutsOf, findingQueries, focusOf, hopKey, linkIndex, nodeFacts, nodeIndex, pathsOf, withReaders, type Series } from "../paths";
import { href } from "../route";
import type { DeVries } from "../state";
import { KIND_WORDS, WithNames, capital, clock, countWord, findingTitle, plural, short } from "../text";
import { RunTrace } from "../Trace";
import { Block, Button, Empty, Eyebrow, Fold, KV, Loading } from "../ui";
import { After } from "./Fixes";
import { ServerTable } from "./Servers";
import { CutBlock, WhatIfLine } from "./WhatIf";

const two = (n: number) => String(n).padStart(2, "0");
type Step = "summary" | "path" | "why" | "fix" | "options" | "trace";

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

/** A sandbox verdict in figures: what a person reads before the words. */
function Figures({ items }: { items: { n: ReactNode; label: string; tone?: "good" | "bad" }[] }) {
  return (
    <dl className="figures">
      {items.map((it) => (
        <div key={it.label} className={it.tone ?? ""}>
          <dd>{it.n}</dd>
          <dt>{it.label}</dt>
        </div>
      ))}
    </dl>
  );
}

/** Every plan a sandbox was asked about for this finding, cheapest first, as one chart: its cost as a bar, what it
 *  did to each finding that was open as a cell, what it would open and break as counts; under each row, the verdict
 *  in words. A passing plan can be previewed. */
function Tested({ finding, desk, c, scenario, picked, onPick }: { finding: Finding; desk: Desk; c: DeVries; scenario: string; picked: string | null; onPick: (id: string | null) => void }) {
  if (!desk.tested.length) return <Empty>No plan has been tested for this finding yet.</Empty>;
  const plans = [...desk.tested].sort((a, b) => a.cost - b.cost || a.created_at - b.created_at);
  const ms = plans.reduce((sum, m) => sum + (m.sandbox_ms ?? 0), 0);
  const maxCost = Math.max(1, ...plans.map((m) => m.cost));
  // the findings that were open when the plans were tested, this one first
  const columns = [...new Set([finding.id, ...plans.flatMap((m) => m.open_before ?? [])])];
  const all = [...(c.findings?.findings ?? []), ...(c.findings?.past ?? [])];
  const title = (id: string) => { const f = all.find((x) => x.id === id); return f ? findingTitle(f, c.names) : id; };
  const cell = (m: Mitigation, id: string) =>
    m.resolved?.includes(id) ? { k: "closed", t: "closed in the sandbox" }
      : m.open_after?.includes(id) || m.open_before?.includes(id) ? { k: "open", t: "left open" }
        : { k: "none", t: "not open when this plan was tested" };
  return (
    <section className="block tested">
      <div className="block-head">
        <Eyebrow>Tested in sandbox graphs</Eyebrow>
        <span>{plural(plans.length, "plan", "plans")} · {ms} ms · cheapest first</span>
      </div>
      <ul className="verdicts matrix">
        <li className="matrix-head" aria-hidden>
          <span />
          <span className="verdict-plan">Plan</span>
          <span className="verdict-cost">cost</span>
          <span className="verdict-cells">
            {columns.map((id, i) => <b key={id} title={title(id)}>{i + 1}</b>)}
            <b className="n">opens</b>
            <b className="n">breaks</b>
          </span>
        </li>
        {plans.map((m) => {
          const opens = m.introduced?.length ?? 0, breaks = m.newly_broken?.length ?? 0;
          return (
            <li key={m.id} className={`verdict ${m.passed ? "pass" : "fail"}${picked === m.id ? " on" : ""}`}>
              <span className="verdict-mark" aria-label={m.passed ? "passes" : "fails"}>{m.passed ? "✓" : "✕"}</span>
              <span className="verdict-plan"><WithNames text={m.summary.join(", and ")} names={c.names} /></span>
              <span className="verdict-cost"><i className="bar" style={{ width: `${Math.round((m.cost / maxCost) * 100)}%` }} aria-hidden />cost {m.cost}</span>
              <span className="verdict-cells">
                {columns.map((id) => { const x = cell(m, id); return <i key={id} className={`cell ${x.k}`} title={`${title(id)}: ${x.t}`} />; })}
                <em className={`n${opens ? " bad" : ""}`}>{opens}</em>
                <em className={`n${breaks ? " bad" : ""}`}>{breaks}</em>
              </span>
              <span className="verdict-why">
                {m.passed ? verdictLine(m) : <WithNames text={m.reason ?? "it did not pass"} names={c.names} />}
                {m.status === "rejected" && ` · rejected by ${m.approved_by ?? "a person"}${m.decision_reason ? `: ${m.decision_reason}` : ""}`}
                {m.status === "applied" && " · applied"}
                {m.passed && <> · <button className="link" onClick={() => onPick(picked === m.id ? null : m.id)}>{picked === m.id ? "hide the preview" : "preview it"}</button></>}
              </span>
            </li>
          );
        })}
      </ul>
      <p className="chart-note">
        A filled cell is a finding the plan closed in the sandbox, an empty one a finding it left open{columns.length === 1 ? "; the one column is this finding" : `; column 1 is this finding`}. Cost is the search's own measure: cheaper plans are tried first.
      </p>
      {columns.length > 1 && (
        <Fold summary="The findings, by column" sub={`${plural(columns.length, "finding was", "findings were")} open when the plans were tested`}>
          <ol className="analysis-rows columns">
            {columns.map((id, i) => <li key={id}><strong>{i + 1}</strong> <a className="link" href={href(scenario, "finding", id)}>{title(id)}</a>{i === 0 ? " · this finding" : ""}</li>)}
          </ol>
        </Fold>
      )}
    </section>
  );
}

type Card = Scorecard["agents"][number];
const PROPERTIES: { key: "A" | "B" | "C"; word: string; series: Series; of: (a: Card) => string[] }[] = [
  { key: "A", word: "untrusted input", series: "hot", of: (a) => a.untrusted_in },
  { key: "B", word: "private data", series: "private", of: (a) => a.private_in },
  { key: "C", word: "a way to act", series: "exit", of: (a) => a.acts_on },
];

/** Meta's Rule of Two as a grid: each agent on the path against the three properties, with what gives it each one. */
function RuleOfTwo({ cards, c }: { cards: Card[]; c: DeVries }) {
  const name = (id: string) => c.names[id] ?? id;
  const few = (ids: string[]) => (ids.length <= 3 ? ids.map(name).join(", ") : `${ids.slice(0, 2).map(name).join(", ")} and ${ids.length - 2} more`);
  return (
    <section className="block rule">
      <div className="block-head">
        <Eyebrow>Meta's Rule of Two</Eyebrow>
        <span>an agent may hold two of the three at once; holding all three, it must not run unattended</span>
      </div>
      <div className="rot" role="table" aria-label="Meta's Rule of Two, for each agent on the path">
        <div className="rot-row rot-head" role="row">
          <span role="columnheader" className="rot-agent">Agent on the path</span>
          {PROPERTIES.map((p) => <span role="columnheader" key={p.key} className={`s-${p.series}`}><b>{p.key}</b>{p.word}</span>)}
        </div>
        {cards.map((a) => (
          <div className={`rot-row${a.count === 3 ? " all" : ""}`} role="row" key={a.agent_id} data-agent={a.agent_id}>
            <span role="rowheader" className="rot-agent">
              <strong>{name(a.agent_id)}</strong>
              <span className="rot-sub">{a.count === 3 ? "all three" : `${countWord(a.count)} of three`} · {a.autonomous ? "runs unattended" : a.workflows.length ? "supervised" : "no workflow"}</span>
            </span>
            {PROPERTIES.map((p) => {
              const ids = p.of(a);
              const held = a.properties.includes(p.key);
              return (
                <span role="cell" key={p.key} className={`rot-cell s-${p.series}${held ? " on" : ""}`} title={ids.join(", ") || `no ${p.word}`}>
                  <i aria-hidden />
                  <span className="rot-what">{held ? few(ids) : "—"}</span>
                </span>
              );
            })}
          </div>
        ))}
      </div>
    </section>
  );
}

/** What this means for a fix: each agent's verdict under the rule, the workflows a fix must not break, the class in OWASP's list. */
function Analysis({ finding, cards, c }: { finding: Finding; cards: Card[]; c: DeVries }) {
  const agentIds = cards.map((a) => a.agent_id);
  const workflows = (c.flow?.workflows ?? []).filter((w) => agentIds.includes(w.run_by));
  return (
    <Block className="analysis" eyebrow="What it means for a fix" aside="read off the flow layer">
      <ul className="analysis-rows">
        {cards.map((a) => (
          <li key={a.agent_id}>
            <strong>{c.names[a.agent_id] ?? a.agent_id}</strong>: {capital(a.verdict)}.
            {a.autonomous ? " It runs unattended: nobody is there to catch a call." : ""}
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
            {finding.paths_found ? ` ${finding.paths_capped ? `${finding.paths_found} or more routes` : plural(finding.paths_found, "route", "routes")}` : " one route"}.
          </li>
        )}
        {finding.taxonomy && finding.taxonomy.length > 0 && (
          <li>In the OWASP Top 10 for Agentic Applications it is {finding.taxonomy.map((t, i) => <span key={t.code}>{i > 0 && " and "}<strong>{t.code}</strong> {t.name}</span>)}.</li>
        )}
      </ul>
    </Block>
  );
}

const SOURCE: Record<string, string> = { scripted: "the scripted search", agent: "the model", search: "a search asked for here" };

/** The rail holds what the step at hand needs and nothing from the others: the finding's facts and the evidence
 *  beside the summary and the path, the three properties beside the rule, the plan's verdict beside the fix. */
function Rail({ step, finding, plan, desk, cites, picked, onPick, c, scenario }: { step: Step; finding: Finding; plan: Mitigation | null; desk: Desk; cites: Map<string, number>; picked: string | null; onPick: (id: string | null) => void; c: DeVries; scenario: string }) {
  const nodes = nodeIndex(c.flow);
  const paths = pathsOf(finding);
  const catalog = new Map(c.catalog.map((q) => [q.name, q]));
  const name = (id?: string) => (id ? c.names[id] ?? id : "none");
  useEffect(() => {
    if (picked) document.getElementById(`evidence-${cites.get(picked)}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [picked, cites]);

  const facts = (
    <section key="facts">
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
  );
  const evidence = (
    <section key="evidence">
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
  );
  const constraints = c.flow && (
    <section key="constraints">
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
  );
  const takeaway = (
    <section key="takeaway">
      <Eyebrow>Take it with you</Eyebrow>
      <p className="rail-note takeaway">
        <a href={api.briefUrl(scenario, finding.id)} target="_blank" rel="noopener">The brief as Markdown</a> · <a href={api.figureUrl(scenario, finding.id)} target="_blank" rel="noopener">the path as a picture</a>
        {finding.taxonomy && finding.taxonomy.length > 0 && <> · OWASP {finding.taxonomy.map((t) => `${t.code} ${t.name}`).join(", ")}</>}
      </p>
    </section>
  );
  const queries = (
    <section key="queries">
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
  );
  const properties = (
    <section key="properties">
      <Eyebrow>The three properties</Eyebrow>
      <ul className="constraints">
        <li className="constraint"><p className="head"><strong>A · untrusted input</strong></p><p>Text an outsider can write reaches the agent's context.</p></li>
        <li className="constraint"><p className="head"><strong>B · private data</strong></p><p>Data marked private reaches its context.</p></li>
        <li className="constraint"><p className="head"><strong>C · a way to act</strong></p><p>It can call a tool that changes a resource or sends something out of the organisation.</p></li>
      </ul>
      <p className="rail-note">Meta's Agents Rule of Two: in one session an agent should hold at most two of the three, or a person approves what it does. <a href={href(scenario, "queries", "reach.agents_from_sources")}>How it is read</a>.</p>
    </section>
  );
  const planFacts = plan && (
    <section key="plan">
      <Eyebrow>The plan</Eyebrow>
      <dl>
        <KV k="Plan"><code className="id">{plan.id}</code></KV>
        <KV k="Status">{plan.status === "proposed" ? "awaiting approval" : plan.status}</KV>
        <KV k="Passed">{plan.passed ? "yes" : "no"}</KV>
        <KV k="Leaves open">{plural(plan.open_after?.length ?? 0, "finding", "findings")}</KV>
        <KV k="Proposed by">{SOURCE[plan.source] ?? plan.source}</KV>
        {plan.approved_by && <KV k={plan.status === "rejected" ? "Rejected by" : "Approved by"}>{plan.approved_by}</KV>}
        {plan.applied_at && <KV k="Applied">{clock(plan.applied_at)}</KV>}
        <KV k="Tested against">config <code>{plan.config_hash?.slice(0, 10) ?? "unknown"}</code></KV>
      </dl>
      {c.configHash && plan.config_hash && c.configHash !== plan.config_hash && <p className="rail-note">The config has changed since the plan was tested, so it is verified again before it is applied.</p>}
      {plan.decision_reason && <p className="rail-note">Reason given: {plan.decision_reason}</p>}
    </section>
  );
  const ledger = (
    <section key="ledger">
      <Eyebrow>This finding's ledger</Eyebrow>
      <dl>
        <KV k="Tested">{desk.tested.length}</KV>
        <KV k="Passed">{desk.tested.filter((m) => m.passed).length}</KV>
        <KV k="Applied">{desk.tested.filter((m) => m.status === "applied").length}</KV>
        <KV k="Rejected">{desk.tested.filter((m) => m.status === "rejected").length}</KV>
        <KV k="Sandbox time">{desk.tested.reduce((sum, m) => sum + (m.sandbox_ms ?? 0), 0)} ms</KV>
      </dl>
      <p className="rail-note">Every plan of every finding is under <a href={href(scenario, "fixes")}>Ledger</a>.</p>
    </section>
  );
  const run = c.run && (
    <section key="run">
      <Eyebrow>The run</Eyebrow>
      <dl>
        <KV k="Run"><code className="id">{c.run.id}</code></KV>
        <KV k="Kind">{c.run.kind}</KV>
        <KV k="Driven by">{c.run.mode === "agent" ? c.run.model ?? "the model" : "the scripted search"}</KV>
        <KV k="Status">{c.run.status.replace("_", " ")}</KV>
        <KV k="Steps">{c.run.steps.length}</KV>
        <KV k="Sandboxes">{c.run.usage.simulations}</KV>
        {c.run.usage.cost_usd > 0 && <KV k="Model cost">${c.run.usage.cost_usd.toFixed(3)}</KV>}
        <KV k="Started">{clock(c.run.started_at)}</KV>
      </dl>
    </section>
  );

  const shown: Record<Step, ReactNode[]> = {
    summary: [facts, evidence, takeaway],
    path: [evidence, queries],
    why: [properties, constraints],
    fix: [planFacts ?? facts, constraints],
    options: [ledger, takeaway],
    trace: [run ?? facts, queries],
  };
  return <aside className="rail" aria-label="Beside the step">{shown[step]}</aside>;
}

/** What an attacker would plant: the model's rehearsal of the finding, asked for from here and answered as a question run. */
function Rehearsal({ finding, c, scenario, head = true }: { finding: Finding; c: DeVries; scenario: string; head?: boolean }) {
  const model = c.session?.model;
  const runs = c.runList.filter((r) => r.kind === "ask" && (r.question ?? "").startsWith(`Rehearse ${finding.id}:`));
  const latest = runs[0];
  const shown = latest && c.run?.id === latest.id ? c.run : null;
  const canAsk = !!model?.configured && !model.budget_spent && model.questions_left > 0 && finding.status === "open";
  return (
    <section className="block rehearsal">
      {head && (
        <div className="block-head">
          <Eyebrow>What an attacker would plant</Eyebrow>
          {canAsk && !latest && <button className="link" onClick={() => c.ask(api.rehearsal(finding.id))} disabled={c.busy}>Ask the model to rehearse it</button>}
        </div>
      )}
      {!latest ? (
        <p className="rail-note">
          {model?.configured
            ? "The model reads the path and writes the text an outsider would put into the source so that the agent at the end makes the call. Nothing is sent anywhere; it is for the person deciding on the fix."
            : "Rehearsing a finding needs a model; none is configured here."}
          {!head && canAsk && <> <button className="link" onClick={() => c.ask(api.rehearsal(finding.id))} disabled={c.busy}>Ask the model to rehearse it</button></>}
        </p>
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
  const [step, setStep] = useState<Step>("summary");
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
  const cards = useMemo(() => agentIds.map((id) => c.scorecard?.agents.find((a) => a.agent_id === id)).filter((a): a is Card => !!a), [agentIds, c.scorecard]);
  // the agent the step is about: a trifecta's own; on an injection path, the one holding most, the last of them if tied
  const worst = cards.find((a) => a.agent_id === finding.agent_id) ?? cards.reduce<Card | null>((most, a) => (!most || a.count >= most.count ? a : most), null);
  const optionPlan = option ? c.mitigations[option] ?? null : null;
  const name = (id?: string | null) => (id ? c.names[id] ?? id : "");
  const words = (props: string[]) => props.map((p) => PROPERTIES.find((q) => q.key === p)?.word ?? p).join(" and ");

  const steps: { id: Step; n: string; label: string; sub: string }[] = [
    { id: "summary", n: "1", label: "Summary", sub: "the finding in brief" },
    { id: "path", n: "2", label: "Path", sub: "how the text travels" },
    { id: "why", n: "3", label: "Why", sub: "what makes it a problem" },
    { id: "fix", n: "4", label: "Fix", sub: desk.applied ? "applied" : desk.proposal ? "awaiting your approval" : desk.tone === "info" ? "being tested" : "none yet" },
    { id: "options", n: "5", label: "Options", sub: `${plural(desk.tested.length, "plan", "plans")} tested` },
    { id: "trace", n: "", label: "Trace", sub: c.run ? c.run.id : "no run" },
  ];
  const switcher = <RendererSwitch value={renderer} onChange={setRenderer} layout={canvasLayout} onLayout={setCanvasLayout} />;
  const next = (to: Step, label: string) => <p className="step-next"><button className="link" onClick={() => setStep(to)}>Next: {label} →</button></p>;
  const routes = finding.kind === "injection" && paths.length > 1 && (
    <>
      <span className="control">Route</span>
      <div className="pills" role="tablist" aria-label="Evidence paths">
        {paths.map((p, i) => (
          <button key={i} role="tab" aria-selected={i === pathIndex} className={i === pathIndex ? "on" : ""} onClick={() => setPathIndex(i)}>{p.label}</button>
        ))}
      </div>
    </>
  );
  // a plan waits for a person on the fix step and nowhere else: each step talks about one thing
  const deciding = step === "fix" && !!desk.proposal;

  return (
    <div className={`workspace${deciding ? " deciding" : ""}`}>
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
          ) : step === "summary" ? (
            <div className="brief-inner">
              <Eyebrow>Summary</Eyebrow>
              <h1 className="brief-title">
                {head.title} <em>{head.line}</em>
              </h1>
              <section className="tldr">
                <Eyebrow>TL;DR</Eyebrow>
                <p>
                  <WithNames text={tldr(finding, c.flow)} names={c.names} cites={cites} onCite={(n) => setPicked(byNumber.get(n) ?? null)} />
                </p>
                {finding.note && <p className="note">{finding.note}</p>}
                <p className="note">Put together from what the graph queries returned. No model wrote this brief.</p>
              </section>
              <figure className="figure">
                <div className="chart-controls">{switcher}</div>
                {c.flow ? (
                  <Chart renderer={renderer} layout={canvasLayout} graph={c.flow} names={c.names} focus={focus} only cites={cites}
                    picked={picked} onPick={setPicked} idle="The path of the finding. Hover a card to read it; click it to find it in the evidence." />
                ) : <Loading label="Reading the graph" />}
              </figure>
              {next("path", "the path, hop by hop")}
            </div>
          ) : step === "path" ? (
            <div className="brief-inner">
              <Eyebrow>The path</Eyebrow>
              <h1 className="brief-title">
                {finding.kind === "injection" ? <>{capital(exposure(finding))} <em>with no person in between.</em></> : <>Three legs <em>meet in one agent.</em></>}
              </h1>
              <p className="claim-sub">
                {finding.kind === "injection"
                  ? "Each hop is derived from one edge of the configuration by one of seven rules. The path is in the graph whether or not any text has travelled it yet."
                  : "Untrusted text comes in on one leg, private data on another, and the third leads out. Each hop is derived from one edge of the configuration by one of seven rules."}
              </p>
              <figure className="figure">
                <div className="chart-controls">
                  <span className="control">Show</span>
                  <div className="pills" role="tablist" aria-label="How much of the graph">
                    <button role="tab" aria-selected={scope === "finding"} className={scope === "finding" ? "on" : ""} onClick={() => setScope("finding")}>This finding</button>
                    <button role="tab" aria-selected={scope === "system"} className={scope === "system" ? "on" : ""} onClick={() => setScope("system")}>Whole system</button>
                  </div>
                  {routes}
                  {switcher}
                </div>
                {c.flow ? (
                  <Chart renderer={renderer} layout={canvasLayout} graph={c.flow} names={c.names} focus={focus} only={scope === "finding"} cites={cites}
                    picked={picked} onPick={setPicked} idle="Hover a card to read it. Click it to find it in the evidence." />
                ) : <Loading label="Reading the graph" />}
                <figcaption>
                  <Fold className="source" summary="Source and method" sub={`${queries[0]} · ${queries[1]} · ${renderer === "falkordb" ? "FalkorDB canvas" : "ELK and React Flow"}`}>
                    <p className="chart-note">
                      Source: the flow layer of {scenario}{c.current?.own_copy ? " (your sandbox copy)" : ""} in FalkorDB, found by{" "}
                      <a href={href(scenario, "queries", queries[0])}>{queries[0]}</a> and traced by <a href={href(scenario, "queries", queries[1])}>{queries[1]}</a>.
                      A card is filled when untrusted text reaches it, which FalkorDB works out (reach.untrusted_nodes); the page only colours it. A path means text can flow, not that it did.
                    </p>
                  </Fold>
                </figcaption>
              </figure>
              {shown.map(({ label, path }) => (
                <Fold className="hops-fold" key={label} open summary={finding.kind === "injection" ? "Hop by hop" : label} sub={`${plural(path.rules.length, "hop", "hops")} · each with its rule and the config edge behind it`}>
                  <Hops path={path} c={c} />
                </Fold>
              ))}
              {!paths.length && <Empty>No evidence path was stored for this finding.</Empty>}
              {next("why", "why it is a problem")}
            </div>
          ) : step === "why" ? (
            <div className="brief-inner">
              <Eyebrow>Why it is a problem</Eyebrow>
              <h1 className="brief-title">
                {worst ? (
                  <>{name(worst.agent_id)} <em>{worst.count === 3 ? "holds all three." : worst.count === 2 ? `holds ${words(worst.properties)}.` : worst.count === 1 ? `holds ${words(worst.properties)}.` : "holds none of the three."}</em></>
                ) : (
                  <>Read <em>against Meta's Rule of Two.</em></>
                )}
              </h1>
              <p className="claim-sub">
                {finding.kind === "trifecta"
                  ? "Untrusted input, private data and a way to act, in one agent at once: whoever writes the text can ask for the data to be sent out. That is the lethal trifecta, and all three properties of Meta's Rule of Two."
                  : "Untrusted input and a way to act, with no person between them: whoever writes the text can ask for the action. Two of Meta's three properties, in the pair that makes an injection path."}
              </p>
              {c.scorecard ? (cards.length ? <RuleOfTwo cards={cards} c={c} /> : <Empty>No agent on this path is in the scorecard.</Empty>) : <Loading label="Reading the scorecard" />}
              <Analysis finding={finding} cards={cards} c={c} />
              <Fold className="source" summary="Source and method" sub="reach.agents_from_sources · the flow layer">
                <p className="chart-note">
                  Source: the flow layer of {scenario} in FalkorDB. Which sources reach each agent, and what it acts on, is read by{" "}
                  <a href={href(scenario, "queries", "reach.agents_from_sources")}>reach.agents_from_sources</a>; the workflows are declared in the scenario. The rule is Meta's Agents Rule of Two (2025); the OWASP class is from the Top 10 for Agentic Applications.
                </p>
              </Fold>
              {next("fix", "the fix")}
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
                  {verdictSentence(plan)} {desk.proposal ? "It waits for your approval in the bar below: no tool can approve a change to the graph." : ""}
                </p>
              )}
              {plan && (
                <Figures items={[
                  { n: plan.resolved?.length ?? 0, label: plan.resolved?.length === 1 ? "finding resolved" : "findings resolved", tone: (plan.resolved?.length ?? 0) ? "good" : undefined },
                  { n: plan.introduced?.length ?? 0, label: "introduced", tone: (plan.introduced?.length ?? 0) ? "bad" : undefined },
                  { n: plan.newly_broken?.length ?? 0, label: plan.newly_broken?.length === 1 ? "workflow broken" : "workflows broken", tone: (plan.newly_broken?.length ?? 0) ? "bad" : undefined },
                  { n: plan.cost, label: "cost" },
                  ...(plan.sandbox_ms != null ? [{ n: `${plan.sandbox_ms} ms`, label: "in the sandbox" }] : []),
                ]} />
              )}
              {desk.applied ? <Applied plan={desk.applied} run={c.run} c={c} /> : approved ? <Drafted plan={approved} c={c} applying /> : desk.proposal ? <Drafted plan={desk.proposal} c={c} applying={false} /> : (
                <Empty>
                  {canAudit ? <>No fix has been tested for this finding. <button className="link" onClick={c.startAudit} disabled={c.busy}>Run the audit</button> to try the candidate fixes on a sandbox copy of the graph.</> : desk.tone === "info" ? "The audit is testing candidate fixes now; the first that passes lands here." : `${desk.nextLabel}: ${desk.next}`}
                </Empty>
              )}
              {desk.proposal && c.flow && (
                <Block className="before" eyebrow="Where it cuts" aside="the path as it stands · ‖ marks the hop the plan cuts">
                  <div className="chart-controls">{switcher}</div>
                  <Chart renderer={renderer} layout={canvasLayout} graph={c.flow} names={c.names} focus={focus} only cuts={cuts} cutsMean="where this plan cuts"
                    idle="The path as it stands now; the mark is the hop the plan would cut." />
                </Block>
              )}
              {plan && <After m={plan} c={c} scenario={scenario} renderer={renderer} layout={canvasLayout} controls={desk.proposal ? undefined : switcher} link={false} />}
              {desk.proposal && (
                <p className="rail-note">
                  The change to your configuration, as a diff you can edit, is in the bar below: see the change, then Approve.
                </p>
              )}
              {next("options", "every other option")}
            </div>
          ) : (
            <div className="brief-inner">
              <Eyebrow>The options</Eyebrow>
              <h1 className="brief-title">
                {desk.tested.length ? <>{capital(plural(desk.tested.length, "plan", "plans"))} <em>tested in sandbox graphs.</em></> : <>Nothing else <em>has been tried yet.</em></>}
              </h1>
              <p className="claim-sub">Every plan the search or the model asked a sandbox about, cheapest first: what each would close, open and break. A plan that passed can be previewed.</p>
              <Tested finding={finding} desk={desk} c={c} scenario={scenario} picked={option} onPick={setOption} />
              {optionPlan && <After m={optionPlan} c={c} scenario={scenario} renderer={renderer} layout={canvasLayout} controls={switcher} link={false} />}
              <Block className="more" eyebrow="Ask the sandbox more" aside="each answered on a copy of the graph that is then deleted · nothing here changes the scenario">
                <Fold summary="What if" sub="one more grant or delegation, tested before it is made">
                  <WhatIfLine c={c} scenario={scenario} agentId={agentIds[agentIds.length - 1] ?? null} head={false} />
                </Fold>
                <Fold summary="The cheapest cut" sub="by max flow, as rules a gateway could enforce">
                  <CutBlock c={c} scenario={scenario} compact head={false} />
                </Fold>
                <Fold summary="Servers on the path" sub="what taking one out would close and break">
                  <ServerTable c={c} scenario={scenario} />
                </Fold>
                <Fold summary="What an attacker would plant" sub={c.session?.model?.configured ? "the model rehearses the finding; nothing is sent anywhere" : "needs a model; none is configured here"}>
                  <Rehearsal finding={finding} c={c} scenario={scenario} head={false} />
                </Fold>
              </Block>
            </div>
          )}
        </div>
        <Rail step={step} finding={finding} plan={plan} desk={desk} cites={cites} picked={picked} onPick={setPicked} c={c} scenario={scenario} />
      </div>

      {deciding && (
        <ApprovalBar mitigation={desk.proposal!} names={c.names} busy={c.busy} scenario={scenario} canWrite={!!c.session?.can_write}
          onApprove={(who, write) => c.approve(desk.proposal!.id, who, write)} onReject={(who, why) => c.reject(desk.proposal!.id, who, why)} />
      )}
    </div>
  );
}
