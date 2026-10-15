// Everything the UI knows comes through these calls and one event stream.

export type Scenario = { id: string; title: string; description: string; imported?: boolean; private?: boolean; nodes: number; open_findings: number; own_copy: boolean };

export type GraphNode = {
  id: number;
  label: "Agent" | "Tool" | "DataSource" | "Resource";
  data: {
    id: string; name?: string; trust?: string; impact?: string; external?: boolean; owner?: string;
    capability?: string; server_id?: string; zone?: number; blast?: boolean; community?: number;
    /** Flow layer only: untrusted text reaches this node, as FalkorDB answered (reach.untrusted_nodes). */
    tainted?: boolean;
    /** Flow layer only: PageRank over the flow layer (choke.pagerank), and the node's rank by it. */
    pagerank?: number; pagerank_rank?: number;
  };
};
export type GraphLink = {
  id: number;
  rel: string;
  data: {
    from_id: string; to_id: string; rule: number | null; gate: string | null; sentence: string;
    /** Flow layer only: the config edge this hop is derived from, and the fixes that can cut it. */
    config?: { rel: string; from_id: string; to_id: string };
    fixes?: string[];
  };
};
export type Workflow = { id: string; name: string; description: string | null; mode: string; run_by: string; needs: string[]; reads: string[] };
export type Graph = {
  scenario: string; layer: "flow" | "config"; own_copy: boolean;
  nodes: GraphNode[]; links: GraphLink[]; workflows: Workflow[]; queries: string[];
};

export type Path = { node_ids: string[]; rules: number[]; hops: string[] };
export type Taxonomy = { code: string; name: string };
export type Finding = {
  id: string; kind: "injection" | "trifecta" | "drift" | "poisoned_description"; severity: "critical" | "high" | "medium"; status: "open" | "mitigated" | "accepted" | "closed";
  /** OWASP Top 10 for Agentic Applications: the classes this kind of finding belongs to. */
  taxonomy?: Taxonomy[];
  /** Drift only: the server whose manifest changed and what changed. Poisoned description only: the tool and the marks found. */
  server_id?: string; drift?: { added: string[]; removed: string[]; changed: Record<string, string[]> };
  tool_id?: string; flags?: { kind: string; detail: string; span: string }[];
  /** Standing findings (drift, a poisoned description): who accepted it. */
  accepted_by?: string | null;
  source_id?: string; target_id?: string; paths?: Path[]; paths_found?: number; paths_capped?: boolean;
  agent_id?: string; untrusted_ids?: string[]; private_ids?: string[]; exit_ids?: string[];
  legs?: { untrusted_in: Path | null; private_in: Path | null; exit_out: Path | null };
  note?: string;
};
export type LastScan = { scan_id: string; at: number; duration_ms: number; injection: number; trifecta: number; partial: boolean };
export type Findings = {
  scenario: string; own_copy: boolean; findings: Finding[]; past: Finding[]; names: Record<string, string>;
  /** When this graph was last scanned, or null if it never was. */
  last_scan: LastScan | null; queries: string[];
};

export type Mitigation = {
  id: string; status: "proposed" | "approved" | "applied" | "rejected" | "failed"; passed: boolean; cost: number; source: string;
  plan: { fixes: Record<string, any>[] }; summary: string[]; patch: Record<string, unknown>[]; targets: string[];
  reason: string | null; rationale: string | null; approved_by: string | null; decision_reason: string | null;
  created_at: number; applied_at: number | null; config_hash?: string; sandbox_ms?: number | null;
  resolved?: string[]; open_before?: string[]; open_after?: string[]; introduced?: unknown[];
  newly_broken?: { workflow_id?: string; why: string }[];
};

