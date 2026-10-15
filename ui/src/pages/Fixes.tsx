// Every plan a sandbox was asked about, passed or not, as a ledger. Selecting a row puts its verdict
// in the rail; a passing plan that is still waiting can be approved from here. The page is Manthan's
// approval ledger (filters, table, selection rail, the bar underneath); see ui/THIRD_PARTY_NOTICES.md.

import { useEffect, useMemo, useState } from "react";
import { api, type Graph, type Mitigation, type Preview } from "../api";
import { ApprovalBar } from "../ApprovalBar";
import { best, isLive, patchText, recommendation, type Tone } from "../desk";
import { Chart, RendererSwitch, useRenderer, type Renderer } from "../graph/Chart";
import { focusOf, withReaders } from "../paths";
import { go, href } from "../route";
import type { DeVries } from "../state";
import { WithNames, capital, clock, countWord, plural, short } from "../text";
import { Button, Empty, Eyebrow, KV, Loading, PageHeader, Status, Tabs } from "../ui";

type Filter = "all" | "waiting" | "applied" | "failed" | "rejected" | "superseded";

const STATE: Record<Mitigation["status"], { word: string; tone: Tone; pulse?: boolean; filter: Filter }> = {
  proposed: { word: "Awaiting nod", tone: "amber", pulse: true, filter: "waiting" },
  approved: { word: "Applying", tone: "accent", pulse: true, filter: "waiting" },
  applied: { word: "Applied", tone: "accent", filter: "applied" },
  rejected: { word: "Rejected", tone: "muted", filter: "rejected" },
  failed: { word: "Failed", tone: "danger", filter: "failed" },
};

/** A plan that passed and was never decided on, for a finding that has since been closed some other way. */
const SUPERSEDED = { word: "Superseded", tone: "muted" as Tone, pulse: false, filter: "superseded" as Filter };

const SOURCE: Record<string, string> = { scripted: "the scripted search", agent: "the model", search: "a search asked for here" };

function Selection({ m, c, scenario, superseded }: { m: Mitigation; c: DeVries; scenario: string; superseded: boolean }) {
  const before = m.open_before?.length ?? 0;
  const resolved = m.resolved?.length ?? 0;
  const current = c.configHash && m.config_hash ? c.configHash === m.config_hash : null;
  return (
    <>
      <section>
        <Eyebrow>Selection</Eyebrow>
        <p className={`big-figure${m.passed ? " good" : ""}`}>{resolved} / {before}</p>
        <p className="figure-sub">open findings it resolves in the sandbox</p>
        <p className="selection-plan"><WithNames text={capital(m.summary.join(", and "))} names={c.names} />.</p>
        {!m.passed && m.reason && <p className="selection-reason"><WithNames text={capital(m.reason)} names={c.names} />.</p>}
        {superseded && <p className="rail-note">Superseded: the finding it was verified against has since been closed, so it can no longer be applied.</p>}
      </section>
      <section>
        <Eyebrow>Verdict</Eyebrow>
        <dl>
          <KV k="Passed">{m.passed ? "yes" : "no"}</KV>
          <KV k="Introduces">{plural(m.introduced?.length ?? 0, "finding", "findings")}</KV>
          <KV k="Breaks">{plural(m.newly_broken?.length ?? 0, "workflow", "workflows")}</KV>
          <KV k="Leaves open">{plural(m.open_after?.length ?? 0, "finding", "findings")}</KV>
          <KV k="Cost">{m.cost}</KV>
          {m.sandbox_ms != null && <KV k="Sandbox">{m.sandbox_ms} ms</KV>}
          <KV k="Proposed by">{SOURCE[m.source] ?? m.source}</KV>
          {m.approved_by && <KV k={m.status === "rejected" ? "Rejected by" : "Approved by"}>{m.approved_by}</KV>}
          {m.applied_at && <KV k="Applied">{clock(m.applied_at)}</KV>}
        </dl>
        {m.decision_reason && <p className="rail-note">Reason given: {m.decision_reason}</p>}
      </section>
      <section>
        <Eyebrow>The change</Eyebrow>
        {m.patch.map((p, i) => <p className="patch" key={i}>{patchText(p)}</p>)}
        <p className="rail-note">
          Tested against config <code>{m.config_hash?.slice(0, 10) ?? "unknown"}</code>
          {current === null ? "." : current ? ", which is still the config." : "; the config has changed since, so it is verified again before it is applied."}
        </p>
        <p className="rail-note">
          Meant to close {m.targets.map((id, i) => (
            <span key={id}>{i > 0 && ", "}<a className="id" href={href(scenario, "finding", id)}>{id}</a></span>
          ))}.
        </p>
      </section>
    </>
  );
}

