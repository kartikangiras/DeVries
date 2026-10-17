// Where the visitor is. Routes live in the hash, so the app is one static page behind any server.
//
//   #/acme_support                      the posture of the scenario: the analytics, where the risk is
//   #/acme_support/inbox                the open findings
//   #/acme_support/done                 the closed ones
//   #/acme_support/finding/fnd:…[/step] one finding: summary, rule, path, fix, options; the step is the fourth part
//   #/acme_support/graph[/id]           the explorer: the whole system on either renderer, a node or a finding's path lit
//   #/acme_support/inventory[/kind]     every agent, tool, source, resource and server, with what it reaches
//   #/acme_support/audit[/run:…]        activity: scans, runs, proposals, decisions and writes, in order
//   #/acme_support/queries[/name]       the Cypher behind all of it, as a drawer over the page
//   #/acme_support/import               paste a config or a tools/list and audit your own
//
// Older addresses keep working: fixes/mit:… lands on the plan's finding, whatif on the explorer, servers on the
// inventory's servers tab. The nav groups the places: Posture · Findings (Open, Closed) · System (Explorer,
// Inventory, Queries) · Record (Activity, Import).

export const PAGES = ["posture", "inbox", "done", "finding", "fixes", "whatif", "graph", "inventory", "servers", "audit", "queries", "import"] as const;
export type Page = (typeof PAGES)[number];
export type Route = { scenario: string | null; page: Page; id: string | null; sub: string | null };

export function readRoute(): Route {
  const [scenario, page, id, sub] = window.location.hash.replace(/^#\/?/, "").split("/").map(decodeURIComponent);
  const known = (PAGES as readonly string[]).includes(page) ? (page as Page) : "posture";
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
