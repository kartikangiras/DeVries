// The MCP servers behind the tools, and the one question people ask of a scanner's report: which server
// would I pull? Each row says what the server puts into the system and, on request, what a sandbox says
// taking it out would close and break. The table is the Servers tab of the inventory.

import { useEffect, useState } from "react";
import { api, type Servers as ServerList, type WhatIf } from "../api";
import { href } from "../route";
import type { DeVries } from "../state";
import { Empty, Loading } from "../ui";

export function ServerTable({ c, scenario }: { c: DeVries; scenario: string }) {
  const [servers, setServers] = useState<ServerList | null>(null);
  const [answers, setAnswers] = useState<Record<string, WhatIf | string>>({});
  const [asking, setAsking] = useState<string | null>(null);
  useEffect(() => {
    let wanted = true;
    api.servers(scenario).then((s) => wanted && setServers(s)).catch(() => wanted && setServers(null));
    return () => { wanted = false; };
  }, [scenario, c.flow]);
  if (!servers || servers.scenario !== scenario) return <Loading label="Reading the servers" />;
  if (!servers.servers.length) return <Empty>This scenario names no MCP server.</Empty>;
  const name = (id: string) => c.names[id] ?? id;
  const ask = async (id: string) => {
    setAsking(id);
    try {
      setAnswers((old) => ({ ...old, [id]: "" }));
      const answer = await api.whatIf(scenario, [{ kind: "drop_server", server_id: id }]);
      setAnswers((old) => ({ ...old, [id]: answer }));
    } catch (e) {
      setAnswers((old) => ({ ...old, [id]: e instanceof Error ? e.message : "The sandbox could not answer." }));
    } finally {
      setAsking(null);
    }
  };
  return (
    <section className="servers">
      <table className="table">
        <thead><tr><th>Server</th><th>Tools</th><th>Held by</th><th className="num">Findings through it</th><th>Without it</th></tr></thead>
        <tbody>
          {servers.servers.map((s) => {
            const a = answers[s.id];
            return (
              <tr key={s.id}>
                <td>{s.name ?? s.id}<br /><span className="faint mono">{s.synthetic ? "synthetic" : s.source_url ?? "imported"}</span></td>
                <td className="mono">{s.tools.map((t) => name(t)).join(", ") || "·"}</td>
                <td>{s.agents.map((x) => name(x)).join(", ") || "nobody"}</td>
                <td className="num">{s.findings.length}</td>
                <td>
                  {a === undefined || a === ""
                    ? <button className="link" onClick={() => ask(s.id)} disabled={asking !== null || c.busy}>{asking === s.id ? "asking a sandbox…" : "test removing it"}</button>
                    : typeof a === "string" ? a
                      : `closes ${a.resolved.length}, opens ${a.introduced.length}, breaks ${a.newly_broken.length}${a.newly_broken.length ? ` (${a.newly_broken.map((b) => name(b.workflow_id)).join(", ")})` : ""} · ${a.sandbox_ms} ms`}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="chart-note">
        Read by <a href={href(scenario, "queries", "server.summary")}>server.summary</a>; a removal is <a href={href(scenario, "queries", "whatif.drop_server")}>whatif.drop_server</a> on a copy of the graph, which is then deleted. Nothing here changes the scenario.
      </p>
    </section>
  );
}
