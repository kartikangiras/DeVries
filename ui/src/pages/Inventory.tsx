// Every agent, tool, source, resource and server in the scenario, with what each holds and reaches, one table a
// kind. The answer to "what do we have?"; a row opens the thing in the Explorer, where its neighbourhood is drawn.

import { api } from "../api";
import { useFetch } from "../fetch";
import { go, href } from "../route";
import type { DeVries } from "../state";
import { capital, countWord, plural } from "../text";
import { Empty, Fold, Loading, PageBody, PageHeader, Tabs } from "../ui";
import { ServerTable } from "./Servers";

type Kind = "agents" | "tools" | "sources" | "resources" | "servers";
const KINDS: Kind[] = ["agents", "tools", "sources", "resources", "servers"];

export function InventoryPage({ c, scenario, kind }: { c: DeVries; scenario: string; kind: string | null }) {
  const shown: Kind = (KINDS as string[]).includes(kind ?? "") ? (kind as Kind) : "agents";
  const inv = useFetch(() => api.inventory(scenario), [scenario, c.configHash, c.scannedAt, c.findings?.findings.length]);
  const d = inv.data?.scenario === scenario ? inv.data : null;
  const name = (id: string, given?: string | null) => given ?? c.names[id] ?? id;
  const open = (id: string) => go(scenario, "graph", id);
  const row = (id: string) => ({ onClick: () => open(id), onKeyDown: (e: React.KeyboardEvent) => e.key === "Enter" && open(id), tabIndex: 0, className: "pick" });
  const yes = (b: boolean) => (b ? "yes" : "·");

  return (
    <PageBody width="wide">
      <PageHeader
        eyebrow="Inventory"
        title={d ? `${capital(plural(d.agents.length, "agent", "agents"))}, ${plural(d.tools.length, "tool", "tools")}, ${plural(d.sources.length, "source", "sources")}, ${plural(d.resources.length, "resource", "resources")}, ${plural(d.servers.length, "server", "servers")}.` : "What the system holds."}
        meta="Each thing with what reaches it, what it reaches, and the open findings that run through it, read from the graph. A row opens it in the Explorer."
      />
      {inv.error && <p className="whatif-error">{inv.error}</p>}
      {!d ? <Loading label={c.ready ? "Reading the inventory" : "Connecting"} /> : (
        <>
          <Tabs label="Kind" value={shown} onChange={(k) => go(scenario, "inventory", k === "agents" ? null : k)} options={[
            { value: "agents", label: "Agents", count: d.agents.length },
            { value: "tools", label: "Tools", count: d.tools.length },
            { value: "sources", label: "Sources", count: d.sources.length },
            { value: "resources", label: "Resources", count: d.resources.length },
            { value: "servers", label: "Servers", count: d.servers.length },
          ]} />
          <div className="inventory">
            {shown === "agents" && (d.agents.length ? (
              <table className="table">
                <thead><tr><th>Agent</th><th>Rule of Two</th><th>Runs</th><th className="num">Grants</th><th className="num">Gated</th><th className="num">Delegates to</th><th>Untrusted reaches it</th><th className="num">Open findings</th><th className="num">PageRank</th></tr></thead>
                <tbody>
                  {d.agents.map((a) => (
                    <tr key={a.id} {...row(a.id)}>
                      <td className="plan">{name(a.id, a.name)}<br /><span className="faint mono">{a.id}{a.owner ? ` · ${a.owner}` : ""}</span></td>
                      <td className="mono">{a.properties.join(" · ") || "·"}{a.count === 3 ? <span className={`t-${a.autonomous ? "danger" : "amber"} rot-word`}> all three{a.autonomous ? ", unattended" : ""}</span> : ""}</td>
                      <td>{a.workflows ? `${plural(a.workflows, "workflow", "workflows")}${a.autonomous ? ", unattended" : ""}` : "·"}</td>
                      <td className="num">{a.grants}</td>
                      <td className="num">{a.gated}</td>
                      <td className="num">{a.delegates_to}</td>
                      <td>{yes(a.reached)}</td>
                      <td className="num">{a.findings}</td>
                      <td className="num">{a.pagerank_rank != null ? `#${a.pagerank_rank}` : "·"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <Empty>No agent in this scenario.</Empty>)}
            {shown === "tools" && (d.tools.length ? (
              <table className="table">
                <thead><tr><th>Tool</th><th>Server</th><th>Capability</th><th className="num">Held by</th><th className="num">Gated</th><th className="num">Reads</th><th className="num">Acts on</th><th>Untrusted reaches it</th><th className="num">Open findings</th><th className="num">PageRank</th></tr></thead>
                <tbody>
                  {d.tools.map((t) => (
                    <tr key={t.id} {...row(t.id)}>
                      <td className="plan"><span className="code">{name(t.id, t.name)}</span><br /><span className="faint mono">{t.id}</span></td>
                      <td>{t.server_id ? name(t.server_id) : "·"}</td>
                      <td className="mono">{t.capability ?? "unknown"}</td>
                      <td className="num">{t.held_by}</td>
                      <td className="num">{t.gated}</td>
                      <td className="num">{t.reads}</td>
                      <td className="num">{t.acts_on}</td>
                      <td>{yes(t.reached)}</td>
                      <td className="num">{t.findings}</td>
                      <td className="num">{t.pagerank_rank != null ? `#${t.pagerank_rank}` : "·"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <Empty>No tool in this scenario.</Empty>)}
            {shown === "sources" && (d.sources.length ? (
              <table className="table">
                <thead><tr><th>Data source</th><th>Trust</th><th className="num">Read by</th><th className="num">Agents it reaches</th><th className="num">Open findings</th></tr></thead>
                <tbody>
                  {d.sources.map((s) => (
                    <tr key={s.id} {...row(s.id)}>
                      <td className="plan">{name(s.id, s.name)}<br /><span className="faint mono">{s.id}</span></td>
                      <td className={s.trust === "untrusted" ? "t-danger" : s.trust === "private" ? "t-amber" : ""}>{s.trust ?? "unknown"}</td>
                      <td className="num">{s.read_by}</td>
                      <td className="num">{s.reaches_agents}</td>
                      <td className="num">{s.findings}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <Empty>No data source in this scenario.</Empty>)}
            {shown === "resources" && (d.resources.length ? (
              <table className="table">
                <thead><tr><th>Resource</th><th>Impact</th><th>Leaves the org</th><th className="num">Acted on by</th><th>Untrusted reaches it</th><th className="num">Untrusted sources</th><th className="num">Open findings</th></tr></thead>
                <tbody>
                  {d.resources.map((r) => (
                    <tr key={r.id} {...row(r.id)}>
                      <td className="plan">{name(r.id, r.name)}<br /><span className="faint mono">{r.id}</span></td>
                      <td className={r.impact === "high" ? "t-danger" : ""}>{r.impact ?? "unknown"}</td>
                      <td>{yes(r.external)}</td>
                      <td className="num">{r.acted_on_by}</td>
                      <td>{yes(r.reached_by_untrusted)}</td>
                      <td className="num">{r.reaching_sources}</td>
                      <td className="num">{r.findings}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <Empty>No resource in this scenario.</Empty>)}
            {shown === "servers" && <ServerTable c={c} scenario={scenario} />}
          </div>
          <Fold className="source" summary="Source and method" sub={`${plural(d.queries.length, "FalkorDB query", "FalkorDB queries")}`}>
            <p className="chart-note">
              Read from {scenario} in FalkorDB by {d.queries.map((q, i) => <span key={q}>{i > 0 && ", "}<a href={href(scenario, "queries", q)}>{q}</a></span>)}.
              "Untrusted reaches it" is <code>algo.bfs</code> from every untrusted source; the Rule of Two letters are three BFS passes; PageRank is <code>algo.pageRank</code> over the flow layer, {countWord(1)} rank a node. The open findings through a thing are the ones whose evidence paths pass through it.
            </p>
          </Fold>
        </>
      )}
    </PageBody>
  );
}
