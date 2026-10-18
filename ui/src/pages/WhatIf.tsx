// A question answered in a sandbox, which changes nothing in the scenario: what one more grant or delegation
// would open, close and break, asked from the Explorer's reader. (The cheapest cut is on Posture, in CutLine.)

import { useState } from "react";
import { api, type Change, type WhatIf } from "../api";
import type { DeVries } from "../state";
import { KIND_WORDS, WithNames, capital, findingTitle, plural } from "../text";
import { Button, Eyebrow } from "../ui";

/** One change, asked as a question: what would it open, close and break? Answered from a sandbox. `head` is off where a fold already names it. */
export function WhatIfLine({ c, scenario, agentId, head = true }: { c: DeVries; scenario: string; agentId?: string | null; head?: boolean }) {
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
      {head && (
        <div className="block-head">
          <Eyebrow>What if</Eyebrow>
          <span>tested in a sandbox · nothing changes</span>
        </div>
      )}
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
