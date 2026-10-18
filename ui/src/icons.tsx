// Icons for the scenarios and for the kinds of finding: one stroke drawing each, in the app's line weight. A scenario
// the set does not know, an import for one, gets the layers.

import type { ReactNode } from "react";
import type { Finding } from "./api";

const SCENARIO: Record<string, ReactNode> = {
  acme_support: <><path d="M4.5 13.5V12a7.5 7.5 0 0 1 15 0v1.5" /><path d="M4.5 13.5h2a1 1 0 0 1 1 1V18a1 1 0 0 1-1 1h-1a1 1 0 0 1-1-1zM19.5 13.5h-2a1 1 0 0 0-1 1V18a1 1 0 0 0 1 1h1a1 1 0 0 0 1-1z" /><path d="M16.5 19v.5a2 2 0 0 1-2 2H12" /></>,
  acme_exec: <><rect x="3.5" y="7.5" width="17" height="12" rx="2" /><path d="M8.5 7.5v-2A1.5 1.5 0 0 1 10 4h4a1.5 1.5 0 0 1 1.5 1.5v2M3.5 12.5h17" /></>,
  acme_dev: <><circle cx="7" cy="5.5" r="2" /><circle cx="7" cy="18.5" r="2" /><circle cx="17" cy="8.5" r="2" /><path d="M7 7.5v9M17 10.5c0 3-3 4-6 4.5-1.6.3-3 .9-4 2.5" /></>,
  acme_hr: <><circle cx="9" cy="8" r="3" /><path d="M3.5 19a5.5 5.5 0 0 1 11 0" /><path d="M15.5 5.5a3 3 0 0 1 0 5.6M17 13.6a5.5 5.5 0 0 1 3.5 5.4" /></>,
  acme_ops: <><rect x="3.5" y="4.5" width="17" height="6" rx="1.5" /><rect x="3.5" y="13.5" width="17" height="6" rx="1.5" /><path d="M7 7.5h.01M7 16.5h.01" /></>,
  acme_finance: <><path d="M12 3.5v17" /><path d="M16.5 7.5A3.5 3 0 0 0 13 5h-2.5a3 3 0 0 0 0 6h3a3 3 0 0 1 0 6H11a3.5 3 0 0 1-3.5-2.5" /></>,
  acme_sales: <><path d="M3.5 17.5 9 12l3.5 3.5 8-8" /><path d="M15.5 7.5h5v5" /></>,
  acme_data: <><ellipse cx="12" cy="6" rx="7.5" ry="2.5" /><path d="M4.5 6v12c0 1.4 3.4 2.5 7.5 2.5s7.5-1.1 7.5-2.5V6" /><path d="M4.5 12c0 1.4 3.4 2.5 7.5 2.5s7.5-1.1 7.5-2.5" /></>,
  devries_self: <><path d="M12 3.5 5 6.2v5.3c0 4.2 2.9 7.6 7 9 4.1-1.4 7-4.8 7-9V6.2z" /><path d="m9 12 2.2 2.2L15.5 10" /></>,
  import: <><path d="m12 3.5 8.5 4.2L12 11.9 3.5 7.7z" /><path d="m3.5 12.2 8.5 4.2 8.5-4.2M3.5 16.4l8.5 4.2 8.5-4.2" /></>,
};

export function ScenarioIcon({ id, size = 18 }: { id: string; size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {SCENARIO[id] ?? SCENARIO.import}
    </svg>
  );
}

const KIND: Record<Finding["kind"], ReactNode> = {
  injection: <><path d="M3.5 12h10" /><path d="m10.5 8.5 3.5 3.5-3.5 3.5" /><rect x="15.5" y="6.5" width="5" height="11" rx="1.5" /></>,
  trifecta: <><path d="M12 4.5 20 18.5H4z" /><circle cx="12" cy="10" r="0.9" fill="currentColor" /><circle cx="9" cy="15" r="0.9" fill="currentColor" /><circle cx="15" cy="15" r="0.9" fill="currentColor" /></>,
  drift: <path d="M4 8h12M13.5 5.5 16 8l-2.5 2.5M20 16H8M10.5 13.5 8 16l2.5 2.5" />,
  poisoned_description: <><path d="M6 4.5h8l4 4v11H6z" /><path d="M14 4.5v4h4" /><path d="m9.5 12 5 5M14.5 12l-5 5" /></>,
};

export function KindIcon({ kind, size = 14 }: { kind: Finding["kind"]; size?: number }) {
  return (
    <svg className="icon kind-icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {KIND[kind]}
    </svg>
  );
}
