// Where the visitor is. Routes live in the hash, so the app is one static page behind any server.
//
//   #/acme_support                      the posture of the scenario: the analytics, where the risk is
//   #/acme_support/inbox                the open findings
//   #/acme_support/done                 the closed ones
//   #/acme_support/finding/fnd:…[/step] one finding: summary, rule, path, fix, options; the step is the fourth part
//   #/acme_support/graph[/id]           the explorer: the whole system on either renderer, a node or a finding's path lit
//   #/acme_support/graph/tables[/kind]  the same system as tables: agents, tools, sources, resources, servers
//   #/acme_support/method[/section]     how DeVries decides: the rules, the flow layer, the fixes, the analytics
//   #/acme_support/method/queries[/name] every Cypher statement, by name
//   #/acme_support/audit[/run:…]        activity: scans, runs, proposals, decisions and writes, in order
//   #/acme_support/import               paste a config or a tools/list and audit your own
//
// Older addresses keep working: fixes/mit:… lands on the plan's finding, whatif on the explorer, inventory and
// servers on the explorer's tables, queries on the method page. The nav is three groups: Findings (Posture, Open,
// Closed) · System (Explorer, Method) · Record (Activity, Import).

export const PAGES = ["posture", "inbox", "done", "finding", "graph", "audit", "method", "import"] as const;
export type Page = (typeof PAGES)[number];
/** The older addresses, each of which still lands somewhere. */
const OLD = ["fixes", "whatif", "inventory", "servers", "queries"] as const;
type Old = (typeof OLD)[number];
export type Route = { scenario: string | null; page: Page | Old; id: string | null; sub: string | null };

/** An older address: the nav row it belongs to, and where it lands now. A plan's address lands on its finding, so it needs the plan. */
type Legacy = { place: Page; to: (id: string | null, plan?: { targets: string[] } | null) => [Page, string | null, string | null] };
const LEGACY: Record<Old, Legacy> = {
  fixes: { place: "audit", to: (_, plan) => (plan?.targets[0] ? ["finding", plan.targets[0], "fix"] : ["audit", null, null]) },
  whatif: { place: "graph", to: () => ["graph", null, null] },
  inventory: { place: "graph", to: (id) => ["graph", "tables", id] },
  servers: { place: "graph", to: () => ["graph", "tables", "servers"] },
  queries: { place: "method", to: (id) => ["method", "queries", id] },
};
const isOld = (page: string): page is Old => (OLD as readonly string[]).includes(page);
/** Where an older address lands, or null for a page that is live. */
export const legacyOf = (page: Page | Old): Legacy | null => (isOld(page) ? LEGACY[page] : null);

/** The nav row a route belongs to: a finding belongs to the list it is in, an older address to the row it lands on. */
export function placeOf(route: Route, closed: boolean): Page {
  if (route.page === "finding") return closed ? "done" : "inbox";
  return isOld(route.page) ? LEGACY[route.page].place : route.page;
}

export function readRoute(): Route {
  const [scenario, page, id, sub] = window.location.hash.replace(/^#\/?/, "").split("/").map(decodeURIComponent);
  const known = (PAGES as readonly string[]).includes(page) || isOld(page) ? (page as Page | Old) : "posture";
  return { scenario: scenario || null, page: known, id: id || null, sub: sub || null };
}

export function href(scenario: string | null, page: Page = "posture", id?: string | null, sub?: string | null): string {
  const parts = [scenario, page === "posture" ? null : page, page === "posture" ? null : id, page === "posture" ? null : sub].filter((p): p is string => !!p);
  return "#/" + parts.map(encodeURIComponent).join("/");
}

export function go(scenario: string | null, page: Page = "posture", id?: string | null, sub?: string | null) {
  const hash = href(scenario, page, id, sub);
  if (window.location.hash !== hash) window.location.hash = hash;
}
