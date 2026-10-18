// One finding, worked through in five steps, each answering one question nobody else answers: what is this
// (Summary), which rule fired and what satisfies it (Rule), hop by hop how the text travels (Path, the only step
// that draws the chart), what the recommended change is and whether you approve (Fix, the only step with the
// approval bar), and what else was tried (Options). The rail holds what the step at hand needs: a strip, a brief,
// the drafted change, the rail and the approval bar.
//
// Each step's blocks live under ./finding: the hops and the path in words, the rule's checklist and the Rule of Two
// grid, the plan and the path after it, the plan chart, the rail, the rehearsal, and the standing finding's page.
// This file holds the strip, the five steps and what each step shows.

import { useMemo, useState } from "react";
import type { Finding, Mitigation } from "../api";
import { ApprovalBar } from "../ApprovalBar";
import { citations, headline, tldr, verdictSentence } from "../brief";
import { deskOf, exposure, isLive, recommendation } from "../desk";
import { Chart, RendererSwitch, useRenderer } from "../graph/Chart";
import { focusOf, pathsOf, withReaders } from "../paths";
import { go, href } from "../route";
import type { DeVries } from "../state";
import { KIND_WORDS, WithNames, capital, plural, short } from "../text";
import { Empty, Eyebrow, Figures, Fold, Loading } from "../ui";
import { Applied, Drafted, PathAfter } from "./finding/Fix";
import { Hops, PathWords } from "./finding/Hops";
import { Rail } from "./finding/Rail";
import { Rehearsal } from "./finding/Rehearsal";
import { Analysis, RuleNeeds, RuleOfTwo } from "./finding/Rule";
import { PROPERTIES, isStep, type Card, type Step } from "./finding/shared";
import { StandingPage } from "./finding/StandingPage";
import { Tested } from "./finding/Tested";

export function FindingPage({ c, scenario, finding, step }: { c: DeVries; scenario: string; finding: Finding; step: string | null }) {
  if (finding.kind === "drift" || finding.kind === "poisoned_description") return <StandingPage c={c} scenario={scenario} finding={finding} />;
  return <FindingBody c={c} scenario={scenario} finding={finding} step={isStep(step) ? step : "summary"} />;
}

