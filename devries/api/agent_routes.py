"""The auditor's runs and questions, and the event stream."""

import json
import logging
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse

from devries.agent.loop import Auditor
from devries.agent.runs import runs
from devries.api.context import Context
from devries.api.models import AskBody, RunActive, RunBody
from devries.errors import UnknownScenario
from devries.events import BOOT, bus
from devries.graph import keys
from devries.mitigation import store

log = logging.getLogger("devries.api")


def mount(router: APIRouter, ctx: Context) -> None:
    sessions = ctx.sessions
    mcp_server = ctx.mcp_server
    run_limiter = ctx.run_limiter
    read_key = ctx.read_key
    write_key = ctx.write_key
    model_for = ctx.model_for
    spawn = ctx.spawn
    own_run = ctx.own_run
    visible = ctx.visible
    ration = ctx.ration

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

