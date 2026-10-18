"""Visitor sessions. Each visitor works in private copies of the scenario graphs.

A session is a random 128-bit id in an HTTP-only cookie. Reads are served from
`scn:<scenario>` until the visitor does something that writes; at that moment
the scenario graph is copied to `ses:<session>:<scenario>` with GRAPH.COPY and
the session uses its copy from then on. Nothing a visitor does can write to a
scenario graph: FalkorDB's one-graph-per-tenant model is the isolation.
"""

import asyncio
import time
from dataclasses import dataclass, field
from secrets import token_urlsafe
from typing import Callable

from starlette.datastructures import MutableHeaders
from starlette.requests import Request
from starlette.responses import JSONResponse

from devries.config import get_settings
from devries.errors import DeVriesError, UnknownScenario
from devries.graph import keys
from devries.graph.client import GraphClient

COOKIE = "devries_session"
IDLE_BEFORE_EVICTION_S = 300          # a session this quiet may lose its copies when the limit is reached


class SessionLimit(DeVriesError):
    code = "session_limit"
    retryable = True


class RateLimited(DeVriesError):
    code = "rate_limited"
    retryable = True


SANDBOX_READS_PER_MIN = 30            # what-if tests and plan previews one session may ask for in a minute


@dataclass
class Session:
    id: str
    last_seen: float = field(default_factory=time.monotonic)
    copies: set[str] = field(default_factory=set)       # scenario names this session holds a copy of
    runs_used: int = 0                                  # audit runs driven by a model
    questions_used: int = 0
    sandbox_reads: list[float] = field(default_factory=list)   # when it last asked for a what-if or a preview


