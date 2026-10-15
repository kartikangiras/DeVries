// The landing page: what Cistern is, before the app. Its structure, its measurements and its motion
// follow Manthan's landing page (manthan-ui/src/pages/Landing.tsx, Copyright 2026 Manthan
// Engineering, Apache-2.0; see ui/THIRD_PARTY_NOTICES.md), rewritten as plain React and CSS for
// Cistern's own content, with the accent moved from emerald to iris and the videos replaced by a
// drawn background. Routes stay in the hash: the bare address is this page, "#/acme_support" is the app.

import { useEffect, useRef, useState, type CSSProperties, type MouseEvent } from "react";
import type { Scenario } from "../api";
import { href } from "../route";
import { Mark } from "../ui";
import { Anatomy } from "./Anatomy";
import { Ambient, Arrow, PlayGlyph, Reveal, ServerIcon } from "./bits";
import { HeroDemo } from "./HeroDemo";
import { ExplainScene, FixScene, ScanScene } from "./Scenes";
import { MARQUEE } from "./servers";

const HACKATHON = "https://www.wemakedevs.org/hackathons/falkordb";
const FALKORDB = "https://www.falkordb.com/";

export function Landing({ scenarios }: { scenarios: Scenario[] }) {
  const first = scenarios[0]?.id ?? "acme_support";
  const app = href(first);
  const queries = href(first, "queries");
  useEffect(() => {
    document.body.classList.add("landing-body");
    return () => document.body.classList.remove("landing-body");
  }, []);
  return (
    <div className="landing" id="top">
      <Hero app={app} />
      <Manifesto />
      <Stack />
      <HowItWorks />
      <AnatomySection />
      <RunIt app={app} queries={queries} />
      <Footer app={app} queries={queries} />
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

/* ---- 1 · hero: the copy in the upper band, the showcase beneath it, no overlap */

function Hero({ app }: { app: string }) {
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
          <Mark size={26} />
          <span>Cistern</span>
        </a>
        <div className="l-nav-right">
          <a href="#/" className="l-nav-link" onClick={jump("how")}>How it works</a>
          <a href={app} className="l-pill-white">Open the app</a>
        </div>
      </nav>

      <div ref={copy} className="l-hero-copy">
        <div className="l-enter d0">
          <a className="l-announce" href={HACKATHON} target="_blank" rel="noopener noreferrer">
            <span className="l-chip">Graph Hacks</span>
            <span className="l-announce-text">Track 01 · Agents that act on connected data</span>
            <span className="l-announce-arrow" aria-hidden>→</span>
          </a>
        </div>
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
          <a href={app} className="l-cta">Open the app <Arrow /></a>
        </div>
      </div>

      <div className="l-showcase l-enter-fade">
        <div className="l-showcase-frame">
          <Ambient seed={3} strength={0.75} />
          <div className="l-showcase-vignette" />
          <div className="l-showcase-top" />
          <div className="l-showcase-demo">
            <div className="l-showcase-demo-inner"><HeroDemo appHref={app} /></div>
          </div>
          <div className="l-showcase-fade" />
        </div>
      </div>
    </section>
  );
}

/* ---- 2 · manifesto: one sentence, lit word by word as it is scrolled into */

const LINE =
  "A list of grants never tells the whole story. Cistern puts every agent, tool, data source and resource in one " +
  "FalkorDB graph, derives where text can flow, finds each path to a payment or a deploy, and tests the fix on a " +
  "copy before anyone is asked.";

function Manifesto() {
  const section = useRef<HTMLElement>(null);
  const words = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const el = section.current;
        const w = words.current;
        if (!el || !w) return;
        const r = el.getBoundingClientRect();
        const vh = window.innerHeight;
        const start = vh * 0.85;
        const end = vh / 2 - r.height / 2;
        const p = Math.min(1, Math.max(0, (start - r.top) / (start - end)));
        w.style.setProperty("--p", p.toFixed(3));
      });
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      cancelAnimationFrame(raf);
    };
  }, []);
  const parts = LINE.split(" ");
  return (
    <section ref={section} className="l-manifesto">
      <Reveal className="l-manifesto-inner" y={50} margin="-120px" duration={0.7}>
        <Reveal className="l-manifesto-label" y={16} delay={0.05} duration={0.5} margin="-120px">
          <span className="l-quote" aria-hidden>“</span>
          <span>How Cistern works</span>
        </Reveal>
        <Reveal className="l-words" y={24} delay={0.12} duration={0.7} margin="-120px">
          <div ref={words} className="l-words-inner" style={{ "--n": parts.length } as CSSProperties}>
            {parts.map((word, i) => (
              <span key={i} className="l-word" style={{ "--i": i / parts.length } as CSSProperties}>{word}</span>
            ))}
          </div>
        </Reveal>
      </Reveal>
    </section>
  );
}

