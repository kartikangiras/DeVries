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
type Workflow = { id: string; name: string; description: string | null; mode: string; run_by: string; needs: string[]; reads: string[] };
export type Graph = {
  scenario: string; layer: "flow" | "config"; own_copy: boolean;
  nodes: GraphNode[]; links: GraphLink[]; workflows: Workflow[]; queries: string[];
};

export type Path = { node_ids: string[]; rules: number[]; hops: string[] };
type Taxonomy = { code: string; name: string };
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
type LastScan = { scan_id: string; at: number; duration_ms: number; injection: number; trifecta: number; partial: boolean };
export type Findings = {
  scenario: string; own_copy: boolean; findings: Finding[]; past: Finding[]; names: Record<string, string>;
  /** When this graph was last scanned, or null if it never was. */
  last_scan: LastScan | null; queries: string[];
};

export type Mitigation = {
  id: string; status: "proposed" | "approved" | "applied" | "rejected" | "failed"; passed: boolean; cost: number; source: string;
  /** The graph declares no workflow, so the sandbox could not check what the plan breaks. Older servers leave it out. */
  unconstrained?: boolean;
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
/** What a run used. `cost_is_ceiling` says the model is not in the price table, so `cost_usd` is the dearest known rate. */
export type RunUsage = { model_steps: number; input_tokens: number; output_tokens: number; cost_usd: number; cost_is_ceiling?: boolean; simulations: number };
export type Run = {
  id: string; kind: "audit" | "ask"; scenario: string; status: "running" | "awaiting_approval" | "done" | "failed";
  phase: string; mode: "agent" | "scripted"; scripted_reason: string | null; model: string | null;
  question: string | null; answer: string | null; answer_by: "model" | "template" | null;
  mitigation_id: string | null; outcome: string | null; error: string | null;
  usage: RunUsage;
  started_at: number; finished_at: number | null;
};
export type RunWithSteps = Run & { steps: Step[] };

export type Session = {
  copies: string[];
  model: { configured: boolean; name: string | null; budget_spent: boolean; runs_left: number; questions_left: number };
  /** A public site: nothing is launched, nothing is written to a file, an import is private to this session. */
  public?: boolean; can_write?: boolean; can_launch?: boolean;
};

/** One scenario of the model eval: the plan the search finds, the sandboxes each driver needed, and how often the model matched. */
export type EvalScenario = {
  scenario: string; baseline: string; baseline_cost: number; search_to_first_pass: number; search_total: number;
  model_sandboxes: string; model_steps: string; usd: string; matched: number; runs: number;
};
export type Eval = { measured_at: string; model: string; runs_per_scenario: number; scenarios: EvalScenario[]; matched: number; runs: number };
/** What this build is: the counts the landing quotes, the engine's cost of each kind of fix, the model, and the eval when one was measured. */
export type About = {
  version: string; rules: number; fix_costs: Record<string, number>; mcp_tools: number; queries: number; scenarios: number;
  model: string | null; model_default: string; eval: Eval | null;
};

export type Health = { ok: boolean; falkordb: boolean; falkordb_version?: string | null; falkordb_mb?: number | null; canary: { ok: boolean; detail: string; ms: number } | null; public?: boolean };

/** The one picture: only the open paths, as ribbons from untrusted sources through agents to high-impact actions. */
export type Ribbon = {
  id: string; kind: "injection" | "trifecta"; source_id: string | null; target_id: string | null; agent_ids: string[];
  hops: number; routes: number; severity: string; untrusted_ids?: string[]; private_ids?: string[]; exit_ids?: string[];
};
export type Overview = {
  scenario: string; own_copy: boolean; partial: boolean;
  /** One short clause; `sentence_more` is the second clause (the trifecta count), when there is one. */
  sentence: string; sentence_more?: string | null;
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
type Draft = {
  id: string; kind: string; path: string | null; after: string; diff: string; note: string; commands: string[];
  writable: boolean; edited: boolean; before_hash: string; after_hash: string; changes: boolean;
  /** False when `after` is redacted (secrets shown as •••): it is read-only and must not be sent back on write. Missing means true. */
  editable?: boolean;
};
type Origin = { kind: string; path: string | null; settings_path: string | null; hash: string | null; servers: Record<string, string> };
export type DraftAnswer = { scenario: string; mitigation_id: string; draft: Draft; can_write: boolean; origin: Origin | null };
type Receipt = { draft_id: string; path: string; backup: string; before_hash: string; after_hash: string; written_at: number; written_by: string; open_after: string[]; closed: string[]; reloaded: boolean };
export type ImportAnswer = {
  scenario: string; private: boolean; servers: { id: string; name: string; trust: string | null; impact: string | null; external: boolean }[];
  tools: number; skipped: string[]; origin: Origin | null; findings: Finding[]; run: Run | null;
  /** The import declares no workflow, so a fix's sandbox cannot check what it breaks. Older servers leave it out. */
  unconstrained?: boolean;
};
export type Policy = { scenario: string; cost: number | null; hops: Cut["hops"]; claude_code: { permissions: Record<string, string[]> }; claude_code_text: string; docker_mcp_gateway: string[]; named: string[] };

/** A change to test in a sandbox: a fix, or a grant or delegation that does not exist yet. */
export type Change =
  | { kind: "grant_call" | "gate_call" | "revoke_call"; agent_id: string; tool_id: string }
  | { kind: "add_delegation" | "quarantine_delegation"; from_agent_id: string; to_agent_id: string }
  | { kind: "drop_read"; tool_id: string; source_id: string }
  | { kind: "drop_server"; server_id: string }
  | { kind: "split_agent"; agent_id: string; reader_tool_ids: string[] };
type FindingRef = { id: string; kind: "injection" | "trifecta"; source_id?: string; target_id?: string; agent_id?: string; path_ids?: string[] };
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
  hops: { from_id: string; to_id: string; rule: number; sentence: string; capacity: number; fixes: string[]; fix?: string | null; config: { rel: string; from_id: string; to_id: string } }[];
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
/** One scan of the graph, kept so a posture can be read over time. */
export type ScanRow = { scan_id: string; at: number; duration_ms: number; injection: number; trifecta: number; open: number; partial: boolean };
/** The system's standing, all of it read from FalkorDB: where untrusted text can go, what stands in its way, how it has moved. */
export type Posture = {
  scenario: string; own_copy: boolean; partial: boolean;
  /** One short clause; `sentence_more` is the second clause (the trifecta count), when there is one. */
  sentence: string; sentence_more?: string | null;
  counts: Overview["counts"];
  facts: { nodes: number; flows: number; workflows: number; last_scan: { at: number; duration_ms: number } | null };
  exposure: { high_reached: number; high_total: number; external_reached: number; external_total: number; agents_reached: number; agents_total: number };
  rule_of_two: { tally: Record<string, number>; unattended_three: number; agents: Scorecard["agents"] };
  blast: { id: string; name: string; reached: number; agents: number; tools: number; resources: number; high: number; external: number; ids: string[] }[];
  targets: { id: string; name: string; impact: string | null; external: boolean; reaching: number; sources: string[] }[];
  chokes: { id: string; name: string | null; label: string; routes: number; findings: number; betweenness: number | null }[];
  cut: { cost: number | null; cuttable: boolean; hops: Cut["hops"] };
  scans: ScanRow[];
  owasp: { code: string; name: string; open: number; checked: boolean }[];
  queries: string[];
};
/** One line of what happened on a scenario: a scan, a run, a plan tested or proposed, a decision, an application, a write. */
export type ActivityItem = {
  at: number; kind: "scan" | "run" | "tested" | "proposal" | "decision" | "applied" | "written" | "labelled" | "import";
  sentence: string; who: string | null; status: string | null; reason?: string | null;
  refs: { run_id?: string; mitigation_id?: string; finding_ids?: string[]; scan_id?: string; draft_id?: string; path?: string };
};
export type Activity = { scenario: string; items: ActivityItem[]; queries: string[] };
/** Every thing in the system with what it holds and reaches, one table a kind. */
export type Inventory = {
  scenario: string; queries: string[];
  agents: { id: string; name: string | null; owner: string | null; properties: string[]; count: number; autonomous: boolean; workflows: number; grants: number; gated: number; delegates_to: number; reached: boolean; findings: number; pagerank_rank: number | null }[];
  tools: { id: string; name: string | null; server_id: string | null; capability: string | null; held_by: number; gated: number; reads: number; acts_on: number; reached: boolean; findings: number; pagerank_rank: number | null }[];
  sources: { id: string; name: string | null; trust: string | null; read_by: number; reaches_agents: number; findings: number }[];
  resources: { id: string; name: string | null; impact: string | null; external: boolean; acted_on_by: number; reached_by_untrusted: boolean; reaching_sources: number; findings: number }[];
  servers: Servers["servers"];
};
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

/** Whether the database is answering. A 503 with graph_unavailable, or a request to /api that fails or times out,
 *  says it is not; a retried read that answers, or the health line (state.ts), says it is. The shell shows one banner
 *  while it is down, and reads retry meanwhile. */
type Watcher = (down: boolean) => void;
const watchers = new Set<Watcher>();
let isDown = false;
export const outage = {
  get down() { return isDown; },
  watch(w: Watcher): () => void { watchers.add(w); return () => { watchers.delete(w); }; },
  set(down: boolean) {
    if (down === isDown) return;
    isDown = down;
    watchers.forEach((w) => w(down));
  },
};
const RETRY_MS = 4000;
const RETRIES = 30;                 // a read is asked again every few seconds for two minutes before it gives up
const READ_TIMEOUT_MS = 30000;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function call<T>(method: string, path: string, body?: unknown, attempt = 0): Promise<T> {
  // a POST or a PUT always carries a JSON body, {} at the least: the server requires one
  const sent = body === undefined && method !== "GET" ? {} : body;
  const read = method === "GET";
  // a read that finds the database gone is asked again every few seconds; a write is not, since it may have landed
  const again = async () => { await sleep(RETRY_MS); return call<T>(method, path, body, attempt + 1); };
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: sent === undefined ? undefined : { "Content-Type": "application/json" },
      body: sent === undefined ? undefined : JSON.stringify(sent),
      signal: read ? AbortSignal.timeout(READ_TIMEOUT_MS) : undefined,
    });
  } catch {
    outage.set(true);
    if (read && attempt < RETRIES) return again();
    throw new ApiError("unreachable", "FalkorDB is not answering.");
  }
  const text = await response.text();
  let payload: any = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON: handled below */
  }
  if (!response.ok) {
    const error = payload?.error;
    if (response.status === 503 && error?.code === "graph_unavailable") {
      outage.set(true);
      if (read && attempt < RETRIES) return again();
    }
    throw new ApiError(error?.code ?? `http_${response.status}`, error?.message ?? `The server answered ${response.status}.`);
  }
  // only a read that had failed and now answers says the database is back: a read that never failed says nothing,
  // or the shell's own reads, which do not touch the graph, would call it back every time a scenario read fails
  if (attempt > 0) outage.set(false);
  return payload as T;
}