class Sessions:
    def __init__(self) -> None:
        self._sessions: dict[str, Session] = {}
        self._lock = asyncio.Lock()

    def touch(self, session_id: str) -> Session:
        session = self._sessions.get(session_id)
        if session is None:
            session = self._sessions[session_id] = Session(id=session_id)
        session.last_seen = time.monotonic()
        return session

    def holders(self) -> list[Session]:
        return [s for s in self._sessions.values() if s.copies]

    def count_sandbox_read(self, session_id: str) -> None:
        """A what-if or a preview costs a sandbox and needs no copy of one's own, so it is rationed by the minute."""
        session = self.touch(session_id)
        now = time.monotonic()
        session.sandbox_reads = [t for t in session.sandbox_reads if now - t < 60]
        if len(session.sandbox_reads) >= SANDBOX_READS_PER_MIN:
            raise RateLimited("That is a lot of sandbox tests in one minute. Wait a little and try again.")
        session.sandbox_reads.append(now)

    # ------------------------------------------------------------------ graphs

    def key_for_read(self, session_id: str, scenario: str) -> str:
        """The session's copy if it has one, the shared scenario graph otherwise."""
        if scenario in self.touch(session_id).copies:
            return keys.session_key(session_id, scenario)
        return keys.scenario_key(scenario)

    def ref(self, session_id: str, scenario: str) -> str:
        """The scenario reference an MCP tool takes for this session's view of a scenario."""
        key = self.key_for_read(session_id, scenario)
        return f"{scenario}@{session_id}" if key.startswith("ses:") else scenario

    async def key_for_write(self, client: GraphClient, session_id: str, scenario: str,
                            busy: Callable[[str], bool] = lambda key: False) -> str:
        """The session's own copy, made now if this is its first write to the scenario."""
        session = self.touch(session_id)
        dest = keys.session_key(session_id, scenario)
        async with self._lock:                            # one decision at a time about who holds copies
            if scenario in session.copies:
                return dest
            source = keys.scenario_key(scenario)
            if not await client.exists(source):
                raise UnknownScenario(f"no scenario {scenario!r}")
            if not session.copies and len(self.holders()) >= get_settings().session_max:
                await self._evict_one(client, busy)
            await client.delete(dest)                     # a leftover from a process that died mid-copy
            await client.copy(source, dest)
            session.copies.add(scenario)
            return dest

    async def _evict_one(self, client: GraphClient, busy: Callable[[str], bool]) -> None:
        now = time.monotonic()
        idle = sorted((s for s in self.holders()
                       if now - s.last_seen > IDLE_BEFORE_EVICTION_S and not self._busy(s, busy)),
                      key=lambda s: s.last_seen)
        if not idle:
            raise SessionLimit("Every sandbox copy is in use right now. You can still look at the shared scenario; "
                               "try again in a few minutes to run an audit of your own.")
        await self._drop(client, idle[0])

    @staticmethod
    def _busy(session: Session, busy: Callable[[str], bool]) -> bool:
        return any(busy(keys.session_key(session.id, scenario)) for scenario in session.copies)

    async def _drop(self, client: GraphClient, session: Session) -> list[str]:
        dropped = []
        for scenario in sorted(session.copies):
            key = keys.session_key(session.id, scenario)
            await client.delete(key)
            dropped.append(key)
        session.copies.clear()
        return dropped

    async def drop_scenario(self, client: GraphClient, session_id: str, scenario: str) -> bool:
        """Delete this session's copy of one scenario, so that it reads the shared graph again."""
        session = self.touch(session_id)
        async with self._lock:
            if scenario not in session.copies:
                return False
            await client.delete(keys.session_key(session_id, scenario))
            session.copies.discard(scenario)
            return True

    async def drop_oldest(self, client: GraphClient, busy: Callable[[str], bool], count: int = 3) -> list[str]:
        """Drop the copies of the longest-idle sessions that no run is using: what the janitor does when the
        database is past its memory ceiling."""
        dropped: list[str] = []
        async with self._lock:
            idle = sorted((s for s in self.holders() if not self._busy(s, busy)), key=lambda s: s.last_seen)
            for session in idle[:count]:
                dropped += await self._drop(client, session)
        return dropped

    async def reset(self, client: GraphClient, session_id: str) -> list[str]:
        """Delete this session's copies; it sees the shared scenario graphs again."""
        async with self._lock:
            return await self._drop(client, self.touch(session_id))

    async def recover(self, client: GraphClient) -> int:
        """Adopt session graphs left by an earlier process, so a returning visitor keeps their copy
        and an abandoned one is swept after the usual idle time."""
        found = 0
        for key in await client.list_graphs():
            if not key.startswith("ses:"):
                continue
            try:
                keys.kind(key)
            except UnknownScenario:
                continue
            _, session_id, scenario = key.split(":", 2)
            self.touch(session_id).copies.add(scenario)
            found += 1
        return found

    async def sweep(self, client: GraphClient, busy: Callable[[str], bool] = lambda key: False) -> list[str]:
        """Delete the copies of sessions idle for longer than SESSION_TTL_MIN, and forget empty old sessions."""
        limit = get_settings().session_ttl_min * 60
        now = time.monotonic()
        dropped: list[str] = []
        async with self._lock:
            for session in list(self._sessions.values()):
                if now - session.last_seen <= limit or self._busy(session, busy):
                    continue
                dropped += await self._drop(client, session)
                del self._sessions[session.id]
        return dropped

    # ------------------------------------------------------------------ model budget

    def model_runs_left(self, session_id: str) -> int:
        return max(get_settings().session_runs - self.touch(session_id).runs_used, 0)

    def questions_left(self, session_id: str) -> int:
        return max(get_settings().session_questions - self.touch(session_id).questions_used, 0)


class RateLimiter:
    """Rationing per address on a public site: at most `limit()` hits per `per_s` seconds, in a sliding window.
    The limit is read when it is needed, so a setting changed while the app runs applies."""

    def __init__(self, limit: Callable[[], int], per_s: float, what: str):
        self.limit, self.per_s, self.what = limit, per_s, what
        self._hits: dict[str, list[float]] = {}

    def forgive(self, key: str) -> None:
        """Take back the latest hit: the request it counted was refused before it cost anything."""
        if self._hits.get(key):
            self._hits[key].pop()

    def hit(self, key: str) -> None:
        now = time.monotonic()
        recent = [t for t in self._hits.get(key, []) if now - t < self.per_s]
        if len(recent) >= self.limit():
            raise RateLimited(f"That is a lot of {self.what} from one address. Wait a while and try again.")
        recent.append(now)
        self._hits[key] = recent
        if len(self._hits) > 10_000:                      # forget addresses not seen in a window
            self._hits = {k: v for k, v in self._hits.items() if v and now - v[-1] < self.per_s}


def client_ip(request: Request) -> str:
    """The visitor's address. X-Forwarded-For is believed only when TRUST_PROXY is set, which the shipped overlay does:
    without a proxy in front, the header is whatever the caller typed."""
    forwarded = request.headers.get("x-forwarded-for", "") if get_settings().trust_proxy else ""
    if forwarded:
        return forwarded.split(",")[0].strip()[:64]
    return (request.client.host if request.client else "unknown")[:64]


