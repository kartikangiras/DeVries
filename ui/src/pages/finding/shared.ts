// What the finding's steps share: the step names, a two-digit counter, an agent's scorecard row and Meta's three properties.

import type { Scorecard } from "../../api";
import type { Series } from "../../paths";

export const two = (n: number) => String(n).padStart(2, "0");
export type Step = "summary" | "rule" | "path" | "fix" | "options";
export const STEPS: readonly Step[] = ["summary", "rule", "path", "fix", "options"];
export const isStep = (s: string | null | undefined): s is Step => !!s && (STEPS as readonly string[]).includes(s);

export type Card = Scorecard["agents"][number];

export const PROPERTIES: { key: "A" | "B" | "C"; word: string; series: Series; of: (a: Card) => string[] }[] = [
  { key: "A", word: "untrusted input", series: "hot", of: (a) => a.untrusted_in },
  { key: "B", word: "private data", series: "private", of: (a) => a.private_in },
  { key: "C", word: "a way to act", series: "exit", of: (a) => a.acts_on },
];
