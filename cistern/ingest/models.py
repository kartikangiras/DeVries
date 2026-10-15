"""The scenario file: the graph facts we author, plus the findings we expect from them."""

import re
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

from cistern.graph.keys import SCENARIO_RE

_ID_BODY = r"[a-z0-9][A-Za-z0-9_.-]{0,95}"


def _id(prefix: str):
    return Annotated[str, StringConstraints(pattern=rf"^{prefix}:{_ID_BODY}$")]


ServerId, ToolId, SourceId, ResourceId, AgentId, WorkflowId = (
    _id("srv"), _id("tool"), _id("src"), _id("res"), _id("agent"), _id("wf"))

Trust = Literal["untrusted", "internal", "private", "unknown"]     # unknown: imported and not yet labelled; it yields no finding
Impact = Literal["high", "medium", "low", "unknown"]
Capability = Literal["read", "write", "exfil", "exec", "unknown"]


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ServerSpec(_Strict):
    id: ServerId
    manifest: str
    name: str | None = None
    synthetic: bool = False
    source_url: str | None = None


class ToolFacts(_Strict):
    """Facts a manifest cannot express: what a tool reads and what it acts on."""
    id: ToolId
    reads: list[SourceId] = Field(default_factory=list)
    writes: list[ResourceId] = Field(default_factory=list)
    capability: Capability | None = None      # a manual label beats every other source


class DataSourceSpec(_Strict):
    id: SourceId
    name: str
    trust: Trust


class ResourceSpec(_Strict):
    id: ResourceId
    name: str
    impact: Impact
    external: bool
    feeds: list[SourceId] = Field(default_factory=list)     # what is written here is read back from these (rule 7)


class Grant(_Strict):
    id: ToolId
    gate: Literal["human_approval"] | None = None

    @model_validator(mode="before")
    @classmethod
    def _from_string(cls, value):
        return {"id": value} if isinstance(value, str) else value


class Delegation(_Strict):
    id: AgentId
    gate: Literal["quarantine"] | None = None

    @model_validator(mode="before")
    @classmethod
    def _from_string(cls, value):
        return {"id": value} if isinstance(value, str) else value


class AgentSpec(_Strict):
    id: AgentId
    name: str
    owner: str | None = None
    can_call: list[Grant] = Field(default_factory=list)
    delegates_to: list[Delegation] = Field(default_factory=list)


class WorkflowSpec(_Strict):
    id: WorkflowId
    name: str | None = None
    description: str | None = None
    run_by: AgentId
    mode: Literal["supervised", "autonomous"] = "supervised"
    needs: list[ToolId] = Field(default_factory=list)       # tools it must still be able to call
    reads: list[SourceId] = Field(default_factory=list)     # data it must still be able to read


class RejectedPlan(_Strict):
    kind: str
    reason_contains: str


class Expect(_Strict):
    """The golden oracle: what a scan of this file must find, and how its fix search must end."""
    injection: list[tuple[SourceId, ResourceId]] = Field(default_factory=list)
    trifecta: list[AgentId] = Field(default_factory=list)
    best_fix_kind: str | None = None
    rejected: list[RejectedPlan] = Field(default_factory=list)


class ScenarioFile(_Strict):
    scenario: str
    title: str | None = Field(default=None, max_length=60)    # the name people see; the scenario name if absent
    order: int = Field(default=100, ge=0)                     # where it stands in the list; the first is what a visitor lands on
    imported: dict | None = None                              # set by the importer: {source, client, at}; such a file may be relabelled from the UI
    origin: dict | None = None                                # set by the importer: the real config this came from, where a fix can be written back
    description: str = ""
    servers: list[ServerSpec] = Field(default_factory=list)
    tools: list[ToolFacts] = Field(default_factory=list)
    data_sources: list[DataSourceSpec] = Field(default_factory=list)
    resources: list[ResourceSpec] = Field(default_factory=list)
    agents: list[AgentSpec] = Field(default_factory=list)
    workflows: list[WorkflowSpec] = Field(default_factory=list)
    expect: Expect = Field(default_factory=Expect)

    @model_validator(mode="after")
    def _check_references(self):
        if not SCENARIO_RE.fullmatch(self.scenario):
            raise ValueError(f"scenario name {self.scenario!r} must match {SCENARIO_RE.pattern}")

        def unique(kind: str, ids: list[str]) -> set[str]:
            dupes = sorted({i for i in ids if ids.count(i) > 1})
            if dupes:
                raise ValueError(f"{kind} declared more than once: {dupes}")
            return set(ids)

        unique("server", [s.id for s in self.servers])
        unique("tool facts", [t.id for t in self.tools])
        sources = unique("data source", [d.id for d in self.data_sources])
        resources = unique("resource", [r.id for r in self.resources])
        agents = unique("agent", [a.id for a in self.agents])
        unique("workflow", [w.id for w in self.workflows])

        def known(what: str, ids: list[str], declared: set[str]) -> None:
            missing = sorted(set(ids) - declared)
            if missing:
                raise ValueError(f"{what} refers to undeclared ids: {missing}")

        for tool in self.tools:
            known(f"{tool.id} reads", tool.reads, sources)
            known(f"{tool.id} writes", tool.writes, resources)
        for resource in self.resources:
            known(f"{resource.id} feeds", resource.feeds, sources)
        for agent in self.agents:
            known(f"{agent.id} delegates_to", [d.id for d in agent.delegates_to], agents)
            if agent.id in [d.id for d in agent.delegates_to]:
                raise ValueError(f"{agent.id} delegates to itself")
            unique(f"{agent.id} can_call", [g.id for g in agent.can_call])
            unique(f"{agent.id} delegates_to", [d.id for d in agent.delegates_to])
        for wf in self.workflows:
            known(f"{wf.id} run_by", [wf.run_by], agents)
            known(f"{wf.id} reads", wf.reads, sources)
        known("expect.injection sources", [s for s, _ in self.expect.injection], sources)
        known("expect.injection targets", [t for _, t in self.expect.injection], resources)
        known("expect.trifecta", self.expect.trifecta, agents)
        return self


def server_suffix(server_id: str) -> str:
    return server_id.split(":", 1)[1]


def tool_id(server_id: str, tool_name: str) -> str:
    """tool:<server suffix>.<MCP tool name>, so a manifest entry and its YAML facts join on id."""
    return f"tool:{server_suffix(server_id)}.{tool_name}"


TOOL_ID_RE = re.compile(rf"^tool:{_ID_BODY}$")
