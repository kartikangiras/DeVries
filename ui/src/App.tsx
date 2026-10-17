import { useEffect, useRef, useState } from "react";
import { ActivityPage } from "./pages/Activity";
import { FindingPage } from "./pages/FindingPage";
import { ExplorerPage } from "./pages/GraphPage";
import { ImportPage } from "./pages/Import";
import { Inbox } from "./pages/Inbox";
import { InventoryPage } from "./pages/Inventory";
import { PosturePage } from "./pages/Posture";
import { QueryDrawer } from "./pages/Queries";
import { Landing } from "./landing/Landing";
import { go, href, readRoute, type Route } from "./route";
import { Shell } from "./Shell";
import { useDeVries } from "./state";
import { Empty, Loading, PageBody } from "./ui";

const PLACE: Record<string, string> = {
  posture: "Posture", inbox: "Open", done: "Closed", finding: "Finding", fixes: "Activity", whatif: "Explorer", graph: "Explorer", inventory: "Inventory", servers: "Inventory",
  audit: "Activity", queries: "Queries", import: "Import",
};

export default function App() {
  const [route, setRoute] = useState(readRoute);
  // the queries drawer lies over the page the visitor came from; a deep link to a query lands on the inbox
  const under = useRef<Route>({ scenario: route.scenario, page: "posture", id: null, sub: null });
  useEffect(() => {
    const onHash = () => setRoute(readRoute());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  if (route.page !== "queries") under.current = route;
  else if (under.current.scenario !== route.scenario) under.current = { scenario: route.scenario, page: "posture", id: null, sub: null };

  const c = useDeVries(route.scenario);
  const { scenario, page, id } = route;
  const shown = page === "queries" ? under.current : route;

  useEffect(() => {
    document.title = scenario ? `${PLACE[page]} · ${c.titleOf(scenario)} · DeVries` : "DeVries";
  }, [page, scenario, c.titleOf]);

  // older addresses land where their content now lives: a plan on its finding's fix step, what-ifs in the
  // explorer's reader, the servers in the inventory
  useEffect(() => {
    if (!scenario) return;
    if (page === "fixes") {
      const plan = id ? c.mitigations[id] : undefined;
      if (id && !plan && !c.findings) return;             // the plans are still loading
      if (plan?.targets[0]) go(scenario, "finding", plan.targets[0], "fix");
      else go(scenario, "audit");
    } else if (page === "whatif") go(scenario, "graph");
    else if (page === "servers") go(scenario, "inventory", "servers");
  }, [page, id, scenario, c.mitigations, c.findings]);

  // a bare address is the landing page; the app starts at a scenario
  if (!scenario) return <Landing scenarios={c.scenarios} />;

  const all = c.findings ? [...c.findings.findings, ...c.findings.past] : [];
  const selected = shown.page === "finding" && shown.id ? all.find((f) => f.id === shown.id) ?? null : null;

  return (
    <Shell c={c} route={shown} closed={!!selected && selected.status !== "open"} queriesOpen={page === "queries"}>
      {shown.page === "finding" ? (
        selected ? <FindingPage c={c} scenario={scenario} finding={selected} step={shown.sub} /> : (
          <PageBody>
            {c.findings ? <Empty>No finding {shown.id} in this scenario. <a href={href(scenario, "inbox")}>Back to the open findings</a>.</Empty> : <Loading label="Reading the graph" />}
          </PageBody>
        )
      ) : shown.page === "done" ? (
        <Inbox c={c} scenario={scenario} done />
      ) : shown.page === "inbox" ? (
        <Inbox c={c} scenario={scenario} />
      ) : shown.page === "graph" ? (
        <ExplorerPage c={c} scenario={scenario} id={shown.id} />
      ) : shown.page === "inventory" ? (
        <InventoryPage c={c} scenario={scenario} kind={shown.id} />
      ) : shown.page === "audit" ? (
        <ActivityPage c={c} scenario={scenario} runId={shown.id} />
      ) : shown.page === "import" ? (
        <ImportPage c={c} scenario={scenario} />
      ) : shown.page === "fixes" || shown.page === "whatif" || shown.page === "servers" ? (
        <PageBody><Loading label="Taking you to where this now lives" /></PageBody>
      ) : (
        <PosturePage c={c} scenario={scenario} />
      )}
      {page === "queries" && <QueryDrawer c={c} scenario={scenario} name={id} back={under.current} />}
    </Shell>
  );
}