const at = (scenario: string) => `/api/scenarios/${encodeURIComponent(scenario)}`;

export const api = {
  session: () => call<Session>("GET", "/api/session"),
  /** Health answers 503 with the same body when something is wrong; the body is what we want either way. */
  health: () => fetch("/api/health", { credentials: "same-origin" }).then((r) => r.json() as Promise<Health>),
  queries: () => call<{ queries: CatalogQuery[] }>("GET", "/api/queries").then((r) => r.queries),
  about: () => call<About>("GET", "/api/about"),
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
  scans: (scenario: string) => call<{ scenario: string; scans: ScanRow[] }>("GET", `${at(scenario)}/scans`).then((r) => r.scans),
  posture: (scenario: string) => call<Posture>("GET", `${at(scenario)}/posture`),
  activity: (scenario: string) => call<Activity>("GET", `${at(scenario)}/activity`),
  inventory: (scenario: string) => call<Inventory>("GET", `${at(scenario)}/inventory`),
  /** The cheapest cut as one plan, verified in a sandbox like any other; the answer is the plan or the verdict that refused it. */
  proposeCut: (scenario: string) => call<{ scenario: string; proposed: Mitigation | null; verdict: Record<string, unknown> | null; summary: string[] }>("POST", `${at(scenario)}/cut/propose`),
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
