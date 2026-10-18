// The path, two ways: hop by hop with the rule and the config edge behind each, and in words as one mono line a route.

import type { Finding, Path } from "../../api";
import { cutBy } from "../../desk";
import { hopKey, linkIndex, type Series } from "../../paths";
import type { DeVries } from "../../state";
import { WithNames } from "../../text";
import { two } from "./shared";

/** Hop by hop: the rule that derived each one, the config edge behind it, and whether a fix can cut it. */
export function Hops({ path, c }: { path: Path; c: DeVries }) {
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
                      <span className="cut">{cutBy(fixes)}</span>
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
export function PathWords({ finding, paths, c }: { finding: Finding; paths: { label: string; path: Path }[]; c: DeVries }) {
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
