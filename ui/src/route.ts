// Where the visitor is. Routes live in the hash, so the app is one static page behind any server.
//
//   #/acme_support                      the open findings
//   #/acme_support/done                 the closed ones
//   #/acme_support/finding/fnd:…        one finding: the problem, the fix, the options, the trace
//   #/acme_support/fixes[/mit:…]        every plan that was tested
//   #/acme_support/whatif               a change tested in a sandbox, and the cheapest cut as rules
//   #/acme_support/graph                the whole system, on either renderer
//   #/acme_support/servers              the MCP servers behind the tools
//   #/acme_support/audit[/run:…]        what the auditor did
//   #/acme_support/queries[/name]       the Cypher behind all of it, as a drawer over the page
//   #/acme_support/import               paste a config or a tools/list and audit your own
//
// The nav groups them: Findings (Open, Closed), Fixes (Ledger, What if), System (Graph, Servers, Queries),
// Audit (Runs, Import). The addresses keep their old words (inbox, done), so links in the README and the tests survive.

export const PAGES = ["inbox", "done", "finding", "fixes", "whatif", "graph", "servers", "audit", "queries", "import"] as const;
export type Page = (typeof PAGES)[number];
export type Route = { scenario: string | null; page: Page; id: string | null };

export function readRoute(): Route {
  const [scenario, page, id] = window.location.hash.replace(/^#\/?/, "").split("/").map(decodeURIComponent);
  const known = (PAGES as readonly string[]).includes(page) ? (page as Page) : "inbox";
  return { scenario: scenario || null, page: known, id: id || null };
}

export function href(scenario: string | null, page: Page = "inbox", id?: string | null): string {
  const parts = [scenario, page === "inbox" ? null : page, page === "inbox" ? null : id].filter((p): p is string => !!p);
  return "#/" + parts.map(encodeURIComponent).join("/");
}

export function go(scenario: string | null, page: Page = "inbox", id?: string | null) {
  const hash = href(scenario, page, id);
  if (window.location.hash !== hash) window.location.hash = hash;
}
