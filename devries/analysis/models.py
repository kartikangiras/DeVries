"""Data contracts for scans, findings and chokepoints."""

from hashlib import sha1
from typing import Literal

from pydantic import BaseModel, Field


class PathEvidence(BaseModel):
    node_ids: list[str]                                   # source first, sink last
    rules: list[int]                                      # rules[i] explains the hop node_ids[i] -> node_ids[i+1]
    leg: Literal["path", "untrusted", "private", "exit"] = "path"   # which leg of a trifecta this is


class Finding(BaseModel):
    id: str
    fingerprint: str
    kind: Literal["injection", "trifecta", "drift", "poisoned_description"]
    severity: Literal["critical", "high", "medium"]       # injection = critical, trifecta = high, drift = medium
    status: Literal["open", "mitigated", "accepted", "closed"] = "open"
    source_id: str | None = None                          # injection: the untrusted source
    target_id: str | None = None                          # injection: the high-impact resource
    agent_id: str | None = None                           # trifecta: the agent
    untrusted_ids: list[str] = Field(default_factory=list)   # trifecta: every untrusted source that reaches the agent
    private_ids: list[str] = Field(default_factory=list)     # trifecta: every private source that reaches it
    exit_ids: list[str] = Field(default_factory=list)        # trifecta: every external resource it can reach
    evidence: list[PathEvidence] = Field(default_factory=list)
    evidence_lifted: bool = False                         # no path within 12 hops; the limit was raised to find one
    routes: int | None = None                             # injection: how many routes exist, counted past what is kept
    routes_capped: bool = False                           # the count stopped at its cap: "50 or more"
    server_id: str | None = None                          # drift: the server whose manifest changed
    drift: dict | None = None                             # drift: {added, removed, changed: {tool: [parts]}}
    tool_id: str | None = None                            # poisoned_description: the tool whose description reads as an instruction
    flags: list[dict] = Field(default_factory=list)       # poisoned_description: [{kind, detail, span}]
    accepted_by: str | None = None                        # who accepted it, when a person did

    @property
    def path_ids(self) -> list[str]:
        """One path a person can follow: the first evidence path, or for a trifecta
        the untrusted leg into the agent joined to the exit leg out of it."""
        if self.kind == "poisoned_description":
            return [self.tool_id] if self.tool_id else []
        if not self.evidence:
            return []
        if self.kind == "injection":
            return self.evidence[0].node_ids
        legs = {e.leg: e for e in self.evidence}
        into, out = legs.get("untrusted"), legs.get("exit")
        return (into.node_ids if into else []) + (out.node_ids[1:] if out else [])


class ScanResult(BaseModel):
    graph: str
    scan_id: str
    started_at: int
    duration_ms: int
    findings: list[Finding]
    opened_fingerprints: list[str] = Field(default_factory=list)      # first seen in this scan
    closed_fingerprints: list[str] = Field(default_factory=list)      # held before, no longer holds
    mitigated_fingerprints: list[str] = Field(default_factory=list)   # the closed ones an applied mitigation fixed
    reopened_fingerprints: list[str] = Field(default_factory=list)
    partial: bool = False                                 # an evidence query timed out; verdicts are unaffected


class Zone(BaseModel):
    component_id: int
    members: list[str]
    has_untrusted: bool
    has_high_impact: bool
    is_blast_zone: bool                                   # holds an untrusted source and a high-impact resource


class EdgeRef(BaseModel):
    rel: Literal["CAN_CALL", "DELEGATES_TO", "READS", "WRITES", "FEEDS"]
    from_id: str
    to_id: str
    rule: int                                             # the flow rule this config edge sits behind on the path


class EdgeScore(BaseModel):
    edge: EdgeRef
    score: float                                          # paths: evidence paths crossing the edge; mincut: its capacity
    fixes: list[str]                                      # fix kinds that act on this edge


class NodeScore(BaseModel):
    id: str
    name: str | None = None
    label: str
    score: float


class ChokepointReport(BaseModel):
    method: Literal["paths", "betweenness", "mincut"]
    edges: list[EdgeScore] = Field(default_factory=list)  # paths, mincut
    nodes: list[NodeScore] = Field(default_factory=list)  # betweenness
    split_candidates: list[tuple[str, int]] = Field(default_factory=list)   # (agent, paths on which it reads and then acts)
    split_tools: dict[str, list[str]] = Field(default_factory=dict)         # agent -> the reading tools on those paths
    cut_cost: int | None = None                           # mincut only


def injection_fingerprint(source_id: str, target_id: str) -> str:
    return sha1(f"injection|{source_id}|{target_id}".encode()).hexdigest()


def trifecta_fingerprint(agent_id: str) -> str:
    return sha1(f"trifecta|{agent_id}".encode()).hexdigest()


STANDING_KINDS = ("drift", "poisoned_description")      # not recomputed by a scan: they stand until a person accepts them


def poison_fingerprint(tool_id: str, description_hash: str) -> str:
    """One finding per description a tool was seen with."""
    return sha1(f"poison|{tool_id}|{description_hash}".encode()).hexdigest()


def drift_fingerprint(server_id: str, manifest_hash: str) -> str:
    """One finding per manifest a server was seen with: accepting one does not accept the next."""
    return sha1(f"drift|{server_id}|{manifest_hash}".encode()).hexdigest()


def finding_id(fingerprint: str) -> str:
    return f"fnd:{fingerprint[:10]}"
