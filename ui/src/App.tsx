import { useEffect, useState } from "react";
import { ActivityPage } from "./pages/Activity";
import { FindingPage } from "./pages/FindingPage";
import { ExplorerPage } from "./pages/GraphPage";
import { ImportPage } from "./pages/Import";
import { Inbox } from "./pages/Inbox";
import { MethodPage } from "./pages/Method";
import { PosturePage } from "./pages/Posture";
import { Landing } from "./landing/Landing";
import { go, href, readRoute } from "./route";
import { Shell } from "./Shell";
import { useDeVries } from "./state";
import { Empty, Loading, PageBody } from "./ui";

const PLACE: Record<string, string> = {
  posture: "Posture", inbox: "Open", done: "Closed", finding: "Finding", fixes: "Activity", whatif: "Explorer", graph: "Explorer", inventory: "Explorer", servers: "Explorer",
  audit: "Activity", queries: "Method", method: "Method", import: "Import",
};

export default function App() {
  const [route, setRoute] = useState(readRoute);
  useEffect(() => {
    const onHash = () => setRoute(readRoute());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const c = useDeVries(route.scenario);
  const { scenario, page, id, sub } = route;

  useEffect(() => {
    document.title = scenario ? `${PLACE[page]} · ${c.titleOf(scenario)} · DeVries` : "DeVries";
  }, [page, scenario, c.titleOf]);

  // older addresses land where their content now lives: a plan on its finding's fix step, what-ifs in the
  // explorer's reader, the inventory and the servers in the explorer's tables, the queries on the method page
  useEffect(() => {
    if (!scenario) return;
    if (page === "fixes") {
      const plan = id ? c.mitigations[id] : undefined;
      if (id && !plan && !c.findings) return;             // the plans are still loading
      if (plan?.targets[0]) go(scenario, "finding", plan.targets[0], "fix");
      else go(scenario, "audit");
    } else if (page === "whatif") go(scenario, "graph");
    else if (page === "servers") go(scenario, "graph", "tables", "servers");
    else if (page === "inventory") go(scenario, "graph", "tables", id);
    else if (page === "queries") go(scenario, "method", "queries", id);
  }, [page, id, scenario, c.mitigations, c.findings]);

  // a bare address is the landing page; the app starts at a scenario
  if (!scenario) return <Landing scenarios={c.scenarios} />;

  const all = c.findings ? [...c.findings.findings, ...c.findings.past] : [];
  const selected = page === "finding" && id ? all.find((f) => f.id === id) ?? null : null;

  return (
    <Shell c={c} route={route} closed={!!selected && selected.status !== "open"}>
      {page === "finding" ? (
        selected ? <FindingPage c={c} scenario={scenario} finding={selected} step={sub} /> : (
          <PageBody>
            {c.findings ? <Empty>No finding {id} in this scenario. <a href={href(scenario, "inbox")}>Back to the open findings</a>.</Empty> : <Loading label="Reading the graph" />}
          </PageBody>
        )
      ) : page === "done" ? (
        <Inbox c={c} scenario={scenario} done />
      ) : page === "inbox" ? (
        <Inbox c={c} scenario={scenario} />
      ) : page === "graph" ? (
        <ExplorerPage c={c} scenario={scenario} id={id} sub={sub} />
      ) : page === "method" ? (
        <MethodPage c={c} scenario={scenario} section={id} query={sub} />
      ) : page === "audit" ? (
        <ActivityPage c={c} scenario={scenario} runId={id} />
      ) : page === "import" ? (
        <ImportPage c={c} scenario={scenario} />
      ) : page === "fixes" || page === "whatif" || page === "servers" || page === "inventory" || page === "queries" ? (
        <PageBody><Loading label="Taking you to where this now lives" /></PageBody>
      ) : (
        <PosturePage c={c} scenario={scenario} />
      )}
    </Shell>
  );
}
