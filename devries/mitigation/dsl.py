"""The change language. One definition serves the MCP tool schemas, the API and the stored plans.

Fixes restrict the config; what-if changes extend it and never leave a sandbox.
"""

import json
from hashlib import sha1
from typing import Annotated, Literal

from pydantic import BaseModel, Field


class GateCall(BaseModel):
    """A person must approve each call of this tool by this agent."""
    kind: Literal["gate_call"]
    agent_id: str
    tool_id: str


class RevokeCall(BaseModel):
    """The agent loses this tool."""
    kind: Literal["revoke_call"]
    agent_id: str
    tool_id: str


class QuarantineDelegation(BaseModel):
    """The delegate returns only structured fields to its delegator (the dual-LLM pattern)."""
    kind: Literal["quarantine_delegation"]
    from_agent_id: str
    to_agent_id: str


class DropRead(BaseModel):
    """The tool stops reading this data source."""
    kind: Literal["drop_read"]
    tool_id: str
    source_id: str


class SplitAgent(BaseModel):
    """The agent keeps its acting tools and hands these reading tools to a new reader agent, whose
    results come back quarantined. Only tools whose capability is `read` may move."""
    kind: Literal["split_agent"]
    agent_id: str
    reader_tool_ids: list[str] = Field(min_length=1, max_length=8)


Fix = Annotated[GateCall | RevokeCall | QuarantineDelegation | DropRead | SplitAgent, Field(discriminator="kind")]

# Revoke is cheapest: removing a grant nothing needs is least privilege and should be
# tried first. The workflow check is what stops it when something does need the grant.
# Dropping a read changes what a tool is; splitting an agent adds one. Both cost more than a gate.
COST = {"revoke_call": 1, "gate_call": 2, "quarantine_delegation": 2, "drop_read": 3, "split_agent": 4}


def reader_id(agent_id: str) -> str:
    """The id of the reader a split creates. A dot, not a colon: an id has one colon, after its kind."""
    return f"{agent_id}.reader"


class FixPlan(BaseModel):
    fixes: list[Fix] = Field(min_length=1, max_length=3)

    @property
    def cost(self) -> int:
        """+1 per extra fix, so a single fix beats a pair of equal parts."""
        return sum(COST[f.kind] for f in self.fixes) + (len(self.fixes) - 1)

    def canonical(self) -> str:
        """The same plan always serialises the same way, whatever order its fixes came in."""
        return json.dumps(sorted((f.model_dump() for f in self.fixes), key=lambda f: json.dumps(f, sort_keys=True)),
                          sort_keys=True, separators=(",", ":"))


class GrantCall(BaseModel):
    """What-if only: give an agent a tool it does not have."""
    kind: Literal["grant_call"]
    agent_id: str
    tool_id: str


class DropServer(BaseModel):
    """What if this server were removed: every grant to its tools goes. A question for a sandbox, never a fix."""
    kind: Literal["drop_server"]
    server_id: str


class AddDelegation(BaseModel):
    """What-if only: let one agent delegate to another."""
    kind: Literal["add_delegation"]
    from_agent_id: str
    to_agent_id: str


Change = Annotated[GateCall | RevokeCall | QuarantineDelegation | DropRead | SplitAgent | GrantCall | AddDelegation | DropServer,
                   Field(discriminator="kind")]


class Broken(BaseModel):
    """Something a workflow needs that the config no longer gives it."""
    model_config = {"frozen": True}

    workflow_id: str
    kind: Literal["tool", "data"]
    missing_id: str
    mode: Literal["supervised", "autonomous"] = "supervised"
    gated: bool = False                     # a grant is still there, but every one needs a person's approval

    @property
    def key(self) -> tuple[str, str, str]:
        return (self.workflow_id, self.kind, self.missing_id)

    def sentence(self) -> str:
        if self.kind == "data":
            return f"breaks {self.workflow_id}: nothing on its path can read {self.missing_id} any more"
        if self.gated:
            return (f"breaks {self.workflow_id} ({self.mode}): every way it can call {self.missing_id} "
                    f"needs a person's approval, and it runs unattended")
        return f"breaks {self.workflow_id}: nothing on its path can call {self.missing_id} any more"


