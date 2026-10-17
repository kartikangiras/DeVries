// The open findings, each a small memo of its own, and the same list for the ones that are closed. The scenario's
// standing is on Posture; this page is the list, and for an import, the labels the scan needs. The row is Manthan's inbox row (strip, headline with its figure, footer with what happens
// next), holding a finding instead of a case (see ui/THIRD_PARTY_NOTICES.md).

import type { Finding } from "../api";
import { useState } from "react";
import { headline } from "../brief";
import { deskOf, exposure, recommendation, type Desk } from "../desk";
import { href } from "../route";
import type { DeVries } from "../state";
import { KIND_WORDS, capital, countWord, plural, short } from "../text";
import { Button, Empty, Eyebrow, Loading, PageBody, PageHeader } from "../ui";

/** An imported install carries no labels: say what is untrusted and what matters, and the scan runs on the answer. */
function LabelForm({ c }: { c: DeVries }) {
  const sources = (c.flow?.nodes ?? []).filter((n) => n.label === "DataSource");
  const resources = (c.flow?.nodes ?? []).filter((n) => n.label === "Resource");
  const [trust, setTrust] = useState<Record<string, string>>({});
  const [impact, setImpact] = useState<Record<string, string>>({});
  const [external, setExternal] = useState<Record<string, boolean>>({});
  const unknown = sources.some((n) => (n.data.trust ?? "unknown") === "unknown") || resources.some((n) => (n.data.impact ?? "unknown") === "unknown");
  const [open, setOpen] = useState(unknown);
  if (!sources.length && !resources.length) return null;
  const trustOf = (id: string, now?: string) => trust[id] ?? now ?? "unknown";
  const impactOf = (id: string, now?: string) => impact[id] ?? now ?? "unknown";
  const save = () => {
    const ds = Object.fromEntries(sources.map((n) => [n.data.id, trustOf(n.data.id, n.data.trust)]));
    const rs = Object.fromEntries(resources.map((n) => [n.data.id, { impact: impactOf(n.data.id, n.data.impact), external: external[n.data.id] ?? !!n.data.external }]));
    c.setLabels(ds, rs);
  };
  return (
    <div className="labels">
      <Eyebrow>{unknown ? "Label this install" : "Labels"}</Eyebrow>
      {!open ? (
        <p className="about-note">Every source and resource is labelled. <button className="link" onClick={() => setOpen(true)}>Change the labels</button>.</p>
      ) : (
        <>
          <p className="about-note">
            {unknown ? "Nothing here is a finding until you say what is untrusted and what matters. " : ""}
            For each data source: can people outside the organisation write what these tools read? For each resource: how much does what they act on matter, and does it leave the organisation?
          </p>
          <table className="table">
            <thead><tr><th>Data source</th><th>Trust</th></tr></thead>
            <tbody>
              {sources.map((n) => (
                <tr key={n.data.id}>
                  <td>{n.data.name ?? n.data.id}<br /><span className="faint mono">{n.data.id}</span></td>
                  <td>
                    <select value={trustOf(n.data.id, n.data.trust)} onChange={(e) => setTrust({ ...trust, [n.data.id]: e.target.value })} aria-label={`Trust of ${n.data.id}`}>
                      <option value="unknown">unknown</option><option value="untrusted">untrusted: outsiders write it</option>
                      <option value="internal">internal</option><option value="private">private: must not leak</option>
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <table className="table">
            <thead><tr><th>Resource</th><th>Impact</th><th>Leaves the organisation</th></tr></thead>
            <tbody>
              {resources.map((n) => (
                <tr key={n.data.id}>
                  <td>{n.data.name ?? n.data.id}<br /><span className="faint mono">{n.data.id}</span></td>
                  <td>
                    <select value={impactOf(n.data.id, n.data.impact)} onChange={(e) => setImpact({ ...impact, [n.data.id]: e.target.value })} aria-label={`Impact of ${n.data.id}`}>
                      <option value="unknown">unknown</option><option value="high">high</option><option value="medium">medium</option><option value="low">low</option>
                    </select>
                  </td>
                  <td><input type="checkbox" checked={external[n.data.id] ?? !!n.data.external} onChange={(e) => setExternal({ ...external, [n.data.id]: e.target.checked })} aria-label={`${n.data.id} leaves the organisation`} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="ask-line">
            <Button variant="primary" size="lg" onClick={save} disabled={c.busy}>Save the labels and scan</Button>
            <span className="about-note">The file is rewritten and the graph reloaded: this is your own install, so the shared scenario is the one that changes.</span>
          </p>
        </>
      )}
    </div>
  );
}

function Row({ finding, desk, names, scenario }: { finding: Finding; desk: Desk; names: Record<string, string>; scenario: string }) {
  const head = headline(finding, names);
  const plan = desk.proposal ?? desk.applied;
  return (
    <a className={`case status-${finding.status}`} href={href(scenario, "finding", finding.id)}>
      <article>
        <header className="case-strip">
          <span className="case-id">Finding {short(finding.id)}</span>
          <i>·</i>
          <span className="case-kind">{KIND_WORDS[finding.kind]}</span>
          <i>·</i>
          <span className="case-fact"><span>severity</span> {finding.severity}</span>
          <span className="case-status">
            <span className={`phase t-${desk.tone}${desk.pulse ? " pulse" : ""}`}>{desk.word}</span>
          </span>
        </header>
        <div className="case-body">
          <h2>
            {head.title} <em>{head.line}</em>
          </h2>
          <div className="transform">
            <span className="transform-from">{exposure(finding)}</span>
            <span className="transform-arrow" aria-hidden>→</span>
            {plan ? <span className="transform-to">{recommendation(plan)}</span> : <span className="transform-none">{desk.tone === "info" ? "testing" : "untested"}</span>}
          </div>
        </div>
        <footer className="case-foot">
          <span className="case-next">
            <span>{desk.nextLabel}</span>
            <b>{desk.next}</b>
          </span>
        </footer>
      </article>
    </a>
  );
}

export function Inbox({ c, scenario, done = false }: { c: DeVries; scenario: string; done?: boolean }) {
  const found = c.findings;
  const list = found ? (done ? found.past : found.findings.filter((f) => f.status === "open")) : null;
  const desks = (list ?? []).map((f) => ({ finding: f, desk: deskOf(f, c.plans, c.run, c.openIds) }));
  const awaiting = desks.filter((d) => d.desk.proposal).length;
  const running = c.run?.kind === "audit" && c.run.status === "running";
  const waiting = c.run?.status === "awaiting_approval";
  const n = desks.length;

  const title = !list ? (done ? "Closed." : "Findings.")
    : done ? (n ? `${capital(plural(n, "finding", "findings"))} closed.` : "Nothing closed yet.")
    : n ? `${capital(plural(n, "finding", "findings"))} open.` : "Nothing open.";

  const meta = !list ? null : done ? (
    n ? <>Closed by a fix, accepted, or no longer true of the graph. Each still opens, and shows where it was cut.</> : <>A finding lands here once a fix closes it.</>
  ) : n ? (
    <>
      {awaiting > 0 && <span className="t-amber">{awaiting} awaiting your approval</span>}
      {awaiting > 0 && running && <i>·</i>}
      {running && <span className="t-info">an audit is running</span>}
      {!awaiting && !running && <span>{n === 1 ? "It has" : `${capital(countWord(n))} have`} no tested fix yet. An audit tries the candidate fixes on a sandbox copy of the graph.</span>}
    </>
  ) : (
    <>Nothing untrusted reaches a high-impact resource here, and no agent holds untrusted input, private data and a way out.</>
  );

  return (
    <PageBody>
      <PageHeader
        eyebrow={done ? "Closed findings" : "Open findings"}
        title={title}
        meta={meta}
        actions={!done && n > 0 && !waiting && !awaiting && (
          <Button variant="primary" size="lg" onClick={c.startAudit} disabled={c.busy || running}>
            {running ? "Auditing…" : "Run audit"}
          </Button>
        )}
      />
      {!list ? <Loading label={c.ready ? "Reading the graph" : "Connecting"} /> : n ? (
        <div className="cases">
          {desks.map(({ finding, desk }) => <Row key={finding.id} finding={finding} desk={desk} names={c.names} scenario={scenario} />)}
        </div>
      ) : done ? (
        <Empty>Nothing has been closed in this scenario.</Empty>
      ) : (
        <Empty>
          {found!.past.length ? <>Everything found here is closed. <a href={href(scenario, "done")}>See what was closed</a>.</> : "The last scan found nothing open."}
          {c.current?.imported && !c.current?.own_copy && <> Label the sources and resources below for the scan to find anything.</>}
          {c.current?.own_copy && <> This is your sandbox copy; <button className="link" onClick={c.reset} disabled={c.busy}>reset it</button> to see the shared scenario again.</>}
        </Empty>
      )}
      {!done && c.current?.imported && c.flow && (
        <section className="about">
          <LabelForm c={c} />
        </section>
      )}
    </PageBody>
  );
}
