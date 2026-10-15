"""Graph keys. The only place that turns a scenario reference into a FalkorDB key.

scn:<scenario>            a scenario graph
ses:<session>:<scenario>  one visitor's copy of a scenario graph
sbx:<epoch_ms>:<id>       a throwaway sandbox

A scenario graph or a session copy is a "working" graph; the write rules in
GraphClient work from the prefix alone.
"""

import re
import time
from secrets import token_hex
from typing import Literal

from devries.errors import UnknownScenario

SCENARIO_RE = re.compile(r"^[a-z][a-z0-9_]{0,47}$")
SESSION_RE = re.compile(r"^[A-Za-z0-9_-]{16,64}$")
SANDBOX_RE = re.compile(r"^sbx:(\d{13}):[0-9a-f]{6}$")

Kind = Literal["working", "sandbox"]


def scenario_key(scenario: str) -> str:
    if not SCENARIO_RE.fullmatch(scenario):
        raise UnknownScenario(f"not a scenario name: {scenario!r}")
    return f"scn:{scenario}"


def session_key(session: str, scenario: str) -> str:
    if not SESSION_RE.fullmatch(session):
        raise UnknownScenario("not a session id")
    return f"ses:{session}:{scenario_key(scenario)[4:]}"


def sandbox_key() -> str:
    return f"sbx:{int(time.time() * 1000)}:{token_hex(3)}"


def resolve(ref: str) -> str:
    """'acme_support' -> scn:acme_support; 'acme_support@<session>' -> ses:<session>:acme_support."""
    if not isinstance(ref, str):
        raise UnknownScenario("scenario must be a string")
    scenario, sep, session = ref.partition("@")
    return session_key(session, scenario) if sep else scenario_key(scenario)


def kind(key: str) -> Kind:
    if key.startswith("scn:") and SCENARIO_RE.fullmatch(key[4:]):
        return "working"
    if key.startswith("ses:"):
        _, session, scenario = (key.split(":", 2) + ["", ""])[:3]
        if SESSION_RE.fullmatch(session) and SCENARIO_RE.fullmatch(scenario):
            return "working"
    if SANDBOX_RE.fullmatch(key):
        return "sandbox"
    raise UnknownScenario(f"not a graph key: {key!r}")


def scenario_of(key: str) -> str:
    """The scenario name behind a working graph key."""
    if kind(key) != "working":
        raise UnknownScenario(f"not a working graph: {key!r}")
    return key.rsplit(":", 1)[1]


def sandbox_age_ms(key: str, now_ms: int | None = None) -> int:
    m = SANDBOX_RE.fullmatch(key)
    if not m:
        raise UnknownScenario(f"not a sandbox key: {key!r}")
    return (now_ms if now_ms is not None else int(time.time() * 1000)) - int(m.group(1))
