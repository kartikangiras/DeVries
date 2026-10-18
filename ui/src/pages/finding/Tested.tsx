// The Options step: every plan a sandbox was asked about for this finding, as one chart with the verdict under each row.

import type { Finding, Mitigation } from "../../api";
import { verdictLine, type Desk } from "../../desk";
import { href } from "../../route";
import type { DeVries } from "../../state";
import { WithNames, findingTitle, plural } from "../../text";
import { Empty, Eyebrow, Fold } from "../../ui";

/** Every plan a sandbox was asked about for this finding, cheapest first, as one chart: its cost as a bar, what it
 *  did to each finding that was open as a cell, what it would open and break as counts; under each row, the verdict
 *  in words. Any plan can be read on the Fix step. */
export function Tested({ finding, desk, c, scenario, onRead }: { finding: Finding; desk: Desk; c: DeVries; scenario: string; onRead: (id: string) => void }) {
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
          const recommended = m.id === desk.proposal?.id || m.id === desk.applied?.id;
          return (
            <li key={m.id} className={`verdict ${m.passed ? "pass" : "fail"}${recommended ? " on" : ""}`}>
              <span className="verdict-mark" aria-label={m.passed ? "passes" : "fails"}>{m.passed ? "✓" : "✕"}</span>
              <span className="verdict-plan"><WithNames text={m.summary.join(", and ")} names={c.names} /></span>
              <span className="verdict-cost"><i className="bar" style={{ width: `${Math.round((m.cost / maxCost) * 64)}px` }} aria-hidden />cost {m.cost}</span>
              <span className="verdict-cells">
                {columns.map((id) => { const x = cell(m, id); return <i key={id} className={`cell ${x.k}`} title={`${title(id)}: ${x.t}`} />; })}
                <em className={`n${opens ? " bad" : ""}`}>{opens}</em>
                <em className={`n${breaks ? " bad" : ""}`}>{breaks}</em>
              </span>
              <span className="verdict-why">
                {m.passed ? verdictLine(m) : <WithNames text={m.reason ?? "it did not pass"} names={c.names} />}
                {m.status === "rejected" && ` · rejected by ${m.approved_by ?? "a person"}${m.decision_reason ? `: ${m.decision_reason}` : ""}`}
                {m.status === "applied" && " · applied"}
                {recommended ? " · the recommendation" : <> · <button className="link" onClick={() => onRead(m.id)}>read it on the fix step</button></>}
              </span>
            </li>
          );
        })}
      </ul>
      <p className="chart-note">
        A filled cell is a finding the plan closed in the sandbox, an empty one a finding it left open, and {columns.length === 1 ? "the one column" : "column 1"} is this finding. Cheaper plans are tried first, so cost is the search's own order.
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
