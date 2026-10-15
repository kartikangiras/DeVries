// Questions answered in a sandbox, none of which changes the scenario: what one more grant or delegation
// would open, close and break; and the cheapest set of hops that separates every untrusted source from
// every high-impact resource, as rules a gateway or a client could enforce.

import { useEffect, useState } from "react";
import { api, type Change, type Cut, type Policy, type WhatIf } from "../api";
import { href } from "../route";
import type { DeVries } from "../state";
import { KIND_WORDS, WithNames, capital, findingTitle, plural } from "../text";
import { Button, Eyebrow, Loading, PageBody, PageHeader } from "../ui";

/** One change, asked as a question: what would it open, close and break? Answered from a sandbox. */
export function WhatIfLine({ c, scenario, agentId }: { c: DeVries; scenario: string; agentId?: string | null }) {
  const [kind, setKind] = useState<"grant_call" | "add_delegation">("grant_call");
  const [who, setWho] = useState(agentId ?? "");
  const [what, setWhat] = useState("");
  const [asking, setAsking] = useState(false);
  const [answer, setAnswer] = useState<WhatIf | null>(null);
  const [error, setError] = useState<string | null>(null);
  const agents = (c.flow?.nodes ?? []).filter((n) => n.label === "Agent");
  const tools = (c.flow?.nodes ?? []).filter((n) => n.label === "Tool");
  const others = kind === "grant_call" ? tools : agents.filter((a) => a.data.id !== who);
  if (!c.flow) return null;

  const ask = async () => {
    const change: Change = kind === "grant_call" ? { kind, agent_id: who, tool_id: what } : { kind, from_agent_id: who, to_agent_id: what };
    setAsking(true);
    setError(null);
    setAnswer(null);
    try {
      setAnswer(await api.whatIf(scenario, [change]));
    } catch (e) {
      setError(e instanceof Error ? e.message : "The sandbox could not answer.");
    } finally {
      setAsking(false);
    }
  };
  const opened = answer?.introduced.length ?? 0;
  return (
    <section className="block whatif">
      <div className="block-head">
        <Eyebrow>What if</Eyebrow>
        <span>tested in a sandbox · nothing changes</span>
      </div>
      <form className="whatif-line" onSubmit={(e) => { e.preventDefault(); if (who && what && !asking) ask(); }}>
        <select value={who} onChange={(e) => { setWho(e.target.value); setAnswer(null); }} aria-label="Agent">
          <option value="">an agent…</option>
          {agents.map((a) => <option key={a.data.id} value={a.data.id}>{a.data.name ?? a.data.id}</option>)}
        </select>
        <div className="toggle" role="tablist" aria-label="Kind of change">
          <button type="button" role="tab" aria-selected={kind === "grant_call"} className={kind === "grant_call" ? "on" : ""} onClick={() => { setKind("grant_call"); setWhat(""); setAnswer(null); }}>could call</button>
          <button type="button" role="tab" aria-selected={kind === "add_delegation"} className={kind === "add_delegation" ? "on" : ""} onClick={() => { setKind("add_delegation"); setWhat(""); setAnswer(null); }}>delegated to</button>
        </div>
        <select value={what} onChange={(e) => { setWhat(e.target.value); setAnswer(null); }} aria-label={kind === "grant_call" ? "Tool" : "Delegate"}>
          <option value="">{kind === "grant_call" ? "a tool…" : "another agent…"}</option>
          {others.map((n) => <option key={n.data.id} value={n.data.id}>{n.data.name ?? n.data.id}</option>)}
        </select>
        <Button type="submit" disabled={!who || !what || asking}>{asking ? "Testing…" : "Test in a sandbox"}</Button>
      </form>
      {error && <p className="whatif-error">{error}</p>}
      {answer && (
        <div className="whatif-answer" aria-live="polite">
          <p className={`whatif-verdict${opened ? " opens" : ""}`}>
            <WithNames text={capital(answer.changes.join(", and "))} names={c.names} />: it would open {plural(opened, "finding", "findings")},
            close {plural(answer.resolved.length, "finding", "findings")} and break {plural(answer.newly_broken.length, "workflow", "workflows")}.
          </p>
          {answer.introduced.length > 0 && (
            <ul className="cards">
              {answer.introduced.map((f) => (
                <li className="card finding-open" key={f.id}>
                  <p>{findingTitle({ ...f, severity: "high", status: "open" }, c.names)}</p>
                  <p className="card-meta">{KIND_WORDS[f.kind]}{f.path_ids?.length ? ` · ${f.path_ids.map((id) => c.names[id] ?? id).join(" → ")}` : ""}</p>
                </li>
              ))}
            </ul>
          )}
          {answer.newly_broken.map((b) => <p className="whatif-error" key={b.workflow_id + b.why}><WithNames text={capital(b.why)} names={c.names} />.</p>)}
          <p className="rail-note">Measured in {answer.sandbox_ms} ms in a sandbox copy that has been deleted. The scenario is as it was.</p>
        </div>
      )}
    </section>
  );
}

