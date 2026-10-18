// The frame every page sits in: a top bar with the brand, where you are and the session; under it the sidebar with
// the scenario switch and the places to go in three groups, and the page beside it. Each page carries its own header.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { deskOf } from "./desk";
import { ScenarioIcon } from "./icons";
import { CATALOG, go, href, placeOf, type Page, type Route } from "./route";
import type { DeVries } from "./state";
import { Icon, Mark, type IconName } from "./ui";

type Row = { page: Page; label: string; icon: IconName };
const GROUPS: { label: string; rows: Row[] }[] = [
  { label: "Findings", rows: [{ page: "posture", label: "Posture", icon: "posture" }, { page: "inbox", label: "Open", icon: "inbox" }, { page: "done", label: "Closed", icon: "done" }] },
  { label: "System", rows: [{ page: "graph", label: "Explorer", icon: "graph" }, { page: "method", label: "Method", icon: "method" }] },
  { label: "Record", rows: [{ page: "audit", label: "Activity", icon: "audit" }, { page: "import", label: "Import", icon: "import" }] },
];

function ScenarioSwitch({ c, scenario }: { c: DeVries; scenario: string | null }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", away);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("mousedown", away);
      window.removeEventListener("keydown", key);
    };
  }, [open]);
  const now = c.current;
  return (
    <div className="switch" ref={box}>
      <button className="switch-button" onClick={() => setOpen((o) => !o)} aria-haspopup="listbox" aria-expanded={open} aria-label="Scenario">
        <span className="switch-tile"><ScenarioIcon id={now?.imported ? "import" : scenario ?? "import"} size={16} /></span>
        <span className="switch-text">
          <span className="switch-name">{scenario ? c.titleOf(scenario) : "DeVries"}</span>
          <span className="switch-sub">{now ? (now.private ? `${now.id} · yours alone` : now.id) : c.ready ? "no scenario" : "connecting"}</span>
        </span>
        <Icon name="switch" size={14} />
      </button>
      {open && (
        <ul className="switch-menu" role="listbox" aria-label="Scenarios">
          <li role="option" aria-selected={false} className="switch-all">
            <button onClick={() => { setOpen(false); go(CATALOG); }}>
              <span className="switch-ico"><Icon name="graph" size={14} /></span>
              <span className="switch-all-name">All scenarios, as cards →</span>
            </button>
          </li>
          {c.scenarios.map((s) => (
            <li key={s.id} role="option" aria-selected={s.id === scenario}>
              <button className={s.id === scenario ? "on" : ""} onClick={() => { setOpen(false); go(s.id); }}>
                <span className="switch-ico"><ScenarioIcon id={s.imported ? "import" : s.id} size={14} /></span>
                <span className="switch-name">{c.titleOf(s.id)}</span>
                <span className={`switch-count${s.open_findings ? " some" : ""}`}>{s.open_findings} open</span>
                <span className="switch-about">{s.description}</span>
              </button>
            </li>
          ))}
          <li role="option" aria-selected={false} className="switch-import">
            <button onClick={() => { setOpen(false); go(scenario ?? c.scenarios[0]?.id ?? null, "import"); }}>
              <span className="switch-ico"><Icon name="import" size={14} /></span>
              <span className="switch-name">Audit your own config →</span>
              <span className="switch-about">Paste a client config or a tools/list; the audit starts by itself.</span>
            </button>
          </li>
        </ul>
      )}
    </div>
  );
}

