"""The app process: REST API, event stream, MCP server at /mcp, the auditor, the janitor and the built UI.

    uv run uvicorn devries.app:app --port 8000

At start it waits for FalkorDB (a host with no `depends_on`, or a reboot, brings the database up
late), loads any scenario whose graph is missing, and then audits each shared scenario to its
first proposal, scripted, so that the first screen a visitor sees holds tested plans and not a
button. If the database is still absent it starts anyway, refuses scans with a clear 503, and the
janitor keeps trying.
"""

import asyncio
import json
import logging
import time
from contextlib import asynccontextmanager, suppress
from typing import Any

import redis.exceptions as rex
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from devries.agent.llm import configured_llm, spend
from devries.agent.loop import Auditor
from devries.agent.runs import runs
from devries.analysis.canary import run_canary
from devries.api.routes import build_router, error_response, graph_unavailable
from devries.api.sessions import SessionMiddleware, Sessions
from devries.config import get_settings
from devries.errors import DeVriesError
from devries.graph import keys
from devries.graph.client import GraphClient, get_client
from devries.ingest.scenario_loader import load_scenario, read_scenario
from devries.mcp_server.server import build_server
from devries.mitigation import sandbox

log = logging.getLogger("devries.app")

JANITOR_EVERY_S = 60


async def seed_missing(client: GraphClient) -> dict[str, str]:
    """Load every scenario file whose graph is absent, so a fresh or wiped database heals itself."""
    present = set(await client.list_graphs())
    outcome: dict[str, str] = {}
    for path in sorted(get_settings().scenarios_dir.glob("*.yaml")):
        try:
            name = read_scenario(path).spec.scenario
            if keys.scenario_key(name) in present:
                outcome[name] = "present"
                continue
            report = await load_scenario(client, path)
            outcome[name] = "loaded" if report.ok else "loaded, but the scan disagrees with expect"
        except DeVriesError as e:
            outcome[path.stem] = f"failed: {e.message}"
            log.error("could not load %s: %s", path.name, e.message)
    return outcome


def scenario_info() -> dict[str, dict[str, Any]]:
    """What the scenario files say about themselves, for the scenario list."""
    info: dict[str, dict[str, Any]] = {}
    for path in sorted(get_settings().scenarios_dir.glob("*.yaml")):
        with suppress(DeVriesError):
            spec = read_scenario(path).spec
            info[spec.scenario] = {"title": spec.title or spec.scenario, "description": spec.description, "order": spec.order,
                                   "imported": bool(spec.imported)}
    return info


async def wait_for_db(client: GraphClient, seconds: int) -> bool:
    """True once FalkorDB answers, waiting up to `seconds`; False if it never did."""
    deadline = time.monotonic() + max(0, seconds)
    while True:
        if await client.ping():
            return True
        if time.monotonic() >= deadline:
            return False
        log.warning("FalkorDB is not reachable yet; trying again in 2 s")
        await asyncio.sleep(2)


