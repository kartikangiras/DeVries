// Small pieces the landing page is built from: an in-view hook, a reveal wrapper that stands in for
// motion's whileInView, the ambient background drawn on a canvas, the marks of
// MCP servers, and a few glyphs drawn here so no icon library is needed.

import { createElement, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { About } from "../api";
import { byId } from "./servers";

/** The engine's cost of each kind of fix, as shipped: what the landing prices with until /api/about answers. */
export const ENGINE_COSTS: Record<string, number> = { revoke_call: 1, gate_call: 2, quarantine_delegation: 2, drop_read: 3, split_agent: 4 };
/** The cost of a kind of fix: the server's figure, else the engine's. */
export const costOf = (about: About | null, fix: string): number => about?.fix_costs[fix] ?? ENGINE_COSTS[fix] ?? 0;
/** A finding's id without its prefix, as the landing writes it. */
export const DEMO_FINDING = "dce0910d42";

export function useInView<T extends HTMLElement>({ margin = "0px", amount = 0, once = true }: { margin?: string; amount?: number; once?: boolean } = {}) {
  const ref = useRef<T>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setInView(true);
          if (once) io.disconnect();
        } else if (!once) setInView(false);
      },
      { rootMargin: margin, threshold: amount },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [margin, amount, once]);
  return [ref, inView] as const;
}

type RevealProps = {
  as?: "div" | "section" | "article" | "h2" | "p" | "footer" | "li";
  id?: string;
  className?: string;
  delay?: number;
  duration?: number;
  y?: number;
  x?: number;
  scale?: number;
  margin?: string;
  style?: CSSProperties;
  children?: ReactNode;
};

/** Fades and rises into place the first time it scrolls into view. */
export function Reveal({ as = "div", id, className = "", delay = 0, duration = 0.6, y = 24, x = 0, scale = 1, margin = "-100px", style, children }: RevealProps) {
  const [ref, inView] = useInView<HTMLElement>({ margin });
  return createElement(
    as,
    {
      ref,
      id,
      className: `l-reveal${inView ? " in" : ""}${className ? ` ${className}` : ""}`,
      style: { ...style, "--d": `${delay}s`, "--t": `${duration}s`, "--y": `${y}px`, "--x": `${x}px`, "--s": scale } as CSSProperties,
    },
    children,
  );
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A slow, dark field of colour with ripples crossing it: the water in a devries. It is drawn small
 * and blurred up, pauses off screen, and holds still when the visitor asks for reduced motion.
 */
export function Ambient({ seed = 1, hue = 250, strength = 1, className = "" }: { seed?: number; hue?: number; strength?: number; className?: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [wrap, inView] = useInView<HTMLDivElement>({ once: false, margin: "80px" });
  useEffect(() => {
    const el = canvas.current;
    if (!el || !inView) return;
    const ctx = el.getContext("2d");
    if (!ctx) return;
    const W = 240;
    const H = 135;
    el.width = W;
    el.height = H;
    const rnd = mulberry32(seed * 7919);
    const blobs = Array.from({ length: 8 }, () => ({
      x: rnd(), y: rnd(), r: 0.22 + rnd() * 0.3, sx: 0.5 + rnd(), sy: 0.4 + rnd(), ph: rnd() * Math.PI * 2,
      a: (0.09 + rnd() * 0.12) * strength, l: 36 + rnd() * 22, s: 38 + rnd() * 25, h: hue + (rnd() - 0.5) * 50,
    }));
    const ripples = Array.from({ length: 3 }, () => ({ x: 0.2 + rnd() * 0.6, y: 0.25 + rnd() * 0.5, ph: rnd() * 9, period: 7 + rnd() * 5 }));
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let raf = 0;
    let last = 0;
    const draw = (t: number) => {
      ctx.globalCompositeOperation = "source-over";
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, W, H);
      ctx.globalCompositeOperation = "lighter";
      for (const b of blobs) {
        const x = (b.x + Math.sin(t * 0.00006 * b.sx + b.ph) * 0.16) * W;
        const y = (b.y + Math.cos(t * 0.00005 * b.sy + b.ph) * 0.12) * H;
        const r = b.r * W;
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, `hsla(${b.h}, ${b.s}%, ${b.l}%, ${b.a})`);
        g.addColorStop(1, `hsla(${b.h}, ${b.s}%, ${b.l}%, 0)`);
        ctx.fillStyle = g;
        ctx.fillRect(x - r, y - r, r * 2, r * 2);
      }
      for (const rp of ripples) {
        const k = ((t / 1000 + rp.ph) % rp.period) / rp.period;
        for (let i = 0; i < 3; i++) {
          const kk = (k + i * 0.18) % 1;
          ctx.beginPath();
          ctx.ellipse(rp.x * W, rp.y * H, 6 + kk * 70, (6 + kk * 70) * 0.42, 0, 0, Math.PI * 2);
          ctx.strokeStyle = `hsla(${hue}, 45%, 70%, ${(1 - kk) * 0.16 * strength})`;
          ctx.lineWidth = 1.2 - kk * 0.8;
          ctx.stroke();
        }
      }
    };
    const tick = (t: number) => {
      if (t - last > 40) {
        draw(t);
        last = t;
      }
      raf = requestAnimationFrame(tick);
    };
    if (still) draw(0);
    else raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [seed, hue, strength, inView]);
  return (
    <div ref={wrap} className={`l-ambient${className ? ` ${className}` : ""}`} aria-hidden>
      <canvas ref={canvas} />
      <div className="l-grain" />
    </div>
  );
}

/** The mark of an MCP server, in its brand colour, or in ink where the brand's colour is black. */
export function ServerIcon({ id, size = 18, tinted = true }: { id: string; size?: number; tinted?: boolean }) {
  const s = byId[id];
  if (!s) {
    return <span className="l-ico-fallback" style={{ width: size, height: size }}>{id.slice(0, 2).toUpperCase()}</span>;
  }
  const fill = tinted ? (s.ink ? "var(--ink-strong)" : `#${s.icon.hex}`) : "currentColor";
  return (
    <svg role="img" aria-label={s.name} width={size} height={size} viewBox="0 0 24 24" fill={fill}>
      <path d={s.icon.path} />
    </svg>
  );
}

export function Arrow({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M5 12h14" />
      <path d="m12 5 7 7-7 7" />
    </svg>
  );
}

export function Check({ size = 12, width = 3 }: { size?: number; width?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

export function Cross({ size = 12, width = 3 }: { size?: number; width?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}

export function Spinner({ size = 11 }: { size?: number }) {
  return (
    <svg className="l-spin" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" aria-hidden>
      <path d="M21 12a9 9 0 1 1-6.2-8.56" />
    </svg>
  );
}