export type Step = {
  n: number; phase: string; by: "model" | "loop" | "scripted" | "person"; kind: "tool" | "text" | "note";
  tool: string | null; arguments: Record<string, unknown> | null; because: string | null; headline: string | null;
  result: Record<string, unknown> | null; error: string | null; cited_ids: string[]; queries: string[];
  ms: number | null; text: string | null; at: number;
};
export type Run = {
  id: string; kind: "audit" | "ask"; scenario: string; status: "running" | "awaiting_approval" | "done" | "failed";
  phase: string; mode: "agent" | "scripted"; scripted_reason: string | null; model: string | null;
  question: string | null; answer: string | null; answer_by: "model" | "template" | null;
  mitigation_id: string | null; outcome: string | null; error: string | null;
  usage: { model_steps: number; input_tokens: number; output_tokens: number; cost_usd: number; simulations: number };
  started_at: number; finished_at: number | null;
};
export type RunWithSteps = Run & { steps: Step[] };

export type Session = {
  copies: string[];
  model: { configured: boolean; name: string | null; budget_spent: boolean; runs_left: number; questions_left: number };
  /** A public site: nothing is launched, nothing is written to a file, an import is private to this session. */
  public?: boolean; can_write?: boolean; can_launch?: boolean;
};

export type Health = { ok: boolean; falkordb: boolean; falkordb_version?: string | null; falkordb_mb?: number | null; canary: { ok: boolean; detail: string; ms: number } | null; public?: boolean };

/** The one picture: only the open paths, as ribbons from untrusted sources through agents to high-impact actions. */
export type Ribbon = {
  id: string; kind: "injection" | "trifecta"; source_id: string | null; target_id: string | null; agent_ids: string[];
  hops: number; routes: number; severity: string; untrusted_ids?: string[]; private_ids?: string[]; exit_ids?: string[];
};
export type Overview = {
  scenario: string; own_copy: boolean; partial: boolean; sentence: string;
  counts: { untrusted_sources: number; private_sources: number; sources: number; agents: number; tools: number; high_resources: number; external_resources: number; resources: number; workflows: number; open_findings: number; cut_cost: number | null };
  columns: {
    sources: { id: string; name: string; trust: string | null }[];
    agents: { id: string; name: string; properties: string[]; autonomous: boolean; verdict: string }[];
    actions: { id: string; name: string; impact: string | null; external: boolean }[];
  };
  folded: { sources: string[]; agents: string[]; actions: string[]; tools: string[] };
  ribbons: Ribbon[]; queries: string[];
};

/** A plan as the change to the configuration it came from: the text that would be written, a diff, a note. */
export type Draft = {
  id: string; kind: string; path: string | null; after: string; diff: string; note: string; commands: string[];
  writable: boolean; edited: boolean; before_hash: string; after_hash: string; changes: boolean;
};
export type Origin = { kind: string; path: string | null; settings_path: string | null; hash: string | null; servers: Record<string, string> };
export type DraftAnswer = { scenario: string; mitigation_id: string; draft: Draft; can_write: boolean; origin: Origin | null };
export type Receipt = { draft_id: string; path: string; backup: string; before_hash: string; after_hash: string; written_at: number; written_by: string; open_after: string[]; closed: string[]; reloaded: boolean };
export type ImportAnswer = {
  scenario: string; private: boolean; servers: { id: string; name: string; trust: string | null; impact: string | null; external: boolean }[];
  tools: number; skipped: string[]; origin: Origin | null; findings: Finding[]; run: Run | null;
};
export type Policy = { scenario: string; cost: number | null; hops: Cut["hops"]; claude_code: { permissions: Record<string, string[]> }; claude_code_text: string; docker_mcp_gateway: string[]; named: string[] };

/** A change to test in a sandbox: a fix, or a grant or delegation that does not exist yet. */
export type Change =
  | { kind: "grant_call" | "gate_call" | "revoke_call"; agent_id: string; tool_id: string }
  | { kind: "add_delegation" | "quarantine_delegation"; from_agent_id: string; to_agent_id: string }
  | { kind: "drop_read"; tool_id: string; source_id: string }
  | { kind: "drop_server"; server_id: string }
  | { kind: "split_agent"; agent_id: string; reader_tool_ids: string[] };
