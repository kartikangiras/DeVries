"""What every route shares: the sessions, the model, the run slots, the rate limits, and the helpers that pick the graph a request works on. Built once per app, bound once, read by every route module."""

import asyncio
import re
from pathlib import Path
from typing import Any, Callable

from fastapi import Request

from devries.agent.llm import LLM, spend
from devries.agent.loop import Auditor
from devries.agent.runs import Run, runs
from devries.api.sessions import RateLimiter, Sessions, client_ip
from devries.config import get_settings
from devries.errors import DeVriesError, NotFound, UnknownScenario
from devries.graph import keys
from devries.graph.client import GraphClient, get_client
from devries.ingest.scenario_loader import read_scenario
from devries.mitigation import store
from devries.mitigation import write as write_mod


class Context:
    """The shared state and helpers, as `build_router` used to hold them in one closure."""

    def __init__(self, sessions: Sessions, llm: LLM | None, scenario_info: Callable[[], dict[str, dict[str, Any]]], mcp_server: Any):
        self.sessions, self.llm, self.scenario_info, self.mcp_server = sessions, llm, scenario_info, mcp_server
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


        self.sessions = sessions
        self.llm = llm
        self.settings = settings
        self.tasks = tasks
        self.slots = slots
        self.scenario_info = scenario_info
        self.mcp_server = mcp_server
        self.import_limiter = import_limiter
        self.run_limiter = run_limiter
        self.busy = busy
        self.import_root = import_root
        self.scenario_path_for = scenario_path_for
        self.private_info = private_info
        self.read_key = read_key
        self.write_key = write_key
        self.names = names
        self.model_for = model_for
        self.spawn = spawn
        self.audit_by_itself = audit_by_itself
        self.own_run = own_run
        self.visible = visible
        self.ration = ration