LOCAL_HOSTS = {"localhost", "127.0.0.1", "[::1]"}

# what every response carries: the UI loads nothing from anywhere but this app, so the policy can say so
SECURITY_HEADERS = {
    "content-security-policy": ("default-src 'self'; script-src 'self' 'wasm-unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; "
                                "img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; "
                                "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'"),
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "same-origin",
}


def host_name(host: str) -> str:
    """The name in a Host header, without the port: `[::1]:8000` is `[::1]`, `example.org:443` is `example.org`."""
    if host.startswith("["):
        return host.split("]", 1)[0] + "]"
    return host.rsplit(":", 1)[0] if ":" in host else host


def host_allowed(host: str, allowed_hosts: str | None) -> bool:
    """Whether a Host names this machine or a host the settings allow. A page served from a name an attacker points
    at 127.0.0.1 (DNS rebinding) sends a matching Origin and Host pair, so the pair alone proves nothing."""
    names = {n.strip().lower() for n in (allowed_hosts or "").split(",") if n.strip()}
    return host_name(host).lower() in LOCAL_HOSTS | names


def cross_site(request: Request, trust_proxy: bool, allowed_hosts: str | None = None) -> str | None:
    """Why a state-changing request is refused, or None when it is the person's own: it came from a page on another
    origin, or it names a Host this app does not serve. A browser sends Origin with every POST; a request with none
    (curl, a test, an older client) is taken as the person's own."""
    host = (request.headers.get("x-forwarded-host") if trust_proxy else None) or request.headers.get("host", "")
    if not host_allowed(host, allowed_hosts):
        return f"this app does not serve {host_name(host)!r}: add it to ALLOWED_HOSTS if it is yours"
    origin = request.headers.get("origin")
    if not origin and request.headers.get("sec-fetch-site") != "cross-site":
        return None
    if origin in {f"http://{host}", f"https://{host}"}:
        return None
    # the page may be served from another of this app's own names, a UI host in front of the API: only a name
    # that was configured counts, never the local defaults, so a page on another local port is still another site
    configured = {h.strip() for h in (allowed_hosts or "").split(",") if h.strip()}
    origin_host = origin.split("://", 1)[1] if origin and "://" in origin else ""
    if origin_host and host_name(origin_host) in configured:
        return None
    return "a change is accepted only from this app's own page, not from another site"


class SessionMiddleware:
    """Gives every /api request a session id, refuses a change asked for from another site, and guards /mcp with a
    bearer token when one is configured."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        path = scope["path"]
        settings = get_settings()

        async def send(message, _send=send):
            if message["type"] == "http.response.start":
                headers = MutableHeaders(scope=message)
                for name, value in SECURITY_HEADERS.items():
                    if name not in headers:
                        headers.append(name, value)
            await _send(message)

        if path.startswith("/mcp") and settings.devries_mcp_token:
            given = Request(scope).headers.get("authorization", "")
            if given != f"Bearer {settings.devries_mcp_token}":
                response = JSONResponse({"error": {"code": "unauthorized", "message": "this MCP endpoint needs a bearer token",
                                                   "retryable": False}}, status_code=401,
                                        headers={"WWW-Authenticate": "Bearer"})
                return await response(scope, receive, send)

        if not path.startswith("/api"):
            return await self.app(scope, receive, send)

        if scope.get("method") in ("POST", "PUT", "PATCH", "DELETE"):
            refused = cross_site(Request(scope), settings.trust_proxy, settings.allowed_hosts)
            if refused:
                response = JSONResponse({"error": {"code": "cross_site", "message": refused, "retryable": False}}, status_code=403)
                return await response(scope, receive, send)

        session_id = Request(scope).cookies.get(COOKIE, "")
        is_new = not keys.SESSION_RE.fullmatch(session_id)
        if is_new:
            session_id = token_urlsafe(16)                # 128 random bits
        scope.setdefault("state", {})["session"] = session_id

        async def send_with_cookie(message):
            if is_new and message["type"] == "http.response.start":
                cookie = f"{COOKIE}={session_id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400"
                MutableHeaders(scope=message).append("set-cookie", cookie + ("; Secure" if settings.cookie_secure else ""))
            await send(message)

        await self.app(scope, receive, send_with_cookie)
