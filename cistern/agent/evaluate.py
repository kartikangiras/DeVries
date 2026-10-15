"""python -m cistern.agent.evaluate [--runs 3] [--scenarios a,b]

Is the agent any good? The baseline search is the yardstick (PLAN section 10).

For each scenario, each time on a fresh copy of its graph that is deleted afterwards:

  the baseline   the search's cheapest passing plan for the most severe open finding, and the
                 sandboxes it needed to find it;
  the agent      when a model is configured, `--runs` audit runs, each taken as far as its proposal
                 and no further. A plan is only proposed after a sandbox passed it, so a proposal is
                 a verified plan; it is compared with the baseline's on cost.

The agent does well on a run when it proposes a plan that costs no more than the baseline's. Nothing
stands in for the model: without an API key only the baseline is measured, and the table says so.
The command exits 1 if a run with a model did worse than the baseline, and 0 otherwise.
"""

import argparse
import asyncio
import logging
import sys
from dataclasses import dataclass
from secrets import token_hex

from cistern import ops
from cistern.agent.llm import LLM, configured_llm
from cistern.agent.loop import Auditor
from cistern.agent.runs import runs
from cistern.config import get_settings
from cistern.errors import CisternError
from cistern.graph import keys
from cistern.graph.client import GraphClient
from cistern.ingest.scenario_loader import read_scenario
from cistern.mcp_server.server import build_server
from cistern.mitigation import store
from cistern.mitigation.dsl import describe

RUN_TIMEOUT_S = 600


@dataclass
class Baseline:
    scenario: str
    target: str | None = None          # the finding the search worked on
    plan: str | None = None
    cost: int | None = None
    sandboxes: int = 0


@dataclass
class AgentRun:
    scenario: str
    n: int
    plan: str | None = None
    cost: int | None = None
    sandboxes: int = 0
    model_steps: int = 0
    usd: float = 0.0
    note: str = ""                     # why there is no plan, or that the run stopped being the model's

    def verdict(self, baseline: Baseline) -> str:
        if self.note.startswith("scripted"):
            return "not the model's"
        if self.cost is None:
            return "no plan" if baseline.cost is not None else "none needed"
        if baseline.cost is None:
            return "found one the search did not"
        return "matches" if self.cost == baseline.cost else "cheaper" if self.cost < baseline.cost else "worse"


def words(plan) -> str:
    return "; ".join(describe(fix) for fix in plan.fixes)


async def fresh_copy(client: GraphClient, scenario: str) -> tuple[str, str]:
    """A copy of the scenario graph that only this evaluation touches. Returns its key and its MCP reference."""
    session = f"eval-{token_hex(8)}"
    key = keys.session_key(session, scenario)
    await client.copy(keys.scenario_key(scenario), key)
    return key, f"{scenario}@{session}"


async def measure_baseline(client: GraphClient, scenario: str) -> Baseline:
    key, _ = await fresh_copy(client, scenario)
    try:
        await ops.scan(client, key)
        result = await ops.search(client, key)
        out = Baseline(scenario=scenario, target=result.targets[0] if result.targets else None, sandboxes=result.sandbox_runs)
        if result.passing:
            best = result.passing[0]
            out.plan, out.cost = words(best.plan), best.cost
        return out
    finally:
        await client.delete(key)


async def measure_agent(client: GraphClient, llm: LLM, scenario: str, n: int) -> AgentRun:
    """One audit run with the model, stopped at its proposal: nobody approves anything here."""
    key, ref = await fresh_copy(client, scenario)
    out = AgentRun(scenario=scenario, n=n)
    run = runs.create("audit", scenario, key, ref)
    task = asyncio.create_task(Auditor(client, llm, server=build_server()).run(run))
    try:
        waited = 0.0
        while not task.done() and run.status != "awaiting_approval" and waited < RUN_TIMEOUT_S:
            await asyncio.sleep(0.2)
            waited += 0.2
        out.sandboxes, out.model_steps, out.usd = run.usage.simulations, run.usage.model_steps, run.usage.cost_usd
        if run.mode == "scripted":
            out.note = f"scripted from the {run.phase} phase: {run.scripted_reason}"
        if run.status == "awaiting_approval" and run.mitigation_id:
            proposed = await store.get(client, key, run.mitigation_id)
            out.plan, out.cost = words(proposed.plan), proposed.cost
        elif run.status == "failed":
            out.note = out.note or f"failed: {run.error}"
        elif run.status == "done":
            out.note = out.note or f"ended with {run.outcome}"
        else:
            out.note = out.note or f"no proposal after {RUN_TIMEOUT_S} s"
        return out
    finally:
        if not task.done():
            task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        runs.forget(key)
        await client.delete(key)


