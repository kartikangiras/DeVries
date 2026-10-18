// How DeVries decides, written down in one place: the rules that make a finding, the flow layer they run on,
// the fixes and the sandbox verdict that judges them, the analytics on Posture and in the Explorer, and every
// query behind all of it. The other pages show results; this one explains them, so they do not have to.

import { href, go } from "../route";
import type { DeVries } from "../state";
import { Eyebrow, PageBody, PageHeader, Tabs } from "../ui";
import { QueryCatalog, Statement } from "./Queries";

type Section = "rules" | "flow" | "fixes" | "analytics" | "queries";
const SECTIONS: Section[] = ["rules", "flow", "fixes", "analytics", "queries"];

const FLOW_RULES: [number, string, string, string][] = [
  [1, "DataSource → Tool", "READS", "A tool returns what it reads."],
  [2, "Tool → Agent", "CAN_CALL, to a tool that reads", "What a tool returns enters the context of the agent that called it."],
  [3, "Agent → Tool", "CAN_CALL, to a tool that writes", "An agent's context decides the calls it makes."],
  [4, "Agent → Agent", "DELEGATES_TO", "Context passes down to a delegate."],
  [5, "Tool → Resource", "WRITES", "A tool acts on its resource."],
  [6, "Agent → Agent, delegate to delegator", "DELEGATES_TO", "A delegate's results come back."],
  [7, "Resource → DataSource", "FEEDS", "What was written is read back later: stored taint."],
];
const FIXES: [string, number, string, string][] = [
  ["revoke_call", 1, "Deletes a grant", "Rules 2 and 3 for that agent and tool"],
  ["gate_call", 2, "A person must approve each call", "Rule 3"],
  ["quarantine_delegation", 2, "A delegate returns only structured fields", "Rule 6"],
  ["drop_read", 3, "A tool stops reading a source", "Rule 1"],
  ["split_agent", 4, "A new reader agent takes the agent's reading tools; its results come back quarantined", "Rule 2 into the agent"],
];
const OWASP: [string, string, string][] = [
  ["ASI01", "Agent goal hijack", "an injection path, a poisoned description"], ["ASI02", "Tool misuse and exploitation", "an injection path, a trifecta"],
  ["ASI03", "Identity and privilege abuse", "a trifecta"], ["ASI04", "Agentic supply chain", "manifest drift, a poisoned description"],
  ["ASI05", "Unexpected code execution", "not checked"], ["ASI06", "Memory and context poisoning", "not checked"], ["ASI07", "Insecure inter-agent communication", "not checked"],
  ["ASI08", "Cascading failures", "not checked"], ["ASI09", "Human-agent trust exploitation", "not checked"], ["ASI10", "Rogue agents", "not checked"],
];

function Q({ scenario, name }: { scenario: string; name: string }) {
  return <a className="q" href={href(scenario, "method", "queries", name)}>{name}</a>;
}