def create_app() -> FastAPI:
    settings = get_settings()
    mcp = build_server()
    mcp_http = mcp.streamable_http_app()        # creates the session manager; its route is /mcp
    sessions = Sessions()
    llm = configured_llm(settings)
    router, busy, tasks, spawn = build_router(sessions, llm, scenario_info, mcp)

    async def prerun(client: GraphClient) -> int:
        """Audit each shared scenario with open findings to its first proposal, scripted, so a visitor's first screen
        shows what a sandbox said, and their Audit holds the run that said it. Stops at the proposal: nobody is there
        to nod. Plans left by an earlier process are recorded again under the same ids; the run is what a restart
        loses, so it is made again."""
        started = 0
        for name, state in sorted(app.state.seeded.items()):
            if state.startswith("failed"):
                continue
            key = keys.scenario_key(name)
            try:
                summary = (await client.run("scenario.summary", key))[0]
                if not summary["open_findings"] or runs.active(key) is not None:
                    continue
            except Exception:
                continue
            run = runs.create("audit", name, key, name)
            spawn(run, Auditor(client, None, server=mcp, stop_after_proposal=True,
                               no_model_reason="this is the pass the app runs at start, scripted, so that the first screen shows tested plans"))
            started += 1
        return started

    async def bring_up(client: GraphClient) -> None:
        check = await run_canary(client)
        if not check.ok:
            log.error("self-check failed, scans will be refused: %s", check.detail)
        app.state.seeded = await seed_missing(client)
        await sandbox.sweep(client, max_age_min=0)      # any sandbox present at start was left by a crash
        await sessions.recover(client)
        app.state.db_ready = True
        if settings.prerun_audits:
            started = await prerun(client)
            if started:
                log.info("pre-run audits started on %d scenario(s)", started)

    async def janitor(client: GraphClient) -> None:
        """Sandboxes left by a crash and the copies of idle sessions are deleted here; a database that came up late
        is brought up here; copies past the memory ceiling go here."""
        while True:
            await asyncio.sleep(JANITOR_EVERY_S)
            try:
                if not app.state.db_ready:
                    if await client.ping():
                        log.info("FalkorDB is reachable now; loading scenarios")
                        await bring_up(client)
                    continue
                swept = await sandbox.sweep(client) + await sessions.sweep(client, busy)
                if settings.falkordb_memory_ceiling_mb:
                    used = await client.memory_mb()
                    if used and used > settings.falkordb_memory_ceiling_mb:
                        swept += await sessions.drop_oldest(client, busy)
                        log.warning("FalkorDB holds %s MB, past the %s MB ceiling: the oldest idle copies were dropped",
                                    used, settings.falkordb_memory_ceiling_mb)
                if swept:
                    log.info("janitor removed %d graph(s)", len(swept))
            except Exception:                   # the janitor must outlive a bad minute
                log.exception("janitor pass failed")

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        client = get_client()
        app.state.seeded = {}
        app.state.db_ready = False
        if await wait_for_db(client, settings.startup_db_wait_s):
            await bring_up(client)
        else:
            log.error("FalkorDB is not reachable; starting without scenario graphs, and trying again every minute")
        sweeper = asyncio.create_task(janitor(client), name="janitor")
        try:
            async with mcp.session_manager.run():
                yield
        finally:
            for task in [sweeper, *tasks.values()]:
                task.cancel()
            await asyncio.gather(sweeper, *tasks.values(), return_exceptions=True)

    app = FastAPI(title="DeVries", version="0.3.0", lifespan=lifespan)
    app.state.sessions = sessions
    app.add_middleware(SessionMiddleware)
    app.add_exception_handler(DeVriesError, lambda request, exc: error_response(exc))
    app.add_exception_handler(rex.RedisError, graph_unavailable)

    @app.get("/api/health")
    async def health():
        client = get_client()
        reachable = await client.ping()
        body: dict = {"falkordb": reachable, "falkordb_version": None, "falkordb_mb": None, "scenarios": {}, "canary": None,
                      "public": settings.devries_public}
        if reachable:
            body["falkordb_version"] = await client.version()
            body["falkordb_mb"] = await client.memory_mb()
            present = set(await client.list_graphs())
            for path in sorted(settings.scenarios_dir.glob("*.yaml")):
                body["scenarios"][path.stem] = keys.scenario_key(path.stem) in present
            check = await run_canary(client)
            body["canary"] = {"ok": check.ok, "detail": check.detail, "ms": check.ms}
        body["model"] = {"configured": llm is not None, "name": llm.name if llm else None,
                         "budget_spent": spend.exhausted(), "spent_today_usd": round(spend.today_usd, 4)}
        body["sessions"] = {"holding_copies": len(sessions.holders()), "max": settings.session_max}
        body["runs"] = {"active": sum(1 for r in runs._runs.values() if r.status in ("running", "awaiting_approval"))}
        healthy = reachable and bool(body["canary"] and body["canary"]["ok"]) and all(body["scenarios"].values())
        body["ok"] = healthy
        return JSONResponse(body, status_code=200 if healthy else 503)

    app.include_router(router)
    app.router.routes.extend(mcp_http.routes)
    if settings.ui_dist.is_dir():               # the built UI; in development Vite serves it and proxies /api
        app.mount("/", StaticFiles(directory=settings.ui_dist, html=True), name="ui")
    log.info(json.dumps({"event": "app", "public": settings.devries_public, "model": llm.name if llm else None}))
    return app


app = create_app()