def table(baselines: list[Baseline], agent_runs: list[AgentRun], model: str | None) -> str:
    lines = ["| Scenario | Target | Baseline plan | Cost | Sandboxes |", "| --- | --- | --- | ---: | ---: |"]
    for b in baselines:
        plan = b.plan or ("nothing is open" if b.target is None else "no plan passed")
        lines.append(f"| `{b.scenario}` | {f'`{b.target}`' if b.target else ''} | {plan} | {b.cost if b.cost is not None else ''} | {b.sandboxes} |")
    if model is None:
        lines += ["", "No model is configured (`ANTHROPIC_API_KEY` is not set), so no agent run was made. "
                      "The baseline above is the search's own result; nothing here measures the agent."]
        return "\n".join(lines)
    by_scenario = {b.scenario: b for b in baselines}
    lines += ["", f"Agent runs with `{model}`, each stopped at its proposal:", "",
              "| Scenario | Run | Proposed plan | Cost | Sandboxes | Model steps | Est. USD | Against the baseline |",
              "| --- | ---: | --- | ---: | ---: | ---: | ---: | --- |"]
    for r in agent_runs:
        plan = r.plan or r.note or "none"
        if r.plan and r.note:
            plan += f" ({r.note})"
        lines.append(f"| `{r.scenario}` | {r.n} | {plan} | {r.cost if r.cost is not None else ''} | {r.sandboxes} | "
                     f"{r.model_steps} | {r.usd:.3f} | {r.verdict(by_scenario[r.scenario])} |")
    lines += ["", f"Estimated spend: ${sum(r.usd for r in agent_runs):.2f} at list price, from the token counts of each response."]
    return "\n".join(lines)


async def main(scenarios: list[str], n_runs: int) -> int:
    logging.getLogger("httpx2").setLevel(logging.WARNING)      # the SDK logs every request at INFO; the table is the output
    logging.getLogger("httpx").setLevel(logging.WARNING)
    client = GraphClient()
    llm = configured_llm()
    baselines: list[Baseline] = []
    agent_runs: list[AgentRun] = []
    try:
        loaded = set(await client.list_graphs())
        for scenario in scenarios:
            if keys.scenario_key(scenario) not in loaded:
                print(f"{scenario}: not loaded; run `make seed` first", file=sys.stderr)
                return 2
            baseline = await measure_baseline(client, scenario)
            baselines.append(baseline)
            if llm is not None and baseline.target is not None:
                for n in range(1, n_runs + 1):
                    agent_runs.append(await measure_agent(client, llm, scenario, n))
    except CisternError as e:
        print(f"FAILED: {e.message}", file=sys.stderr)
        return 2
    finally:
        await client.close()
    print(table(baselines, agent_runs, llm.name if llm else None))
    by_scenario = {b.scenario: b for b in baselines}
    return 1 if any(r.verdict(by_scenario[r.scenario]) in ("worse", "no plan", "not the model's") for r in agent_runs) else 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser(prog="python -m cistern.agent.evaluate", description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--runs", type=int, default=3, help="audit runs per scenario when a model is configured (default 3)")
    parser.add_argument("--scenarios", help="comma-separated scenario names (default: every file in scenarios/)")
    args = parser.parse_args()
    names = args.scenarios.split(",") if args.scenarios else sorted(
        read_scenario(path).spec.scenario for path in get_settings().scenarios_dir.glob("*.yaml"))
    sys.exit(asyncio.run(main(names, max(1, args.runs))))
