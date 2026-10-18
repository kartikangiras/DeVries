import { useEffect, useState } from "react";
import type { Page } from "./route";
import { ActivityPage } from "./pages/Activity";
import { FindingPage } from "./pages/FindingPage";
import { ExplorerPage } from "./pages/Explorer";
import { ImportPage } from "./pages/Import";
import { Inbox } from "./pages/Inbox";
import { MethodPage } from "./pages/Method";
import { PosturePage } from "./pages/Posture";
import { Landing } from "./landing/Landing";
import { CatalogPage } from "./pages/Catalog";
import { CATALOG, go, href, legacyOf, placeOf, readRoute } from "./route";
import { Shell } from "./Shell";
import { useDeVries } from "./state";
import { Empty, Loading, PageBody } from "./ui";

/** The window's title for each place; an older address takes the title of the row it lands on (route.ts, LEGACY). */
const PLACE: Partial<Record<Page, string>> = { posture: "Posture", inbox: "Open", done: "Closed", finding: "Finding", graph: "Explorer", method: "Method", audit: "Activity", import: "Import" };

export default function App() {
  const [route, setRoute] = useState(readRoute);
  useEffect(() => {
    const onHash = () => setRoute(readRoute());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const atFront = route.scenario === CATALOG;
  const c = useDeVries(atFront ? null : route.scenario);
  const { scenario, page, id, sub } = route;

  useEffect(() => {
    document.title = atFront ? "Scenarios · DeVries" : scenario ? `${PLACE[placeOf(route, false)] ?? "DeVries"} · ${c.titleOf(scenario)} · DeVries` : "DeVries";
  }, [route, scenario, atFront, c.titleOf]);

  // older addresses land where their content now lives (route.ts, LEGACY); a plan's address waits for the plans to load
  useEffect(() => {
    if (!scenario || atFront) return;
    const legacy = legacyOf(page);
    if (!legacy) return;
    const plan = id ? c.mitigations[id] : undefined;
    if (page === "fixes" && id && !plan && !c.findings) return;
    go(scenario, ...legacy.to(id, plan));
  }, [page, id, scenario, atFront, c.mitigations, c.findings]);

  // a bare address is the landing page; the app opens on its front door, every scenario as a card, or at a scenario
  if (!scenario) return <Landing scenarios={c.scenarios} queries={c.catalog.length} about={c.about} />;
  if (atFront) return <CatalogPage c={c} />;

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
      ) : legacyOf(page) ? (
        <PageBody><Loading label="Taking you to where this now lives" /></PageBody>
      ) : (
        <PosturePage c={c} scenario={scenario} />
      )}
    </Shell>
  );
}
