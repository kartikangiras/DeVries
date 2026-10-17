// One finding, worked through in five steps, each answering one question nobody else answers: what is this
// (Summary), which rule fired and what satisfies it (Rule), hop by hop how the text travels (Path, the only step
// that draws the chart), what the recommended change is and whether you approve (Fix, the only step with the
// approval bar), and what else was tried (Options). The rail holds what the step at hand needs. The page is
// Manthan's case workspace (strip, brief, drafted actions, the rail, the approval bar), holding a finding
// instead of a case (see ui/THIRD_PARTY_NOTICES.md).

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { api, type Finding, type GraphLink, type Mitigation, type Path, type Preview, type RunWithSteps, type Scorecard } from "../api";
import { ApprovalBar } from "../ApprovalBar";
import { citations, headline, tldr, verdictSentence } from "../brief";
import { FIX_VERB, deskOf, exposure, isLive, patchText, recommendation, verdictLine, type Desk } from "../desk";
import { Chart, RendererSwitch, useRenderer } from "../graph/Chart";
import { KIND_OF, findingQueries, focusOf, hopKey, linkIndex, nodeFacts, nodeIndex, pathsOf, withReaders, type Series } from "../paths";
import { go, href } from "../route";
import type { DeVries } from "../state";
import { KIND_WORDS, WithNames, capital, clock, countWord, findingTitle, plural, short } from "../text";
import { Block, Button, Empty, Eyebrow, Figures, Fold, KV, Loading } from "../ui";

const two = (n: number) => String(n).padStart(2, "0");
type Step = "summary" | "rule" | "path" | "fix" | "options";
const STEPS: readonly Step[] = ["summary", "rule", "path", "fix", "options"];
const isStep = (s: string | null | undefined): s is Step => !!s && (STEPS as readonly string[]).includes(s);

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

/** The path in words: the abstraction of the chart, one mono line a route or a leg. */
function PathWords({ finding, paths, c }: { finding: Finding; paths: { label: string; path: Path }[]; c: DeVries }) {
  const name = (id: string) => c.names[id] ?? id;
  const SERIES: Series[] = ["hot", "private", "exit"];
  const LEG = ["untrusted in", "private in", "way out"];
  if (!paths.length) return null;
  return (
    <ol className="path-words" aria-label="The path in words">
      {paths.map(({ path }, i) => (
        <li key={i} className={`s-${finding.kind === "injection" ? "hot" : SERIES[i]}`}>
          {finding.kind === "trifecta" && <span className="leg">{LEG[i]}</span>}
          <span className="chain">
            {path.node_ids.map((id, j) => (
              <span key={id + j}>
                {j > 0 && <i className="arrow" aria-hidden>→</i>}
                <span className={id.startsWith("tool:") ? "code" : "name"} title={id}>{name(id)}</span>
              </span>
            ))}
          </span>
        </li>
      ))}
    </ol>
  );
}

type Card = Scorecard["agents"][number];
const PROPERTIES: { key: "A" | "B" | "C"; word: string; series: Series; of: (a: Card) => string[] }[] = [
  { key: "A", word: "untrusted input", series: "hot", of: (a) => a.untrusted_in },
  { key: "B", word: "private data", series: "private", of: (a) => a.private_in },
  { key: "C", word: "a way to act", series: "exit", of: (a) => a.acts_on },
];

