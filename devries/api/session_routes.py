"""The visitor's session, the query catalog and the figures the pages quote."""

import logging
from typing import Any

from fastapi import APIRouter, Request

from devries import about
from devries.agent.llm import spend
from devries.agent.runs import runs
from devries.api.context import Context
from devries.config import get_settings
from devries.graph import keys
from devries.graph.catalog import CATALOG
from devries.graph.client import get_client

log = logging.getLogger("devries.api")


def mount(router: APIRouter, ctx: Context) -> None:
    sessions = ctx.sessions
    llm = ctx.llm
    tasks = ctx.tasks
    scenario_info = ctx.scenario_info

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

    @router.get("/about")
    async def about_route() -> dict[str, Any]:
        """The figures the pages quote: rules, fix costs, tool and query counts, the model, the last eval. One source."""
        return about.describe(about.version(), llm.name if llm else None, len(scenario_info()))

