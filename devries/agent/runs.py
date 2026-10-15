"""The record of an auditor run: every step, who took it and why. Kept in memory and streamed as events."""

import time
from collections import OrderedDict
from secrets import token_hex
from typing import Any, Literal

from pydantic import BaseModel, Field

from devries.events import bus

Phase = Literal["scan", "investigate", "mitigate", "approval", "apply", "report", "ask"]


class StepRecord(BaseModel):
    n: int
    phase: Phase
    by: Literal["model", "loop", "scripted", "person"]    # who decided this step
    kind: Literal["tool", "text", "note"]
    tool: str | None = None
    arguments: dict[str, Any] | None = None               # without `because`; `scenario` is the plain name
    because: str | None = None
    headline: str | None = None                           # the result in one line
    result: dict[str, Any] | None = None                  # the result, trimmed
    error: str | None = None                              # an error code, if the step failed
    cited_ids: list[str] = Field(default_factory=list)
    queries: list[str] = Field(default_factory=list)      # catalog queries the tool ran
    ms: int | None = None
    text: str | None = None
    at: int = 0


class RunUsage(BaseModel):
    model_steps: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cost_usd: float = 0.0
    simulations: int = 0


class Run(BaseModel):
    id: str
    kind: Literal["audit", "ask"]
    scenario: str
    graph: str = Field(exclude=True)                      # the working graph; never leaves the process
    ref: str = Field(exclude=True)                        # what the MCP tools are given: `name` or `name@session`
    status: Literal["running", "awaiting_approval", "done", "failed"] = "running"
    phase: Phase = "scan"
    mode: Literal["agent", "scripted"] = "agent"
    scripted_reason: str | None = None                    # why no model drove this run, or stopped driving it
    model: str | None = None
    question: str | None = None
    answer: str | None = None                             # the report of an audit run, or the answer of an ask run
    answer_by: Literal["model", "template"] | None = None
    mitigation_id: str | None = None                      # the proposal waiting for, or last given, a decision
    outcome: str | None = None                            # clean | applied | rejected | no_plan | undecided | answered
    error: str | None = None
    steps: list[StepRecord] = Field(default_factory=list)
    usage: RunUsage = Field(default_factory=RunUsage)
    started_at: int = 0
    finished_at: int | None = None

    def summary(self) -> dict[str, Any]:
        return self.model_dump(exclude={"steps"}) | {"steps": len(self.steps)}

    # ------------------------------------------------------------------ recording

    def step(self, **fields: Any) -> StepRecord:
        record = StepRecord(n=len(self.steps) + 1, at=int(time.time() * 1000), **fields)
        self.steps.append(record)
        bus.publish(self.graph, "agent.step", {"run_id": self.id, **record.model_dump()})
        return record

    def changed(self) -> None:
        """Tell the stream that status, phase or mode moved."""
        bus.publish(self.graph, "agent.run", self.summary())

    def enter(self, phase: Phase) -> None:
        self.phase = phase
        self.changed()

    def finish(self, outcome: str | None, error: str | None = None) -> None:
        self.status = "failed" if error else "done"
        self.outcome, self.error = outcome, error
        self.finished_at = int(time.time() * 1000)
        self.changed()


class RunRegistry:
    """Runs of this process, newest last. Old finished runs are dropped."""

    def __init__(self, keep: int = 200):
        self._runs: OrderedDict[str, Run] = OrderedDict()
        self._keep = keep

    def create(self, kind: str, scenario: str, graph: str, ref: str, **fields: Any) -> Run:
        run = Run(id=f"run:{token_hex(4)}", kind=kind, scenario=scenario, graph=graph, ref=ref,
                  started_at=int(time.time() * 1000), **fields)
        self._runs[run.id] = run
        while len(self._runs) > self._keep:
            oldest = next((r for r in self._runs.values() if r.status in ("done", "failed")), None)
            if oldest is None:
                break
            del self._runs[oldest.id]
        return run

    def get(self, run_id: str) -> Run | None:
        return self._runs.get(run_id)

    def for_graph(self, graph: str) -> list[Run]:
        return [r for r in self._runs.values() if r.graph == graph]

    def for_graphs(self, *graphs: str) -> list[Run]:
        """The runs on any of these graphs, oldest first: a visitor's copy and the shared scenario it was copied from."""
        return [r for r in self._runs.values() if r.graph in graphs]

    def active(self, graph: str) -> Run | None:
        return next((r for r in reversed(self._runs.values())
                     if r.graph == graph and r.status in ("running", "awaiting_approval")), None)

    def forget(self, graph: str) -> None:
        for run_id in [r.id for r in self._runs.values() if r.graph == graph and r.status in ("done", "failed")]:
            del self._runs[run_id]


runs = RunRegistry()
