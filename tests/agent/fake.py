"""A scripted stand-in for the model, and helpers to drive a run in a test."""

import asyncio
from typing import Any, Callable

from cistern import ops
from cistern.agent.llm import Step, ToolCall, Usage
from cistern.agent.loop import Auditor
from cistern.agent.runs import Run, runs
from cistern.graph import keys
from cistern.mcp_server.server import build_server


class FakeLLM:
    """Answers from a script. Each entry is a Step, an exception to raise, or a function of the messages so far."""
    name = "fake-model"

    def __init__(self, script: list[Any]):
        self.script = list(script)
        self.calls: list[dict[str, Any]] = []

    async def step(self, system, messages, tools) -> Step:
        self.calls.append({"system": system, "messages": list(messages), "tools": [t.name for t in tools], "specs": list(tools)})
        assert self.script, f"the model was asked for a step the test did not script (tools: {[t.name for t in tools]})"
        item = self.script.pop(0)
        if isinstance(item, Exception):
            raise item
        return item(messages) if callable(item) else item


_n = 0


def call(name: str, **arguments: Any) -> Step:
    """The model asks for one tool call."""
    return calls((name, arguments))


def calls(*wanted: tuple[str, dict[str, Any]], text: str | None = None) -> Step:
    """The model asks for several tool calls in one turn."""
    global _n
    made = []
    for name, arguments in wanted:
        _n += 1
        made.append(ToolCall(id=f"call_{_n}", name=name, arguments=dict(arguments)))
    return Step(text=text, tool_calls=made, raw=[{"type": "thinking", "thinking": "", "signature": f"sig{_n}"}, {"made": made}],
                stop_reason="tool_use", usage=Usage(input_tokens=1000, output_tokens=100, cost_usd=0.006), model="fake-model")


def say(text: str) -> Step:
    """The model ends its turn with text."""
    return Step(text=text, tool_calls=[], raw=[{"type": "text", "text": text}], stop_reason="end_turn",
                usage=Usage(input_tokens=1000, output_tokens=100, cost_usd=0.006), model="fake-model")


def new_run(graph: str, kind: str = "audit", question: str | None = None, ref: str | None = None) -> Run:
    scenario = keys.scenario_of(graph)
    return runs.create(kind, scenario, graph, ref or scenario, question=question)


async def drive(client, run: Run, llm, decide: str | Callable | None = "approve", ref_for=None) -> Run:
    """Run to the end. When the run waits for a person, `decide` is that person: 'approve', 'reject' or None (nobody)."""
    auditor = Auditor(client, llm, server=build_server(), ref_for=ref_for)
    task = asyncio.create_task(auditor.run(run))
    decided: set[str] = set()
    while not task.done():
        await asyncio.sleep(0.01)
        if run.status == "awaiting_approval" and run.mitigation_id not in decided and decide:
            decided.add(run.mitigation_id)
            if callable(decide):
                await decide(run)
            elif decide == "approve":
                await ops.approve(client, run.graph, run.mitigation_id, "kartik")
            else:
                await ops.reject(client, run.graph, run.mitigation_id, "kartik", "not this way")
    await task
    return run


def tools_used(run: Run, by: str | None = None) -> list[str]:
    return [s.tool for s in run.steps if s.kind == "tool" and (by is None or s.by == by)]
