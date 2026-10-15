import type { ReactNode } from "react";
import type { Finding } from "./api";

/** Every id Cistern issues, as it appears in prose. The server's grounding check uses the same shape. */
export const ID = /\b(?:agent|tool|src|res|wf|srv|fnd|mit|scan|run):[A-Za-z0-9][A-Za-z0-9_.-]*/g;
const trimId = (raw: string) => raw.replace(/[.\-_]+$/, "");

export function idsIn(text: string): string[] {
  return [...new Set([...text.matchAll(ID)].map((m) => trimId(m[0])))];
}

/** An id without its prefix, for the places that already say what kind of thing it is. */
export const short = (id: string) => id.slice(id.indexOf(":") + 1);

type WithNamesProps = {
  text: string;
  names: Record<string, string>;
  /** Citation number for an id; the marker is put after the id's first appearance only. */
  cites?: Map<string, number>;
  onCite?: (n: number) => void;
  /** Where an id leads, if anywhere: findings and fixes have pages of their own. */
  link?: (id: string) => string | null;
};

/** Text with every node id shown as its name; the id stays one hover away. Optionally with footnote markers. */
export function WithNames({ text, names, cites, onCite, link }: WithNamesProps) {
  const out: ReactNode[] = [];
  const cited = new Set<string>();
  let last = 0;
  for (const match of text.matchAll(ID)) {
    const id = trimId(match[0]);
    const start = match.index ?? 0;
    const to = link?.(id);
    out.push(text.slice(last, start));
    out.push(
      to ? (
        <a className="id" href={to} key={start}>{id}</a>
      ) : names[id] ? (
        // tools keep the look of code; everything else that has a name reads as a name
        <span className={id.startsWith("tool:") ? "named code" : "named"} title={id} key={start}>
          {names[id]}
        </span>
      ) : (
        <code className="id" key={start}>{id}</code>
      ),
    );
    const n = cites?.get(id);
    if (n !== undefined && !cited.has(id)) {
      cited.add(id);
      out.push(
        <sup className="ref" key={`c${start}`} role="button" tabIndex={0} title={`[${n}] ${id}`}
          onClick={() => onCite?.(n)} onKeyDown={(e) => e.key === "Enter" && onCite?.(n)}>
          [{n}]
        </sup>,
      );
    }
    last = start + id.length;
  }
  out.push(text.slice(last));
  return <>{out}</>;
}

export function findingTitle(finding: Finding, names: Record<string, string>): string {
  const name = (id?: string) => (id ? names[id] ?? id : "?");
  if (finding.kind === "drift") return `${name(finding.server_id)} changed its tools`;
  if (finding.kind === "poisoned_description") return `${name(finding.tool_id)} carries instructions in its description`;
  return finding.kind === "injection"
    ? `${name(finding.source_id)} can reach ${name(finding.target_id)}`
    : `${name(finding.agent_id)} holds untrusted input, private data and a way out`;
}

export const KIND_WORDS: Record<Finding["kind"], string> = { injection: "Injection path", trifecta: "Lethal trifecta", drift: "Manifest drift", poisoned_description: "Poisoned description" };

const WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
/** A small count as a word, for sentences: "one path", "two agents", "12 nodes". */
export function countWord(n: number): string {
  return WORDS[n] ?? String(n);
}
export function plural(n: number, one: string, many: string): string {
  return `${countWord(n)} ${n === 1 ? one : many}`;
}
export const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** HH:MM:SS on the visitor's clock. */
export function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** "Tuesday 13 October", for the day a group of events happened on. */
export function day(ms: number): string {
  return new Date(ms).toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" });
}

/** A scenario id as a name: "acme_support" reads "Acme support". */
export const scenarioName = (id: string) => capital(id.replace(/[_-]+/g, " "));
