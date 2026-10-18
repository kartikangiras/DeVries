"""The plans: the search, a plan, its draft, the what-if, and the decisions a person makes."""

import logging
from typing import Any

from fastapi import APIRouter, Request

from devries import ops, views
from devries.agent.loop import Auditor
from devries.agent.runs import runs
from devries.api.context import Context
from devries.api.models import Decision, DraftBody, SearchBody, WhatIfBody, WriteBody
from devries.api.picture import graph_view
from devries.errors import ForbiddenWrite, UnknownScenario
from devries.graph import keys
from devries.graph.client import get_client
from devries.mitigation import sandbox, store
from devries.mitigation import write as write_mod

log = logging.getLogger("devries.api")


def mount(router: APIRouter, ctx: Context) -> None:
    sessions = ctx.sessions
    settings = ctx.settings
    tasks = ctx.tasks
    mcp_server = ctx.mcp_server
    busy = ctx.busy
    import_root = ctx.import_root
    scenario_path_for = ctx.scenario_path_for
    read_key = ctx.read_key
    write_key = ctx.write_key
    names = ctx.names
    spawn = ctx.spawn
    audit_by_itself = ctx.audit_by_itself

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

