"""A scenario as the pages read it: the graph, the overview, the posture, the scans, the activity, the cut, the labels, an import, the tables."""

import logging
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Query, Request
from fastapi.responses import JSONResponse

from devries import ops, views
from devries.agent.runs import runs
from devries.analysis import chokepoints, scorecard
from devries.analysis import findings as findings_mod
from devries.analysis import posture as posture_mod
from devries.analysis.models import finding_id as finding_id_of
from devries.api.context import Context
from devries.api.models import ImportBody, LabelsBody
from devries.api.picture import cut_view, graph_view, picture, servers_view
from devries.api.sessions import client_ip
from devries.config import get_settings
from devries.errors import DeVriesError, FixFailed, InvalidFix, InvalidScenario, UnknownScenario
from devries.events import bus
from devries.graph import keys
from devries.graph.client import get_client
from devries.ingest.importer import guess, import_install, import_pasted
from devries.ingest.scenario_loader import load_scenario
from devries.mitigation import candidates, store
from devries.mitigation import write as write_mod
from devries.mitigation.compile import policy_from_cut
from devries.mitigation.dsl import FixPlan, describe

log = logging.getLogger("devries.api")


def mount(router: APIRouter, ctx: Context) -> None:
    sessions = ctx.sessions
    settings = ctx.settings
    scenario_info = ctx.scenario_info
    import_limiter = ctx.import_limiter
    import_root = ctx.import_root
    scenario_path_for = ctx.scenario_path_for
    private_info = ctx.private_info
    read_key = ctx.read_key
    write_key = ctx.write_key
    names = ctx.names
    audit_by_itself = ctx.audit_by_itself
    visible = ctx.visible
    ration = ctx.ration

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

