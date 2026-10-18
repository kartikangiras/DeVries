// The landing page: what DeVries is, before the app, in plain React and CSS with a drawn background.
// Routes stay in the hash: the bare address is this page, "#/acme_support" is the app.

import { Fragment, useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { api, type About, type Scenario } from "../api";
import { CATALOG, href } from "../route";
import { capital, countWord, short } from "../text";
import { Mark } from "../ui";
import { Anatomy } from "./Anatomy";
import { Ambient, Arrow, DEMO_FINDING, ENGINE_COSTS, Reveal, ServerIcon } from "./bits";
import { HeroDemo } from "./HeroDemo";
import { LiveGraph } from "./LiveGraph";
import { ExplainScene, FixScene, ScanScene } from "./Scenes";
import { MARQUEE } from "./servers";

const FALKORDB = "https://www.falkordb.com/";

/** The finding the demo and the scenes tell: the support desk's first open injection path, read from the app once and
 *  kept for the session; the id it shipped with until then, or if the desk is not loaded here. */
let demoFinding: string | null = null;
function useDemoFinding(): string {
  const [id, setId] = useState(demoFinding ?? DEMO_FINDING);
  useEffect(() => {
    if (demoFinding) return;
    api.findings("acme_support")
      .then((answer) => {
        const open = answer.findings.find((f) => f.kind === "injection" && f.status === "open");
        const found = open ?? answer.past.find((f) => f.kind === "injection");
        if (found) {
          demoFinding = short(found.id);
          setId(demoFinding);
        }
      })
      .catch(() => {});
  }, []);
  return id;
}

/** `scenarios` and `queries` are what the server lists, `about` what the build says of itself (/api/about): the
 *  counts, the costs and the eval on the page are theirs, not typed in. */
export function Landing({ scenarios, queries, about }: { scenarios: Scenario[]; queries: number; about: About | null }) {
  const first = scenarios[0]?.id ?? "acme_support";
  const app = href(first);                       // the demo's own link: the support desk it tells
  const start = href(CATALOG);                   // "Open the app": the front door, every scenario as a card
  const queriesHref = href(first, "method", "queries");
  const findingId = useDemoFinding();
  // the lists and /api/about arrive a moment after the page; until then the figures are what the server shipped with
  const counts: Counts = {
    scenarios: scenarios.length || about?.scenarios || 9,
    queries: queries || about?.queries || 90,
    rules: about?.rules ?? 7,
    kinds: about ? Object.keys(about.fix_costs).length : Object.keys(ENGINE_COSTS).length,
    tools: about?.mcp_tools ?? 11,
  };
  useEffect(() => {
    document.body.classList.add("landing-body");
    return () => document.body.classList.remove("landing-body");
  }, []);
  return (
    <div className="landing" id="top">
      <Hero app={app} start={start} about={about} findingId={findingId} />
      <Stack />
      <HowItWorks findingId={findingId} />
      <Inside queries={counts.queries} tools={counts.tools} />
      <AnatomySection about={about} />
      <RunIt start={start} counts={counts} />
      <Footer start={start} queries={queriesHref} />
    </div>
  );
}

/** An in-page link: scrolls without touching the hash, which is the route. */
function jump(id: string) {
  return (e: MouseEvent) => {
    e.preventDefault();
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
}

/* ---- 1 · hero: the copy in the upper band, the showcase beneath it, FalkorDB's part in one line under that */

/** What FalkorDB does, said once: the search, the sandbox and the cut. */
const FACTS: ReactNode[] = [
  "Verdicts are BFS over the flow layer in FalkorDB",
  <>Every fix is tested on a <code>GRAPH.COPY</code>, then the copy is deleted</>,
  "The cheapest cut is max flow, with capacities that keep the workflows",
];

function Hero({ app, start, about, findingId }: { app: string; start: string; about: About | null; findingId: string }) {
  const section = useRef<HTMLElement>(null);
  const copy = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const el = section.current;
        const c = copy.current;
        if (!el || !c) return;
        const p = Math.min(1, Math.max(0, -el.getBoundingClientRect().top / el.offsetHeight));
        c.style.transform = `translateY(${-120 * p}px)`;
        c.style.opacity = String(Math.max(0, 1 - p / 0.6));
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(raf);
    };
  }, []);
  return (
    <section ref={section} className="l-hero">
      <nav className="l-nav">
        <a href="#/" className="l-brand" onClick={jump("top")}>
          <Mark size={30} />
          <span>DeVries</span>
        </a>
        <div className="l-nav-right">
          <a href="#/" className="l-nav-link" onClick={jump("how")}>How it works</a>
          <a href={start} className="l-pill-white">Open the app</a>
        </div>
      </nav>

      <div ref={copy} className="l-hero-copy">
        <h1 className="l-h1 l-enter d1">
          The audit layer for
          <br />
          <em>systems of agents.</em>
        </h1>
        <p className="l-sub l-enter d2">
          Finds every path by which untrusted text can reach a high-impact action, hop by hop, and the smallest
          change to the configuration that closes it. Every fix is tested on a copy of the graph.{" "}
          <span className="l-white">Nothing changes until a person approves.</span>
        </p>
        <div className="l-enter d3">
          <a href={start} className="l-cta">Open the app <Arrow /></a>
        </div>
      </div>

      <div className="l-showcase l-enter-fade">
        <div className="l-showcase-frame">
          <Ambient seed={3} strength={0.75} />
          <div className="l-showcase-vignette" />
          <div className="l-showcase-top" />
          <div className="l-showcase-demo">
            <div className="l-showcase-demo-inner"><HeroDemo appHref={app} about={about} findingId={findingId} /></div>
          </div>
          <div className="l-showcase-fade" />
        </div>
      </div>

      <p className="l-facts l-enter-fade">
        {FACTS.map((fact, i) => (
          <span key={i}>
            <span className="l-fact">{fact}</span>
            {i < FACTS.length - 1 && <span className="l-sep">{" · "}</span>}
          </span>
        ))}
      </p>
    </section>
  );
}

