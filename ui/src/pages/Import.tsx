// Audit your own config: paste a client config (mcpServers) or a saved tools/list, label what is untrusted
// and what matters, and the audit starts by itself. On this machine the import joins the shared scenarios
// and can also be a source the command line takes; on a public site only what is pasted is read, nothing
// is launched, and the result is yours alone.

import { useState } from "react";
import type { Cistern } from "../state";
import { href } from "../route";
import { Button, Empty, Eyebrow, PageBody, PageHeader } from "../ui";

const EXAMPLE = `{
  "mcpServers": {
    "github": { "url": "https://api.githubcopilot.com/mcp/" },
    "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] }
  }
}`;

const CLIENTS = [["claude-code", "Claude Code (.mcp.json)"], ["claude-desktop", "Claude Desktop"], ["cursor", "Cursor"], ["vscode", "VS Code"], ["pasted", "Something else"]];

export function ImportPage({ c, scenario }: { c: Cistern; scenario: string }) {
  // until the session has answered, the page assumes a public site: nothing that launches a command is offered unseen
  const isPublic = c.session ? !!c.session.public : true;
  const [mode, setMode] = useState<"paste" | "source">("paste");
  const [text, setText] = useState("");
  const [source, setSource] = useState("");
  const [client, setClient] = useState("claude-code");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Awaited<ReturnType<Cistern["importConfig"]>>>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    let config: unknown;
    if (mode === "paste") {
      try {
        config = JSON.parse(text);
      } catch (err) {
        setError(`That is not JSON: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
    }
    const answer = await c.importConfig({
      config: mode === "paste" ? config : undefined,
      source: mode === "source" ? source.trim() : undefined,
      name: name.trim() || undefined,
      client,
      audit: true,
    });
    setResult(answer);
  };

  return (
    <PageBody>
      <PageHeader
        eyebrow="Import"
        title="Audit your own config."
        meta={isPublic
          ? "Paste a client config or a saved tools/list. Servers with a URL are asked for their tools; a command is never launched here. What you import is yours alone and goes when your session does."
          : "Paste a client config or a saved tools/list, or name a source the command line would take. Each stdio server is launched with this machine's environment to read its tools, so import only what you would run anyway."}
      />
      <form className="import" onSubmit={submit}>
        {!isPublic && (
          <div className="toggle" role="tablist" aria-label="How to import">
            <button type="button" role="tab" aria-selected={mode === "paste"} className={mode === "paste" ? "on" : ""} onClick={() => setMode("paste")}>Paste</button>
            <button type="button" role="tab" aria-selected={mode === "source"} className={mode === "source" ? "on" : ""} onClick={() => setMode("source")}>A source on this machine</button>
          </div>
        )}
        {mode === "paste" ? (
          <>
            <label className="import-field">
              <Eyebrow>The JSON</Eyebrow>
              <textarea value={text} onChange={(e) => setText(e.target.value)} rows={12} spellCheck={false} placeholder={EXAMPLE} aria-label="The config or tools/list" />
            </label>
            <p className="about-note">A client config has an <code>mcpServers</code> block. A tools/list is what a server answers to <code>tools/list</code>: an object with <code>tools</code>. Secrets in <code>env</code> never appear in a diff.</p>
          </>
        ) : (
          <label className="import-field">
            <Eyebrow>The source</Eyebrow>
            <input type="text" value={source} onChange={(e) => setSource(e.target.value)} placeholder="claude-code · claude-desktop · cursor · a path to a config · a command · an https:// URL" aria-label="Source" />
            <p className="about-note">The same words <code>python -m cistern.ingest --import</code> takes. A client name reads that client's config on this machine.</p>
          </label>
        )}
        <div className="import-row">
          <label className="import-field short">
            <Eyebrow>It came from</Eyebrow>
            <select value={client} onChange={(e) => setClient(e.target.value)} aria-label="Which client">
              {CLIENTS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
            </select>
          </label>
          <label className="import-field short">
            <Eyebrow>Call it</Eyebrow>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="import_mine" pattern="[a-z][a-z0-9_]{0,47}" aria-label="Scenario name" />
          </label>
          <Button variant="primary" size="lg" type="submit" disabled={c.busy || (mode === "paste" ? !text.trim() : !source.trim())}>
            {c.busy ? "Importing…" : "Import and audit"}
          </Button>
        </div>
        {error && <p className="whatif-error">{error}</p>}
      </form>
      {result && (
        <section className="block">
          <div className="block-head">
            <Eyebrow tone="accent">Imported</Eyebrow>
            <span>{result.tools} tools from {result.servers.length} server(s){result.private ? " · yours alone" : ""}</span>
          </div>
          <p className="tldr-text">
            <a href={href(result.scenario)}>{result.scenario}</a> is loaded. {result.findings.length ? `${result.findings.length} finding(s) already, from the labels given.` : "Nothing is a finding until you label what is untrusted and what matters, on its Inbox."}
            {result.run ? " The audit started by itself and will stop at its first proposal." : ""}
          </p>
          {result.skipped.length > 0 && <ul className="cards">{result.skipped.map((s) => <li className="card" key={s}><p>{s}</p></li>)}</ul>}
        </section>
      )}
      <section className="about">
        <div>
          <Eyebrow>What happens next</Eyebrow>
          <p>The import drafts one agent, the client, holding every tool, and one data source and one resource per server. Label them on the Inbox. The scan runs on the answer, and the audit tests the candidate fixes in sandbox copies and stops at the cheapest that passes, for your nod.</p>
          {!isPublic && <p>Approving a plan can also write it back to the file it came from: an <code>ask</code> rule in a Claude Code settings file, a server removed from a desktop config, a line in a scenario file. You read the diff first, and nothing is written on a public site.</p>}
        </div>
      </section>
      {!c.scenarios.length && <Empty>No scenario is loaded yet. <a href={href(scenario)}>Back</a>.</Empty>}
    </PageBody>
  );
}
