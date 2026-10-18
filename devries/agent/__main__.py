"""python -m devries.agent --scenario NAME [--no-model] [--wait]

One audit on a shared scenario graph, driven by the configured model when a key is set and scripted
otherwise, kept on the graph as it moves so the running app shows it on the scenario's Activity page.
It stops once a plan waits for a person: approve or reject that plan in the app. With --wait it stays
and waits for the decision instead (up to APPROVAL_TIMEOUT_S), which only an approval made in this
same process could satisfy, so --wait is for a scripted check, not for the app.
"""

import argparse
import asyncio
import sys

import redis.exceptions as rex

from devries.agent.llm import configured_llm, spend
from devries.agent.loop import Auditor
from devries.agent.runs import Persister, runs
from devries.analysis import canary
from devries.config import get_settings
from devries.graph import keys
from devries.graph.client import GraphClient, unreachable
from devries.mcp_server.server import build_server


def _line(step) -> str:
    what = step.tool or step.kind
    text = step.headline or step.text or ""
    return f"  {step.n:>2}. [{step.phase:<11}] {step.by:<8} {what:<22} {text[:100]}"


async def main(scenario: str, use_model: bool, wait: bool) -> int:
    settings = get_settings()
    try:
        client = GraphClient()
    except (rex.RedisError, OSError) as e:
        print(unreachable(e))
        return 2
    try:
        key = keys.scenario_key(scenario)
        if not await client.ping():
            print(unreachable(ConnectionError("no answer")))
            return 2
        spend.attach(client)
        await spend.load()                                # today's model spend, shared with the app
        if not await client.exists(key):
            print(f"no scenario graph for {scenario!r}: run `make seed` first")
            return 1
        check = await canary.ensure(client)
        print(f"canary: {check.detail} ({check.ms} ms)")
        llm = configured_llm(settings) if use_model else None
        runs.persister = Persister(client)
        await runs.hydrate(client, key)
        run = runs.create("audit", scenario, key, scenario)
        reason = "--no-model was given" if not use_model else "no model is configured"
        auditor = Auditor(client, llm, server=build_server(), stop_after_proposal=not wait, no_model_reason=reason)
        print(f"{run.id} on {scenario}: {'model ' + llm.name if llm else 'scripted'}")
        task = asyncio.create_task(auditor.run(run))
        shown = 0
        while not task.done():
            for step in run.steps[shown:]:
                print(_line(step))
            shown = len(run.steps)
            await asyncio.sleep(0.3)
        for step in run.steps[shown:]:
            print(_line(step))
        await task
        await runs.persister.flush()
        print(f"{run.status}: {run.outcome or run.error or ''} · {len(run.steps)} steps · {run.usage.simulations} sandbox graphs"
              + (f" · ${run.usage.cost_usd:.2f}" if run.usage.cost_usd else ""))
        if run.mitigation_id:
            print(f"plan {run.mitigation_id} waits for a person: open the scenario in the app to approve or reject it")
        print(f"the run is kept on the graph: the app shows it on {scenario}'s Activity page")
        return 0 if run.status == "done" else 1
    finally:
        await client.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(prog="python -m devries.agent", description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--scenario", required=True, help="the scenario to audit, by name (acme_dev)")
    parser.add_argument("--no-model", action="store_true", help="drive the run with the scripted search even when a key is set")
    parser.add_argument("--wait", action="store_true", help="wait for a decision instead of stopping at the proposal")
    args = parser.parse_args()
    sys.exit(asyncio.run(main(args.scenario, not args.no_model, args.wait)))
