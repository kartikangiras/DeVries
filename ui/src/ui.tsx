// The small pieces every page is made of. Their shapes and sizes follow Manthan's page, button and
// badge components (see ui/THIRD_PARTY_NOTICES.md); the code and the icons are DeVries's own.

import { useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import type { Tone } from "./desk";

export function Eyebrow({ children, tone, className = "" }: { children: ReactNode; tone?: Tone; className?: string }) {
  return <div className={`eyebrow${tone ? ` t-${tone}` : ""} ${className}`}>{children}</div>;
}

/** A status as a dot and a word. The word carries the meaning; the dot only helps the eye find it. */
export function Status({ tone, pulse, children, wide }: { tone: Tone; pulse?: boolean; children: ReactNode; wide?: boolean }) {
  return (
    <span className={`status t-${tone}${wide ? " wide" : ""}`}>
      <i className={pulse ? "pulse" : ""} aria-hidden />
      {children}
    </span>
  );
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" | "accent" | "danger"; size?: "sm" | "md" | "lg" };

export function Button({ variant = "secondary", size = "md", className = "", ...rest }: ButtonProps) {
  return <button className={`btn btn-${variant} btn-${size} ${className}`} {...rest} />;
}

/** A page's outer measure and rhythm. */
export function PageBody({ children, width = "default" }: { children: ReactNode; width?: "default" | "wide" }) {
  return (
    <div className="scroll">
      <div className={`page page-${width}`}>{children}</div>
    </div>
  );
}

/** A page's own header: a small label, a sentence for a title, a line under it, and at most one action. */
export function PageHeader({ eyebrow, title, meta, actions }: { eyebrow: ReactNode; title: ReactNode; meta?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="page-head">
      <div>
        <Eyebrow>{eyebrow}</Eyebrow>
        <h1>{title}</h1>
        {meta && <p className="page-meta">{meta}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  );
}

export function Loading({ label = "Loading" }: { label?: string }) {
  return (
    <p className="loading">
      {label}
      <span className="pulse-text">…</span>
    </p>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}

/** A section of a page: a small label, at most one line of fact beside it, then what it holds. */
export function Block({ eyebrow, aside, className = "", children }: { eyebrow: ReactNode; aside?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <section className={`block ${className}`}>
      <div className="block-head">
        <Eyebrow>{eyebrow}</Eyebrow>
        {aside && <span>{aside}</span>}
      </div>
      {children}
    </section>
  );
}

/** Something a person can ask for but need not read: folded under one line, and made only once it is opened. */
export function Fold({ summary, sub, open: initially = false, className = "", children }: { summary: ReactNode; sub?: ReactNode; open?: boolean; className?: string; children: ReactNode }) {
  const [open, setOpen] = useState(initially);
  return (
    <details className={`fold ${className}`} open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>
        <span className="eyebrow">{summary}</span>
        {sub && <span className="fold-sub">{sub}</span>}
      </summary>
      {open && <div className="fold-body">{children}</div>}
    </details>
  );
}

/** A verdict or a posture in figures: what a person reads before the words. A long word reads smaller. */
export function Figures({ items }: { items: { n: ReactNode; label: string; tone?: "good" | "bad" }[] }) {
  return (
    <dl className="figures">
      {items.map((it) => (
        <div key={it.label} className={it.tone ?? ""}>
          <dd className={typeof it.n === "string" && it.n.length > 7 ? "word" : ""}>{it.n}</dd>
          <dt>{it.label}</dt>
        </div>
      ))}
    </dl>
  );
}

/** A label and its value on one line, the value to the right. */
export function KV({ k, children, title }: { k: string; children: ReactNode; title?: string }) {
  return (
    <div className="kv" title={title}>
      <dt>{k}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** A row of filters where exactly one is on. */
export function Tabs<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: { value: T; label: string; count?: number }[]; label: string }) {
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} role="tab" aria-selected={o.value === value} className={o.value === value ? "on" : ""} onClick={() => onChange(o.value)}>
          {o.label}
          {o.count !== undefined && <span className="n">{o.count}</span>}
        </button>
      ))}
    </div>
  );
}

const ICONS = {
  inbox: <><path d="M4 13.5 6.6 5.5h10.8L20 13.5V18a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z" /><path d="M4 13.5h4.4a3.6 3.6 0 0 0 7.2 0H20" /></>,
  done: <><circle cx="12" cy="12" r="8.5" /><path d="m8.4 12.3 2.4 2.4 4.8-5.2" /></>,
  fixes: <><path d="M6 4.5h12v15H6z" /><path d="M9 9h6M9 12.5h6M9 16h3.5" /></>,
  graph: <><circle cx="6" cy="7" r="2.2" /><circle cx="18" cy="7" r="2.2" /><circle cx="12" cy="17.5" r="2.2" /><path d="M8.2 7h7.6M7.1 8.9l3.8 6.7M16.9 8.9l-3.8 6.7" /></>,
  audit: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>,
  queries: <path d="M8.5 6 4 12l4.5 6M15.5 6 20 12l-4.5 6" />,
  switch: <path d="m8 10 4-4 4 4M8 14l4 4 4-4" />,
  right: <path d="M5 12h14M13 6l6 6-6 6" />,
  reset: <path d="M4.5 12a7.5 7.5 0 1 0 2.4-5.5M4.5 4.5v4h4" />,
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  cross: <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />,
  search: <><circle cx="11" cy="11" r="6.5" /><path d="m20 20-4.3-4.3" /></>,
  servers: <><rect x="4" y="4.5" width="16" height="6" rx="1.5" /><rect x="4" y="13.5" width="16" height="6" rx="1.5" /><path d="M7.5 7.5h.01M7.5 16.5h.01" /></>,
  whatif: <><path d="M6 18V9a3 3 0 0 1 3-3h9" /><path d="m14 2.5 4 3.5-4 3.5" /><path d="M6 18h7" /><circle cx="6" cy="18" r="0.6" /></>,
  import: <><path d="M12 4v10" /><path d="m8 10.5 4 4 4-4" /><path d="M4 15.5V18a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2.5" /></>,
  posture: <><path d="M4 17.5a8 8 0 0 1 16 0" /><path d="M12 17.5 15.5 11" /><circle cx="12" cy="17.5" r="1.2" /></>,
  inventory: <><path d="M4.5 6.5h15M4.5 12h15M4.5 17.5h15" /><circle cx="4.5" cy="6.5" r="0.7" /><circle cx="4.5" cy="12" r="0.7" /><circle cx="4.5" cy="17.5" r="0.7" /></>,
} as const;
export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 20 }: { name: keyof typeof ICONS; size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {ICONS[name]}
    </svg>
  );
}

/** DeVries's mark: a basin and its outlet. */
export function Mark({ size = 24 }: { size?: number }) {
  return <img className="mark" src="/brand/mark.png" width={size} height={size} alt="" aria-hidden />;
}
