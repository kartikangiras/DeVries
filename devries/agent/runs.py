"""The record of an auditor run: every step, who took it and why.

Kept in memory for the process that drives it, streamed as events, and written to the working
graph it belongs to as it moves, so that a restart loses nothing a person saw: the runs come back
from the graph, the way findings and plans do.
"""

import asyncio
import json
import logging
import time
from collections import OrderedDict
from secrets import token_hex
from typing import Any, Callable, Literal

from pydantic import BaseModel, Field, PrivateAttr

from devries.events import bus
from devries.graph import keys

log = logging.getLogger("devries.runs")

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
    session: str | None = None                            # a hash of the session that asked, for a question; audits are everyone's
    answer: str | None = None                             # the report of an audit run, or the answer of an ask run
    answer_by: Literal["model", "template"] | None = None
    mitigation_id: str | None = None                      # the proposal waiting for, or last given, a decision
    outcome: str | None = None                            # clean | applied | rejected | no_plan | undecided | answered
    error: str | None = None
    steps: list[StepRecord] = Field(default_factory=list)
    usage: RunUsage = Field(default_factory=RunUsage)
    started_at: int = 0
    finished_at: int | None = None
    _persist: Any = PrivateAttr(default=None)             # how this run is written to its graph, set by the registry

    def summary(self) -> dict[str, Any]:
        return self.model_dump(exclude={"steps"}) | {"steps": len(self.steps)}

    def saved(self) -> None:
        """Write the record to the graph, if a writer is attached."""
        if self._persist is not None:
            self._persist(self)

    # ------------------------------------------------------------------ recording

    def step(self, **fields: Any) -> StepRecord:
        record = StepRecord(n=len(self.steps) + 1, at=int(time.time() * 1000), **fields)
        self.steps.append(record)
        bus.publish(self.graph, "agent.step", {"run_id": self.id, **record.model_dump()})
        self.saved()
        return record

    def changed(self) -> None:
        """Tell the stream that status, phase or mode moved."""
        bus.publish(self.graph, "agent.run", self.summary())
        self.saved()

    def enter(self, phase: Phase) -> None:
        self.phase = phase
        self.changed()

    def finish(self, outcome: str | None, error: str | None = None) -> None:
        self.status = "failed" if error else "done"
        self.outcome, self.error = outcome, error
        self.finished_at = int(time.time() * 1000)
        self.changed()


class Persister:
    """Writes a run to its graph as one node, serially per run, always the latest state. Failures are logged, never raised:
    the run itself carries on in memory."""

    def __init__(self, client):
        self.client = client
        self._locks: dict[str, asyncio.Lock] = {}
        self._tasks: set[asyncio.Task] = set()

    def __call__(self, run: "Run") -> None:
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return                                        # no loop: a record made outside the app, nothing to write to
        task = loop.create_task(self.save(run))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def save(self, run: "Run") -> None:
        lock = self._locks.setdefault(run.id, asyncio.Lock())
        async with lock:
            try:
                await self.client.run("run.record", run.graph, id=run.id, kind=run.kind, status=run.status,
                                      started_at=run.started_at, json=run.model_dump_json())
            except Exception as e:  # noqa: BLE001 - a lost record is a logged fact, never a failed run
                log.warning("run %s was not written to %s: %s", run.id, run.graph.split(":", 1)[0], type(e).__name__)

    async def flush(self) -> None:
        if self._tasks:
            await asyncio.gather(*list(self._tasks), return_exceptions=True)


def ref_of(graph: str) -> str:
    """The MCP reference for a working graph: the scenario name, or name@session for a visitor's copy."""
    if graph.startswith("ses:"):
        _, session, scenario = graph.split(":", 2)
        return f"{scenario}@{session}"
    return keys.scenario_of(graph)


class RunRegistry:
    """Runs of this process, newest last, plus the runs read back from the graphs. Old finished runs are dropped
    from memory; the graph keeps them."""

    def __init__(self, keep: int = 200):
        self._runs: OrderedDict[str, Run] = OrderedDict()
        self._keep = keep
        self.persister: Callable[[Run], None] | None = None
        self._hydrated: set[str] = set()

    def create(self, kind: str, scenario: str, graph: str, ref: str, **fields: Any) -> Run:
        run = Run(id=f"run:{token_hex(4)}", kind=kind, scenario=scenario, graph=graph, ref=ref,
                  started_at=int(time.time() * 1000), **fields)
        run._persist = self.persister
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
        self._hydrated.discard(graph)

    async def hydrate(self, client, graph: str, again: bool = False) -> int:
        """Read the runs kept on a graph into memory, once per graph, or again to pick up what another process wrote
        (`make audit`, a reseed). At first reading, a run that was running when its process ended comes back as
        failed, and says so; when reading again, an unfinished run may still be another process's, and is left for
        a later reading."""
        if graph in self._hydrated and not again:
            return 0
        self._hydrated.add(graph)
        try:
            rows = await client.run("run.list", graph)
        except Exception as e:  # noqa: BLE001 - a graph that is gone, or a database that is not: nothing to read
            log.debug("no runs read from %s: %s", graph.split(":", 1)[0], type(e).__name__)
            return 0
        added = 0
        for row in rows:
            if row["id"] in self._runs or not row.get("json"):
                continue
            try:
                run = Run.model_validate({**json.loads(row["json"]), "graph": graph, "ref": ref_of(graph)})
            except (ValueError, TypeError) as e:
                log.warning("run %s on %s could not be read back: %s", row["id"], graph.split(":", 1)[0], type(e).__name__)
                continue
            run._persist = self.persister
            if run.status in ("running", "awaiting_approval"):
                if again:
                    continue
                run.status, run.error = "failed", "the process that drove this run ended before it finished"
                run.finished_at = run.finished_at or int(time.time() * 1000)
                run.saved()
            self._runs[run.id] = run
            added += 1
        if added:                                          # oldest first, whatever order they arrived in
            self._runs = OrderedDict(sorted(self._runs.items(), key=lambda kv: (kv[1].started_at, kv[0])))
        return added


runs = RunRegistry()
