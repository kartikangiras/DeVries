"""The only way to run a query: by name, against a graph key, with parameters."""

import asyncio
import contextlib
import contextvars
import json
import logging
import time
from typing import Any, Iterator

import redis.exceptions as rex
from falkordb.asyncio import FalkorDB

from devries.config import Settings, get_settings
from devries.errors import ForbiddenWrite, QueryTimeout, UnknownQuery
from devries.graph import keys
from devries.graph.catalog import CATALOG

log = logging.getLogger("devries.graph")

# Names of the catalog queries run inside a `recording()` block, so a tool
# response can say how it was computed.
_recorder: contextvars.ContextVar[list[str] | None] = contextvars.ContextVar("devries_queries", default=None)

_RETRYABLE = (rex.ConnectionError, rex.TimeoutError, ConnectionError, OSError)

# Guarded queries (the fixes) may touch a working graph only when the caller
# holds this token. mitigation/apply.py is the one module that passes it.
_APPLY_TOKEN = object()


class GraphClient:
    def __init__(self, settings: Settings | None = None):
        s = settings or get_settings()
        self._db = FalkorDB(
            host=s.falkordb_host,
            port=s.falkordb_port,
            username=s.falkordb_username,
            password=s.falkordb_password,
            max_connections=32,
            # a database that stops answering (paused, gone) fails a request in seconds instead of hanging it:
            # longer than the longest query timeout the catalog allows, shorter than a person's patience
            socket_connect_timeout=3,
            socket_timeout=12,
        )
        # GRAPH.COPY: on FalkorDB 4.x only one fork runs at a time, and a second
        # copy issued meanwhile can fail. One at a time is right on every version.
        self._copy_lock = asyncio.Lock()

    # ------------------------------------------------------------------ queries

    async def run(self, name: str, graph_key: str, *, _token: object = None, **params: Any) -> list[dict[str, Any]]:
        query = CATALOG.get(name)
        if query is None:
            raise UnknownQuery(f"no catalog query named {name!r}")
        kind = keys.kind(graph_key)
        if query.mode == "rw" and kind not in query.targets:
            raise ForbiddenWrite(f"{name} may not write to a {kind} graph ({graph_key})")
        if query.guarded and kind == "working" and _token is not _APPLY_TOKEN:
            raise ForbiddenWrite(f"{name} changes config: on a working graph it runs only through apply_fix")

        graph = self._db.select_graph(graph_key)
        call = graph.ro_query if query.mode == "ro" else graph.query
        may_retry = query.mode == "ro" or query.idempotent
        started = time.monotonic()
        attempt = 0
        while True:
            attempt += 1
            try:
                result = await call(query.cypher, params or None, timeout=query.timeout_ms)
                break
            except rex.ResponseError as e:
                if "timed out" in str(e).lower():
                    raise QueryTimeout(f"{name} exceeded {query.timeout_ms} ms", query=name) from e
                raise
            except _RETRYABLE:
                if not may_retry or attempt > 1:
                    raise
                await asyncio.sleep(0.05)

        names = [column[1] for column in result.header]
        rows = [dict(zip(names, row)) for row in result.result_set]

        recorded = _recorder.get()
        if recorded is not None and name not in recorded:
            recorded.append(name)
        log.info(json.dumps({
            "event": "query", "name": name, "graph": graph_key.split(":", 1)[0],
            "ms": round((time.monotonic() - started) * 1000, 2), "rows": len(rows),
        }))
        return rows

    @contextlib.contextmanager
    def recording(self) -> Iterator[list[str]]:
        """Collect the names of the catalog queries run inside the block."""
        names: list[str] = []
        token = _recorder.set(names)
        try:
            yield names
        finally:
            _recorder.reset(token)

    # ------------------------------------------------------------------ graphs

    def graph(self, graph_key: str):
        """The underlying client graph, for the non-Cypher commands (constraints)."""
        keys.kind(graph_key)
        return self._db.select_graph(graph_key)

    async def copy(self, source_key: str, dest_key: str) -> None:
        """GRAPH.COPY, one at a time, with one retry if the server could not fork."""
        keys.kind(source_key), keys.kind(dest_key)
        async with self._copy_lock:
            for attempt in (1, 2):
                try:
                    await self._db.select_graph(source_key).copy(dest_key)
                    return
                except rex.ResponseError as e:
                    if "could not fork" in str(e).lower() and attempt == 1:
                        await asyncio.sleep(0.2)
                        continue
                    raise

    async def delete(self, graph_key: str, missing_ok: bool = True) -> None:
        keys.kind(graph_key)
        try:
            await self._db.select_graph(graph_key).delete()
        except rex.ResponseError:
            if not missing_ok or await self.exists(graph_key):
                raise

    async def list_graphs(self) -> list[str]:
        return list(await self._db.list_graphs())

    async def exists(self, graph_key: str) -> bool:
        return graph_key in await self.list_graphs()

    @property
    def connection(self):
        """The Redis connection under the graph client, for the few non-graph commands (the apply lock, INFO)."""
        return self._db.connection

    async def version(self) -> str | None:
        """The FalkorDB module's version as the server reports it, such as "6.0.2"."""
        try:
            for module in await self._db.connection.execute_command("MODULE", "LIST"):
                # a module is a map or a flat list of name, value pairs, with text as str or bytes
                pairs = module if isinstance(module, dict) else dict(zip(module[::2], module[1::2]))
                fields = {(k.decode() if isinstance(k, bytes) else k): v for k, v in pairs.items()}
                name = fields.get("name")
                if (name.decode() if isinstance(name, bytes) else name) == "graph":
                    ver = int(fields["ver"])
                    return f"{ver // 10000}.{ver // 100 % 100}.{ver % 100}"
        except (rex.RedisError, OSError, KeyError, ValueError, TypeError) as e:
            log.debug("MODULE LIST did not say the version: %s", type(e).__name__)
            return None
        return None

    async def memory_mb(self) -> float | None:
        """What the server holds, in MB, from INFO memory; None if it cannot say."""
        try:
            info = await self._db.connection.info("memory")
            used = info.get("used_memory") if isinstance(info, dict) else None
            return round(int(used) / 1_048_576, 1) if used is not None else None
        except (rex.RedisError, OSError, ValueError, TypeError) as e:
            log.debug("INFO memory did not answer: %s", type(e).__name__)
            return None

    async def ping(self) -> bool:
        try:
            await self.list_graphs()
            return True
        except (rex.RedisError, OSError) as e:
            log.debug("FalkorDB did not answer a ping: %s", type(e).__name__)
            return False

    async def close(self) -> None:
        await self._db.aclose()


_clients: dict[int, GraphClient] = {}


def get_client() -> GraphClient:
    """One client per event loop: the connection pool belongs to the loop that made it."""
    loop_id = id(asyncio.get_running_loop())
    client = _clients.get(loop_id)
    if client is None:
        client = _clients[loop_id] = GraphClient()
    return client