/** What max flow found: the hops of the cheapest cut, each with the fix that would cut it, and the rules that would make it. */
export function CutBlock({ c, scenario, compact = false }: { c: DeVries; scenario: string; compact?: boolean }) {
  const [cut, setCut] = useState<Cut | null>(null);
  const [policy, setPolicy] = useState<Policy | null>(null);
  useEffect(() => {
    let wanted = true;
    api.cut(scenario).then((found) => wanted && setCut(found)).catch(() => wanted && setCut(null));
    api.cutPolicy(scenario).then((found) => wanted && setPolicy(found)).catch(() => wanted && setPolicy(null));
    return () => { wanted = false; };
  }, [scenario, c.flow]);
  if (!cut || cut.scenario !== scenario) return <Loading label="Asking max flow for the cheapest cut" />;
  const by = <>Worked out by <a href={href(scenario, "queries", "choke.maxflow")}>choke.maxflow</a>, which runs FalkorDB's <code>algo.maxFlow</code> over the flow layer with each hop's capacity set to the cost of the cheapest fix that cuts it.</>;
  const rules = policy && policy.scenario === scenario && (policy.docker_mcp_gateway.length > 0 || Object.keys(policy.claude_code.permissions).length > 0) ? policy : null;
  return (
    <section className="block cut-block">
      <div className="block-head">
        <Eyebrow>The cheapest cut</Eyebrow>
        <span>{cut.hops.length ? (cut.cuttable ? `cost ${cut.cost} · ${plural(cut.hops.length, "hop", "hops")}` : "no set of fixes separates them") : "nothing to cut"}</span>
      </div>
      {!cut.hops.length ? (
        <p className="chart-note">No untrusted source reaches a high-impact resource in this graph, so the max flow between them is zero. {by}</p>
      ) : (
        <div className="chart-note cut-note">
          <p>
            <strong>{cut.cuttable ? `Cheapest cut: cost ${cut.cost}.` : "No set of fixes separates them."}</strong>{" "}
            {cut.cuttable
              ? `Taking away ${plural(cut.hops.length, "hop", "hops")} separates every untrusted source from every high-impact resource, and nothing cheaper does.`
              : "The cheapest cut crosses a hop that no fix can cut."}
          </p>
          <ul className="cut-list">
            {cut.hops.map((h) => (
              <li key={`${h.from_id}>${h.to_id}`}>
                <WithNames text={h.sentence.replace(/rule \d+: /, "")} names={c.names} />
                <span> · rule {h.rule} · {h.fixes.length ? `${h.fixes.join(" or ")}, cost ${h.capacity}` : "cannot be cut"}</span>
              </li>
            ))}
          </ul>
          {rules && (
            <details className="policy" open={!compact}>
              <summary>The cut as rules: a Claude Code permissions block, and Docker MCP Gateway commands</summary>
              <pre className="draft-diff">{rules.claude_code_text.trim()}</pre>
              {rules.docker_mcp_gateway.length > 0 && <pre className="draft-diff">{rules.docker_mcp_gateway.join("\n")}</pre>}
              <p>A guide like the cut itself: a rule is safe only once a sandbox has passed the plan it stands for.</p>
            </details>
          )}
          {!compact && (
            <p>
              {by} It is a guide, not a verdict: it knows nothing about which workflows need what, and a trifecta is not a cut.
              A fix is real only once a sandbox has passed it; the plans that were tested are under <a href={href(scenario, "fixes")}>Fixes</a>.
            </p>
          )}
        </div>
      )}
    </section>
  );
}

export function WhatIfPage({ c, scenario }: { c: DeVries; scenario: string }) {
  return (
    <PageBody>
      <PageHeader eyebrow="What if" title="Ask the sandbox before you change anything." meta="A grant or a delegation that is not in the config yet, tested on a copy of the graph that is deleted afterwards; and the cheapest cut, from max flow, as rules." />
      {c.flow ? <WhatIfLine c={c} scenario={scenario} /> : <Loading label="Reading the graph" />}
      <CutBlock c={c} scenario={scenario} />
    </PageBody>
  );
}