/** What the rule needs, and what in this graph supplies each need: the rule's own checklist, with names. */
function RuleNeeds({ finding, paths, cards, c }: { finding: Finding; paths: { label: string; path: Path }[]; cards: Card[]; c: DeVries }) {
  const name = (id?: string | null) => (id ? c.names[id] ?? id : "?");
  const nodes = nodeIndex(c.flow);
  const live = linkIndex(c.flow);
  const hops = (p?: { path: Path }) => plural(p?.path.rules.length ?? 0, "hop", "hops");
  const gatedNow = paths.some(({ path }) => path.node_ids.some((id, i) => i < path.node_ids.length - 1 && live.get(hopKey(id, path.node_ids[i + 1]))?.rel === "GATED_FLOW"));
  let rows: { need: string; have: ReactNode; sub?: ReactNode }[];
  if (finding.kind === "injection") {
    const path = paths[0]?.path;
    const target = nodes.get(finding.target_id ?? "");
    const rules = [...new Set(path?.rules ?? [])];
    rows = [
      { need: "a source outsiders write", have: name(finding.source_id), sub: `trust: ${nodes.get(finding.source_id ?? "")?.data.trust ?? "untrusted"}` },
      { need: "a route over the flow layer", have: hops(paths[0]), sub: `${rules.length ? `rules ${rules.join(", ")}` : "no rule"}${(finding.paths_found ?? paths.length) > 1 ? ` · ${finding.paths_capped ? `${finding.paths_found} or more` : finding.paths_found ?? paths.length} routes` : ""}` },
      { need: "a high-impact action", have: name(finding.target_id), sub: `impact: ${target?.data.impact ?? "high"}${target?.data.external ? " · leaves the organisation" : ""}` },
      { need: "no person in between", have: gatedNow ? "a hop is gated now, so the path no longer holds" : `none of the ${countWord(path?.rules.length ?? 0)} hops is gated`, sub: "a gate on a call (rule 3) or a quarantine on a delegation (rule 6) would stop it" },
    ];
  } else {
    const card = cards.find((a) => a.agent_id === finding.agent_id);
    const unattended = card?.workflows.filter((w) => w.mode === "autonomous") ?? [];
    const leaves = (finding.exit_ids ?? []).some((id) => nodes.get(id)?.data.external);
    rows = [
      { need: "A · untrusted input reaches the agent", have: (finding.untrusted_ids ?? []).map((id) => name(id)).join(", "), sub: `in ${hops(paths[0])}` },
      { need: "B · private data reaches it", have: (finding.private_ids ?? []).map((id) => name(id)).join(", "), sub: `in ${hops(paths[1])}` },
      { need: "C · it can reach a way out", have: (finding.exit_ids ?? []).map((id) => name(id)).join(", "), sub: `in ${hops(paths[2])}${leaves ? " · leaves the organisation" : ""}` },
      {
        need: "nobody between it and the action",
        have: unattended.length ? `${unattended.map((w) => name(w.id)).join(", ")} ${unattended.length === 1 ? "runs" : "run"} unattended` : card?.workflows.length ? "its workflows are supervised" : "no workflow is declared",
        sub: unattended.length ? "by Meta's rule, an agent that holds all three must not run autonomously" : "supervision is the rule's minimum for an agent that holds all three",
      },
    ];
  }
  return (
    <Block className="needs" eyebrow="What the rule needs, and what this finding supplies" aside="each need, and the name that meets it">
      <ol className="rule-needs">
        {rows.map((row, i) => (
          <li key={i} className="met">
            <span className="need"><b>{two(i + 1)}</b>{row.need}</span>
            <span className="have">
              <WithNames text={String(row.have)} names={c.names} />
              {row.sub && <span className="sub">{row.sub}</span>}
            </span>
          </li>
        ))}
      </ol>
    </Block>
  );
}

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
    <Block className="analysis" eyebrow="What it means for a fix" aside="the workflows a fix must not break, and the class in OWASP's list">
      <ul className="analysis-rows">
        {workflows.map((w) => (
          <li key={w.id}>
            <strong>{w.name}</strong> is {w.mode === "autonomous" ? "an unattended" : "a supervised"} workflow that needs <WithNames text={w.needs.join(", ") || "no tool"} names={c.names} />
            {w.mode === "autonomous" ? ", so a gate on one of those breaks it: a fix has to go around it" : ", so a gate on one of those is a fix a person can live with"}.
          </li>
        ))}
        {!workflows.length && <li>No declared workflow runs through these agents, so nothing constrains the fix.</li>}
        {finding.taxonomy && finding.taxonomy.length > 0 && (
          <li>In the OWASP Top 10 for Agentic Applications it is {finding.taxonomy.map((t, i) => <span key={t.code}>{i > 0 && " and "}<strong>{t.code}</strong> {t.name}</span>)}.</li>
        )}
      </ul>
    </Block>
  );
}