export type FindingRef = { id: string; kind: "injection" | "trifecta"; source_id?: string; target_id?: string; agent_id?: string; path_ids?: string[] };
/** What a set of changes would do, measured in a sandbox that no longer exists. */
export type WhatIf = {
  scenario: string; changes: string[]; resolved: string[]; introduced: FindingRef[];
  newly_broken: { workflow_id: string; why: string }[]; open_before: string[]; open_after: string[]; sandbox_ms: number;
};
/** The flow layer with a plan applied, read from a sandbox; or the graph itself once the plan is applied. */
export type Preview = Pick<Graph, "layer" | "nodes" | "links" | "workflows"> & { scenario: string; mitigation_id: string; applied: boolean };
/** The cheapest cut between untrusted sources and high-impact resources, as max flow found it. */
export type Cut = {
  scenario: string; cost: number; cuttable: boolean; queries: string[];
  hops: { from_id: string; to_id: string; rule: number; sentence: string; capacity: number; fixes: string[]; config: { rel: string; from_id: string; to_id: string } }[];
};
/** Each MCP server: its tools, who holds them, and the findings whose paths run through them. */
export type Servers = {
  scenario: string; queries: string[];
  servers: { id: string; name: string | null; source_url: string | null; synthetic: boolean | null; manifest_hash: string | null; tools: string[]; agents: string[]; findings: string[] }[];
};
/** Meta's Rule of Two per agent: A untrusted input reaches it, B private data reaches it, C it acts on a resource. */
export type Scorecard = {
  scenario: string; queries: string[];
  agents: { agent_id: string; name: string | null; properties: string[]; count: number; untrusted_in: string[]; private_in: string[]; acts_on: string[]; external: boolean; high_impact: boolean; workflows: { id: string; mode: string }[]; autonomous: boolean; verdict: string }[];
};
/** The most central agents and tools on the flow layer, by betweenness: context, never a verdict. */
export type Central = { scenario: string; nodes: { id: string; name: string | null; label: string; score: number }[]; queries: string[] };
export type Layer = "flow" | "config";
export type CatalogQuery = { name: string; mode: "ro" | "rw"; doc: string; cypher: string; targets: string[]; timeout_ms: number };

export type StreamEvent = { id?: number; type: string; scenario?: string; at?: number; data?: any; boot?: string };

export class ApiError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let payload: any = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON: handled below */
  }
  if (!response.ok) {
    const error = payload?.error;
    throw new ApiError(error?.code ?? `http_${response.status}`, error?.message ?? `The server answered ${response.status}.`);
  }
  return payload as T;
}

const at = (scenario: string) => `/api/scenarios/${encodeURIComponent(scenario)}`;

