// Where the visitor is. Routes live in the hash, so the app is one static page behind any server.
//
//   #/acme_support                        the posture of the scenario: the analytics, where the risk is
//   #/acme_support/open                   the open findings
//   #/acme_support/closed                 the closed ones
//   #/acme_support/finding/fnd:…[/step]   one finding: summary, rule, path, fix, options; the step is the fourth part
//   #/acme_support/explorer[/id]          the explorer: the whole system on either renderer, a node or a finding's path lit
//   #/acme_support/explorer/tables[/kind] the same system as tables: agents, tools, sources, resources, servers
//   #/acme_support/method[/section]       how DeVries decides: the rules, the flow layer, the fixes, the analytics
//   #/acme_support/method/queries[/name]  every Cypher statement, by name
//   #/acme_support/activity[/run:…]       activity: scans, runs, proposals, decisions and writes, in order
//   #/acme_support/import                 paste a config or a tools/list and audit your own
//
// The address says what the nav says. The pages keep their first names in the code (inbox, done, graph, audit), and
// those spellings still parse as the same pages. Older addresses keep working too: fixes/mit:… lands on the plan's
// finding, whatif on the explorer, inventory and servers on the explorer's tables, queries on the method page. The
// nav is three groups: Findings (Posture, Open, Closed) · System (Explorer, Method) · Record (Activity, Import).

/** The front door of the app, every scenario as a card: it sits where a scenario name would, so no scenario may take this name. */
export const CATALOG = "scenarios";
/** The scenario the front door puts first and Enter opens: the dev team, whose eleven-hop path is the fullest story. */
export const RECOMMENDED = "acme_dev";

export const PAGES = ["posture", "inbox", "done", "finding", "graph", "audit", "method", "import"] as const;
export type Page = (typeof PAGES)[number];
/** What the address bar shows for each page: the nav's word for it. */
const SLUG: Record<Page, string> = { posture: "posture", inbox: "open", done: "closed", finding: "finding", graph: "explorer", audit: "activity", method: "method", import: "import" };
/** The page an address names: by its slug, or by the page's own name, which the first addresses used. */
const pageOf = (part: string): Page | null =>
  (PAGES as readonly string[]).includes(part) ? (part as Page) : ((Object.keys(SLUG) as Page[]).find((p) => SLUG[p] === part) ?? null);
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
  const known: Page | Old = pageOf(page) ?? (isOld(page) ? page : "posture");
  return { scenario: scenario || null, page: known, id: id || null, sub: sub || null };
}

export function href(scenario: string | null, page: Page = "posture", id?: string | null, sub?: string | null): string {
  const parts = [scenario, page === "posture" ? null : SLUG[page], page === "posture" ? null : id, page === "posture" ? null : sub].filter((p): p is string => !!p);
  return "#/" + parts.map(encodeURIComponent).join("/");
}

export function go(scenario: string | null, page: Page = "posture", id?: string | null, sub?: string | null) {
  const hash = href(scenario, page, id, sub);
  if (window.location.hash !== hash) window.location.hash = hash;
}
