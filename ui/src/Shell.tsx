// The frame every page sits in: the sidebar with the scenario switch, the places to go in four groups, and
// the session; and the page beside it. There is no top bar; each page carries its own header.
// The structure follows Manthan's AppShell (see ui/THIRD_PARTY_NOTICES.md).

import { useEffect, useRef, useState, type ReactNode } from "react";
import { deskOf } from "./desk";
import { go, href, type Page, type Route } from "./route";
import type { Cistern } from "./state";
import { Icon, Mark, type IconName } from "./ui";

type Row = { page: Page; label: string; icon: IconName };
const GROUPS: { label: string; rows: Row[] }[] = [
  { label: "Findings", rows: [{ page: "inbox", label: "Inbox", icon: "inbox" }, { page: "done", label: "Done", icon: "done" }] },
  { label: "Fixes", rows: [{ page: "fixes", label: "Ledger", icon: "fixes" }, { page: "whatif", label: "What if", icon: "whatif" }] },
  { label: "System", rows: [{ page: "graph", label: "Graph", icon: "graph" }, { page: "servers", label: "Servers", icon: "servers" }, { page: "queries", label: "Queries", icon: "queries" }] },
  { label: "Audit", rows: [{ page: "audit", label: "Runs", icon: "audit" }, { page: "import", label: "Import", icon: "import" }] },
];

/** The nav row a route belongs to: a finding belongs to the list it is in. */
export function placeOf(route: Route, closed: boolean): Page {
  if (route.page === "finding") return closed ? "done" : "inbox";
  return route.page;
}

function ScenarioSwitch({ c, scenario }: { c: Cistern; scenario: string | null }) {
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
        <Mark />
        <span className="switch-text">
          <span className="switch-name">{scenario ? c.titleOf(scenario) : "Cistern"}</span>
          <span className="switch-sub">{now ? (now.private ? `${now.id} · yours alone` : now.id) : c.ready ? "no scenario" : "connecting"}</span>
        </span>
        <Icon name="switch" size={14} />
      </button>
      {open && (
        <ul className="switch-menu" role="listbox" aria-label="Scenarios">
          {c.scenarios.map((s) => (
            <li key={s.id} role="option" aria-selected={s.id === scenario}>
              <button className={s.id === scenario ? "on" : ""} onClick={() => { setOpen(false); go(s.id); }}>
                <span className="switch-name">{c.titleOf(s.id)}</span>
                <span className={`switch-count${s.open_findings ? " some" : ""}`}>{s.open_findings} open</span>
                <span className="switch-about">{s.description}</span>
              </button>
            </li>
          ))}
          <li role="option" aria-selected={false} className="switch-import">
            <button onClick={() => { setOpen(false); go(scenario ?? c.scenarios[0]?.id ?? null, "import"); }}>
              <span className="switch-name">Audit your own config →</span>
              <span className="switch-about">Paste a client config or a tools/list; the audit starts by itself.</span>
            </button>
          </li>
        </ul>
      )}
    </div>
  );
}

function Session({ c }: { c: Cistern }) {
  const own = !!c.current?.own_copy;
  const model = c.session?.model;
  return (
    <div className="session">
      <span className={`session-dot${c.connected ? "" : " off"}`} title={c.connected ? "Live: changes arrive as they happen" : "Reconnecting"} aria-hidden />
      <span className="session-text">
        <span className="session-name">{own ? (c.current?.private ? "Your import" : "Your sandbox copy") : "Shared scenario"}</span>
        <span className="session-sub model-badge">{model?.configured ? `model · ${model.name}` : "scripted · no model"}</span>
      </span>
      {own && (
        <button className="session-reset" onClick={c.reset} disabled={c.busy} title="Delete your copies and see the shared scenarios again" aria-label="Reset">
          <Icon name="reset" size={16} />
        </button>
      )}
    </div>
  );
}

export function Shell({ c, route, closed = false, queriesOpen = false, children }: { c: Cistern; route: Route; closed?: boolean; queriesOpen?: boolean; children: ReactNode }) {
  const open = c.findings?.findings.filter((f) => f.status === "open") ?? [];
  const awaiting = open.some((f) => deskOf(f, c.plans, c.run, c.openIds).proposal);
  const counts: Partial<Record<Page, number | undefined>> = {
    inbox: c.findings ? open.length : undefined,
    done: c.findings ? c.findings.past.length : undefined,
    fixes: c.plans.length || undefined,
    audit: c.runList.length || undefined,
  };
  const at = queriesOpen ? "queries" : placeOf(route, closed);
  const runTone = c.run?.status === "running" ? "info" : c.run?.status === "awaiting_approval" ? "amber" : null;

  return (
    <div className="shell">
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
        <Session c={c} />
      </aside>
      <main className="main">
        {c.problem && (
          <p className="problem" role="alert">
            {c.problem} <button className="link" onClick={c.dismiss}>Dismiss</button>
          </p>
        )}
        {/* keyed so a new page fades in; a finding is its own page, a selection inside a page is not; the queries drawer lies over whatever is under it */}
        <div className="view" key={`${route.scenario}/${route.page}${route.page === "finding" ? `/${route.id}` : ""}`}>{children}</div>
      </main>
    </div>
  );
}