/** Where you stand and what drives the runs, as two pills: the scope of this graph, and the model's standing. */
function Session({ c }: { c: DeVries }) {
  const own = !!c.current?.own_copy;
  const model = c.session?.model;
  // the model pill says what drove the newest run on this scenario; a configured model only speaks for the next one
  const newest = c.runList[0] ?? c.run ?? null;
  const drove = newest?.mode === "agent";
  const badge = drove ? `Model · ${newest?.model ?? model?.name ?? "a model"}`
    : model?.configured ? (newest ? "Model ready · last pass scripted" : `Model ready · ${model.name ?? "model"}`)
      : "Scripted · no model";
  const why = drove ? "The newest run on this scenario was driven by the model."
    : model?.configured ? "A key is set: the next audit run is the model's. The pass the app ran at start was the scripted search."
      : "No key is set, so every run is the scripted search: the same tools, in a fixed order.";
  const scope = c.current ? (own ? (c.current.private ? "Your import" : "Your sandbox copy") : "Shared scenario") : null;
  return (
    <div className="session">
      {scope && (
        <span className={`pill pill-scope${own ? " own" : ""}`} title={own ? "What changes here is yours alone, until you reset." : "Everyone sees this graph. Approving a fix gives you a private copy to apply it on."}>
          <Icon name={own ? "copy" : "globe"} size={13} />
          <span className="session-name">{scope}</span>
          {own && (
            <button className="session-reset" onClick={c.reset} disabled={c.busy} title="Delete your copies and see the shared scenarios again" aria-label="Reset">
              <Icon name="reset" size={13} />
            </button>
          )}
        </span>
      )}
      <span className={`pill pill-model${model?.configured ? " on" : ""}`} title={`${why}${c.connected ? "" : " The live connection is being re-made."}`}>
        <i className={`pill-dot${c.connected ? "" : " off"}`} aria-hidden />
        <span className="session-sub model-badge">{badge}</span>
      </span>
    </div>
  );
}

/** The bar over everything: the brand, which leads back to the front page; where you are; the session. */
export function TopBar({ c, scenario }: { c: DeVries; scenario: string | null }) {
  return (
    <header className="topbar">
      <a href="#/" className="topbar-brand" title="Back to the front page">
        <Mark size={22} />
        <span>DeVries</span>
      </a>
      <nav className="topbar-crumbs" aria-label="Where you are">
        <a href={href(CATALOG)} className={`topbar-crumb${scenario ? "" : " on"}`}>Scenarios</a>
        {scenario && (
          <>
            <span className="topbar-sep" aria-hidden>/</span>
            <span className="topbar-crumb on"><ScenarioIcon id={c.current?.imported ? "import" : scenario} size={14} />{c.titleOf(scenario)}</span>
          </>
        )}
      </nav>
      <Session c={c} />
    </header>
  );
}

export function Shell({ c, route, closed = false, children }: { c: DeVries; route: Route; closed?: boolean; children: ReactNode }) {
  const open = c.findings?.findings.filter((f) => f.status === "open") ?? [];
  const awaiting = open.some((f) => deskOf(f, c.plans, c.run, c.openIds).proposal);
  const counts: Partial<Record<Page, number | undefined>> = {
    inbox: c.findings ? open.length : undefined,
    done: c.findings ? c.findings.past.length : undefined,
    audit: c.runList.length || undefined,
  };
  const at = placeOf(route, closed);
  const runTone = c.run?.status === "running" ? "info" : c.run?.status === "awaiting_approval" ? "amber" : null;

  return (
    <div className="shell">
      <TopBar c={c} scenario={route.scenario} />
      <div className="shell-body">
      <aside className="side">
        <ScenarioSwitch c={c} scenario={route.scenario} />
        <nav className="nav" aria-label="Places">
          {GROUPS.map((g) => (
            <div className="nav-group" key={g.label}>
              <span className="nav-group-label">{g.label}</span>
              {g.rows.map((row) => (
                <a key={row.page} href={href(route.scenario, row.page)} className={`nav-row${at === row.page ? " on" : ""}`} aria-current={at === row.page ? "page" : undefined}>
                  <Icon name={row.icon} />
                  <span className="nav-label">{row.label}</span>
                  {row.page === "audit" && runTone ? (
                    <i className={`nav-dot t-${runTone} pulse`} title={runTone === "info" ? "An audit run is working" : "An audit run is waiting for you"} />
                  ) : (
                    counts[row.page] !== undefined && <span className={`nav-count${row.page === "inbox" && awaiting ? " alert" : ""}`}>{counts[row.page]}</span>
                  )}
                </a>
              ))}
            </div>
          ))}
        </nav>
      </aside>
      <main className="main">
        {c.dbDown && <p className="outage" role="status">FalkorDB is not answering. Retrying every few seconds.</p>}
        {c.problem && (
          <p className="problem" role="alert">
            {c.problem} <button className="link" onClick={c.dismiss}>Dismiss</button>
          </p>
        )}
        {/* keyed so a new page fades in; a finding is its own page, a selection inside a page is not; the queries drawer lies over whatever is under it */}
        <div className="view" key={`${route.scenario}/${route.page}${route.page === "finding" ? `/${route.id}` : ""}`}>{children}</div>
      </main>
      </div>
    </div>
  );
}
