// The Cypher behind everything, one named query at a time: the catalog down the side, the statement in the
// middle, where it is used on the right. Nothing in the app runs a query that is not in this list. It sits on
// the Method page.

import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { CatalogQuery } from "../api";
import { go, href } from "../route";
import type { DeVries } from "../state";
import { plural } from "../text";
import { Eyebrow, Icon, KV, Loading } from "../ui";

const GROUPS: { label: string; prefixes: string[] }[] = [
  { label: "Verdicts and evidence", prefixes: ["reach", "find", "evidence", "wf", "graph"] },
  { label: "Graph algorithms", prefixes: ["zones", "choke"] },
  { label: "Fixes and what-ifs", prefixes: ["fix", "whatif"] },
  { label: "Findings, plans, drafts and runs", prefixes: ["finding", "mitigation", "draft", "config", "scan", "run"] },
  { label: "The flow layer", prefixes: ["projection", "flow"] },
  { label: "Reading for the page", prefixes: ["ui", "node", "scenario", "overview", "inventory", "server", "agent"] },
  { label: "Loading a scenario", prefixes: ["ingest", "schema", "canary", "drift"] },
];
const DEFAULT = "reach.untrusted_to_high";
/** Where on screen a query's answer shows, by its prefix: the places, so a reader can find the figure it feeds. */
const USED_ON: [string, string][] = [
  ["reach.untrusted_to_high", "a finding's Rule step · Posture's exposure"], ["find.trifecta", "a finding's Rule step · Posture's tally"],
  ["reach.agents_from_sources", "Posture's Rule of Two tally · the Explorer's reader"], ["reach.from", "Posture's blast radius · the Explorer's tables"],
  ["reach.into", "Posture's exposure · the Explorer's tables"], ["reach.untrusted_nodes", "every chart's filled cards · the Explorer's tables"],
  ["evidence.", "a finding's Path step · Posture's choke points"], ["wf.", "every sandbox verdict"], ["choke.maxflow", "Posture's cheapest cut · the Explorer's cut lens"],
  ["choke.betweenness", "Posture's choke points · the Explorer's central lens"], ["choke.pagerank", "the Explorer's tables and reader"],
  ["zones.", "the Explorer's communities lens"], ["fix.", "a plan applied, or tested in a sandbox"], ["whatif.", "the Explorer's reader and tables"],
  ["finding.", "Open and Closed · Activity"], ["mitigation.", "a finding's Fix and Options steps · Activity"], ["scan.", "Posture's history · Activity"],
  ["draft.", "the change under the approval bar · Activity"], ["run.", "Activity · a finding's Fix step"], ["ui.", "the Explorer"], ["overview.", "Posture"], ["server.", "the Explorer's tables"], ["inventory.", "the Explorer's tables"],
  ["projection.", "every scan"], ["flow.", "the Explorer · the cut"], ["ingest.", "loading a scenario"], ["schema.", "loading a scenario"], ["canary.", "the self-check at start"],
  ["config.", "the config hash a plan is tested against"], ["graph.", "every scan"], ["node.", "every page's names"], ["scenario.", "the scenario switch"], ["agent.", "Posture's tally"],
  ["drift.", "a manifest drift finding"],
];
const usedOn = (name: string) => USED_ON.find(([prefix]) => name === prefix || name.startsWith(prefix))?.[1] ?? "the API";

const TOKEN = /(\/\/[^\n]*)|('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")|(\$\w+)|\b(algo\.\w+|[a-zA-Z_]+\.[a-zA-Z_.]+(?=\())|\b(OPTIONAL MATCH|ORDER BY|DETACH DELETE|ON CREATE SET|ON MATCH SET|MATCH|WHERE|RETURN|WITH|UNWIND|CALL|YIELD|MERGE|CREATE|SET|DELETE|REMOVE|LIMIT|SKIP|AS|AND|OR|XOR|NOT|IN|IS|NULL|DISTINCT|CASE|WHEN|THEN|ELSE|END|EXISTS|FOR|ON|INDEX|ASC|DESC|TRUE|FALSE|true|false|null)\b|(:[A-Z][A-Za-z_]*)/g;
const KIND = ["comment", "string", "param", "fn", "kw", "label"];

/** Cypher with its parts told apart: keywords, parameters, procedures, labels. */
export function Cypher({ text }: { text: string }) {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(TOKEN)) {
    const at = m.index ?? 0;
    out.push(text.slice(last, at));
    const kind = KIND[m.slice(1).findIndex((g) => g !== undefined)];
    out.push(<span className={`c-${kind}`} key={at}>{m[0]}</span>);
    last = at + m[0].length;
  }
  out.push(text.slice(last));
  return <pre className="cypher"><code>{out}</code></pre>;
}

/** One query's statement, read from the catalog by name, for the Method page to quote. */
export function Statement({ c, scenario, name }: { c: DeVries; scenario: string; name: string }) {
  const q = c.catalog.find((x) => x.name === name);
  if (!q) return <Loading label={`Reading ${name}`} />;
  return (
    <figure className="statement">
      <figcaption><a href={href(scenario, "method", "queries", name)}>{q.name}</a> <span>{q.doc}</span></figcaption>
      <Cypher text={q.cypher} />
    </figure>
  );
}

