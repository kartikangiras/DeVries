"""The REST API and the event stream. The UI talks only to these routes.

Approval lives here and nowhere else: no MCP tool can approve a fix. Every
route that writes acts on the caller's own session copy of a scenario; nothing
here writes to a scenario graph. The one route that writes a file, a draft to
the configuration it was imported from, is behind a person's click, refused on
a public site, and recorded with a receipt.
"""

import asyncio
import json
import logging
import re
from pathlib import Path
from typing import Any, Callable

import redis.exceptions as rex
from fastapi import APIRouter, Query, Request
from fastapi.responses import JSONResponse, PlainTextResponse, Response, StreamingResponse
from pydantic import BaseModel, Field

from devries import ops, views
from devries.agent.llm import LLM, spend
from devries.agent.loop import Auditor
from devries.agent.runs import Run, runs
from devries.analysis import chokepoints, scorecard, zones
from devries.analysis import findings as findings_mod
from devries.analysis import posture as posture_mod
from devries.analysis.models import ChokepointReport, Finding
from devries.analysis.models import finding_id as finding_id_of
from devries.analysis.scorecard import AgentCard
from devries.api.sessions import RateLimiter, Sessions, client_ip
from devries.config import get_settings
from devries.errors import DeVriesError, FixFailed, ForbiddenWrite, InvalidFix, InvalidScenario, NotFound, UnknownScenario
from devries.events import BOOT, bus
from devries.graph import keys
from devries.graph.catalog import CATALOG
from devries.graph.client import GraphClient, get_client
from devries.ingest.importer import guess, import_install, import_pasted
from devries.ingest.scenario_loader import load_scenario, read_scenario
from devries.mitigation import candidates, sandbox, store
from devries.mitigation import write as write_mod
from devries.mitigation.compile import policy_from_cut
from devries.mitigation.dsl import Change, FixPlan, describe

log = logging.getLogger("devries.api")

STATUS = {
    "unknown_scenario": 404, "not_found": 404, "invalid_fix": 422, "invalid_scenario": 422, "fix_failed": 409,
    "needs_approval": 409, "stale": 409, "run_active": 409, "forbidden_write": 403, "not_writable": 409, "timeout": 504,
    "session_limit": 503, "canary_failed": 503, "sandbox_error": 503, "rate_limited": 429, "graph_unavailable": 503,
}
FLOW_LAYER = ["FLOWS_TO", "GATED_FLOW"]
CONFIG_LAYER = ["CAN_CALL", "DELEGATES_TO", "READS", "WRITES", "FEEDS"]
APPROVER_RE = re.compile(r"[^A-Za-z0-9 ._@-]")


class RunActive(DeVriesError):
    code = "run_active"


class Decision(BaseModel):
    approver: str = Field(default="a visitor", max_length=200)
    reason: str | None = Field(default=None, max_length=300)

    def who(self) -> str:
        return APPROVER_RE.sub("", self.approver).strip()[:60] or "a visitor"


class LabelsBody(BaseModel):
    data_sources: dict[str, str] = Field(default_factory=dict)         # src:x -> trust
    resources: dict[str, dict[str, Any]] = Field(default_factory=dict)  # res:x -> {impact, external}
    audit: bool = True                                                  # start an audit on the result, by itself


class SearchBody(BaseModel):
    finding_ids: list[str] | None = Field(default=None, max_length=3)


class WhatIfBody(BaseModel):
    changes: list[Change] = Field(min_length=1, max_length=3)


class RunBody(BaseModel):
    scenario: str


class AskBody(BaseModel):
    scenario: str
    question: str = Field(min_length=3, max_length=2000)


class ImportBody(BaseModel):
    """A pasted config (`mcpServers`) or tools/list (`tools`); on this machine, also a source as the command line takes it."""
    config: dict | None = None
    source: str | None = Field(default=None, max_length=1000)
    name: str | None = Field(default=None, max_length=48)
    client: str | None = Field(default=None, max_length=40)
    labels: dict[str, str] = Field(default_factory=dict)
    audit: bool = True


class DraftBody(BaseModel):
    after: str = Field(max_length=200_000)


class WriteBody(Decision):
    after: str | None = Field(default=None, max_length=200_000)


def error_response(e: DeVriesError) -> JSONResponse:
    return JSONResponse(e.to_dict(), status_code=STATUS.get(e.code, 400))


def config_sentence(rel: str, a: str, b: str, gate: str | None) -> str:
    base = {"CAN_CALL": f"{a} can call {b}", "DELEGATES_TO": f"{a} delegates to {b}",
            "READS": f"{a} reads {b}", "WRITES": f"{a} acts on {b}",
            "FEEDS": f"what is written to {a} is read back from {b}"}[rel]
    if gate == "human_approval":
        return base + ", and a person approves each call"
    if gate == "quarantine":
        return base + ", and only structured fields come back"
    return base


async def graph_view(client: GraphClient, key: str, layer: str) -> dict[str, Any]:
    """One layer of a graph as the chart takes it: nodes with their zone, links with a sentence each, workflows."""
    zone_of: dict[str, dict[str, Any]] = {}
    for zone in await zones.trust_zones(client, key):          # blast zones come first, and the first zone wins
        for member in zone.members:
            zone_of.setdefault(member, {"zone": zone.component_id, "blast": zone.is_blast_zone})
    for group in await zones.communities(client, key):         # finer than a zone: what hangs together, for colouring
        for member in group.members:
            zone_of.setdefault(member, {})["community"] = group.component_id
    reached: set[str] = set()
    rank_of: dict[str, dict[str, Any]] = {}
    if layer == "flow":                                        # what untrusted text reaches: FalkorDB's answer, not the page's
        depth = max(1, (await client.run("graph.node_count", key))[0]["nodes"])
        rows = await client.run("reach.untrusted_nodes", key, max_depth=depth)
        reached = set(rows[0]["reached"]) if rows else set()
        for i, row in enumerate(await client.run("choke.pagerank", key), 1):
            rank_of[row["id"]] = {"pagerank": round(row["score"], 3), "pagerank_rank": i}
    nodes = []
    for row in await client.run("ui.nodes", key):
        data = {k: v for k, v in row.items() if k not in ("nid", "label") and v is not None}
        if layer == "flow":
            data["tainted"] = row["id"] in reached or (row["label"] == "DataSource" and row["trust"] == "untrusted")
            data |= rank_of.get(row["id"], {})
        nodes.append({"id": row["nid"], "label": row["label"], "data": data | zone_of.get(row["id"], {})})
    links = []
    for row in await client.run("ui.links", key, types=FLOW_LAYER if layer == "flow" else CONFIG_LAYER):
        if layer == "flow":
            sentence = views.hop_sentence(row["rule"], row["from_id"], row["to_id"])
            if row["rel"] == "GATED_FLOW":
                sentence = f"blocked by {row['gate']}: {sentence}"
        else:
            sentence = config_sentence(row["rel"], row["from_id"], row["to_id"], row["gate"])
        data = {"from_id": row["from_id"], "to_id": row["to_id"], "rule": row["rule"],
                "gate": row["gate"], "sentence": sentence}
        if layer == "flow":                               # what a person could change to cut this hop
            data |= views.behind_hop(row["rule"], row["from_id"], row["to_id"])
        links.append({"id": row["lid"], "rel": row["rel"], "data": data})
    return {"layer": layer, "nodes": nodes, "links": links, "workflows": await client.run("ui.workflows", key)}


