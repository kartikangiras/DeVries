"""The REST API: one router, mounted resource by resource. Every route answers with ids and display names, refuses
with a structured error, and reads the graph a visitor is looking at (their own copy once they changed something)."""

import asyncio
from typing import Any, Callable

from fastapi import APIRouter

from devries.agent.llm import LLM
from devries.agent.loop import Auditor
from devries.agent.runs import Run
from devries.api import agent_routes, finding_routes, mitigation_routes, scenario_routes, session_routes
from devries.api.context import Context
from devries.api.models import error_response, graph_unavailable  # noqa: F401 - the app imports both from here
from devries.api.sessions import Sessions


def build_router(sessions: Sessions, llm: LLM | None, scenario_info: Callable[[], dict[str, dict[str, Any]]],
                 mcp_server: Any) -> tuple[APIRouter, Any, dict[str, asyncio.Task], Callable[[Run, Auditor], None]]:
    """The router, the janitor's "is a run using this graph" check, the running tasks, and how to start a run."""
    ctx = Context(sessions, llm, scenario_info, mcp_server)
    router = APIRouter(prefix="/api")
    for module in (session_routes, scenario_routes, finding_routes, mitigation_routes, agent_routes):
        module.mount(router, ctx)
    return router, ctx.busy, ctx.tasks, ctx.spawn