/** The selected plan's target, drawn with the plan applied: read from a sandbox, or from the graph once it is applied. */
export function After({ m, c, scenario, renderer = "devries", layout = "tree" }: { m: Mitigation; c: DeVries; scenario: string; renderer?: Renderer; layout?: "force" | "tree" }) {
  const [shown, setShown] = useState<{ preview?: Preview; error?: string } | null>(null);
  const stamp = `${m.id}/${m.status}/${c.configHash}`;      // ask again when the plan or the config has moved
  useEffect(() => {
    let wanted = true;
    setShown(null);
    api.preview(scenario, m.id)
      .then((preview) => wanted && setShown({ preview }))
      .catch((e) => wanted && setShown({ error: e instanceof Error ? e.message : "The preview could not be made." }));
    return () => {
      wanted = false;
    };
  }, [scenario, stamp]); // the plan itself is read through its id: `stamp` says when to ask again

  const target = useMemo(
    () => [...(c.findings?.findings ?? []), ...(c.findings?.past ?? [])].find((f) => f.id === m.targets[0]) ?? null,
    [c.findings, m.targets],
  );
  const graph = shown?.preview ? ({ ...shown.preview, own_copy: false, queries: [] } as Graph) : null;
  const splits = m.plan.fixes.some((f) => f.kind === "split_agent");
  const focus = useMemo(() => (target ? withReaders(focusOf(target), m, shown?.preview) : null), [target, m, shown]);
  if (!target || !focus) return null;
  return (
    <section className="block after">
      <div className="block-head">
        <Eyebrow>{shown?.preview?.applied ? "As applied" : "With this plan, in a sandbox"}</Eyebrow>
        <span><a className="id" href={href(scenario, "finding", target.id)}>{target.id}</a></span>
      </div>
      {graph ? (
        <>
          <Chart renderer={renderer} layout={layout} graph={graph} names={c.names} focus={focus} only height={300} idle="The path of the finding this plan is meant to close, as the plan would leave it." />
          <p className="chart-note">
            {shown!.preview!.applied
              ? "The plan is applied, so this is the graph as it stands."
              : "Read from a sandbox copy with the plan applied; the copy is deleted and nothing here has changed."}{" "}
            A hop the plan gates is green and dashed, a grant it revokes is gone, and a dot is no longer filled once untrusted text stops reaching it.
            {splits && " The reader a split adds stands with the delegates: it does the reading, and what it returns is quarantined."}
          </p>
        </>
      ) : shown?.error ? <p className="rail-note">{shown.error}</p> : <Loading label="Asking a sandbox" />}
    </section>
  );
}

