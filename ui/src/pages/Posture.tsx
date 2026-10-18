// The scenario's standing, read from FalkorDB: how exposed it is, where the risk runs, what stands in its way, and
// whether it is getting better. Five figures, the live flow, two bar charts, the choke points with the cut, the
// Rule of Two agent by agent (open), the history once there is one, and the OWASP coverage folded under one line.
// How each figure is read is on the Method page, not here.

import { useEffect, useState } from "react";
import { api, type Mitigation, type Posture } from "../api";
import { useFetch } from "../fetch";
import { loadElk } from "../graph/Flow";
import { RiskFlow } from "../graph/RiskFlow";
import { href } from "../route";
import type { DeVries } from "../state";
import { cutBy } from "../desk";
import { WithNames, capital, clock, countWord, plural } from "../text";
import { Block, Button, Empty, Figures, Fold, Loading, PageBody, PageHeader } from "../ui";

/** One row a thing, a bar for its figure against the largest, a second thinner bar for the part that matters most. */
function Bars({ rows, max, label }: { rows: { id: string; name: string; sub: string; value: number; accent?: number; href?: string }[]; max: number; label: string }) {
  if (!rows.length) return <p className="rail-note">Nothing to measure.</p>;
  const top = Math.max(1, max);
  return (
    <ol className="bars" aria-label={label}>
      {rows.map((r) => (
        <li key={r.id}>
          <span className="bar-label">
            {r.href ? <a href={r.href} title={r.id}>{r.name}</a> : <span title={r.id}>{r.name}</span>}
            <span className="bar-sub">{r.sub}</span>
          </span>
          <span className="bar-track">
            <i className="bar-fill" style={{ width: `${Math.round((r.value / top) * 100)}%` }} />
            {r.accent != null && r.accent > 0 && <i className="bar-accent" style={{ width: `${Math.round((r.accent / top) * 100)}%` }} />}
          </span>
          <span className="bar-n">{r.value}</span>
        </li>
      ))}
    </ol>
  );
}

/** Open findings after each scan, as one bar a scan; the latest is lit, so a fix shows as a drop. Drawn once there are two. */
function Scans({ scans }: { scans: Posture["scans"] }) {
  const max = Math.max(1, ...scans.map((s) => s.open));
  const shown = scans.slice(-24);
  return (
    <ol className="scans" aria-label="Open findings after each scan">
      {shown.map((s, i) => (
        <li key={s.scan_id} className={`scan${i === shown.length - 1 ? " lit" : ""}${s.open ? "" : " clean"}`} title={`${s.scan_id} · ${clock(s.at)} · ${plural(s.open, "open finding", "open findings")} · ${s.duration_ms} ms`}>
          <span className="scan-n">{s.open}</span>
          <i className="scan-bar" style={{ height: `${Math.max(4, Math.round((s.open / max) * 100))}%` }} />
          <span className="scan-at">{clock(s.at)}</span>
        </li>
      ))}
    </ol>
  );
}

/** The cheapest cut in one line, with the rules it would become folded under it and a button that makes it a plan. */
function CutLine({ c, scenario, cut }: { c: DeVries; scenario: string; cut: Posture["cut"] }) {
  const [state, setState] = useState<{ busy?: boolean; plan?: Mitigation | null; verdict?: Record<string, unknown> | null; error?: string } | null>(null);
  const policy = useFetch(cut.hops.length ? () => api.cutPolicy(scenario) : null, [scenario, c.configHash, cut.cost]);
  const hasInjection = (c.findings?.findings ?? []).some((f) => f.status === "open" && f.kind === "injection");
  if (!cut.hops.length) return <p className="cut-line rail-note">No untrusted source reaches a high-impact resource, so there is nothing to cut.</p>;
  const propose = async () => {
    setState({ busy: true });
    try {
      const answer = await api.proposeCut(scenario);
      setState({ plan: answer.proposed, verdict: answer.verdict });
    } catch (e) {
      setState({ error: e instanceof Error ? e.message : "The sandbox could not answer." });
    }
  };
  const target = state?.plan?.targets[0];
  const rules = policy.data && policy.data.scenario === scenario && (policy.data.docker_mcp_gateway.length > 0 || Object.keys(policy.data.claude_code.permissions).length > 0) ? policy.data : null;
  return (
    <div className="cut-line">
      <p>
        <strong>{cut.cuttable ? `Cheapest cut: cost ${cut.cost}.` : "No set of fixes separates them."}</strong>{" "}
        {cut.hops.map((h, i) => (
          <span key={`${h.from_id}>${h.to_id}`}>{i > 0 && "; "}<WithNames text={h.sentence.replace(/^rule \d+: /, "")} names={c.names} />{h.fix ? ` (${cutBy([h.fix])})` : h.fixes.length ? ` (${cutBy(h.fixes)})` : " (cannot be cut)"}</span>
        ))}.
        {cut.cuttable && hasInjection && (
          !state || state.error ? <> <Button size="sm" onClick={propose} disabled={c.busy}>Propose it as one plan</Button>{state?.error && <span className="whatif-error"> {state.error}</span>}</>
            : state.busy ? <> <span className="rail-note">asking a sandbox…</span></>
              : state.plan ? <> Passed in a sandbox{target && <>: <a href={href(scenario, "finding", target, "fix")}>read it on the fix step →</a></>}</>
                : <> <span className="whatif-error">The sandbox refused it: <WithNames text={String((state.verdict as { reason?: string } | null)?.reason ?? "it did not pass")} names={c.names} />.</span></>
        )}
      </p>
      {rules && (
        <details className="policy">
          <summary>The cut as rules: a Claude Code permissions block, and Docker MCP Gateway commands</summary>
          <pre className="draft-diff">{rules.claude_code_text.trim()}</pre>
          {rules.docker_mcp_gateway.length > 0 && <pre className="draft-diff">{rules.docker_mcp_gateway.join("\n")}</pre>}
        </details>
      )}
    </div>
  );
}