/** The plan, change by change, each with the literal edit to the configuration. `aside` says where the plan stands. */
function Drafted({ plan, c, aside }: { plan: Mitigation; c: DeVries; aside: string }) {
  const n = plan.plan.fixes.length;
  return (
    <section className="block drafted">
      <div className="block-head">
        <Eyebrow>{plan.status === "approved" ? "Applying" : "The change"}</Eyebrow>
        <span>{plural(n, "change", "changes")} · {aside}</span>
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
          : plan.source === "cut"
            ? <>Proposed from the cheapest cut, by max flow, then verified in a sandbox like any other plan.</>
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

/** The path as the plan leaves it, hop by hop, read from a sandbox copy with the plan applied (or from the graph once
 *  it is applied): what each hop reads before, and what it reads after. A sandbox answer, without a chart. */
function PathAfter({ finding, plan, paths, c, scenario }: { finding: Finding; plan: Mitigation; paths: { label: string; path: Path }[]; c: DeVries; scenario: string }) {
  const [shown, setShown] = useState<{ preview?: Preview; error?: string } | null>(null);
  const stamp = `${plan.id}/${plan.status}/${c.configHash}`;      // ask again when the plan or the config has moved
  useEffect(() => {
    let wanted = true;
    setShown(null);
    api.preview(scenario, plan.id)
      .then((preview) => wanted && setShown({ preview }))
      .catch((e) => wanted && setShown({ error: e instanceof Error ? e.message : "The preview could not be made." }));
    return () => {
      wanted = false;
    };
  }, [scenario, stamp]); // the plan itself is read through its id: `stamp` says when to ask again
  const name = (id: string) => c.names[id] ?? id;
  const before = linkIndex(c.flow);
  const beforeNodes = nodeIndex(c.flow);
  const preview = shown?.preview;
  const after = new Map<string, GraphLink>((preview?.links ?? []).map((l) => [hopKey(l.data.from_id, l.data.to_id), l]));
  const afterNodes = new Map((preview?.nodes ?? []).map((n) => [n.data.id, n]));
  const readers = plan.plan.fixes.filter((f) => f.kind === "split_agent").map((f) => `${f.agent_id}.reader`).filter((id) => afterNodes.has(id));
  const applied = !!preview?.applied;

  const change = (a: string, b: string): { text: string; changed: boolean } => {
    const was = before.get(hopKey(a, b));
    const now = after.get(hopKey(a, b));
    if (!now) return { text: applied ? "gone: the grant is revoked" : "gone: the plan revokes the grant behind it", changed: true };
    if (now.rel === "GATED_FLOW" && was?.rel !== "GATED_FLOW") {
      return { text: now.data.gate === "quarantine" ? "quarantined: only structured fields come back" : "gated: a person approves each call", changed: true };
    }
    const wasTainted = !!beforeNodes.get(b)?.data.tainted;
    const nowTainted = !!afterNodes.get(b)?.data.tainted;
    if (wasTainted && !nowTainted) return { text: `untrusted text no longer reaches ${name(b)}`, changed: true };
    if (now.rel === "GATED_FLOW") return { text: "still gated", changed: false };
    return { text: "unchanged", changed: false };
  };
  return (
    <Block className="path-after" eyebrow={applied ? "The path, as it stands" : "The path, after"} aside={applied ? "the graph as it stands, with the plan applied" : "read from a sandbox copy with the plan applied, since deleted"}>
      {preview ? (
        <>
          {paths.map(({ label, path }, k) => (
            <ol className="steps hops hops-after" key={k} aria-label={label}>
              {finding.kind === "trifecta" && <li className="hops-after-label"><span /><span className="col">{label}</span><span /></li>}
              {path.hops.map((hop, i) => {
                const [, ...rest] = hop.split(": ");
                const diff = change(path.node_ids[i], path.node_ids[i + 1]);
                return (
                  <li key={i} className={diff.changed ? "changed" : ""}>
                    <span className="num">{two(i + 1)}.</span>
                    <p className="was"><WithNames text={rest.join(": ")} names={c.names} /></p>
                    <p className="now">{diff.text}</p>
                  </li>
                );
              })}
            </ol>
          ))}
          <p className="chart-note">
            Left, each hop as the finding found it; right, what the sandbox says about it with the plan applied.
            {readers.length > 0 && <> The reader the split adds, <WithNames text={readers.join(", ")} names={c.names} />, does the reading now; what it returns is quarantined.</>}
            {" "}Nothing in the scenario has changed{applied ? " since the plan was applied" : ""}.
          </p>
        </>
      ) : shown?.error ? <p className="rail-note">{shown.error}</p> : <Loading label="Asking a sandbox" />}
    </Block>
  );
}

/** Every plan a sandbox was asked about for this finding, cheapest first, as one chart: its cost as a bar, what it
 *  did to each finding that was open as a cell, what it would open and break as counts; under each row, the verdict
 *  in words. Any plan can be read on the Fix step. */
function Tested({ finding, desk, c, scenario, onRead }: { finding: Finding; desk: Desk; c: DeVries; scenario: string; onRead: (id: string) => void }) {
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
                {recommended ? " · the recommendation" : <> · <button className="link" onClick={() => onRead(m.id)}>read it on the fix step</button></>}
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

const SOURCE: Record<string, string> = { scripted: "the scripted search", agent: "the model", search: "a search asked for here", cut: "the cheapest cut" };

/** The rail holds what the step at hand needs and nothing from the others: the finding's facts beside the summary,
 *  the three properties beside the rule, the evidence beside the path, the plan's facts beside the fix, the
 *  decisions and the run beside the options. */
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
        {c.run.usage.cost_usd > 0 && <KV k="Model cost">${c.run.usage.cost_usd.toFixed(3)}</KV>}
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
              {findingQueries(finding).map((q, i) => <span key={q}>{i > 0 && ", "}<a href={href(scenario, "method", "queries", q)}>{q}</a></span>)}
            </p>
          </section>
        </aside>
      </div>
    </div>
  );
}

export function FindingPage({ c, scenario, finding, step }: { c: DeVries; scenario: string; finding: Finding; step: string | null }) {
  if (finding.kind === "drift" || finding.kind === "poisoned_description") return <StandingPage c={c} scenario={scenario} finding={finding} />;
  return <FindingBody c={c} scenario={scenario} finding={finding} step={isStep(step) ? step : "summary"} />;
}

function FindingBody({ c, scenario, finding, step }: { c: DeVries; scenario: string; finding: Finding; step: Step }) {
  const [renderer, setRenderer] = useRenderer();
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
    { id: "rule", n: "2", label: "Rule", sub: finding.kind === "injection" ? "rule 1 · an injection path" : "rule 2 · a trifecta" },
    { id: "path", n: "3", label: "Path", sub: "how the text travels" },
    { id: "fix", n: "4", label: "Fix", sub: desk.applied ? "applied" : desk.proposal ? "awaiting your approval" : desk.tone === "info" ? "being tested" : "none yet" },
    { id: "options", n: "5", label: "Options", sub: `${plural(desk.tested.length, "plan", "plans")} tested` },
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
                  ? <>Rule 1 <em>untrusted text reaches a high-impact action with no person in between.</em></>
                  : <>Rule 2 <em>one agent holds untrusted input, private data and a way out.</em></>}
              </h1>
              <p className="claim-sub">
                {worst && <>{name(worst.agent_id)} holds {worst.count === 3 ? "all three" : worst.count ? words(worst.properties) : "none of the three"}. </>}
                {finding.kind === "trifecta"
                  ? "Whoever writes the untrusted text can ask for the private data to be sent out. That is the lethal trifecta, and all three properties of Meta's Rule of Two in one context."
                  : "Whoever writes the text can ask for the action. Two of Meta's three properties, in the pair that makes an injection path; the rule is read off the flow layer, not off any run."}
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
                {reading ? <>{recommendation(reading)} <em>{reading.status === "applied" ? "is applied." : reading.passed ? "passed its sandbox." : "failed its sandbox."}</em></> : desk.tone === "info" ? <>Testing fixes <em>in sandbox graphs.</em></> : <>No fix <em>has been tested yet.</em></>}
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
                  { n: reading.newly_broken?.length ?? 0, label: reading.newly_broken?.length === 1 ? "workflow broken" : "workflows broken", tone: (reading.newly_broken?.length ?? 0) ? "bad" : undefined },
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