function FindingBody({ c, scenario, finding, step }: { c: DeVries; scenario: string; finding: Finding; step: Step }) {
  const [renderer, setRenderer] = useRenderer("finding");
  const [canvasLayout, setCanvasLayout] = useState<"force" | "tree">("tree");
  const [pathIndex, setPathIndex] = useState(0);
  const [picked, setPicked] = useState<string | null>(null);
  const [option, setOption] = useState<string | null>(null);
  // the step is the fourth part of the address, so a plan can be linked to from anywhere
  const setStep = (to: Step) => go(scenario, "finding", finding.id, to === "summary" ? null : to);

  const desk = deskOf(finding, c.plans, c.run, c.openIds);
  const cites = useMemo(() => citations(finding), [finding]);
  // once a split has closed the finding, the reader it added is drawn beside the path it was cut out of
  const focus = useMemo(() => withReaders(focusOf(finding, pathIndex), desk.applied, c.flow), [finding, pathIndex, desk.applied, c.flow]);
  const byNumber = useMemo(() => new Map([...cites].map(([id, n]) => [n, id])), [cites]);
  const head = headline(finding, c.names);
  const paths = pathsOf(finding);
  const shown = finding.kind === "injection" ? paths.slice(pathIndex, pathIndex + 1) : paths;
  const plan = desk.proposal ?? desk.applied;
  const approved = desk.tested.find((m) => m.status === "approved") ?? null;
  const canAudit = finding.status === "open" && !plan && !approved && !(c.run && (c.run.status === "running" || c.run.status === "awaiting_approval"));
  const agentIds = useMemo(() => {
    const ids = new Set<string>();
    for (const { path } of paths) for (const id of path.node_ids) if (id.startsWith("agent:")) ids.add(id);
    if (finding.agent_id) ids.add(finding.agent_id);
    return [...ids];
  }, [paths, finding.agent_id]);
  const cards = useMemo(() => agentIds.map((id) => c.scorecard?.agents.find((a) => a.agent_id === id)).filter((a): a is Card => !!a), [agentIds, c.scorecard]);
  // the agent the rule is about: a trifecta's own; on an injection path, the one holding most, the last of them if tied
  const worst = cards.find((a) => a.agent_id === finding.agent_id) ?? cards.reduce<Card | null>((most, a) => (!most || a.count >= most.count ? a : most), null);
  // the fix step reads the recommended plan, or another tested plan a person asked to read from the options
  const reading = (option && option !== plan?.id ? c.mitigations[option] ?? null : null) ?? plan ?? approved;
  const name = (id?: string | null) => (id ? c.names[id] ?? id : "");
  const words = (props: string[]) => props.map((p) => PROPERTIES.find((q) => q.key === p)?.word ?? p).join(" and ");
  const passed = desk.tested.filter((m) => m.passed).length;
  const hopsOnShortest = finding.kind === "injection" ? Math.min(...paths.map((p) => p.path.rules.length), Infinity) : paths.reduce((n, p) => n + p.path.rules.length, 0);

  const steps: { id: Step; n: string; label: string; sub: string }[] = [
    { id: "summary", n: "1", label: "Summary", sub: "the finding in brief" },
    { id: "rule", n: "2", label: "Rule", sub: finding.kind === "injection" ? "check 1 · an injection path" : "check 2 · a trifecta" },
    { id: "path", n: "3", label: "Path", sub: "how the text travels" },
    { id: "fix", n: "4", label: "Fix", sub: desk.applied ? "applied" : desk.proposal ? "awaiting your approval" : desk.tone === "info" ? "being tested" : "none yet" },
    { id: "options", n: "5", label: "Options", sub: `${plural(desk.tested.length, "plan", "plans")} tested` },
  ];
  const switcher = <RendererSwitch value={renderer} onChange={setRenderer} layout={canvasLayout} onLayout={setCanvasLayout} />;
  const next = (to: Step, label: string) => <p className="step-next"><button className="link" onClick={() => setStep(to)}>Next: {label} →</button></p>;
  const routes = finding.kind === "injection" && paths.length > 1 && (
    <span className="control-group">
      <span className="control">Route</span>
      <div className="pills" role="tablist" aria-label="Evidence paths">
        {paths.map((p, i) => (
          <button key={i} role="tab" aria-selected={i === pathIndex} className={i === pathIndex ? "on" : ""} onClick={() => setPathIndex(i)}>{p.label}</button>
        ))}
      </div>
    </span>
  );
  // a plan waits for a person on the fix step and nowhere else: each step talks about one thing
  const deciding = step === "fix" && !!desk.proposal;
  const readingAside = (m: Mitigation) =>
    m.status === "approved" ? "approved, being applied"
      : m.status === "applied" ? "applied"
        : m.status === "rejected" ? `rejected by ${m.approved_by ?? "a person"}`
          : m.id === desk.proposal?.id ? "awaiting approval"
            : m.passed ? (isLive(m, c.openIds) ? "passed; not the recommendation" : "passed, for a graph that has since changed") : "failed in its sandbox";

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
          <button key={s.id} role="tab" aria-selected={step === s.id} className={`workflow-step${step === s.id ? " on" : ""}`} onClick={() => setStep(s.id)}>
            <span className="workflow-n">{s.n}</span>
            <span className="workflow-text"><span className="workflow-label">{s.label}</span><span className="workflow-sub">{s.sub}</span></span>
          </button>
        ))}
      </nav>

      <div className="spread">
        <div className="brief scroll">
          {step === "summary" ? (
            <div className="brief-inner">
              <Eyebrow>Summary</Eyebrow>
              <h1 className="brief-title">
                {head.title} <em>{head.line}</em>
              </h1>
              <PathWords finding={finding} paths={shown} c={c} />
              <Figures items={[
                { n: finding.severity, label: "severity", tone: finding.severity === "critical" ? "bad" : undefined },
                ...(finding.kind === "injection"
                  ? [{ n: finding.paths_capped ? `${finding.paths_found}+` : finding.paths_found ?? paths.length, label: finding.paths_found === 1 ? "route" : "routes" }, { n: Number.isFinite(hopsOnShortest) ? hopsOnShortest : 0, label: "hops, shortest route" }]
                  : [{ n: paths.length, label: "legs" }, { n: hopsOnShortest, label: "hops, all legs" }]),
                { n: agentIds.length, label: agentIds.length === 1 ? "agent on the path" : "agents on the path" },
                { n: `${passed} / ${desk.tested.length}`, label: "plans passed / tested", tone: passed ? "good" : undefined },
                { n: desk.word.toLowerCase(), label: "status", tone: desk.tone === "accent" ? "good" : undefined },
              ]} />
              <section className="tldr">
                <Eyebrow>TL;DR</Eyebrow>
                <p>
                  <WithNames text={tldr(finding, c.flow)} names={c.names} cites={cites} onCite={(n) => { setPicked(byNumber.get(n) ?? null); setStep("path"); }} />
                </p>
                {finding.note && <p className="note">{finding.note}</p>}
                <p className="note">Put together from what the graph queries returned. No model wrote this brief. A footnote opens the path with that card lit.</p>
              </section>
              {next("rule", "the rule it broke")}
            </div>
          ) : step === "rule" ? (
            <div className="brief-inner">
              <Eyebrow>The rule</Eyebrow>
              <h1 className="brief-title">
                {finding.kind === "injection"
                  ? <>Check 1 <em>untrusted text reaches a high-impact action with no person in between.</em></>
                  : <>Check 2 <em>one agent holds untrusted input, private data and a way out.</em></>}
              </h1>
              <p className="claim-sub">
                {worst && <>{name(worst.agent_id)} holds {worst.count === 3 ? "all three" : worst.count ? words(worst.properties) : "none of the three"}. </>}
                {finding.kind === "trifecta"
                  ? "Whoever writes the untrusted text can ask for the private data to be sent out. That is the lethal trifecta, and all three properties of Meta's Rule of Two in one context."
                  : "Whoever writes the text can ask for the action. An injection path takes two of Meta's three properties: untrusted text reaches the agent, and the agent can act. Both are read from the flow layer, not from any run."}
              </p>
              <RuleNeeds finding={finding} paths={paths} cards={cards} c={c} />
              {finding.kind === "trifecta" && (c.scorecard ? (cards.length ? <RuleOfTwo cards={cards} c={c} /> : <Empty>No agent on this path is in the scorecard.</Empty>) : <Loading label="Reading the scorecard" />)}
              <Analysis finding={finding} cards={cards} c={c} />
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
                  {routes}
                  {switcher}
                  <a className="chart-link" href={href(scenario, "graph", finding.id)}>Open in the Explorer with this path lit →</a>
                </div>
                {c.flow ? (
                  <Chart renderer={renderer} layout={canvasLayout} graph={c.flow} names={c.names} focus={focus} only cites={cites}
                    picked={picked} onPick={setPicked} idle="Hover a card to read it. Click it to find it in the evidence." />
                ) : <Loading label="Reading the graph" />}
                <figcaption>
                </figcaption>
              </figure>
              {shown.map(({ label, path }) => (
                <Fold className="hops-fold" key={label} open summary={finding.kind === "injection" ? "Hop by hop" : label} sub={`${plural(path.rules.length, "hop", "hops")} · each with its rule and the config edge behind it`}>
                  <Hops path={path} c={c} />
                </Fold>
              ))}
              {!paths.length && <Empty>No evidence path was stored for this finding.</Empty>}
              {next("fix", "the fix")}
            </div>
          ) : step === "fix" ? (
            <div className="brief-inner">
              <Eyebrow>The fix</Eyebrow>
              <h1 className="brief-title">
                {reading ? <>{capital(recommendation(reading))} <em>{reading.status === "applied" ? "is applied." : reading.passed ? "passed its sandbox." : "failed its sandbox."}</em></> : desk.tone === "info" ? <>Testing fixes <em>in sandbox graphs.</em></> : <>No fix <em>has been tested yet.</em></>}
              </h1>
              {reading && (
                <p className="claim-sub">
                  <em className="voice"><WithNames text={capital(reading.summary.join(", and "))} names={c.names} />.</em>{" "}
                  {reading.passed ? verdictSentence(reading) : <WithNames text={`It did not pass: ${reading.reason ?? "the sandbox refused it"}.`} names={c.names} />}{" "}
                  {reading.id === desk.proposal?.id ? "It waits for your approval in the bar below: no tool can approve a change to the graph." : ""}
                </p>
              )}
              {reading && reading.id !== plan?.id && (
                <p className="rail-note reading-other">
                  You are reading a plan from the options, not the recommendation.{" "}
                  {plan && <button className="link" onClick={() => setOption(null)}>Back to the recommended plan</button>}
                </p>
              )}
              {reading && (
                <Figures items={[
                  { n: reading.resolved?.length ?? 0, label: reading.resolved?.length === 1 ? "finding resolved" : "findings resolved", tone: (reading.resolved?.length ?? 0) ? "good" : undefined },
                  { n: reading.introduced?.length ?? 0, label: "introduced", tone: (reading.introduced?.length ?? 0) ? "bad" : undefined },
                  // with no workflow declared the sandbox had nothing to check for breakage, and the figure says so
                  reading.unconstrained
                    ? { n: "unchecked", label: "workflows broken" }
                    : { n: reading.newly_broken?.length ?? 0, label: reading.newly_broken?.length === 1 ? "workflow broken" : "workflows broken", tone: (reading.newly_broken?.length ?? 0) ? "bad" : undefined },
                  { n: reading.cost, label: "cost" },
                  ...(reading.sandbox_ms != null ? [{ n: `${reading.sandbox_ms} ms`, label: "in the sandbox" }] : []),
                ]} />
              )}
              {reading ? (
                reading.status === "applied" ? <Applied plan={reading} run={c.run} c={c} /> : <Drafted plan={reading} c={c} aside={readingAside(reading)} />
              ) : (
                <Empty>
                  {canAudit ? <>No fix has been tested for this finding. <button className="link" onClick={c.startAudit} disabled={c.busy}>Run the audit</button> to try the candidate fixes on a sandbox copy of the graph.</> : desk.tone === "info" ? "The audit is testing candidate fixes now; the first that passes lands here." : `${desk.nextLabel}: ${desk.next}`}
                </Empty>
              )}
              {reading && reading.passed && c.flow && <PathAfter finding={finding} plan={reading} paths={shown} c={c} scenario={scenario} />}
              {desk.proposal && reading?.id === desk.proposal.id && (
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
              <p className="claim-sub">Every plan the search or the model asked a sandbox about, cheapest first: what each would close, open and break. Any of them can be read on the fix step.</p>
              <Tested finding={finding} desk={desk} c={c} scenario={scenario} onRead={(id) => { setOption(id); setStep("fix"); }} />
              <Fold summary="What an attacker would plant" sub={c.session?.model?.configured ? "the model rehearses the finding; nothing is sent anywhere" : "needs a model; none is configured here"}>
                <Rehearsal finding={finding} c={c} scenario={scenario} head={false} />
              </Fold>
            </div>
          )}
        </div>
        <Rail step={step} finding={finding} plan={step === "fix" ? reading : plan} desk={desk} cites={cites} picked={picked} onPick={setPicked} c={c} scenario={scenario} />
      </div>

      {deciding && (
        <ApprovalBar mitigation={desk.proposal!} names={c.names} busy={c.busy} scenario={scenario} canWrite={!!c.session?.can_write}
          onApprove={(who, write) => c.approve(desk.proposal!.id, who, write)} onReject={(who, why) => c.reject(desk.proposal!.id, who, why)} />
      )}
    </div>
  );
}