export function PosturePage({ c, scenario }: { c: DeVries; scenario: string }) {
  // ask again when the config, a scan or a plan has moved
  const posture = useFetch(() => api.posture(scenario), [scenario, c.configHash, c.scannedAt, c.plans.length, c.findings?.findings.length]);
  // the Explorer and a finding's Path step lay their chart out with ELK: fetch it now, while this page is idle, so they open faster
  useEffect(() => {
    const warm = () => void loadElk().catch(() => {});
    if (typeof window.requestIdleCallback === "function") {
      const id = window.requestIdleCallback(warm, { timeout: 4000 });
      return () => window.cancelIdleCallback(id);
    }
    const id = window.setTimeout(warm, 1500);           // Safari has no idle callback
    return () => window.clearTimeout(id);
  }, []);
  const p = posture.data?.scenario === scenario ? posture.data : null;
  const overview = c.overview?.scenario === scenario ? c.overview : null;
  const open = c.findings?.findings.filter((f) => f.status === "open") ?? [];
  const active = c.run && (c.run.status === "running" || c.run.status === "awaiting_approval");
  const canAudit = open.length > 0 && !active;
  const name = (id: string) => c.names[id] ?? id;
  const untrustedTotal = p?.counts.untrusted_sources ?? 0;
  const three = p?.rule_of_two.agents.filter((a) => a.count === 3) ?? [];
  // the second clause of the sentence, when the server gives one, opens the meta line
  const more = p?.sentence_more?.trim().replace(/[.;,]\s*$/, "");

  return (
    <PageBody width="wide">
      <PageHeader
        eyebrow="Posture"
        title={p?.sentence ?? overview?.sentence ?? (c.ready ? "Reading the graph." : "Connecting.")}
        meta={<>
          {more ? `${capital(more)}. ` : ""}
          {c.current?.description ? `${c.current.description}. ` : ""}
          {p?.facts.last_scan ? `Last scanned ${clock(p.facts.last_scan.at)}.` : "Not scanned yet."}
          {p?.own_copy ? " Your sandbox copy." : ""}
          {" "}<a href={href(scenario, "method", "analytics")}>How each figure is read →</a>
          {c.current?.imported && !open.length && <> Label the sources and resources under <a href={href(scenario, "inbox")}>Open</a> for the scan to find anything.</>}
        </>}
        actions={canAudit && <Button variant="primary" size="lg" onClick={c.startAudit} disabled={c.busy}>Run audit</Button>}
      />
      {posture.error && <p className="whatif-error">{posture.error}</p>}
      {!p ? <Loading label={c.ready ? "Reading the posture" : "Connecting"} /> : (
        <>
          <Figures items={[
            { n: p.counts.open_findings, label: p.counts.open_findings === 1 ? "open finding" : "open findings", tone: p.counts.open_findings ? "bad" : "good" },
            { n: `${p.exposure.high_reached} / ${p.exposure.high_total}`, label: "high-impact actions reached", tone: p.exposure.high_reached ? "bad" : undefined },
            { n: p.rule_of_two.tally["3"] ?? 0, label: "agents holding all three", tone: (p.rule_of_two.tally["3"] ?? 0) ? "bad" : undefined },
            { n: p.rule_of_two.unattended_three, label: "of them unattended", tone: p.rule_of_two.unattended_three ? "bad" : undefined },
            { n: p.cut.cost ?? "—", label: "cheapest cut, cost" },
          ]} />

          <Block className="posture-picture" eyebrow="Where the risk runs" aside="the open paths, as a map you can pan and zoom">
            {overview ? <RiskFlow view={overview} posture={p} names={c.names} scenario={scenario} /> : <Loading label="Reading the picture" />}
          </Block>

          <div className="posture-pair">
            <Block className="posture-blast" eyebrow="Blast radius" aside="what each untrusted source's text can reach">
              <Bars label="Blast radius" max={Math.max(1, ...p.blast.map((b) => b.reached))}
                rows={p.blast.map((b) => ({
                  id: b.id, name: b.name, value: b.reached, accent: b.high + b.external, href: href(scenario, "graph", b.id),
                  sub: [plural(b.agents, "agent", "agents"), plural(b.tools, "tool", "tools"), b.high ? `${countWord(b.high)} high-impact` : null, b.external ? `${countWord(b.external)} way${b.external === 1 ? "" : "s"} out` : null].filter(Boolean).join(" · "),
                }))} />
              {p.blast.length > 0 && <p className="bars-key"><i aria-hidden />what the source's text reaches · <i className="lit" aria-hidden />lit: high-impact resources and ways out among them</p>}
            </Block>
            <Block className="posture-targets" eyebrow="Exposure" aside="how many untrusted sources reach each action">
              <Bars label="Exposure" max={Math.max(1, untrustedTotal)}
                rows={p.targets.map((t) => ({
                  id: t.id, name: t.name, value: t.reaching, href: href(scenario, "graph", t.id),
                  sub: [t.impact ? `${t.impact} impact` : null, t.external ? "leaves the organisation" : null, t.reaching ? `from ${t.sources.map(name).join(", ")}` : "from no untrusted source"].filter(Boolean).join(" · "),
                }))} />
              {p.targets.length > 0 && <p className="bars-key"><i aria-hidden />how many of the {plural(untrustedTotal, "untrusted source", "untrusted sources")} reach it</p>}
            </Block>
          </div>

          <Block className="posture-chokes" eyebrow="Choke points" aside="where one change would cut the most open routes">
            {p.chokes.length ? (
              <ol className="chokes">
                {p.chokes.slice(0, 5).map((n, i) => (
                  <li key={n.id}>
                    <span className="choke-rank">{i + 1}</span>
                    <span className="choke-name"><a href={href(scenario, "graph", n.id)} title={n.id}>{n.name ?? name(n.id)}</a><span className="choke-kind">{n.label.toLowerCase()}</span></span>
                    <span className="bar-track"><i className="bar-fill" style={{ width: `${Math.round((n.routes / Math.max(1, p.chokes[0].routes)) * 100)}%` }} /></span>
                    <span className="choke-n">{plural(n.routes, "route", "routes")} · {plural(n.findings, "finding", "findings")}</span>
                  </li>
                ))}
              </ol>
            ) : <p className="rail-note">No open route passes through any agent or tool.</p>}
            <CutLine c={c} scenario={scenario} cut={p.cut} />
          </Block>

          <Fold className="posture-tally" open summary="Rule of Two, agent by agent" sub={`${plural(p.rule_of_two.agents.length, "agent", "agents")} · ${three.length ? `${countWord(three.length)} ${three.length === 1 ? "holds" : "hold"} all three` : "none holds all three"}${p.rule_of_two.unattended_three ? `, ${countWord(p.rule_of_two.unattended_three)} unattended` : ""}`}>
            {p.rule_of_two.agents.length ? (
              <ul className="tally">
                {p.rule_of_two.agents.map((a) => (
                  <li key={a.agent_id} className={`tally-card${a.count === 3 ? " all" : ""}${a.count === 3 && a.autonomous ? " unattended" : ""}`}>
                    <a href={href(scenario, "graph", a.agent_id)} title={a.agent_id}><strong>{name(a.agent_id)}</strong></a>
                    <span className="tally-dots" aria-label={`holds ${a.properties.join(", ") || "none"}`}>
                      {(["A", "B", "C"] as const).map((k) => <i key={k} className={`s-${k === "A" ? "hot" : k === "B" ? "private" : "exit"}${a.properties.includes(k) ? " on" : ""}`}>{k}</i>)}
                    </span>
                    <span className="tally-sub">{a.count === 3 ? (a.autonomous ? "all three · runs unattended" : "all three · supervised") : a.count ? `${countWord(a.count)} of three` : "none of the three"}</span>
                  </li>
                ))}
              </ul>
            ) : <Empty>No agent in this scenario.</Empty>}
          </Fold>

          {p.scans.length >= 2 ? (
            <Block className="posture-scans" eyebrow="Over time" aside={`${plural(p.scans.length, "scan", "scans")} · open findings after each`}>
              <Scans scans={p.scans} />
            </Block>
          ) : (
            <p className="rail-note posture-scans-note">{p.scans.length === 1 ? "One scan so far; the history starts with the next." : "No scan has been recorded on this graph yet; the history starts with the second."}</p>
          )}

          <Fold className="posture-owasp" summary="OWASP Top 10 coverage" sub={`${p.owasp.filter((o) => o.checked).length} of 10 classes checked · ${plural(p.owasp.filter((o) => o.open > 0).length, "class", "classes")} with open findings`}>
            <ul className="owasp-row">
              {p.owasp.map((o) => (
                <li key={o.code} className={`owasp-code${o.checked ? "" : " off"}${o.open ? " hot" : ""}`} title={`${o.code} ${o.name}${o.checked ? "" : " · not checked by DeVries"}`}>
                  <b>{o.code}</b>
                  <span className="owasp-name">{o.name}</span>
                  <span className="owasp-n">{o.checked ? plural(o.open, "open", "open") : "not checked"}</span>
                </li>
              ))}
            </ul>
          </Fold>
        </>
      )}
    </PageBody>
  );
}
