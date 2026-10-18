// The rail beside the steps: what the step at hand needs and nothing from the others.

import { useEffect, type ReactNode } from "react";
import { api, type Finding, type Mitigation } from "../../api";
import { isLive, type Desk } from "../../desk";
import { KIND_OF, findingQueries, nodeFacts, nodeIndex, pathsOf } from "../../paths";
import { href } from "../../route";
import type { DeVries } from "../../state";
import { Cost } from "../../Trace";
import { KIND_WORDS, WithNames, clock, plural } from "../../text";
import { Eyebrow, KV } from "../../ui";
import type { Step } from "./shared";

const SOURCE: Record<string, string> = { scripted: "the scripted search", agent: "the model", search: "a search asked for here", cut: "the cheapest cut" };

/** The rail holds what the step at hand needs and nothing from the others: the finding's facts beside the summary,
 *  the three properties beside the rule, the evidence beside the path, the plan's facts beside the fix, the
 *  decisions and the run beside the options. */
export function Rail({ step, finding, plan, desk, cites, picked, onPick, c, scenario }: { step: Step; finding: Finding; plan: Mitigation | null; desk: Desk; cites: Map<string, number>; picked: string | null; onPick: (id: string | null) => void; c: DeVries; scenario: string }) {
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
              <a href={href(scenario, "method", "queries", q)}>{q}</a>
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
      <p className="rail-note"><a href={href(scenario, "method")}>How the rule is read →</a></p>
    </section>
  );
  const planFacts = plan && (
    <section key="plan">
      <Eyebrow>The plan</Eyebrow>
      <dl>
        <KV k="Plan"><code className="id">{plan.id}</code></KV>
        <KV k="Status">{plan.status === "proposed" ? (isLive(plan, c.openIds) ? "awaiting approval" : "passed, not applied") : plan.status}</KV>
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
  const decisions = (
    <section key="decisions">
      <Eyebrow>Decisions on this finding</Eyebrow>
      <dl>
        <KV k="Tested">{desk.tested.length}</KV>
        <KV k="Passed">{desk.tested.filter((m) => m.passed).length}</KV>
        <KV k="Applied">{desk.tested.filter((m) => m.status === "applied").length}</KV>
        <KV k="Rejected">{desk.tested.filter((m) => m.status === "rejected").length}</KV>
        <KV k="Sandbox time">{desk.tested.reduce((sum, m) => sum + (m.sandbox_ms ?? 0), 0)} ms</KV>
      </dl>
      <p className="rail-note">Every scan, run, proposal and decision on this scenario, in order, is under <a href={href(scenario, "audit")}>Activity</a>.</p>
    </section>
  );
  const run = c.run && (
    <section key="run">
      <Eyebrow>The run</Eyebrow>
      <dl>
        <KV k="Run"><a className="id" href={href(scenario, "audit", c.run.id)}>{c.run.id}</a></KV>
        <KV k="Kind">{c.run.kind}</KV>
        <KV k="Driven by">{c.run.mode === "agent" ? c.run.model ?? "the model" : "the scripted search"}</KV>
        <KV k="Status">{c.run.status.replace("_", " ")}</KV>
        <KV k="Steps">{c.run.steps.length}</KV>
        <KV k="Sandboxes">{c.run.usage.simulations}</KV>
        {c.run.usage.cost_usd > 0 && <KV k="Model cost"><Cost usage={c.run.usage} digits={3} /></KV>}
        <KV k="Started">{clock(c.run.started_at)}</KV>
      </dl>
      <p className="rail-note">Its trace, step by step, is under <a href={href(scenario, "audit", c.run.id)}>Activity</a>.</p>
    </section>
  );

  const shown: Record<Step, ReactNode[]> = {
    summary: [facts, takeaway],
    rule: [properties, constraints],
    path: [evidence, queries],
    fix: [planFacts ?? facts, constraints],
    options: [decisions, run, takeaway],
  };
  return <aside className="rail" aria-label="Beside the step">{shown[step]}</aside>;
}
