"""The findings: the list, one finding, its brief and its figure, and a person's acceptance."""

import logging
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import PlainTextResponse, Response

from devries import views
from devries.analysis import findings as findings_mod
from devries.analysis.models import finding_id as finding_id_of
from devries.api.context import Context
from devries.errors import DeVriesError, NotFound
from devries.graph.client import GraphClient
from devries.mitigation import store
from devries.mitigation import write as write_mod

log = logging.getLogger("devries.api")


def mount(router: APIRouter, ctx: Context) -> None:
    scenario_path_for = ctx.scenario_path_for
    read_key = ctx.read_key
    names = ctx.names

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