def _sentence(open_findings: list, agents: list, counts: dict, cards: dict | None = None) -> tuple[str, str | None]:
    """The overview's title and its second line: one short sentence a stranger can read, made from the counts, and the
    trifecta count as a sentence of its own when both kinds are open. The figure beside it counts the Rule of Two
    cards that hold all three properties, so when that differs from the agents with a way out, the sentence says both."""
    injections = [f for f in open_findings if f.kind == "injection"]
    trifectas = [f for f in open_findings if f.kind == "trifecta"]
    if not injections and not trifectas:
        if counts["untrusted_sources"] == 0:
            return "No source here is written by outsiders, so nothing untrusted can flow at all.", None
        return "Nothing untrusted reaches a high-impact resource.", "No agent holds untrusted input, private data and a way out."

    def n(count: int, one: str, many: str) -> str:
        words = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"]
        return f"{words[count] if count < len(words) else count} {one if count == 1 else many}"

    parts = []
    if injections:
        hops = [len(f.evidence[0].rules) for f in injections if f.evidence]
        span = f"in {min(hops)} hops" if hops and min(hops) == max(hops) else f"in {min(hops)} to {max(hops)} hops" if hops else ""
        parts.append(f"{n(len({f.source_id for f in injections}), 'untrusted source reaches', 'untrusted sources reach')} "
                     f"{n(len({f.target_id for f in injections}), 'high-impact resource', 'high-impact resources')} through "
                     f"{n(len(agents), 'agent', 'agents')}{', ' + span if span else ''}")
    if trifectas:
        with_exit = len({getattr(f, "agent_id", None) or f.id for f in trifectas})
        all_three = sum(1 for c in (cards or {}).values() if len(c.properties) == 3)
        if cards and all_three != with_exit:
            parts.append(f"{n(all_three, 'agent holds', 'agents hold')} all three of Meta's properties, "
                         f"{n(with_exit, 'of them', 'of them')} with a way out of the organisation")
        else:
            parts.append(f"{n(with_exit, 'agent holds', 'agents hold')} untrusted input, private data and a way out")
    first, *rest = [p[0].upper() + p[1:] + "." for p in parts]
    return first, (rest[0] if rest else None)


class Picture:
    """What the overview and the posture page both start from: the counts, the findings that hold, the Rule of Two
    cards, the chart's nodes and the cheapest cut, with the open injection and trifecta findings picked out."""

    def __init__(self, counts: dict[str, Any], current: list[Finding], partial: bool, cards: dict[str, AgentCard],
                 rows: list[dict[str, Any]], cut: ChokepointReport):
        self.counts, self.current, self.partial, self.cards, self.rows, self.cut = counts, current, partial, cards, rows, cut
        self.node = {r["id"]: r for r in rows}
        self.open = [f for f in current if f.status == "open" and f.kind in ("injection", "trifecta")]
        on_path = {i for f in self.open for p in f.evidence for i in p.node_ids}
        self.agents_on = sorted(i for i in on_path if self.label(i) == "Agent")
        self.sources_on = sorted({f.source_id for f in self.open if f.source_id} | {i for f in self.open for i in f.untrusted_ids})
        self.actions_on = sorted({f.target_id for f in self.open if f.target_id} | {i for f in self.open for i in f.exit_ids})

    def label(self, node_id: str) -> str | None:
        return self.node.get(node_id, {}).get("label")

    def name(self, node_id: str) -> str:
        return self.node.get(node_id, {}).get("name") or node_id

    @property
    def sentence(self) -> str:
        return _sentence(self.open, self.agents_on, self.counts, self.cards)[0]

    @property
    def sentence_more(self) -> str | None:
        return _sentence(self.open, self.agents_on, self.counts, self.cards)[1]

    @property
    def summary_counts(self) -> dict[str, Any]:
        return self.counts | {"open_findings": len(self.open), "cut_cost": self.cut.cut_cost}


async def picture(client: GraphClient, key: str) -> Picture:
    """Read the picture of one graph: five calls, every one a catalog query or built on them."""
    return Picture((await client.run("overview.counts", key))[0], *await findings_mod.current(client, key),
                   {c.agent_id: c for c in await scorecard.rule_of_two(client, key)},
                   await client.run("ui.nodes", key), await chokepoints.mincut(client, key))


def cut_view(report: ChokepointReport) -> dict[str, Any]:
    """The cheapest cut as the page takes it: its cost, whether every hop can be cut, and the hops."""
    return {"cost": report.cut_cost, "cuttable": all(e.score < chokepoints.UNCUTTABLE for e in report.edges),
            "hops": [views.cut_hop(e) for e in report.edges]}


