// The front door of the app: every system DeVries holds, as a card each, the dev team first and recommended. Enter
// opens it; a card opens its posture; the last card is an import of your own.

import { useEffect, type CSSProperties } from "react";
import type { Scenario } from "../api";
import { ScenarioIcon } from "../icons";
import { RECOMMENDED, go, href } from "../route";
import { TopBar } from "../Shell";
import type { DeVries } from "../state";
import { capital, countWord, plural } from "../text";
import { Eyebrow, Loading } from "../ui";

function Card({ s, i, recommended }: { s: Scenario; i: number; recommended: boolean }) {
  return (
    <li className={`front-card${recommended ? " recommended" : ""}`} style={{ "--i": i } as CSSProperties}>
      <a href={href(s.id)}>
        <span className="front-top">
          <span className="front-tile"><ScenarioIcon id={s.imported ? "import" : s.id} size={22} /></span>
          {recommended && <span className="front-tag">Recommended</span>}
          {s.imported && <span className="front-tag quiet">{s.private ? "Your import" : "Imported"}</span>}
          {s.own_copy && !s.imported && <span className="front-tag quiet">Your copy</span>}
        </span>
        <span className="front-title">{s.title}</span>
        <span className="front-about">{s.description}</span>
        <span className="front-foot">
          <span className={`front-open${s.open_findings ? " some" : ""}`}><i aria-hidden />{s.open_findings ? plural(s.open_findings, "finding open", "findings open") : "nothing open"}</span>
          <span className="front-nodes">{s.nodes} nodes</span>
          <span className="front-go">Open →</span>
        </span>
      </a>
    </li>
  );
}

export function CatalogPage({ c }: { c: DeVries }) {
  const list = [...c.scenarios].sort((a, b) => (a.id === RECOMMENDED ? -1 : b.id === RECOMMENDED ? 1 : 0));
  const first = list[0]?.id ?? null;
  // Enter, anywhere that is not a control, opens the recommended scenario
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || !first) return;
      if (e.target instanceof HTMLElement && e.target.closest("a, button, input, select, textarea")) return;
      go(first);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [first]);
  const open = c.scenarios.reduce((n, s) => n + s.open_findings, 0);
  return (
    <div className="shell">
      <TopBar c={c} scenario={null} />
      <div className="scroll">
        <div className="page page-wide front">
          <header className="front-head">
            <Eyebrow>Scenarios</Eyebrow>
            <h1>Pick a system to audit.</h1>
            {c.scenarios.length > 0 && (
              <p className="page-meta">
                {capital(countWord(c.scenarios.length))} systems of agents, each loaded and audited when the app started; {countWord(open)} {open === 1 ? "finding is" : "findings are"} open across them.
                Open one to read where it stands and the fix waiting for a decision, or press <kbd>Enter</kbd> for the one to start with.
              </p>
            )}
          </header>
          {!c.scenarios.length ? <Loading label={c.ready ? "Reading the scenarios" : "Connecting"} /> : (
            <ul className="front-grid">
              {list.map((s, i) => <Card key={s.id} s={s} i={i} recommended={s.id === RECOMMENDED} />)}
              <li className="front-card front-import" style={{ "--i": list.length } as CSSProperties}>
                <a href={href(first, "import")}>
                  <span className="front-top"><span className="front-tile"><ScenarioIcon id="import" size={22} /></span></span>
                  <span className="front-title">Audit your own config</span>
                  <span className="front-about">Paste a Claude Desktop, Cursor or VS Code config, a command, a URL or a saved tools/list. The audit starts by itself.</span>
                  <span className="front-foot"><span className="front-go">Import →</span></span>
                </a>
              </li>
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