class FindingRef(BaseModel):
    """Enough of a finding to name it without fetching its evidence."""
    id: str
    fingerprint: str
    kind: Literal["injection", "trifecta"]
    source_id: str | None = None
    target_id: str | None = None
    agent_id: str | None = None
    path_ids: list[str] = Field(default_factory=list)   # set for introduced findings: one path through the sandbox


class Diff(BaseModel):
    """What a set of changes does to findings and workflows, measured in one sandbox."""
    open_before: list[str]                  # finding fingerprints
    open_after: list[str]
    resolved: list[str]                     # before minus after
    introduced: list[str]                   # after minus before
    newly_broken: list[Broken]              # broken after and not before
    findings: dict[str, FindingRef]         # every fingerprint named above
    sandbox_ms: int


class Verdict(BaseModel):
    plan: FixPlan
    targets: list[str]                      # fingerprints the plan must resolve
    passed: bool
    remaining: list[str]                    # targets still open after the plan
    diff: Diff
    reason: str | None = None               # why it failed, in words


def mitigation_id(plan: FixPlan, targets: list[str]) -> str:
    """The same plan for the same targets is the same mitigation."""
    digest = sha1((plan.canonical() + "|" + ",".join(sorted(targets))).encode()).hexdigest()
    return f"mit:{digest[:10]}"


def describe(change) -> str:
    """One change as a sentence built only from our own ids."""
    return {
        "gate_call": lambda c: f"require human approval before {c.agent_id} calls {c.tool_id}",
        "revoke_call": lambda c: f"revoke {c.tool_id} from {c.agent_id}",
        "quarantine_delegation": lambda c: f"quarantine what {c.to_agent_id} returns to {c.from_agent_id}",
        "drop_read": lambda c: f"stop {c.tool_id} reading {c.source_id}",
        "split_agent": lambda c: (f"split {c.agent_id}: a quarantined reader takes over "
                                  + ", ".join(sorted(c.reader_tool_ids))),
        "grant_call": lambda c: f"grant {c.tool_id} to {c.agent_id}",
        "add_delegation": lambda c: f"let {c.from_agent_id} delegate to {c.to_agent_id}",
        "drop_server": lambda c: f"no agent holds a grant to any tool of {c.server_id}",
        "drop_server": lambda c: f"remove {c.server_id} and every grant to its tools",
    }[change.kind](change)


def nothing_to_change(change) -> str:
    """Why a change query matched nothing."""
    return {
        "gate_call": lambda c: f"{c.agent_id} has no ungated grant for {c.tool_id}: there is no grant, or it is already gated",
        "revoke_call": lambda c: f"{c.agent_id} has no grant for {c.tool_id}",
        "quarantine_delegation": lambda c: (f"{c.from_agent_id} has no unquarantined delegation to {c.to_agent_id}: "
                                            f"there is no delegation, or it is already quarantined"),
        "drop_read": lambda c: f"{c.tool_id} does not read {c.source_id}",
        "split_agent": lambda c: (f"{c.agent_id} cannot be split that way: it has no grant for one of "
                                  f"{', '.join(sorted(c.reader_tool_ids))}, or it already has a reader"),
        "grant_call": lambda c: f"{c.agent_id} can already call {c.tool_id}",
        "add_delegation": lambda c: f"{c.from_agent_id} already delegates to {c.to_agent_id}",
    }[change.kind](change)


def config_patch(change) -> dict:
    """One fix as the change it makes to the configuration: which edge, and what happens to it."""
    if change.kind == "gate_call":
        return {"op": "set_gate", "edge": "CAN_CALL", "from_id": change.agent_id, "to_id": change.tool_id, "gate": "human_approval"}
    if change.kind == "revoke_call":
        return {"op": "delete", "edge": "CAN_CALL", "from_id": change.agent_id, "to_id": change.tool_id}
    if change.kind == "quarantine_delegation":
        return {"op": "set_gate", "edge": "DELEGATES_TO", "from_id": change.from_agent_id, "to_id": change.to_agent_id, "gate": "quarantine"}
    if change.kind == "drop_read":
        return {"op": "delete", "edge": "READS", "from_id": change.tool_id, "to_id": change.source_id}
    if change.kind == "split_agent":
        return {"op": "split", "agent_id": change.agent_id, "reader_id": reader_id(change.agent_id),
                "moved_tool_ids": sorted(change.reader_tool_ids), "gate": "quarantine"}
    raise ValueError(f"{change.kind} is a what-if change, not a fix")
