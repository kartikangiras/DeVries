// The one picture: untrusted sources on the left, the agents they reach in the middle, the high-impact
// actions those agents can take on the right, and only the open paths drawn between them, as ribbons
// whose width is the number of routes. Everything else folds into a count under each column. The
// drawing follows what the attack-path tools agree on: show the open routes, anchor them to the real
// things, colour by what is at stake, and leave the detail for a click.

import type { Overview } from "../api";

/** The counts strip above the picture: what the scenario holds, in figures. */
export function OverviewCounts({ view }: { view: Overview }) {
  const c = view.counts;
  const cells: [string, string | number][] = [
    ["untrusted sources", c.untrusted_sources], ["private sources", c.private_sources], ["agents", c.agents], ["tools", c.tools],
    ["high-impact actions", c.high_resources], ["leave the org", c.external_resources], ["workflows to keep", c.workflows],
    ["open findings", c.open_findings], ["cheapest cut", c.cut_cost ?? "—"],
  ];
  return (
    <dl className="ov-counts">
      {cells.map(([label, n]) => (
        <div key={label} className={label === "open findings" && Number(n) > 0 ? "hot" : ""}>
          <dd>{n}</dd>
          <dt>{label}</dt>
        </div>
      ))}
    </dl>
  );
}