/* ---- 2 · the stack: a card, and a marquee of MCP servers that magnifies under the pointer */

function Stack() {
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const o = outer.current;
    const n = inner.current;
    if (!o || !n) return;
    const icons = Array.from(n.querySelectorAll<HTMLElement>("[data-dock]"));
    if (!icons.length) return;
    const ICON_W = 124;
    const min = ICON_W + 14;
    const max = min * 1.32;
    const bound = min * Math.PI;
    const onMove = (e: globalThis.MouseEvent) => {
      const first = icons[0].getBoundingClientRect();
      const pointer = e.clientX - first.left;
      icons.forEach((el, i) => {
        const center = i * min + min / 2;
        const d = center - pointer;
        let x = 0;
        let scale = 1;
        if (-bound < d && d < bound) {
          const rad = (d / min) * 0.5;
          scale = 1 + (max / min - 1) * Math.cos(rad);
          x = 2 * (max - min) * Math.sin(rad);
        } else {
          x = (-bound < d ? 2 : -2) * (max - min);
        }
        el.style.transform = `translateX(${x.toFixed(1)}px) scale(${scale.toFixed(3)})`;
      });
    };
    const onEnter = () => {
      n.style.animationPlayState = "paused";
    };
    const onLeave = () => {
      icons.forEach((el) => {
        el.style.transform = "";
      });
      n.style.animationPlayState = "running";
    };
    o.addEventListener("mouseenter", onEnter);
    o.addEventListener("mousemove", onMove);
    o.addEventListener("mouseleave", onLeave);
    return () => {
      o.removeEventListener("mouseenter", onEnter);
      o.removeEventListener("mousemove", onMove);
      o.removeEventListener("mouseleave", onLeave);
    };
  }, []);
  const loop = [...MARQUEE, ...MARQUEE];
  return (
    <section className="l-stack">
      <Reveal className="l-stack-card" y={28}>
        <Ambient seed={5} strength={0.85} />
        <div className="l-stack-vignette" />
        <Reveal className="l-stack-copy" y={16} delay={0.1} duration={0.7}>
          <h2 className="l-h2">
            Load the config
            <br />
            <em>your agents already run.</em>
          </h2>
          <p>
            Claude Desktop, Cursor, a command, a URL or a saved tools/list. DeVries loads every MCP server it
            finds, classifies each tool it lists, and audits the whole system as one graph.
          </p>
        </Reveal>
      </Reveal>
      <Reveal className="l-marquee" y={20} delay={0.25} duration={0.7} margin="-80px">
        <div ref={outer} className="l-marquee-mask">
          <div ref={inner} className="l-marquee-inner">
            {loop.map((id, i) => (
              <div key={`${id}-${i}`} data-dock className="l-dock-icon"><ServerIcon id={id} size={36} /></div>
            ))}
          </div>
        </div>
      </Reveal>
    </section>
  );
}