export function Fixes({ c, scenario, selectedId }: { c: DeVries; scenario: string; selectedId: string | null }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [renderer, setRenderer] = useRenderer();
  const plans = [...c.plans].reverse(); // newest first
  const stateOf = (m: Mitigation) => (m.status === "proposed" && !isLive(m, c.openIds) ? SUPERSEDED : STATE[m.status]);
  const rows = filter === "all" ? plans : plans.filter((m) => stateOf(m).filter === filter);
  const selected = (selectedId && c.mitigations[selectedId]) || best(rows.filter((m) => isLive(m, c.openIds)), c.run) || rows[0] || null;
  const count = (f: Filter) => plans.filter((m) => stateOf(m).filter === f).length;
  const passed = plans.filter((m) => m.passed).length;
  const canAudit = (c.findings?.findings.some((f) => f.status === "open") ?? false) && !(c.run && (c.run.status === "running" || c.run.status === "awaiting_approval"));
  const waiting = selected && isLive(selected, c.openIds) ? selected : null;

  return (
    <div className={`workspace${waiting ? " deciding" : ""}`}>
      <div className="spread">
        <div className="scroll">
          <div className="ledger">
            <PageHeader
              eyebrow="Fixes"
              title={plans.length ? `${capital(plural(plans.length, "plan", "plans"))} tested, ${passed ? countWord(passed) : "none"} passed.` : "No plan has been tested yet."}
              meta="Every plan a sandbox was asked about, passed or not. A plan changes the graph only after a person approves it."
              actions={<>{canAudit && <Button variant="primary" size="lg" onClick={c.startAudit} disabled={c.busy}>Run audit</Button>}</>}
            />
            {!c.findings ? <Loading /> : plans.length ? (
              <>
                <Tabs label="Status" value={filter} onChange={setFilter} options={[
                  { value: "all", label: "All", count: plans.length },
                  { value: "waiting", label: "Awaiting", count: count("waiting") },
                  { value: "applied", label: "Applied", count: count("applied") },
                  { value: "failed", label: "Failed", count: count("failed") },
                  { value: "rejected", label: "Rejected", count: count("rejected") },
                  ...(count("superseded") ? [{ value: "superseded" as Filter, label: "Superseded", count: count("superseded") }] : []),
                ]} />
                <table className="table">
                  <thead>
                    <tr><th>№</th><th>Plan</th><th>Does</th><th className="num">Cost</th><th>Status</th><th className="num">Sandbox</th><th className="num">Tested</th></tr>
                  </thead>
                  <tbody>
                    {rows.map((m) => (
                      <tr key={m.id} className={m.id === selected?.id ? "on" : ""} onClick={() => go(scenario, "fixes", m.id)} tabIndex={0}
                        onKeyDown={(e) => e.key === "Enter" && go(scenario, "fixes", m.id)} aria-selected={m.id === selected?.id}>
                        <td className="mono">{short(m.id)}</td>
                        <td className="plan"><WithNames text={capital(m.summary.join(", and "))} names={c.names} /></td>
                        <td className="does">{recommendation(m)}</td>
                        <td className="num">{m.cost}</td>
                        <td><Status tone={stateOf(m).tone} pulse={stateOf(m).pulse}>{stateOf(m).word}</Status></td>
                        <td className="num">{m.sandbox_ms != null ? `${m.sandbox_ms} ms` : ""}</td>
                        <td className="num faint">{clock(m.created_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!rows.length && <Empty>No plan has this status.</Empty>}
                {selected && (
                  <>
                    <div className="chart-controls"><RendererSwitch value={renderer} onChange={setRenderer} /></div>
                    <After m={selected} c={c} scenario={scenario} renderer={renderer} />
                  </>
                )}
              </>
            ) : (
              <Empty>An audit tries the candidate fixes for a finding on a sandbox copy of the graph, cheapest first. Each one it tries lands here.</Empty>
            )}
            {c.findings && <p className="rail-note">A change that is not in the config yet is tested under <a href={href(scenario, "whatif")}>What if</a>.</p>}
          </div>
        </div>
        <aside className="rail" aria-label="The selected plan">
          {selected ? <Selection m={selected} c={c} scenario={scenario} superseded={stateOf(selected) === SUPERSEDED} /> : (
            <section>
              <Eyebrow>Selection</Eyebrow>
              <p className="rail-note">Select a plan to read what the sandbox said about it.</p>
            </section>
          )}
          <section>
            <Eyebrow>The ledger</Eyebrow>
            <dl>
              <KV k="Tested">{plans.length}</KV>
              <KV k="Passed">{passed}</KV>
              <KV k="Applied">{count("applied")}</KV>
              <KV k="Rejected">{count("rejected")}</KV>
              <KV k="Sandbox time">{plans.reduce((sum, m) => sum + (m.sandbox_ms ?? 0), 0)} ms</KV>
            </dl>
          </section>
        </aside>
      </div>
      {waiting && (
        <ApprovalBar mitigation={waiting} names={c.names} busy={c.busy} scenario={scenario} canWrite={!!c.session?.can_write}
          onApprove={(who, write) => c.approve(waiting.id, who, write)} onReject={(who, why) => c.reject(waiting.id, who, why)} />
      )}
    </div>
  );
}
