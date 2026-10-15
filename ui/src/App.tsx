import { useEffect, useRef, useState } from "react";
import { Audit } from "./pages/Audit";
import { FindingPage } from "./pages/FindingPage";
import { Fixes } from "./pages/Fixes";
import { GraphPage } from "./pages/GraphPage";
import { ImportPage } from "./pages/Import";
import { Inbox } from "./pages/Inbox";
import { QueryDrawer } from "./pages/Queries";
import { ServersPage } from "./pages/Servers";
import { WhatIfPage } from "./pages/WhatIf";
import { Landing } from "./landing/Landing";
import { href, readRoute, type Route } from "./route";
import { Shell } from "./Shell";
import { useDeVries } from "./state";
import { Empty, Loading, PageBody } from "./ui";

const PLACE: Record<string, string> = {
  inbox: "Inbox", done: "Done", finding: "Finding", fixes: "Fixes", whatif: "What if", graph: "Graph", servers: "Servers", audit: "Audit", queries: "Queries", import: "Import",
};

export default function App() {
  const [route, setRoute] = useState(readRoute);
  // the queries drawer lies over the page the visitor came from; a deep link to a query lands on the inbox
  const under = useRef<Route>({ scenario: route.scenario, page: "inbox", id: null });
  useEffect(() => {
    const onHash = () => setRoute(readRoute());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  if (route.page !== "queries") under.current = route;
  else if (under.current.scenario !== route.scenario) under.current = { scenario: route.scenario, page: "inbox", id: null };

  const c = useDeVries(route.scenario);
  const { scenario, page, id } = route;
  const shown = page === "queries" ? under.current : route;

  useEffect(() => {
    document.title = scenario ? `${PLACE[page]} · ${c.titleOf(scenario)} · DeVries` : "DeVries";
  }, [page, scenario, c.titleOf]);

  // a bare address is the landing page; the app starts at a scenario
  if (!scenario) return <Landing scenarios={c.scenarios} />;

  const all = c.findings ? [...c.findings.findings, ...c.findings.past] : [];
  const selected = shown.page === "finding" && shown.id ? all.find((f) => f.id === shown.id) ?? null : null;

  return (
    <Shell c={c} route={shown} closed={!!selected && selected.status !== "open"} queriesOpen={page === "queries"}>
      {shown.page === "finding" ? (
        selected ? <FindingPage c={c} scenario={scenario} finding={selected} /> : (
          <PageBody>
            {c.findings ? <Empty>No finding {shown.id} in this scenario. <a href={href(scenario)}>Back to the inbox</a>.</Empty> : <Loading label="Reading the graph" />}
          </PageBody>
        )
      ) : shown.page === "done" ? (
        <Inbox c={c} scenario={scenario} done />
      ) : shown.page === "fixes" ? (
        <Fixes c={c} scenario={scenario} selectedId={shown.id} />
      ) : shown.page === "whatif" ? (
        <WhatIfPage c={c} scenario={scenario} />
      ) : shown.page === "graph" ? (
        <GraphPage c={c} scenario={scenario} />
      ) : shown.page === "servers" ? (
        <ServersPage c={c} scenario={scenario} />
      ) : shown.page === "audit" ? (
        <Audit c={c} scenario={scenario} runId={shown.id} />
      ) : shown.page === "import" ? (
        <ImportPage c={c} scenario={scenario} />
      ) : (
        <Inbox c={c} scenario={scenario} />
      )}
      {page === "queries" && <QueryDrawer c={c} scenario={scenario} name={id} back={under.current} />}
    </Shell>
  );
}