export function MethodPage({ c, scenario, section, query }: { c: DeVries; scenario: string; section: string | null; query: string | null }) {
  const shown: Section = (SECTIONS as string[]).includes(section ?? "") ? (section as Section) : "rules";
  return (
    <PageBody width={shown === "queries" ? "full" : "wide"}>
      <PageHeader
        eyebrow="Method"
        title="How DeVries decides."
        meta="The rules that make a finding, the flow layer they run on, the fixes and the verdict that judges them, the analytics, and every query behind all of it. The other pages show results; this one explains them."
      />
      <Tabs label="Section" value={shown} onChange={(s) => go(scenario, "method", s === "rules" ? null : s)} options={[
        { value: "rules", label: "Rules" }, { value: "flow", label: "Flow layer" }, { value: "fixes", label: "Fixes and verdicts" }, { value: "analytics", label: "Analytics" }, { value: "queries", label: "Queries", count: c.catalog.length || undefined },
      ]} />

      {shown === "rules" && (
        <div className="method">
          <section className="method-block">
            <Eyebrow>Check 1 · an injection path</Eyebrow>
            <h2>Untrusted text reaches a high-impact action with no person in between.</h2>
            <p>A data source is <em>untrusted</em> when people outside the organisation can write what the tools read. A resource is <em>high-impact</em> by its label. The check fires when a breadth-first search from each untrusted source over the flow layer, as deep as the graph has nodes, reaches such a resource. A path means text <em>can</em> flow, not that it did.</p>
            <Statement c={c} scenario={scenario} name="reach.untrusted_to_high" />
          </section>
          <section className="method-block">
            <Eyebrow>Check 2 · a lethal trifecta</Eyebrow>
            <h2>One agent holds untrusted input, private data and a way out.</h2>
            <p>Meta's Agents Rule of Two names three properties: [A] the agent processes untrustworthy input, [B] it has access to sensitive systems or private data, [C] it can change state or communicate externally. DeVries reads A as "an untrusted source reaches it", B as "a private source reaches it", C as "it can act on a resource", any resource, whether or not it leaves the organisation, each by one search over the flow layer. The finding is the sharpest case: an agent that holds A and B and can act on a resource that leaves the organisation, a way out, so whoever writes the text can have the data sent. One that also runs an unattended workflow is the worst case, since, in Meta's words, such an agent should not be permitted to operate autonomously.</p>
            <Statement c={c} scenario={scenario} name="find.trifecta" />
          </section>
          <section className="method-block">
            <Eyebrow>Checks 3 and 4 · standing findings</Eyebrow>
            <h2>A server's tool definitions changed, or a description reads as instructions.</h2>
            <p><strong>Manifest drift.</strong> Every tool definition is hashed part by part when its manifest is loaded; a reload that finds a server's manifest changed opens a finding naming the tools and the parts that changed. <strong>Poisoned description.</strong> A tool description that reads as an instruction to the model, hides text in invisible characters or comments, or names another server's tool is a finding, high when the tool sits on an open finding's path. Neither is fixed by the graph; both stand until a person accepts them, and no tool can do that.</p>
          </section>
          <section className="method-block">
            <Eyebrow>Evidence</Eyebrow>
            <h2>The path a finding shows never decides it.</h2>
            <p>A finding exists because a verdict query says so. The hops a person reads come from a separate shortest-path query, fewest hops first, up to ten routes per finding; a route count is capped at fifty. Each hop names the rule that derived it and the configuration edge behind it, which is where a fix can act.</p>
            <Statement c={c} scenario={scenario} name="evidence.pair_paths" />
          </section>
        </div>
      )}

      {shown === "flow" && (
        <div className="method">
          <section className="method-block">
            <Eyebrow>The flow layer</Eyebrow>
            <h2>Seven rules turn the configuration into where text and data can travel.</h2>
            <p>The configuration is what a person set up: which agent can call which tool, who delegates to whom, what each tool reads and acts on. One statement, <Q scenario={scenario} name="projection.rebuild" />, deletes and rewrites a second layer of edges from it in one go, so a reader never sees half a layer. Every verdict and every chart runs on that layer.</p>
            <table className="table method-table">
              <thead><tr><th>Rule</th><th>Derived edge</th><th>From</th><th>In words</th></tr></thead>
              <tbody>
                {FLOW_RULES.map(([n, edge, from, words]) => (
                  <tr key={n}><td className="mono">{n}</td><td className="mono">{edge}</td><td className="mono">{from}</td><td>{words}</td></tr>
                ))}
              </tbody>
            </table>
          </section>
          <section className="method-block">
            <Eyebrow>Gates</Eyebrow>
            <h2>A gate does not remove a grant; it removes the flow.</h2>
            <p>A grant gated behind a person's approval yields a blocked edge in place of its rule 3 edge, and a quarantined delegation in place of its rule 6 edge. The verdict queries follow open flow only, so a gated hop stops a path, and a chart still draws it, dashed. Gates cut rules 3 and 6 because those are the two places a person or a schema can stand between text and its effect; reading, passing context down, a tool acting and stored data being read again have nobody in the loop.</p>
          </section>
          <section className="method-block">
            <Eyebrow>Two sides of a tool</Eyebrow>
            <h2>What a tool returns and what it does are kept apart.</h2>
            <p>A tool that writes has two nodes on the flow layer: its reading side, which flows toward its callers, and an acting side that only flows toward its resource. With one node, an agent's context would flow through a tool into every other agent that calls it, which is not something that happens. Every query that reads the layer names the acting side by its tool, so a path still reads agent → tool → resource. Each flow edge also carries a <em>capacity</em>: the cost of the cheapest fix that can cut it without breaking a workflow that needs the hop, or 1000 where none can, which is what max flow runs on.</p>
            <Statement c={c} scenario={scenario} name="flow.edges" />
          </section>
        </div>
      )}

      {shown === "fixes" && (
        <div className="method">
          <section className="method-block">
            <Eyebrow>The fixes</Eyebrow>
            <h2>Five changes to the configuration, each cutting the hop it acts on.</h2>
            <p>Candidate fixes come from the configuration edges a finding's path crosses. Cost orders the search; it is a preference, not a measurement. Revoking is cheapest because removing a grant nothing needs is least privilege; the workflow check is what stops it when something does need the grant.</p>
            <table className="table method-table">
              <thead><tr><th>Fix</th><th className="num">Cost</th><th>What it changes</th><th>What it cuts</th></tr></thead>
              <tbody>
                {FIXES.map(([fix, cost, changes, cuts]) => (
                  <tr key={fix}><td className="mono">{fix}</td><td className="num">{cost}</td><td>{changes}</td><td>{cuts}</td></tr>
                ))}
              </tbody>
            </table>
          </section>
          <section className="method-block">
            <Eyebrow>The verdict</Eyebrow>
            <h2>A plan is judged on a copy of the graph, never on the graph itself.</h2>
            <p>To test a plan, DeVries copies the graph, applies the plan's fixes to the copy, rebuilds the flow layer, runs the three verdict queries, and compares with the same three on the original. The plan <strong>passes</strong> if every finding it targets is gone, no finding exists that did not before, and no workflow is broken that was not before. Then the copy is deleted. A supervised workflow can live with a gate, because someone is there to approve; an unattended one cannot, which is why the right fix depends on the graph. A plan is one to three fixes; each fix after the first adds a point. The search tries single fixes cheapest first and pairs only if no single fix passes, within a budget of twenty sandboxes.</p>
            <Statement c={c} scenario={scenario} name="wf.broken" />
          </section>
          <section className="method-block">
            <Eyebrow>Approval</Eyebrow>
            <h2>Nothing changes the graph until a person approves, and no tool can approve.</h2>
            <p>A plan that passed is stored with the hash of the configuration it was verified against. A person approves or rejects it by name, on the finding's Fix step and nowhere else. On apply, if the configuration has changed since the verdict, the plan is verified again first; if its finding is already gone, it is refused as stale. Approving can also write the change to the file the scenario came from, with a backup beside it, after the diff has been read; a public site never writes a file.</p>
          </section>
        </div>
      )}

      {shown === "analytics" && (
        <div className="method">
          <section className="method-block">
            <Eyebrow>Posture</Eyebrow>
            <h2>Five figures, a flow, two bar charts, the choke points, the history.</h2>
            <ul className="method-list">
              <li><strong>Open findings</strong>: the findings that hold right now, by the two checks.</li>
              <li><strong>High-impact actions reached</strong>: how many high-impact resources any untrusted source reaches, by <Q scenario={scenario} name="reach.untrusted_to_high" />.</li>
              <li><strong>Agents holding all three</strong>, and how many of them run unattended: Meta's Rule of Two, read by three searches, <Q scenario={scenario} name="reach.agents_from_sources" /> twice and <Q scenario={scenario} name="agent.acts_on" />.</li>
              <li><strong>Where the risk runs</strong>: the open findings' paths between the untrusted and private sources, the agents and the high-impact actions, as a map; the tokens run the paths for as long as they are open. A card's figure is a search answer: what a source's text reaches, how many untrusted sources reach an action, which of the three properties an agent holds.</li>
              <li><strong>Blast radius</strong>: everything each untrusted source's text can reach, one search per source, <Q scenario={scenario} name="reach.from" />; the lit part of the bar is the high-impact resources and the ways out among them.</li>
              <li><strong>Exposure</strong>: for each high-impact resource or way out, how many untrusted sources reach it, one search from every node, <Q scenario={scenario} name="reach.into" />.</li>
              <li><strong>Choke points</strong>: the agents and tools the most open routes pass through, counted over the findings' evidence paths; where one change would cut the most.</li>
              <li><strong>The cheapest cut</strong>: the least set of hops that separates every untrusted source from every high-impact resource, by FalkorDB's max flow, <Q scenario={scenario} name="choke.maxflow" />. Each hop's capacity is the cost of the cheapest fix that cuts it without breaking a workflow that needs the hop: a revoke of a tool a workflow needs, a gate on a call an autonomous workflow makes, or a dropped read of data a workflow needs count as uncuttable, so the cut lands on a plan a sandbox can pass. A guide, not a verdict: the sandbox has the last word, and a trifecta is not a cut. "Propose it as one plan" sends it through the sandbox like any other plan.</li>
              <li><strong>Over time</strong>: one record per scan, <Q scenario={scenario} name="scan.history" />, so a fix shows as the next bar's drop.</li>
            </ul>
          </section>
          <section className="method-block">
            <Eyebrow>The Explorer</Eyebrow>
            <h2>The whole system, with lenses.</h2>
            <ul className="method-list">
              <li><strong>Open paths</strong> light the open findings' hops over everything else.</li>
              <li><strong>Communities</strong>: groups that hang together, by label propagation over the configuration edges, <Q scenario={scenario} name="zones.communities" />; a <em>blast zone</em> is a connected part that holds both an untrusted source and a high-impact resource, <Q scenario={scenario} name="zones.wcc" />. Neither looks at direction, so either can prove a source cannot reach a resource, never that it can.</li>
              <li><strong>Most central</strong>: the five agents and tools the most flow passes through, by betweenness centrality, <Q scenario={scenario} name="choke.betweenness" />; the reader also gives a node's PageRank over the flow layer, <Q scenario={scenario} name="choke.pagerank" />. Context for a person; no verdict rests on either.</li>
              <li><strong>Test a change</strong>: one more grant or delegation for a picked agent, tried on a sandbox copy that is then deleted, <Q scenario={scenario} name="whatif.grant_call" />.</li>
              <li><strong>Tables</strong>: every agent, tool, source, resource and server with what reaches it, what it reaches and the open findings through it, <Q scenario={scenario} name="inventory.rows" />; a server can be tested for removal, <Q scenario={scenario} name="whatif.drop_server" />.</li>
            </ul>
          </section>
          <section className="method-block">
            <Eyebrow>OWASP Top 10 for Agentic Applications</Eyebrow>
            <h2>Four of the ten classes, named on every finding.</h2>
            <table className="table method-table">
              <thead><tr><th>Class</th><th>Name</th><th>What DeVries finds under it</th></tr></thead>
              <tbody>
                {OWASP.map(([code, name, what]) => (
                  <tr key={code} className={what === "not checked" ? "faint" : ""}><td className="mono">{code}</td><td>{name}</td><td>{what}</td></tr>
                ))}
              </tbody>
            </table>
            <p>The other six are about memory, code execution, inter-agent messaging, cascades, people and rogue agents, which a configuration graph does not see.</p>
          </section>
        </div>
      )}

      {shown === "queries" && (
        <div className="method method-queries">
          <p className="method-lede">Every Cypher statement the product runs is a named entry in one catalog, sent with parameters and never built from strings. Reads go with <code>GRAPH.RO_QUERY</code>, so the server itself refuses a write in them; the fix statements are guarded, running on a working graph only for a plan a person approved.</p>
          <QueryCatalog c={c} scenario={scenario} name={query} />
        </div>
      )}
    </PageBody>
  );
}