export const api = {
  session: () => call<Session>("GET", "/api/session"),
  /** Health answers 503 with the same body when something is wrong; the body is what we want either way. */
  health: () => fetch("/api/health", { credentials: "same-origin" }).then((r) => r.json() as Promise<Health>),
  queries: () => call<{ queries: CatalogQuery[] }>("GET", "/api/queries").then((r) => r.queries),
  reset: () => call<{ reset: string[] }>("POST", "/api/session/reset"),
  scenarios: () => call<{ scenarios: Scenario[] }>("GET", "/api/scenarios").then((r) => r.scenarios),
  graph: (scenario: string, layer: "flow" | "config") => call<Graph>("GET", `${at(scenario)}/graph?layer=${layer}`),
  findings: (scenario: string) => call<Findings>("GET", `${at(scenario)}/findings`),
  mitigations: (scenario: string) =>
    call<{ mitigations: Mitigation[]; config_hash: string }>("GET", `${at(scenario)}/mitigations`),
  /** `applies` says who applies it: the audit run that is waiting on it, or nobody until `apply` is called. */
  approve: (scenario: string, id: string, approver: string) =>
    call<{ mitigation: Mitigation; applies: string }>("POST", `${at(scenario)}/mitigations/${encodeURIComponent(id)}/approve`, { approver }),
  apply: (scenario: string, id: string) =>
    call<{ open: string[] }>("POST", `${at(scenario)}/mitigations/${encodeURIComponent(id)}/apply`),
  acceptFinding: (scenario: string, id: string, approver: string) =>
    call<{ finding: Finding }>("POST", `${at(scenario)}/findings/${encodeURIComponent(id)}/accept`, { approver }),
  reject: (scenario: string, id: string, approver: string, reason: string) =>
    call<{ mitigation: Mitigation }>("POST", `${at(scenario)}/mitigations/${encodeURIComponent(id)}/reject`, { approver, reason: reason || null }),
  cut: (scenario: string) => call<Cut>("GET", `${at(scenario)}/cut`),
  cutPolicy: (scenario: string) => call<Policy>("GET", `${at(scenario)}/cut/policy`),
  overview: (scenario: string) => call<Overview>("GET", `${at(scenario)}/overview`),
  draft: (scenario: string, id: string) => call<DraftAnswer>("GET", `${at(scenario)}/mitigations/${encodeURIComponent(id)}/draft`),
  editDraft: (scenario: string, id: string, after: string) => call<DraftAnswer>("PUT", `${at(scenario)}/mitigations/${encodeURIComponent(id)}/draft`, { after }),
  writeDraft: (scenario: string, id: string, approver: string, after?: string | null) =>
    call<{ receipt: Receipt }>("POST", `${at(scenario)}/mitigations/${encodeURIComponent(id)}/draft/write`, { approver, after: after ?? null }),
  importConfig: (body: { config?: unknown; source?: string; name?: string; client?: string; labels?: Record<string, string>; audit?: boolean }) =>
    call<ImportAnswer>("POST", "/api/import", body),
  briefUrl: (scenario: string, id: string) => `${at(scenario)}/findings/${encodeURIComponent(id)}/brief.md`,
  figureUrl: (scenario: string, id: string) => `${at(scenario)}/findings/${encodeURIComponent(id)}/figure.svg`,
  central: (scenario: string) => call<Central>("GET", `${at(scenario)}/central`),
  scorecard: (scenario: string) => call<Scorecard>("GET", `${at(scenario)}/scorecard`),
  servers: (scenario: string) => call<Servers>("GET", `${at(scenario)}/servers`),
  setLabels: (scenario: string, data_sources: Record<string, string>, resources: Record<string, { impact: string; external: boolean }>) =>
    call<{ findings: Finding[] }>("POST", `${at(scenario)}/labels`, { data_sources, resources }),
  whatIf: (scenario: string, changes: Change[]) => call<WhatIf>("POST", `${at(scenario)}/whatif`, { changes }),
  preview: (scenario: string, id: string) => call<Preview>("GET", `${at(scenario)}/mitigations/${encodeURIComponent(id)}/preview`),
  startAudit: (scenario: string) => call<{ run: Run }>("POST", "/api/agent/runs", { scenario }).then((r) => r.run),
  /** The question that asks the model to rehearse a finding: the text an attacker would plant. */
  rehearsal: (findingId: string) => `Rehearse ${findingId}: write the text an attacker would plant in its untrusted source so that the agent at the end of its path makes the call, and say which hop each part rides.`,
  ask: (scenario: string, question: string) => call<{ run: Run }>("POST", "/api/agent/ask", { scenario, question }).then((r) => r.run),
  run: (id: string) => call<{ run: RunWithSteps }>("GET", `/api/agent/runs/${encodeURIComponent(id)}`).then((r) => r.run),
  runs: (scenario: string) => call<{ runs: Run[] }>("GET", `${at(scenario)}/runs`).then((r) => r.runs),
};

/** The event stream. The browser reconnects by itself and sends Last-Event-ID, so nothing recent is missed. */
export function openEvents(onEvent: (event: StreamEvent) => void, onState: (connected: boolean) => void): () => void {
  const source = new EventSource("/api/events");
  source.onopen = () => onState(true);
  source.onerror = () => onState(false);
  source.onmessage = (message) => {
    try {
      onEvent(JSON.parse(message.data));
    } catch {
      /* a malformed event is dropped */
    }
  };
  return () => source.close();
}
