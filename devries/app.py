"""The app process: REST API, event stream, MCP server at /mcp, the auditor, the janitor and the built UI.

    uv run uvicorn devries.app:app --port 8000

At start it waits for FalkorDB (a host with no `depends_on`, or a reboot, brings the database up
late), loads any scenario whose graph is missing, and then audits each shared scenario to its
first proposal, with the configured model when there is one and scripted otherwise, so that the
first screen a visitor sees holds tested plans and not a button. If the database is still absent it starts anyway, refuses scans with a clear 503, and the
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
from mcp.server.transport_security import TransportSecuritySettings

from devries import about
from devries.agent.llm import configured_llm, spend
from devries.agent.loop import Auditor
from devries.agent.runs import Persister, runs
from devries.analysis import findings as findings_mod
from devries.analysis.canary import ensure as canary_ensure
from devries.analysis.canary import run_canary
from devries.api.routes import build_router, error_response, graph_unavailable
from devries.api.sessions import SessionMiddleware, Sessions
from devries.config import get_settings
from devries.errors import DeVriesError
from devries.graph import keys
from devries.graph.client import GraphClient, get_client
from devries.ingest.scenario_loader import load_scenario, read_scenario
from devries.mcp_server.server import build_server
from devries.mitigation import sandbox, store

log = logging.getLogger("devries.app")

JANITOR_EVERY_S = 60
PRERUN_QUIET_S = 600         # a scenario whose last run ended this recently is left alone by the janitor


async def needs_prerun(client: GraphClient, key: str, quiet_s: float = 0) -> bool:
    """Whether a shared scenario has an open injection or trifecta finding that no proposed plan addresses and no run is
    working on: what the start-up pass and the janitor look for before starting a scripted audit. The janitor also leaves
    a scenario alone for `quiet_s` after its last run, so a scenario where no plan passes is not audited every minute."""
    if runs.active(key) is not None:
        return False
    current, _ = await findings_mod.current(client, key)
    open_fps = {f.fingerprint for f in current if f.status == "open" and f.kind in ("injection", "trifecta")}
    if not open_fps:
        return False
    for m in await store.list_all(client, key):
        if m.status == "proposed" and m.passed and set(m.targets) & open_fps:
            return False
    newest = max((r.finished_at or r.started_at for r in runs.for_graph(key)), default=0)
    return (time.time() * 1000 - newest) > quiet_s * 1000


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


def served_hosts(allowed_hosts: str | None) -> list[str]:
    """The host names this app answers to: this machine, plus whatever ALLOWED_HOSTS names (the public site, a LAN address)."""
    extra = [h.strip() for h in (allowed_hosts or "").split(",") if h.strip()]
    return ["localhost", "127.0.0.1", "[::1]", *extra]


def transport_security(allowed_hosts: str | None) -> TransportSecuritySettings:
    """The MCP endpoint's own Host and Origin check, with the same hosts the API accepts: the SDK's default allows
    localhost only, which answers 421 to every request that arrives through a reverse proxy on a real name."""
    hosts = served_hosts(allowed_hosts)
    return TransportSecuritySettings(
        enable_dns_rebinding_protection=True,
        allowed_hosts=[pattern for h in hosts for pattern in (h, f"{h}:*")],
        allowed_origins=[f"{scheme}://{h}{port}" for h in hosts for scheme in ("http", "https") for port in ("", ":*")])


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
    if settings.devries_public and not settings.devries_mcp_token:
        raise RuntimeError("DEVRIES_PUBLIC is set but DEVRIES_MCP_TOKEN is not: /mcp must not be open on a public address")
    if not settings.devries_mcp_token:
        log.warning("/mcp accepts every caller: set DEVRIES_MCP_TOKEN before this app is reachable beyond this machine")
    mcp = build_server()
    mcp_http = mcp.streamable_http_app(transport_security=transport_security(settings.allowed_hosts))   # its route is /mcp
    sessions = Sessions()
    llm = configured_llm(settings)
    router, busy, tasks, spawn = build_router(sessions, llm, scenario_info, mcp)

    async def prerun(client: GraphClient, reason: str, quiet_s: float = 0) -> int:
        """Audit each shared scenario that has an open finding and no plan proposed for it to its first proposal, with the
        configured model when PRERUN_MODEL allows it and scripted otherwise, so a visitor's first screen shows what a
        sandbox said, and their Audit holds the run that said it. Stops at the proposal: nobody is there to approve.
        Runs and plans persist on the graph, so a restart starts nothing twice; a graph reseeded from outside (a test
        run, `make seed`) loses its plans, and the janitor finds that here."""
        model = llm if settings.prerun_model else None
        started = 0
        for name, state in sorted(app.state.seeded.items()):
            if state.startswith("failed"):
                continue
            key = keys.scenario_key(name)
            try:
                await runs.hydrate(client, key)
                if not await needs_prerun(client, key, quiet_s):
                    continue
            except Exception as e:  # noqa: BLE001 - one scenario's trouble does not stop the others
                log.warning("could not read %s before the start-up pass: %s", name, type(e).__name__)
                continue
            run = runs.create("audit", name, key, name)
            spawn(run, Auditor(client, model, server=mcp, stop_after_proposal=True, no_model_reason=reason))
            started += 1
        if started:
            log.info("%d audit(s) started by the app itself, %s", started, f"driven by {model.name}" if model else "scripted")
        return started

    async def bring_up(client: GraphClient) -> None:
        check = await run_canary(client)
        if not check.ok:
            log.error("self-check failed, scans will be refused: %s", check.detail)
        app.state.seeded = await seed_missing(client)
        await sandbox.sweep(client, max_age_min=0)      # any sandbox present at start was left by a crash
        await sessions.recover(client)
        runs.persister = Persister(client)
        spend.attach(client)
        await spend.load()                              # today's model spend, shared with every other process
        for name in app.state.seeded:                   # the runs an earlier process made, back from the graphs
            await runs.hydrate(client, keys.scenario_key(name))
        app.state.db_ready = True
        if settings.prerun_audits:
            await prerun(client, "this is the pass the app runs at start, so that the first screen shows tested plans")

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
                await spend.load()                      # another process may have spent since
                swept = await sandbox.sweep(client) + await sessions.sweep(client, busy)
                if settings.prerun_audits:              # a graph reseeded from outside has lost its plans: make them again
                    for name in list(app.state.seeded):
                        key = keys.scenario_key(name)
                        if runs.is_hydrated(key) and not await client.run("run.list", key) and runs.for_graph(key):
                            runs.forget(key)            # the graph was replaced: what this process remembers of it is stale
                    await prerun(client, "the graph was loaded again, so the pass that proposes a plan ran again", quiet_s=PRERUN_QUIET_S)
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
            if isinstance(runs.persister, Persister):
                await runs.persister.flush()

    app = FastAPI(title="DeVries", version=about.version(), lifespan=lifespan)
    app.state.sessions = sessions
    app.add_middleware(SessionMiddleware)
    app.add_exception_handler(DeVriesError, lambda request, exc: error_response(exc))
    app.add_exception_handler(rex.RedisError, graph_unavailable)

    async def file_error(request, exc: OSError) -> JSONResponse:
        """A file the app may not write (a bind mount owned by another user, a read-only disk) is a 409 that names it,
        never a stack trace. A socket failure is the database's, and answers as one."""
        if isinstance(exc, (ConnectionError, TimeoutError)):
            return await graph_unavailable(request, rex.ConnectionError(str(exc)))
        log.error("file error on %s: %s", request.url.path, exc)
        where = f" ({exc.filename})" if getattr(exc, "filename", None) else ""
        return JSONResponse({"error": {"code": "not_writable", "message": f"the app cannot write here: {exc.strerror or type(exc).__name__}{where}. "
                                                                           "On Linux, give the container your user (see docker-compose.yml)",
                                       "retryable": False}}, status_code=409)

    app.add_exception_handler(OSError, file_error)

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
            check = await canary_ensure(client, settings.canary_ttl_s)    # a passing check is trusted for a while: the
            body["canary"] = {"ok": check.ok, "detail": check.detail, "ms": check.ms}   # health probe asks every 10 s
        body["model"] = {"configured": llm is not None, "name": llm.name if llm else None,
                         "budget_spent": spend.exhausted(), "spent_today_usd": round(spend.today_usd, 4)}
        body["sessions"] = {"holding_copies": len(sessions.holders()), "max": settings.session_max}
        body["runs"] = {"active": runs.active_count()}
        body["version"] = about.version()
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