def servers_view(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Each server's row with its lists sorted and the empty entries an OPTIONAL MATCH leaves dropped."""
    return [{**row, "tools": sorted(t for t in row["tools"] if t), "agents": sorted(a for a in row["agents"] if a),
             "findings": sorted(f for f in row["findings"] if f)} for row in rows]


def build_router(sessions: Sessions, llm: LLM | None, scenario_info: Callable[[], dict[str, dict[str, Any]]],
                 mcp_server: Any) -> tuple[APIRouter, Any, dict[str, asyncio.Task], Callable[[Run, Auditor], None]]:
    """The router, the janitor's "is a run using this graph" check, the running tasks, and how to start a run."""
    router = APIRouter(prefix="/api")
    tasks: dict[str, asyncio.Task] = {}                   # run id -> the task driving it
    slots = asyncio.Semaphore(4)                          # runs in flight at once, across all sessions
    settings = get_settings()
    import_limiter = RateLimiter(lambda: get_settings().rate_imports_per_hour, 3600, "imports")
    run_limiter = RateLimiter(lambda: get_settings().rate_runs_per_hour, 3600, "audit runs and questions")

    def busy(graph_key: str) -> bool:
        return runs.active(graph_key) is not None

    def import_root(session_id: str) -> Path:
        """Where a public visitor's imports live: a directory of their own, with scenarios/ and manifests/ under it."""
        return settings.import_dir / re.sub(r"[^A-Za-z0-9_-]", "", session_id)

    def scenario_path_for(session_id: str, scenario: str) -> Path | None:
        return write_mod.scenario_file(scenario, [import_root(session_id) / "scenarios"])

    def private_info(session_id: str, name: str) -> dict[str, Any] | None:
        path = import_root(session_id) / "scenarios" / f"{name}.yaml"
        if not path.is_file():
            return None
        try:
            spec = read_scenario(path).spec
        except DeVriesError:
            return None
        return {"title": spec.title or spec.scenario, "description": spec.description, "order": spec.order, "imported": bool(spec.imported)}

    async def read_key(request: Request, scenario: str) -> tuple[GraphClient, str]:
        client = get_client()
        key = sessions.key_for_read(request.state.session, scenario)
        if not await client.exists(key):
            raise UnknownScenario(f"no scenario {scenario!r}")
        return client, key

    async def write_key(request: Request, scenario: str) -> tuple[GraphClient, str]:
        client = get_client()
        return client, await sessions.key_for_write(client, request.state.session, scenario, busy)

    async def names(client: GraphClient, key: str) -> dict[str, str]:
        return {row["id"]: row["name"] or row["id"] for row in await client.run("node.names", key)}

    def model_for(session_id: str, kind: str) -> tuple[LLM | None, str]:
        """The model for a new run, or the reason there is none. Counts the run against the session's budget."""
        session = sessions.touch(session_id)
        s = get_settings()
        if llm is None:
            return None, "no model is configured"
        if spend.exhausted():
            return None, "today's model budget is spent"
        if kind == "audit":
            if session.runs_used >= s.session_runs:
                return None, f"this session has used its {s.session_runs} audit runs with a model"
            session.runs_used += 1
        else:
            if session.questions_used >= s.session_questions:
                return None, f"this session has used its {s.session_questions} questions"
            session.questions_used += 1
        return llm, ""

    def spawn(run: Run, auditor: Auditor) -> None:
        async def go() -> None:
            await slots.acquire()
            auditor.slot, auditor.slot_held = slots, True
            try:
                await auditor.run(run)
            finally:
                if auditor.slot_held:                 # the auditor lets go of it while a person decides, and takes it back
                    slots.release()

        task = asyncio.create_task(go(), name=run.id)
        tasks[run.id] = task
        task.add_done_callback(lambda _: tasks.pop(run.id, None))

    def audit_by_itself(request: Request, scenario: str, key: str, reason: str) -> Run | None:
        """An audit that starts without a click, after an import or a labelling: scripted unless a model is free. It
        stops once a plan waits for a person. None if a run is on that graph already."""
        if runs.active(key) is not None:
            return None
        sid = request.state.session
        model, why = model_for(sid, "audit")
        run = runs.create("audit", scenario, key, sessions.ref(sid, scenario))
        spawn(run, Auditor(get_client(), model, server=mcp_server, stop_after_proposal=True,
                           no_model_reason=why or reason))
        return run

    async def own_run(request: Request, run_id: str) -> Run:
        run = runs.get(run_id)
        mine = f"ses:{request.state.session}:"
        if run is None:                                   # another process made it, or this one before a restart
            client = get_client()
            session = sessions.touch(request.state.session)
            for graph in [*(keys.session_key(session.id, s) for s in sorted(session.copies)),
                          *(k for k in await client.list_graphs() if k.startswith("scn:"))]:
                await runs.hydrate(client, graph, again=graph.startswith("scn:"))
            run = runs.get(run_id)
        if run is None or not (run.graph.startswith(mine) or run.graph.startswith("scn:")) or not visible(run, request.state.session):
            raise NotFound(f"no run {run_id!r}")
        return run

    def visible(run: Run, session_id: str) -> bool:
        """An audit run is everyone's record of the scenario; a question is its asker's alone."""
        return run.kind != "ask" or run.session in (None, store.session_hash(session_id))

    def ration(request: Request, limiter: RateLimiter) -> None:
        if settings.devries_public:
            limiter.hit(client_ip(request))

    # ------------------------------------------------------------------ session and catalog

    @router.get("/session")
    async def session_info(request: Request) -> dict[str, Any]:
        session = sessions.touch(request.state.session)
        s = get_settings()
        return {
            "copies": sorted(session.copies),
            "model": {"configured": llm is not None, "name": llm.name if llm else None,
                      "budget_spent": spend.exhausted(),
                      "runs_left": sessions.model_runs_left(session.id) if llm else 0,
                      "questions_left": sessions.questions_left(session.id) if llm else 0},
            "limits": {"session_ttl_min": s.session_ttl_min, "approval_timeout_s": s.approval_timeout_s},
            "public": s.devries_public,
            "can_write": not s.devries_public,
            "can_launch": not s.devries_public,
        }

    @router.post("/session/reset")
    async def session_reset(request: Request) -> dict[str, Any]:
        client, sid = get_client(), request.state.session
        for scenario in list(sessions.touch(sid).copies):
            key = keys.session_key(sid, scenario)
            for run in runs.for_graph(key):
                if run.id in tasks:
                    tasks[run.id].cancel()
            runs.forget(key)
        dropped = await sessions.reset(client, sid)
        return {"reset": [keys.scenario_of(k) for k in dropped]}

    @router.get("/queries")
    async def queries() -> dict[str, Any]:
        return {"queries": [{"name": q.name, "mode": q.mode, "doc": q.doc, "cypher": q.cypher.strip(),
                             "targets": sorted(q.targets), "timeout_ms": q.timeout_ms} for q in CATALOG.values()]}

    # ------------------------------------------------------------------ scenarios, graph, findings

    @router.get("/scenarios")
    async def scenarios(request: Request) -> dict[str, Any]:
        client, sid = get_client(), request.state.session
        present = set(await client.list_graphs())
        session = sessions.touch(sid)
        shared = {keys.scenario_of(k) for k in present if k.startswith("scn:")}
        # a public visitor's own imports have no shared graph: only their copy exists
        private = [c for c in sorted(session.copies) if keys.scenario_key(c) not in present and keys.session_key(sid, c) in present]
        info_now = scenario_info()                        # read afresh: an import adds a file while the app runs
        for name in private:
            info = private_info(sid, name)
            if info:
                info_now[name] = info
        out = []
        for name in sorted(shared | set(private), key=lambda n: (info_now.get(n, {}).get("order", 100), n)):
            key = sessions.key_for_read(sid, name)
            if key not in present:
                continue
            row = (await client.run("scenario.summary", key))[0]
            info = info_now.get(name, {})
            out.append({"id": name, "title": info.get("title", name), "description": info.get("description", ""),
                        "imported": info.get("imported", False), "private": name in private,
                        "nodes": row["nodes"], "open_findings": row["open_findings"], "own_copy": key.startswith("ses:")})
        return {"scenarios": out}

    @router.get("/scenarios/{scenario}/graph")
    async def graph(request: Request, scenario: str, layer: str = Query("flow", pattern="^(flow|config)$")) -> dict[str, Any]:
        client, key = await read_key(request, scenario)
        with client.recording() as ran:
            view = await graph_view(client, key, layer)
        return {"scenario": scenario, "own_copy": key.startswith("ses:")} | view | {"queries": ran}

    @router.get("/scenarios/{scenario}/overview")
    async def overview(request: Request, scenario: str) -> dict[str, Any]:
        """The one picture: untrusted sources, the agents they reach, the high-impact actions those can take, with only
        the open paths drawn as ribbons, and a sentence that says it. Everything else folds into counts."""
        client, key = await read_key(request, scenario)
        with client.recording() as ran:
            pic = await picture(client, key)
        node = pic.node
        ribbons = []
        for f in pic.open:
            if f.kind == "injection":
                path = f.evidence[0] if f.evidence else None
                ribbons.append({"id": f.id, "kind": "injection", "source_id": f.source_id, "target_id": f.target_id,
                                "agent_ids": [i for i in (path.node_ids if path else []) if pic.label(i) == "Agent"],
                                "hops": len(path.rules) if path else 0, "routes": f.routes if f.routes is not None else len(f.evidence),
                                "severity": f.severity})
            else:
                ribbons.append({"id": f.id, "kind": "trifecta", "agent_ids": [f.agent_id], "source_id": f.untrusted_ids[0] if f.untrusted_ids else None,
                                "target_id": f.exit_ids[0] if f.exit_ids else None, "untrusted_ids": f.untrusted_ids, "private_ids": f.private_ids,
                                "exit_ids": f.exit_ids, "hops": sum(len(p.rules) for p in f.evidence), "routes": 1, "severity": f.severity})

        def card(agent_id: str) -> dict[str, Any]:
            c = pic.cards.get(agent_id)
            return {"id": agent_id, "name": pic.name(agent_id),
                    "properties": c.properties if c else [], "autonomous": bool(c and c.autonomous), "verdict": c.verdict if c else ""}

        columns = {
            "sources": [{"id": i, "name": pic.name(i), "trust": node.get(i, {}).get("trust")} for i in pic.sources_on],
            "agents": [card(i) for i in pic.agents_on],
            "actions": [{"id": i, "name": pic.name(i), "impact": node.get(i, {}).get("impact"),
                         "external": bool(node.get(i, {}).get("external"))} for i in pic.actions_on],
        }
        folded = {
            "sources": [r["id"] for r in pic.rows if r["label"] == "DataSource" and r["id"] not in pic.sources_on],
            "agents": [r["id"] for r in pic.rows if r["label"] == "Agent" and r["id"] not in pic.agents_on],
            "actions": [r["id"] for r in pic.rows if r["label"] == "Resource" and r["id"] not in pic.actions_on],
            "tools": [r["id"] for r in pic.rows if r["label"] == "Tool"],
        }
        return {"scenario": scenario, "own_copy": key.startswith("ses:"), "partial": pic.partial, "sentence": pic.sentence,
                "sentence_more": pic.sentence_more,
                "counts": pic.summary_counts, "columns": columns, "folded": folded, "ribbons": ribbons, "queries": ran}

    @router.get("/scenarios/{scenario}/posture")
    async def posture(request: Request, scenario: str) -> dict[str, Any]:
        """The posture page in one call: the overview's sentence and counts, what untrusted text reaches, the Rule of
        Two tally, the blast radius of each untrusted source, who reaches each target, where the open routes meet,
        the cheapest cut, the scans over time and the OWASP classes covered. Every figure is a FalkorDB answer."""
        client, key = await read_key(request, scenario)
        with client.recording() as ran:
            pic = await picture(client, key)
            depth = await posture_mod.depth_of(client, key)
            scanned = await findings_mod.last_scan(client, key)
            facts = {"nodes": len(pic.rows), "flows": len(await client.run("flow.edges", key)),
                     "workflows": len(await client.run("ui.workflows", key)),
                     "last_scan": {"at": scanned["at"], "duration_ms": scanned["duration_ms"]} if scanned else None}
            exposure = await posture_mod.exposure(client, key, depth, pic.node)
            blast = await posture_mod.blast_radius(client, key, depth, pic.node)
            targets = await posture_mod.target_exposure(client, key, depth, pic.node)
            central = await chokepoints.betweenness(client, key)
            scans = await findings_mod.history(client, key)
        return {"scenario": scenario, "own_copy": key.startswith("ses:"), "partial": pic.partial, "sentence": pic.sentence,
                "sentence_more": pic.sentence_more,
                "counts": pic.summary_counts, "facts": facts, "exposure": exposure,
                "rule_of_two": scorecard.tally_view(list(pic.cards.values())), "blast": blast, "targets": targets,
                "chokes": posture_mod.chokes(pic.open, pic.node, central), "cut": cut_view(pic.cut), "scans": scans,
                "owasp": views.owasp_coverage(pic.current), "queries": ran}

    @router.get("/scenarios/{scenario}/scans")
    async def scans(request: Request, scenario: str) -> dict[str, Any]:
        """The scans kept on this graph, oldest first: how the count of open findings moved."""
        client, key = await read_key(request, scenario)
        with client.recording() as ran:
            history = await findings_mod.history(client, key)
        return {"scenario": scenario, "scans": history, "queries": ran}

    def short_path(path: str | None) -> str | None:
        """A scenario file named from the directory the scenarios live in, when it is under it."""
        try:
            return str(Path(path).relative_to(settings.scenarios_dir.parent)) if path else None
        except ValueError:
            return path

    @router.get("/scenarios/{scenario}/activity")
    async def activity(request: Request, scenario: str) -> dict[str, Any]:
        """One list, newest first, of what happened here: scans, audit runs, plans tested, decisions, what was applied
        and what was written to a file. Runs come from this process; everything else from the graph."""
        client, key = await read_key(request, scenario)
        shared = keys.scenario_key(scenario)
        for graph in {key, shared}:
            await runs.hydrate(client, graph, again=graph == shared)   # a run another process made (make audit) shows up
        with client.recording() as ran:
            items = [views.activity_of_scan(row) for row in await findings_mod.history(client, key)]
            items += [views.activity_of_run(run) for run in runs.for_graphs(key, shared) if visible(run, request.state.session)]
            written: dict[str, list[dict]] = {}
            for d in await client.run("draft.list", key):
                if d.get("written_at"):
                    written.setdefault(d["mitigation_id"], []).append(d)
            for m in await store.list_all(client, key):
                items += views.activity_of_mitigation(m, [(d, short_path(d["path"])) for d in written.get(m.id, [])])
        items.sort(key=lambda item: -(item["at"] or 0))
        return {"scenario": scenario, "items": items, "queries": ran}

    @router.get("/scenarios/{scenario}/cut")
    async def cut(request: Request, scenario: str) -> dict[str, Any]:
        """The cheapest set of flow hops that separates every untrusted source from every high-impact resource,
        by max flow. A guide for where to look: only a sandbox verdict says whether a fix is safe to make."""
        client, key = await read_key(request, scenario)
        with client.recording() as ran:
            report = await chokepoints.mincut(client, key)
        return {"scenario": scenario} | cut_view(report) | {"queries": ran}

    @router.post("/scenarios/{scenario}/cut/propose")
    async def propose_cut(request: Request, scenario: str) -> Any:
        """The cheapest cut as one plan: the cheapest fix for each hop, verified in a sandbox against every open injection
        finding and stored as a proposal when it passes. A failing verdict is the answer, not an error: the cut is a
        guide, and only the sandbox says whether the plan can be made."""
        client, key = await write_key(request, scenario)
        with client.recording() as ran:
            report = await chokepoints.mincut(client, key)
            current, _ = await findings_mod.current(client, key)
            injections = [f.id for f in current if f.kind == "injection" and f.status == "open"]
            fixes = candidates.cut_fixes(report)
            refused = ("no open injection finding to cut" if not injections else "no hop of the cut can be cut by a fix" if not fixes
                       else f"the cut takes {len(fixes)} fixes and a plan holds at most three" if len(fixes) > 3 else None)
            if refused:                                   # the cut as it stands, not a bad request: 409, with the cut's own code
                return JSONResponse(InvalidFix(refused).to_dict(), status_code=409)
            plan = FixPlan(fixes=fixes)
            try:
                proposed = await ops.propose(client, key, plan, injections, rationale="the cheapest cut, by max flow", source="cut")
                verdict = None
            except FixFailed as e:
                proposed, verdict = None, e.details["verdict"]
        return {"scenario": scenario, "proposed": views.mitigation_view(proposed) if proposed else None, "verdict": verdict,
                "summary": [describe(f) for f in plan.fixes], "queries": ran}

    @router.get("/scenarios/{scenario}/cut/policy")
    async def cut_policy(request: Request, scenario: str) -> dict[str, Any]:
        """The cheapest cut as the rules that would make it: a Claude Code permissions block and the gateway commands.
        A guide like the cut itself; a plan is safe only once a sandbox has passed it."""
        client, key = await read_key(request, scenario)
        report = await chokepoints.mincut(client, key)
        hops = [views.cut_hop(e) for e in report.edges]
        origin = write_mod.origin_of(scenario_path_for(request.state.session, scenario))
        return {"scenario": scenario, "cost": report.cut_cost, "hops": hops} | policy_from_cut(origin, hops, await names(client, key))

    @router.post("/scenarios/{scenario}/labels")
    async def labels(request: Request, scenario: str, body: LabelsBody) -> dict[str, Any]:
        """Label an imported scenario's sources and resources: the file is rewritten and the graph reloaded, then an
        audit starts by itself. An import on this machine is its own install, so the shared graph is the one that
        changes; a public visitor's import is theirs alone, and so is its graph."""
        client, sid = get_client(), request.state.session
        path = scenario_path_for(sid, scenario)
        if path is None:
            raise UnknownScenario(f"no scenario file for {scenario!r}")
        private = path.parent.parent == import_root(sid)
        key = keys.session_key(sid, scenario) if private else keys.scenario_key(scenario)
        report = await ops.relabel(client, scenario, path, body.data_sources, body.resources, graph_key=key)
        run = None
        if body.audit and any(f.status == "open" for f in report.scan.findings):
            run = audit_by_itself(request, scenario, key, "the audit that follows a labelling runs by itself, scripted")
        return {"scenario": scenario, "findings": [views.finding_view(f) for f in report.scan.findings],
                "mismatches": report.mismatches, "run": run.summary() if run else None}

    @router.post("/import")
    async def import_config(request: Request, body: ImportBody) -> dict[str, Any]:
        """Import a real install. On this machine: a pasted config or tools/list, or a source as the command line takes it,
        into the shared scenarios. On a public site: only what is pasted, only servers with a URL, into a scenario that
        exists for this session alone and goes when it does."""
        client, sid = get_client(), request.state.session
        s = get_settings()
        if body.config is None and not body.source:
            raise InvalidScenario("paste a config (mcpServers) or a saved tools/list (tools), or name a source")
        if s.devries_public and body.source:
            raise InvalidScenario("a public site reads only what you paste; it launches nothing")
        if body.name and not keys.SCENARIO_RE.fullmatch(body.name):
            raise InvalidScenario("a scenario name is lower-case letters, digits and underscores, starting with a letter")
        name = body.name or f"import_{(body.client or 'pasted').replace('-', '_')}"
        ration(request, import_limiter)                   # a refused request above did not count
        if s.devries_public:
            root = import_root(sid)
            try:
                result = await import_pasted(body.config or {}, root, name, body.client or "pasted config", body.labels, public=True,
                                             timeout=s.import_timeout_s, max_tools=s.import_max_tools)
            except DeVriesError:
                import_limiter.forgive(client_ip(request))    # refused before it cost anything: not counted either
                raise
            key = keys.session_key(sid, name)
            report = await load_scenario(client, result.scenario_path, root=root, graph_key=key)
            sessions.touch(sid).copies.add(name)
        else:
            root = s.scenarios_dir.parent
            if body.source:
                result = await import_install(body.source, root, name, body.labels)
            else:
                result = await import_pasted(body.config or {}, root, name, body.client or "pasted config", body.labels, public=False,
                                             max_tools=s.import_max_tools)
            key = keys.scenario_key(name)
            report = await load_scenario(client, result.scenario_path, root=root, graph_key=key)
        bus.publish(key, "scan.finished", {"scan_id": report.scan.scan_id, "duration_ms": report.scan.duration_ms, "partial": report.scan.partial,
                                           "open": [f.id for f in report.scan.findings if f.status == "open"], "closed": []})
        run = None
        if body.audit and any(f.status == "open" for f in report.scan.findings):
            run = audit_by_itself(request, name, key, "the audit that follows an import runs by itself, scripted")
        servers = [{"id": sid_, "name": sid_[4:], **guess(sid_[4:])} for sid_ in result.servers]
        return {"scenario": name, "private": s.devries_public, "servers": servers, "tools": result.tools, "skipped": result.skipped,
                "origin": result.origin.to_dict() if result.origin else None,
                # an import declares no workflow, so a sandbox cannot say what a fix breaks until a person adds one
                "unconstrained": not report.nodes.get("workflows"),
                "findings": [views.finding_view(f) for f in report.scan.findings], "run": run.summary() if run else None}

    @router.get("/scenarios/{scenario}/servers")
    async def servers(request: Request, scenario: str) -> dict[str, Any]:
        """Each MCP server: its tools, who holds them, and the findings that run through them."""
        client, key = await read_key(request, scenario)
        with client.recording() as ran:
            rows = await client.run("server.summary", key)
        return {"scenario": scenario, "servers": servers_view(rows), "queries": ran}

    @router.get("/scenarios/{scenario}/inventory")
    async def inventory(request: Request, scenario: str) -> dict[str, Any]:
        """Every agent, tool, source and resource with what the config gives it and what the graph says about it, and
        the servers. One page, four lists; most findings first in each."""
        client, key = await read_key(request, scenario)
        with client.recording() as ran:
            pic = await picture(client, key)
            lists = await posture_mod.inventory(client, key, await client.run("inventory.rows", key), pic.open, pic.cards)
            rows = await client.run("server.summary", key)
        return {"scenario": scenario} | lists | {"servers": servers_view(rows), "queries": ran}

    @router.get("/scenarios/{scenario}/scorecard")
    async def rule_of_two(request: Request, scenario: str) -> dict[str, Any]:
        """Meta's Rule of Two per agent, read off the flow layer by BFS. Context; the findings are the verdicts."""
        client, key = await read_key(request, scenario)
        with client.recording() as ran:
            cards = await scorecard.rule_of_two(client, key)
        return {"scenario": scenario, "agents": [scorecard.card_view(c) for c in cards], "queries": ran}

    @router.get("/scenarios/{scenario}/central")
    async def central(request: Request, scenario: str) -> dict[str, Any]:
        """The most central agents and tools on the flow layer, by betweenness. Context for a person; no verdict."""
        client, key = await read_key(request, scenario)
        with client.recording() as ran:
            report = await chokepoints.betweenness(client, key)
        return {"scenario": scenario, "nodes": [{"id": n.id, "name": n.name, "label": n.label, "score": round(n.score, 3)}
                                                for n in report.nodes], "queries": ran}

    @router.post("/scenarios/{scenario}/scan")
    async def scan(request: Request, scenario: str) -> dict[str, Any]:
        client, key = await write_key(request, scenario)
        with client.recording() as ran:
            result = await ops.scan(client, key)
        return {"scenario": scenario, "scan_id": result.scan_id, "duration_ms": result.duration_ms, "partial": result.partial,
                "findings": [views.finding_view(f) for f in result.findings],
                "closed": [finding_id_of(fp) for fp in result.closed_fingerprints], "queries": ran}

    @router.get("/scenarios/{scenario}/findings")
    async def findings(request: Request, scenario: str) -> dict[str, Any]:
        client, key = await read_key(request, scenario)
        with client.recording() as ran:
            current, partial = await findings_mod.current(client, key)
            holding = {f.fingerprint for f in current}
            past = [f for f in await findings_mod.stored(client, key) if f.fingerprint not in holding]
            for finding in past:                          # a stored `open` that no longer holds awaits the next scan
                if finding.status == "open":
                    finding.status = "closed"
            name_of = await names(client, key)
            scanned = await findings_mod.last_scan(client, key)
        return {"scenario": scenario, "partial": partial, "own_copy": key.startswith("ses:"),
                "findings": [views.finding_view(f) for f in current],
                "past": [views.finding_view(f) for f in past], "names": name_of, "last_scan": scanned, "queries": ran}

    async def one_finding(client: GraphClient, key: str, scenario: str, finding_id: str):
        current, _ = await findings_mod.current(client, key)
        found = next((f for f in current if f.id == finding_id), None)
        if found is None:
            found = next((f for f in await findings_mod.stored(client, key) if f.id == finding_id), None)
            if found is None:
                raise NotFound(f"no finding {finding_id!r} in {scenario}")
            if found.status == "open":
                found.status = "closed"
        return found

    @router.get("/scenarios/{scenario}/findings/{finding_id}")
    async def finding(request: Request, scenario: str, finding_id: str) -> dict[str, Any]:
        client, key = await read_key(request, scenario)
        with client.recording() as ran:
            found = await one_finding(client, key, scenario, finding_id)
            name_of = await names(client, key)
        return {"scenario": scenario, "finding": views.finding_view(found), "names": name_of, "queries": ran}

    @router.get("/scenarios/{scenario}/findings/{finding_id}/brief.md")
    async def finding_brief(request: Request, scenario: str, finding_id: str) -> PlainTextResponse:
        """The finding as a document to forward: the brief, the path, every plan tested, the change drafted."""
        client, key = await read_key(request, scenario)
        found = await one_finding(client, key, scenario, finding_id)
        name_of = await names(client, key)
        plans = [views.mitigation_view(m) for m in await store.list_all(client, key)
                 if finding_id in m.targets or (m.verdict and any(finding_id_of(fp) == finding_id for fp in m.verdict.diff.resolved))]
        draft = None
        chosen = next((m for m in plans if m["status"] == "applied"), None) or next((m for m in plans if m["status"] == "proposed" and m["passed"]), None)
        if chosen:
            try:
                draft = (await write_mod.draft_for(client, key, scenario_path_for(request.state.session, scenario), chosen["id"], name_of)).view()
            except DeVriesError:
                draft = None
        text = views.brief_markdown(scenario, views.finding_view(found), name_of, plans, draft)
        return PlainTextResponse(text, media_type="text/markdown; charset=utf-8",
                                 headers={"Content-Disposition": f'inline; filename="{finding_id.replace(":", "-")}.md"'})

    @router.get("/scenarios/{scenario}/findings/{finding_id}/figure.svg")
    async def finding_figure(request: Request, scenario: str, finding_id: str) -> Response:
        """The finding's path as one small picture, drawn here so it can be fetched without a browser."""
        client, key = await read_key(request, scenario)
        found = await one_finding(client, key, scenario, finding_id)
        return Response(views.figure_svg(views.finding_view(found), await names(client, key)), media_type="image/svg+xml")

    # ------------------------------------------------------------------ mitigations

    @router.post("/scenarios/{scenario}/findings/{finding_id}/accept")
    async def accept_finding(request: Request, scenario: str, finding_id: str, body: Decision) -> dict[str, Any]:
        """A person accepts an open finding as it is. Only a person can: no MCP tool offers it."""
        client, key = await write_key(request, scenario)
        finding = await ops.accept_finding(client, key, finding_id, body.who(), session=store.session_hash(request.state.session))
        return {"scenario": scenario, "finding": views.finding_view(finding)}

    @router.get("/scenarios/{scenario}/mitigations")
    async def mitigations(request: Request, scenario: str) -> dict[str, Any]:
        client, key = await read_key(request, scenario)
        return {"scenario": scenario, "config_hash": await sandbox.config_hash(client, key),
                "mitigations": [views.mitigation_view(m) for m in await store.list_all(client, key)]}

    @router.post("/scenarios/{scenario}/mitigations/search")
    async def search(request: Request, scenario: str, body: SearchBody) -> dict[str, Any]:
        client, key = await write_key(request, scenario)
        with client.recording() as ran:
            result = await ops.search(client, key, body.finding_ids)
        return {"scenario": scenario, "targets": result.targets, "sandbox_runs": result.sandbox_runs,
                "passing": [views.mitigation_view(m) for m in result.passing],
                "failed": [views.mitigation_view(m) for m in result.failed], "queries": ran}

    @router.get("/scenarios/{scenario}/mitigations/{mitigation_id}")
    async def mitigation(request: Request, scenario: str, mitigation_id: str) -> dict[str, Any]:
        client, key = await read_key(request, scenario)
        return {"scenario": scenario, "mitigation": views.mitigation_view(await store.get(client, key, mitigation_id))}

    @router.get("/scenarios/{scenario}/mitigations/{mitigation_id}/preview")
    async def preview(request: Request, scenario: str, mitigation_id: str) -> dict[str, Any]:
        """The flow layer as it would be with this plan applied, read from a sandbox that is then deleted."""
        client, key = await read_key(request, scenario)
        mitigation = await store.get(client, key, mitigation_id)
        if mitigation.status == "applied":                # it is in the graph already: the graph is the preview
            return {"scenario": scenario, "mitigation_id": mitigation_id, "applied": True} | await graph_view(client, key, "flow")
        sessions.count_sandbox_read(request.state.session)
        async with sandbox.changed(client, key, list(mitigation.plan.fixes)) as after:
            view = await graph_view(client, after, "flow")
        return {"scenario": scenario, "mitigation_id": mitigation_id, "applied": False} | view

    @router.get("/scenarios/{scenario}/mitigations/{mitigation_id}/draft")
    async def draft(request: Request, scenario: str, mitigation_id: str) -> dict[str, Any]:
        """The plan as the change to the configuration it came from: the text that would be written, a diff, a note.
        Read-only: nothing is recorded or written here."""
        client, key = await read_key(request, scenario)
        path = scenario_path_for(request.state.session, scenario)
        d = await write_mod.draft_for(client, key, path, mitigation_id, await names(client, key))
        private = path is not None and path.parent.parent == import_root(request.state.session)
        can_write = not settings.devries_public and d.writable and not private
        return {"scenario": scenario, "mitigation_id": mitigation_id, "draft": d.view(), "can_write": can_write,
                "origin": (write_mod.origin_of(path).to_dict() if write_mod.origin_of(path) else None)}

    @router.put("/scenarios/{scenario}/mitigations/{mitigation_id}/draft")
    async def edit_draft(request: Request, scenario: str, mitigation_id: str, body: DraftBody) -> dict[str, Any]:
        """A person's edit of the text that would be written, kept on their own copy until it is written."""
        client, key = await write_key(request, scenario)
        path = scenario_path_for(request.state.session, scenario)
        d = await write_mod.edit(client, key, path, mitigation_id, await names(client, key), body.after)
        return {"scenario": scenario, "mitigation_id": mitigation_id, "draft": d.view(), "can_write": not settings.devries_public and d.writable}

    @router.post("/scenarios/{scenario}/mitigations/{mitigation_id}/draft/write")
    async def write_draft(request: Request, scenario: str, mitigation_id: str, body: WriteBody) -> dict[str, Any]:
        """Write the draft of an approved plan to the file it came from. A person's click, never a tool's; refused for a plan
        nobody approved and on a public site. The shared scenario is read again from the file and rescanned, and this
        visitor's copy is dropped, so what they see next is the configuration as it now is."""
        if settings.devries_public:
            raise ForbiddenWrite("this is a public site: it offers the change to copy or download, and never writes a file here")
        client, sid = get_client(), request.state.session
        decision = body
        source_key = sessions.key_for_read(sid, scenario)
        if not await client.exists(source_key):
            raise UnknownScenario(f"no scenario {scenario!r}")
        path = scenario_path_for(sid, scenario)
        if path is None:
            raise write_mod.NotWritable(f"{scenario} has no file on this machine to write to")
        shared = keys.scenario_key(scenario)
        receipt = await write_mod.write(client, source_key, shared, path, mitigation_id, await names(client, source_key), decision.who(),
                                        decision.after, root=path.parent.parent)
        if source_key != shared:
            for run in runs.for_graph(source_key):
                if run.id in tasks:
                    tasks[run.id].cancel()
            runs.forget(source_key)
            await sessions.drop_scenario(client, sid, scenario)
        write_mod.announce(shared, mitigation_id, receipt)
        # what the written file still leaves open gets its next plan the way the app's start does: scripted, on the shared graph
        if receipt.open_after and runs.active(shared) is None:
            run = runs.create("audit", scenario, shared, scenario)
            spawn(run, Auditor(client, None, server=mcp_server, stop_after_proposal=True,
                               no_model_reason="the audit that follows a written change runs by itself, scripted"))
        return {"scenario": scenario, "mitigation_id": mitigation_id, "receipt": receipt.to_dict()}

    @router.post("/scenarios/{scenario}/whatif")
    async def what_if(request: Request, scenario: str, body: WhatIfBody) -> dict[str, Any]:
        """What these changes would open, close and break. Measured in a sandbox, so nothing is written
        and the visitor needs no copy of their own."""
        client, key = await read_key(request, scenario)
        sessions.count_sandbox_read(request.state.session)
        diff = await ops.what_if(client, key, body.changes)
        return {"scenario": scenario, "changes": [views.describe(c) for c in body.changes]} | views.diff_view(diff)

    @router.post("/scenarios/{scenario}/mitigations/{mitigation_id}/approve")
    async def approve(request: Request, scenario: str, mitigation_id: str, body: Decision) -> dict[str, Any]:
        """A person approves a plan, by name, from their own session; the decision records both."""
        client, key = await write_key(request, scenario)
        approved = await ops.approve(client, key, mitigation_id, body.who(), session=request.state.session)
        return {"scenario": scenario, "mitigation": views.mitigation_view(approved),
                "applies": "the audit run waiting on it" if busy(key) else "POST .../apply"}

    @router.post("/scenarios/{scenario}/mitigations/{mitigation_id}/reject")
    async def reject(request: Request, scenario: str, mitigation_id: str, body: Decision) -> dict[str, Any]:
        client, key = await write_key(request, scenario)
        rejected = await ops.reject(client, key, mitigation_id, body.who(), body.reason, session=request.state.session)
        return {"scenario": scenario, "mitigation": views.mitigation_view(rejected)}

    @router.post("/scenarios/{scenario}/mitigations/{mitigation_id}/apply")
    async def apply(request: Request, scenario: str, mitigation_id: str) -> dict[str, Any]:
        client, key = await write_key(request, scenario)
        patch = await ops.apply(client, key, mitigation_id)
        result = await ops.scan(client, key)              # so the findings it resolved close now
        # what is still open gets its next plan without a click: the audit that follows an applied plan
        if any(f.status == "open" for f in result.findings) and runs.active(key) is None:
            audit_by_itself(request, scenario, key, "the audit that follows an applied plan runs by itself, scripted")
        return {"scenario": scenario, "patch": patch.model_dump(),
                "open": [f.id for f in result.findings if f.status == "open"]}

    # ------------------------------------------------------------------ the auditor

    @router.post("/agent/runs")
    async def start_audit(request: Request, body: RunBody) -> dict[str, Any]:
        sid = request.state.session
        ration(request, run_limiter)
        client, key = await write_key(request, body.scenario)
        active = runs.active(key)
        if active is not None:
            raise RunActive("an audit run is already working on your copy of this scenario", run_id=active.id)
        model, reason = model_for(sid, "audit")
        run = runs.create("audit", body.scenario, key, sessions.ref(sid, body.scenario))
        spawn(run, Auditor(client, model, server=mcp_server, no_model_reason=reason))
        return {"run": run.summary()}

    @router.post("/agent/ask")
    async def start_ask(request: Request, body: AskBody) -> dict[str, Any]:
        sid = request.state.session
        ration(request, run_limiter)
        client, key = await read_key(request, body.scenario)      # an ask run writes nothing outside sandboxes
        model, reason = model_for(sid, "ask")
        run = runs.create("ask", body.scenario, key, sessions.ref(sid, body.scenario), question=body.question,
                          session=store.session_hash(sid))         # a question is the asker's: listed to their session only
        spawn(run, Auditor(client, model, server=mcp_server, ref_for=lambda name: sessions.ref(sid, name),
                           no_model_reason=reason))
        return {"run": run.summary()}

    @router.get("/agent/runs/{run_id}")
    async def get_run(request: Request, run_id: str) -> dict[str, Any]:
        return {"run": (await own_run(request, run_id)).model_dump()}

    @router.get("/scenarios/{scenario}/runs")
    async def scenario_runs(request: Request, scenario: str) -> dict[str, Any]:
        """The runs on this session's view of the scenario, and on the shared scenario a copy came from: the run the
        app made at start, which proposed the plan a visitor is reading, stays in their Audit after they approve it."""
        client, key = await read_key(request, scenario)
        shared = keys.scenario_key(scenario)
        for graph in {key, shared}:
            await runs.hydrate(client, graph, again=graph == shared)   # a run another process made (make audit) shows up
        return {"scenario": scenario, "runs": [r.summary() for r in reversed(runs.for_graphs(key, shared))
                                               if visible(r, request.state.session)]}

    # ------------------------------------------------------------------ events

    @router.get("/events")
    async def events(request: Request) -> StreamingResponse:
        sid = request.state.session

        def mine(event) -> bool:
            """A visitor sees events about the graph they are looking at: their copy if they have one."""
            try:
                return event.graph == sessions.key_for_read(sid, event.scenario)
            except UnknownScenario:
                return False

        try:
            after = int(request.headers.get("last-event-id", ""))
        except ValueError:
            after = None
        if after is not None and after > bus.last_seq:    # ids from before a restart mean nothing now
            after = None

        async def stream():
            yield f"data: {json.dumps({'type': 'hello', 'boot': BOOT, 'last': bus.last_seq})}\n\n"
            with bus.subscribe(mine, after=after) as subscription:
                while True:
                    event = await subscription.get(timeout=15)
                    if event is None:
                        if await request.is_disconnected():
                            return
                        yield ": keep-alive\n\n"
                        continue
                    yield f"id: {event.seq}\ndata: {json.dumps(event.public(), default=str)}\n\n"

        return StreamingResponse(stream(), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    return router, busy, tasks, spawn


async def graph_unavailable(request: Request, exc: rex.RedisError) -> JSONResponse:
    log.error("FalkorDB error on %s: %s", request.url.path, type(exc).__name__)
    return JSONResponse({"error": {"code": "graph_unavailable", "message": f"FalkorDB: {type(exc).__name__}",
                                   "retryable": True}}, status_code=503)
