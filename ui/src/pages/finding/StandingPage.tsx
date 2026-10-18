// A standing finding (manifest drift, a poisoned description): what was found, and the one decision a person can take.

import { useState } from "react";
import type { Finding } from "../../api";
import { headline, tldr } from "../../brief";
import { deskOf, exposure } from "../../desk";
import { findingQueries } from "../../paths";
import { href } from "../../route";
import type { DeVries } from "../../state";
import { KIND_WORDS, WithNames, capital, short } from "../../text";
import { Button, Eyebrow, KV } from "../../ui";
import { two } from "./shared";

/** A standing finding (drift, a poisoned description): what was found, and the one decision a person can take, to accept it. */
export function StandingPage({ c, scenario, finding }: { c: DeVries; scenario: string; finding: Finding }) {
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
              {findingQueries(finding).map((q, i) => <span key={q}>{i > 0 && ", "}<a href={href(scenario, "method", "queries", q)}>{q}</a></span>)}
            </p>
          </section>
        </aside>
      </div>
    </div>
  );
}
