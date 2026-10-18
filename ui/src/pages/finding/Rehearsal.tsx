// What an attacker would plant: the model's rehearsal of the finding, asked for from the Options step.

import { api, type Finding } from "../../api";
import { href } from "../../route";
import type { DeVries } from "../../state";
import { WithNames } from "../../text";
import { Eyebrow, Loading } from "../../ui";

/** What an attacker would plant: the model's rehearsal of the finding, asked for from here and answered as a question run. */
export function Rehearsal({ finding, c, scenario, head = true }: { finding: Finding; c: DeVries; scenario: string; head?: boolean }) {
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