/* ---- 3 · the stack: a card, and a marquee of MCP servers that magnifies under the pointer */

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
            Claude Desktop, Cursor, a command, a URL or a saved tools/list. Cistern loads every MCP server it
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

/* ---- 4 · how it works: three verbs, each with a scene */

const STEPS = [
  {
    num: "01",
    verb: "Scan.",
    copy:
      "Seven rules turn the configuration into a second layer of edges that say where text and data can flow. Two graph queries over that layer find every injection path and every lethal trifecta, with FalkorDB doing the search, in milliseconds.",
    scene: <ScanScene />,
  },
  {
    num: "02",
    verb: "Explain.",
    copy:
      "Each finding comes with its path, hop by hop, each hop naming the rule that made it and the config edge behind it. The longest in the bundled scenarios is eleven hops, through three agents, a push to a branch and a deploy.",
    scene: <ExplainScene />,
  },
  {
    num: "03",
    verb: "Fix, within your gates.",
    copy:
      "Candidate fixes come from the config edges the path crosses. Each is applied to a copy of the graph and judged by the same queries: the finding gone, nothing new, every workflow intact. The cheapest that passes waits for your nod. No tool can approve.",
    scene: <FixScene />,
  },
];

function HowItWorks() {
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
              <Reveal className="l-step-visual" x={16} y={0} delay={i * 0.12 + 0.18} margin="-80px">{s.scene}</Reveal>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ---- 5 · anatomy of a finding */

function AnatomySection() {
  return (
    <section id="anatomy" className="l-anatomy">
      <div className="l-wrap-7xl">
        <Reveal className="l-section-head short" y={24}>
          <h2 className="l-h2">
            Every finding shows its work.
            <br />
            <em>Every fix keeps a trail.</em>
          </h2>
        </Reveal>
        <Anatomy />
      </div>
    </section>
  );
}

/* ---- 6 · run it: where Manthan prices, Cistern says one command */

const CLOSED = ["The finding is gone", "No new finding appeared", "Every workflow still has what it needs"];
const COUNTS: [string, string][] = [["Rules", "7"], ["Kinds of fix", "5"], ["Queries", "81"], ["MCP tools", "11"], ["Scenarios", "4"]];

function RunIt({ app, queries }: { app: string; queries: string }) {
  const importHref = app.replace(/\/?$/, "/import");
  return (
    <section id="run" className="l-run">
      <div className="l-wrap-4xl l-center">
        <Reveal as="h2" className="l-h2" y={16} delay={0.05} duration={0.5}>
          Four scenarios, already audited, in <em>one click.</em>
        </Reveal>
        <Reveal className="l-price" y={24} scale={0.96} delay={0.15} duration={0.7} margin="-80px">
          <span className="l-price-cmd l-price-word">Try it.</span>
          <span className="l-price-unit">/ nothing to install</span>
        </Reveal>
        <Reveal as="p" className="l-run-sub" y={0} delay={0.3} duration={0.5} margin="-80px">
          The support desk, the executive office, the dev team and Cistern itself are loaded, scanned, and their first plans tested. Paste your own client config or a tools/list to audit what you actually run.
        </Reveal>
        <Reveal className="l-run-ctas" y={12} delay={0.35} duration={0.5} margin="-80px">
          <a href={app} className="l-btn-accent">Open the app <Arrow /></a>
          <a href={importHref} className="l-pill-white">Paste your config</a>
          <a href="#/" className="l-text-link" onClick={jump("how")}>Or read how it works first</a>
        </Reveal>
        <Reveal className="l-outcomes" y={16} delay={0.45} duration={0.55} margin="-60px">
          <span className="eyebrow">Closed =</span>
          {CLOSED.map((o, i) => (
            <span key={o}>
              <span className="l-outcome">{o}</span>
              {i < CLOSED.length - 1 && <span className="l-sep">{" · "}</span>}
            </span>
          ))}
        </Reveal>
        <Reveal className="l-bands" y={16} delay={0.55} duration={0.55} margin="-60px">
          {COUNTS.map(([label, n], i) => (
            <span key={label} className="l-band">
              <span className="l-band-label">{label}</span>
              <span className="l-band-n">{n}</span>
              {i < COUNTS.length - 1 && <span className="l-sep">·</span>}
            </span>
          ))}
        </Reveal>
        <Reveal className="l-enterprise" y={0} delay={0.7} duration={0.5} margin="-60px">
          Or run it yourself: <code>make app</code> with Docker, then localhost:8000; <code>make mcp-config</code> prints the entry for an MCP client.{" "}
          <a href={queries} className="l-enterprise-link">See every query it runs <Arrow size={12} /></a>
        </Reveal>
      </div>
    </section>
  );
}

/* ---- 7 · footer: two cards and a watermark */

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

function Footer({ app, queries }: { app: string; queries: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText("make app");
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      /* the clipboard is not always allowed; the command is on the page anyway */
    }
  };
  const nav: FLink[] = [
    { label: "How it works", href: "#/", jump: "how" },
    { label: "Anatomy of a finding", href: "#/", jump: "anatomy" },
    { label: "Run it", href: "#/", jump: "run" },
    { label: "Open the app", href: app },
  ];
  const project: FLink[] = [
    { label: "The queries", href: queries },
    { label: "FalkorDB", href: FALKORDB, ext: true },
    { label: "Graph Hacks", href: HACKATHON, ext: true },
  ];
  return (
    <footer className="l-footer">
      <Reveal className="l-footer-grid" y={40} duration={0.7} margin="-80px">
        <Reveal className="l-fcard-left" y={28} scale={0.985} delay={0.05} duration={0.7} margin="-80px">
          <Ambient seed={9} strength={0.9} />
          <div className="l-fcard-vignette" />
          <div className="l-fbrand">
            <Mark size={28} />
            <span>Cistern</span>
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
              <a href={HACKATHON} target="_blank" rel="noopener noreferrer">Graph Hacks ↗</a>
            </div>
          </div>
        </Reveal>

        <Reveal className="l-fcard-right" y={28} scale={0.985} delay={0.15} duration={0.7} margin="-80px">
          <a href={app} className="l-fbadge" aria-label="Open the app">
            <span className="l-fbadge-tile"><PlayGlyph size={40} /></span>
            <span className="l-fbadge-say">
              <svg viewBox="0 0 24 24" width={22} height={22} aria-hidden>
                <path d="M3 20 C 6 14, 10 9, 18 5" />
                <path d="M18 5 L 12 5" />
                <path d="M18 5 L 18 11" />
              </svg>
              <span>Open the app</span>
            </span>
          </a>
          <div className="l-fcols">
            <FooterCol title="Navigation" links={nav} />
            <FooterCol title="Project" links={project} />
          </div>
          <div className="l-fbottom">
            <span className="l-fcopy">© {new Date().getFullYear()} Cistern. Built for Graph Hacks: Context for AI Agents.</span>
            <div className="l-fsub">
              <h4>
                Run it yourself.
                <br />
                <strong>One command, four scenarios.</strong>
              </h4>
              <div className="l-copy-box">
                <code>make app</code>
                <button type="button" onClick={copy}>{copied ? "Copied" : "Copy"}</button>
              </div>
            </div>
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
        <text ref={text} x={500} y={240} textAnchor="middle" fontSize={320}>Cistern</text>
      </svg>
    </Reveal>
  );
}