/* ---- 3 · how it works: three verbs, each with a scene */

/** Each step's scene is drawn for the finding the landing tells, so the id in it is the app's. */
const STEPS: { num: string; verb: string; copy: string; scene: (findingId: string) => ReactNode }[] = [
  {
    num: "01",
    verb: "Scan.",
    copy:
      "Seven rules turn the configuration into a second layer of edges that say where text and data can flow. Two graph queries over that layer find every injection path and every lethal trifecta, an agent holding untrusted input, private data and a way out at once; FalkorDB does the search, in milliseconds.",
    scene: () => <ScanScene />,
  },
  {
    num: "02",
    verb: "Explain.",
    copy:
      "Each finding comes with its path, hop by hop, each hop naming the rule that made it and the config edge behind it. The longest in the bundled scenarios is eleven hops, through three agents, a push to a branch and a deploy.",
    scene: (findingId) => <ExplainScene findingId={findingId} />,
  },
  {
    num: "03",
    verb: "Fix, within your gates.",
    copy:
      "Candidate fixes come from the config edges the path crosses. Each is applied to a copy of the graph and judged by the same queries: the finding gone, nothing new, every workflow intact. The cheapest that passes waits for your approval. No tool can approve.",
    scene: () => <FixScene />,
  },
];

function HowItWorks({ findingId }: { findingId: string }) {
  return (
    <section id="how" className="l-how">
      <div className="l-wrap-6xl">
        <Reveal className="l-section-head" y={24}>
          <h2 className="l-h2">From a config to a <em>closed finding.</em></h2>
          <p className="l-lead">Three steps. Seven rules. Every verdict is a graph query.</p>
        </Reveal>
        <div>
          {STEPS.map((s, i) => (
            <Reveal key={s.num} className={`l-step${i === STEPS.length - 1 ? " last" : ""}`} y={28} delay={i * 0.12} margin="-80px">
              <div className="l-step-num">{s.num}</div>
              <div className="l-step-body">
                <h3 className="l-step-verb">{s.verb}</h3>
                <p className="l-step-copy">{s.copy}</p>
              </div>
              <Reveal className="l-step-visual" x={16} y={0} delay={i * 0.12 + 0.18} margin="-80px">{s.scene(findingId)}</Reveal>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ---- 4 · inside the app: the places, and the queries under each */

type Place = { where: string; title: string; body: ReactNode; queries: string[] };

/** Each place in the app, what it shows, and the catalog queries that feed it. `tools` is the MCP tool count the server reports. */
function places(tools: number): Place[] {
  return [
    {
      where: "Posture",
      title: "Where the system stands.",
      body: "The Rule of Two tally, what untrusted text reaches, the blast radius of each source, the choke points, and the cheapest cut that closes everything open while every workflow keeps what it needs. The OWASP entries the open findings fall under, and the history across scans.",
      queries: ["reach.untrusted_to_high", "choke.maxflow", "choke.betweenness"],
    },
    {
      where: "Open · Closed",
      title: "Findings as memos.",
      body: "A finding reads Summary, Rule, Path, Fix, Options. The path comes hop by hop, each hop citing the rule that made it and the config edge behind it. The plans tested against it sit on the Fix step; the ones that failed sit on Options, with why.",
      queries: ["evidence.pair_paths", "find.trifecta", "finding.list"],
    },
    {
      where: "Fix step",
      title: "The fix becomes your config.",
      body: "An approved plan compiles to a change in the client config it came from, secrets redacted, shown as a draft under the approval bar with the hash of the config it was tested against. It is written to the file only when you tick it, and the scan that follows runs by itself.",
      queries: ["draft.record", "config.edges", "fix.gate_call"],
    },
    {
      where: "Explorer",
      title: "The whole graph, under lenses.",
      body: "Open paths, communities, the cut, the most central nodes; the flow layer, or the configuration beneath it. Pick a server, a grant or a delegation and the what-if line says what it would open, close or break, before anything is written.",
      queries: ["zones.communities", "choke.pagerank", "whatif.grant_call"],
    },
    {
      where: "Activity",
      title: "A record kept on the graph.",
      body: "Every scan, run, plan, decision and write, with who decided: model, search or person. A run opens to its trace, each step naming the query it ran and how long it took; its report cites the steps it rests on.",
      queries: ["run.list", "scan.history", "mitigation.list"],
    },
    {
      where: "Ask",
      title: "Questions the graph answers itself.",
      body: "What can reach a thing, what a thing reaches, whether there is a path between two, which workflows need a tool: each is one query, no model needed. With a key, the model answers in sentences and the run says which queries it ran.",
      queries: ["reach.into", "reach.from", "wf.needing"],
    },
    {
      where: "MCP",
      title: "An MCP server of its own.",
      body: `${capital(countWord(tools))} tools: scan, find paths, rank choke points, test a fix on a sandbox copy, propose it. Claude Code or any MCP client can drive the audit; approving a fix stays with a person. The auditor is itself one of the scenarios, held to the rules it checks.`,
      queries: ["/mcp", "GRAPH.COPY", "GRAPH.RO_QUERY"],
    },
    {
      where: "CI",
      title: "A gate for CI, and a watch on drift.",
      body: "One command loads a config, scans it and exits 1 while a finding is open. A server whose tool list changed since the last load is a finding of its own until someone accepts it.",
      queries: ["devries.ingest --fail-on open", "drift.before"],
    },
  ];
}

function Inside({ queries, tools }: { queries: number; tools: number }) {
  return (
    <section id="inside" className="l-inside">
      <div className="l-wrap-6xl">
        <Reveal className="l-section-head" y={24}>
          <h2 className="l-h2">One graph, <em>read from every page.</em></h2>
          <p className="l-lead">
            Each place in the app is a view of the same FalkorDB graph, read through {queries} named queries and no other Cypher. Under each, the queries that feed it.
          </p>
        </Reveal>
        <div className="l-places">
          {places(tools).map((p, i) => (
            <Reveal key={p.where} as="article" className="l-place" y={24} delay={(i % 4) * 0.08} duration={0.55} margin="-60px">
              <div className="l-place-where">{p.where}</div>
              <h3 className="l-place-title">{p.title}</h3>
              <p className="l-place-body">{p.body}</p>
              <p className="l-place-queries">
                {p.queries.map((q, j) => (
                  <Fragment key={q}>
                    {j > 0 && <span className="l-sep"> · </span>}
                    <span className="l-q">{q}</span>
                  </Fragment>
                ))}
              </p>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ---- 4 · the eval: the model beside the search */

function AnatomySection({ about }: { about: About | null }) {
  return (
    <section id="anatomy" className="l-anatomy">
      <div className="l-wrap-6xl">
        <Reveal className="l-section-head short" y={24}>
          <h2 className="l-h2">
            Every finding shows its work.
            <br />
            <em>Every run says what drove it.</em>
          </h2>
        </Reveal>
        <Anatomy about={about} />
      </div>
    </section>
  );
}

/* ---- 5 · the graph at work, then how to run it */

const CLOSED = ["The finding is gone", "No new finding appeared", "Every workflow still has what it needs"];
/** The figures in the bands: every one counted by the server (/api/about, the catalog, the scenario list), none typed in. */
type Counts = { scenarios: number; queries: number; rules: number; kinds: number; tools: number };

function RunIt({ start, counts }: { start: string; counts: Counts }) {
  const importHref = `${start}/import`;
  const bands: [string, string][] = [["Rules", String(counts.rules)], ["Kinds of fix", String(counts.kinds)], ["Queries", String(counts.queries)], ["MCP tools", String(counts.tools)], ["Scenarios", String(counts.scenarios)]];
  return (
    <section id="run" className="l-run">
      <div className="l-wrap-6xl">
        <Reveal className="l-section-head" y={24}>
          <h2 className="l-h2">The graph, <em>doing the work.</em></h2>
          <p className="l-lead">
            The support desk as FalkorDB holds it, drawn by the app's own renderer. Each lens is one query over the flow layer the seven rules wrote, and the caption names it.
          </p>
        </Reveal>
        <Reveal y={24} delay={0.1} duration={0.6} margin="-80px"><LiveGraph /></Reveal>
      </div>
      <div className="l-wrap-4xl l-center l-run-rest">
        <Reveal className="l-run-ctas" y={12} delay={0.05} duration={0.5} margin="-60px">
          <a href={start} className="l-text-link">Open the app</a>
          <a href={importHref} className="l-text-link">Audit your own config</a>
          <a href="#/" className="l-text-link" onClick={jump("how")}>Read how it works first</a>
        </Reveal>
        <Reveal className="l-outcomes" y={16} delay={0.15} duration={0.55} margin="-60px">
          <span className="eyebrow">Closed means</span>
          {CLOSED.map((o, i) => (
            <span key={o}>
              <span className="l-outcome">{o}</span>
              {i < CLOSED.length - 1 && <span className="l-sep">{" · "}</span>}
            </span>
          ))}
        </Reveal>
        <Reveal className="l-bands" y={16} delay={0.25} duration={0.55} margin="-60px">
          {bands.map(([label, n], i) => (
            <span key={label} className="l-band">
              <span className="l-band-label">{label}</span>
              <span className="l-band-n">{n}</span>
              {i < bands.length - 1 && <span className="l-sep">·</span>}
            </span>
          ))}
        </Reveal>
      </div>
    </section>
  );
}

/* ---- 6 · footer: two cards and a watermark */

type FLink = { label: string; href: string; ext?: boolean; jump?: string };

function FooterCol({ title, links }: { title: string; links: FLink[] }) {
  return (
    <div className="l-fcol">
      <div className="l-fcol-title">{title}</div>
      <ul>
        {links.map((l) => (
          <li key={l.label}>
            <a href={l.href} onClick={l.jump ? jump(l.jump) : undefined} {...(l.ext ? { target: "_blank", rel: "noopener noreferrer" } : {})}>
              {l.label}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Footer({ start, queries }: { start: string; queries: string }) {
  const nav: FLink[] = [
    { label: "How it works", href: "#/", jump: "how" },
    { label: "Inside the app", href: "#/", jump: "inside" },
    { label: "Model beside the search", href: "#/", jump: "anatomy" },
    { label: "The graph at work", href: "#/", jump: "run" },
    { label: "Open the app", href: start },
  ];
  const project: FLink[] = [
    { label: "The queries", href: queries },
    { label: "FalkorDB", href: FALKORDB, ext: true },
  ];
  return (
    <footer className="l-footer">
      <Reveal className="l-footer-grid" y={40} duration={0.7} margin="-80px">
        <Reveal className="l-fcard-left" y={28} scale={0.985} delay={0.05} duration={0.7} margin="-80px">
          <Ambient seed={9} strength={0.9} />
          <div className="l-fcard-vignette" />
          <div className="l-fbrand">
            <Mark size={32} />
            <span>DeVries</span>
          </div>
          <div className="l-ftag">
            <p>
              Injection paths in systems of agents,
              <br />
              <span className="l-ftag-em">found, explained and closed.</span>
            </p>
          </div>
          <div className="l-fsocial">
            <span className="l-fsocial-say">Built on FalkorDB.</span>
            <div className="l-fsocial-links">
              <a href={FALKORDB} target="_blank" rel="noopener noreferrer">FalkorDB ↗</a>
            </div>
          </div>
        </Reveal>

        <Reveal className="l-fcard-right" y={28} scale={0.985} delay={0.15} duration={0.7} margin="-80px">
          <div className="l-fcols">
            <FooterCol title="Navigation" links={nav} />
            <FooterCol title="Project" links={project} />
          </div>
          <div className="l-fbottom">
            <span className="l-fcopy">© {new Date().getFullYear()} DeVries. Built on FalkorDB.</span>
          </div>
        </Reveal>
      </Reveal>
      <Watermark />
    </footer>
  );
}

function Watermark() {
  const svg = useRef<SVGSVGElement>(null);
  const text = useRef<SVGTextElement>(null);
  useEffect(() => {
    const fit = () => {
      const s = svg.current;
      const t = text.current;
      if (!s || !t) return;
      try {
        const b = t.getBBox();
        // the word has no descenders, so crop the bottom of the box and let it hug the edge
        s.setAttribute("viewBox", `${b.x} ${b.y} ${b.width} ${b.height * 0.78}`);
      } catch {
        /* the fonts are not ready yet */
      }
    };
    document.fonts.ready.then(fit);
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);
  return (
    <Reveal className="l-watermark" y={24} delay={0.3} duration={0.9} margin="-40px">
      <svg ref={svg} viewBox="62 95 876 175" preserveAspectRatio="xMidYMid meet" aria-hidden>
        <text ref={text} x={500} y={240} textAnchor="middle" fontSize={320}>DeVries</text>
      </svg>
    </Reveal>
  );
}
