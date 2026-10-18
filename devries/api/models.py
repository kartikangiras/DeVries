"""The API's request bodies, its error codes and the two error answers every route shares."""

import logging
import re
from typing import Any

import redis.exceptions as rex
from fastapi import Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from devries.errors import DeVriesError
from devries.mitigation.dsl import Change

log = logging.getLogger("devries.api")

STATUS = {
    "unknown_scenario": 404, "not_found": 404, "invalid_fix": 422, "invalid_scenario": 422, "fix_failed": 409,
    "needs_approval": 409, "stale": 409, "run_active": 409, "forbidden_write": 403, "not_writable": 409, "timeout": 504,
    "session_limit": 503, "canary_failed": 503, "sandbox_error": 503, "rate_limited": 429, "graph_unavailable": 503,
}
APPROVER_RE = re.compile(r"[^A-Za-z0-9 ._@-]")


class RunActive(DeVriesError):
    code = "run_active"


class Decision(BaseModel):
    approver: str = Field(default="a visitor", max_length=200)
    reason: str | None = Field(default=None, max_length=300)

    def who(self) -> str:
        return APPROVER_RE.sub("", self.approver).strip()[:60] or "a visitor"


class LabelsBody(BaseModel):
    data_sources: dict[str, str] = Field(default_factory=dict)         # src:x -> trust
    resources: dict[str, dict[str, Any]] = Field(default_factory=dict)  # res:x -> {impact, external}
    audit: bool = True                                                  # start an audit on the result, by itself


class SearchBody(BaseModel):
    finding_ids: list[str] | None = Field(default=None, max_length=3)


class WhatIfBody(BaseModel):
    changes: list[Change] = Field(min_length=1, max_length=3)


class RunBody(BaseModel):
    scenario: str


class AskBody(BaseModel):
    scenario: str
    question: str = Field(min_length=3, max_length=2000)


class ImportBody(BaseModel):
    """A pasted config (`mcpServers`) or tools/list (`tools`); on this machine, also a source as the command line takes it."""
    config: dict | None = None
    source: str | None = Field(default=None, max_length=1000)
    name: str | None = Field(default=None, max_length=48)
    client: str | None = Field(default=None, max_length=40)
    labels: dict[str, str] = Field(default_factory=dict)
    audit: bool = True


class DraftBody(BaseModel):
    after: str = Field(max_length=200_000)


class WriteBody(Decision):
    after: str | None = Field(default=None, max_length=200_000)


def error_response(e: DeVriesError) -> JSONResponse:
    return JSONResponse(e.to_dict(), status_code=STATUS.get(e.code, 400))





async def graph_unavailable(request: Request, exc: rex.RedisError) -> JSONResponse:
    log.error("FalkorDB error on %s: %s", request.url.path, type(exc).__name__)
    return JSONResponse({"error": {"code": "graph_unavailable", "message": f"FalkorDB: {type(exc).__name__}",
                                   "retryable": True}}, status_code=503)