/** The catalog: the list down the side, the statement in the middle, what it is for and who used it on the right. */
export function QueryCatalog({ c, scenario, name }: { c: DeVries; scenario: string; name: string | null }) {
  const [find, setFind] = useState("");
  const byName = useMemo(() => new Map(c.catalog.map((q) => [q.name, q])), [c.catalog]);
  const selected = byName.get(name ?? DEFAULT) ?? c.catalog[0] ?? null;
  const match = (q: CatalogQuery) => !find.trim() || `${q.name} ${q.doc}`.toLowerCase().includes(find.trim().toLowerCase());
  const grouped = useMemo(() => {
    const placed = new Set<string>();
    const groups = GROUPS.map((g) => {
      const list = c.catalog.filter((q) => g.prefixes.includes(q.name.split(".")[0]));
      list.forEach((q) => placed.add(q.name));
      return { label: g.label, list };
    });
    const rest = c.catalog.filter((q) => !placed.has(q.name));
    return rest.length ? [...groups, { label: "Other", list: rest }] : groups;
  }, [c.catalog]);
  // the selected query is in view, however far down the catalog it sits
  useEffect(() => {
    document.querySelector(".catalog-list a.on")?.scrollIntoView({ block: "nearest" });
  }, [selected?.name]);

  if (!c.catalog.length) return <Loading label="Reading the query catalog" />;
  const params = selected ? [...new Set(selected.cypher.match(/\$\w+/g) ?? [])] : [];
  const algos = selected ? [...new Set(selected.cypher.match(/algo\.\w+/g) ?? [])] : [];
  const users = selected && c.run ? c.run.steps.filter((s) => s.queries.includes(selected.name)) : [];

  return (
    <div className="catalog">
      <nav className="catalog-list scroll" aria-label="Queries">
        <label className="search">
          <Icon name="search" size={15} />
          <input type="search" value={find} onChange={(e) => setFind(e.target.value)} placeholder="Find a query…" aria-label="Find a query" />
        </label>
        {grouped.map((g) => {
          const list = g.list.filter(match);
          if (!list.length) return null;
          return (
            <div className="catalog-group" key={g.label}>
              <Eyebrow>{g.label}</Eyebrow>
              {list.map((q) => (
                <a key={q.name} href={href(scenario, "method", "queries", q.name)} className={q.name === selected?.name ? "on" : ""} aria-current={q.name === selected?.name ? "true" : undefined}>
                  {q.name}
                </a>
              ))}
            </div>
          );
        })}
        <p className="catalog-count">{plural(c.catalog.length, "query", "queries")} · all named · no other Cypher runs</p>
      </nav>

      {selected && (
        <div className="scroll">
          <article className="query">
            <header className="query-head">
              <div>
                <Eyebrow>Query</Eyebrow>
                <h1>{selected.name}</h1>
                <p className="query-doc">{selected.doc}</p>
              </div>
              <span className={`phase ${selected.mode === "ro" ? "t-muted" : "t-info"}`}>{selected.mode === "ro" ? "Read only" : "Writes"}</span>
            </header>
            <Eyebrow>Cypher</Eyebrow>
            <Cypher text={selected.cypher} />
          </article>
        </div>
      )}

      {selected && (
        <aside className="rail" aria-label="About this query">
          <section>
            <Eyebrow>At a glance</Eyebrow>
            <dl>
              <KV k="Mode">{selected.mode === "ro" ? "read only" : "writes"}</KV>
              <KV k="Runs on">{selected.targets.map((t) => (t === "working" ? "working graphs" : "sandboxes")).join(", ")}</KV>
              <KV k="Parameters">{params.length ? params.join(" ") : "none"}</KV>
              <KV k="Algorithms">{algos.length ? algos.join(" ") : "none"}</KV>
              <KV k="Time limit">{selected.timeout_ms} ms</KV>
            </dl>
            <p className="rail-note">
              {selected.mode === "ro"
                ? "It is sent with GRAPH.RO_QUERY, so it cannot change a graph."
                : selected.name.startsWith("fix.")
                  ? "Guarded: on a working graph it runs only for a plan a person approved. On a sandbox copy it runs freely, which is how a plan is tested."
                  : !selected.targets.includes("working")
                    ? "It writes, and only to a sandbox copy: it never runs on a working graph."
                    : "It writes to the graph it is run on."}
            </p>
          </section>
          <section>
            <Eyebrow>Used on</Eyebrow>
            <p className="rail-note">{usedOn(selected.name)}.</p>
          </section>
          <section>
            <div className="block-head">
              <Eyebrow>Used by</Eyebrow>
              {c.run && <span>{c.run.id}</span>}
            </div>
            {users.length ? (
              <ul className="used">
                {users.map((s) => (
                  <li key={s.n}>
                    <button onClick={() => go(scenario, "audit", c.run!.id)}>
                      <code>{s.tool}</code>
                      <span>step {s.n} · {s.phase}{s.ms != null ? ` · ${s.ms} ms` : ""}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="rail-note">{c.run ? "No step of the last run used it." : "Run an audit to see which of its steps use this query."}</p>
            )}
          </section>
        </aside>
      )}
    </div>
  );
}
