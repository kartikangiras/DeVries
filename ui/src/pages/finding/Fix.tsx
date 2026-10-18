// The Fix step's blocks: the plan change by change, what happened once it was applied, and the path as the plan leaves it.

import { useEffect, useState } from "react";
import { api, type Finding, type GraphLink, type Mitigation, type Path, type Preview, type RunWithSteps } from "../../api";
import { FIX_VERB, patchText } from "../../desk";
import { hopKey, linkIndex, nodeIndex } from "../../paths";
import type { DeVries } from "../../state";
import { WithNames, capital, clock, plural } from "../../text";
import { Block, Eyebrow, Loading } from "../../ui";
import { two } from "./shared";

/** The plan, change by change, each with the literal edit to the configuration. `aside` says where the plan stands. */
export function Drafted({ plan, c, aside }: { plan: Mitigation; c: DeVries; aside: string }) {
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
export function Applied({ plan, run, c }: { plan: Mitigation; run: RunWithSteps | null; c: DeVries }) {
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
export function PathAfter({ finding, plan, paths, c, scenario }: { finding: Finding; plan: Mitigation; paths: { label: string; path: Path }[]; c: DeVries; scenario: string }) {
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
    <Block className="path-after" eyebrow={applied ? "The path, as it stands" : "The path, after"} aside={applied ? "the graph as it stands, with the plan applied" : "read from a sandbox copy with the plan applied; the copy has since been deleted"}>
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
