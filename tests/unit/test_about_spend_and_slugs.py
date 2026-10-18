"""The third review round: figures from one source, a budget shared through the database, served hosts, and server ids
that do not collide."""

import json
from pathlib import Path

from devries import about
from devries.agent import llm as llm_mod
from devries.agent.evaluate import AgentRun, Baseline, results
from devries.agent.runs import RunRegistry
from devries.app import served_hosts, transport_security
from devries.ingest.importer import _from_config


def test_the_about_figures_come_from_the_code_and_the_files():
    figures = about.describe("1.2.3", None, 9)
    assert figures["version"] == "1.2.3" and figures["rules"] == 7 and figures["queries"] >= 90 and figures["mcp_tools"] == 11
    assert figures["fix_costs"] == {"revoke_call": 1, "gate_call": 2, "quarantine_delegation": 2, "drop_read": 3, "split_agent": 4}
    assert figures["eval"] is None or figures["eval"]["model"]
    assert about.version() != "0.0.0"


def test_an_eval_without_a_model_is_not_quoted(tmp_path: Path):
    path = tmp_path / "eval.json"
    path.write_text(json.dumps({"model": None, "runs": 0}))
    assert about.eval_results(path) is None
    path.write_text("not json")
    assert about.eval_results(path) is None
    path.write_text(json.dumps({"model": "m", "runs": 3}))
    assert about.eval_results(path) == {"model": "m", "runs": 3}


def test_the_eval_writes_what_the_landing_quotes():
    baselines = [Baseline(scenario="s", target="fnd:x", plan="gate it", cost=2, sandboxes=5, to_first_pass=3)]
    runs = [AgentRun(scenario="s", n=1, plan="gate it", cost=2, sandboxes=2, model_steps=5, usd=0.09),
            AgentRun(scenario="s", n=2, plan="gate it", cost=2, sandboxes=3, model_steps=6, usd=0.11)]
    out = results(baselines, runs, "claude-x")
    row = out["scenarios"][0]
    assert (row["model_sandboxes"], row["model_steps"], row["usd"], row["matched"], row["runs"]) == ("2–3", "5–6", "0.09–0.11", 2, 2)
    assert out["matched"] == 2 and out["runs"] == 2 and out["model"] == "claude-x" and out["runs_per_scenario"] == 2


def test_an_unknown_model_is_costed_at_the_dearest_output_rate_and_says_so():
    assert llm_mod.priced("claude-opus-5-5") and not llm_mod.priced("some-new-model")
    assert llm_mod._DEAREST[1] == max(p[1] for p in llm_mod.PRICES.values())


class FakeConnection:
    def __init__(self):
        self.values: dict[str, float] = {}

    async def get(self, key):
        return self.values.get(key)

    async def incrbyfloat(self, key, usd):
        self.values[key] = self.values.get(key, 0.0) + usd

    async def expire(self, key, seconds):
        pass


class FakeClient:
    def __init__(self):
        self.connection = FakeConnection()


async def test_the_daily_budget_is_shared_through_the_database():
    import asyncio

    shared = FakeClient()
    one, two = llm_mod.Spend(), llm_mod.Spend()
    one.attach(shared)
    two.attach(shared)
    one.add(0.25)
    await asyncio.sleep(0)                                 # the write is a task
    await asyncio.sleep(0)
    assert await two.load() == 0.25 and two.today_usd == 0.25
    two.add(0.5)
    await asyncio.sleep(0)
    await asyncio.sleep(0)
    assert await one.load() == 0.75
    alone = llm_mod.Spend()
    alone.add(1.0)
    assert alone.today_usd == 1.0                          # no client attached: it counts in memory


def test_the_served_hosts_are_this_machine_plus_the_setting():
    assert served_hosts(None) == ["localhost", "127.0.0.1", "[::1]"]
    assert served_hosts("devries.example.org, lan.local")[-2:] == ["devries.example.org", "lan.local"]
    security = transport_security("devries.example.org")
    assert "devries.example.org:*" in security.allowed_hosts and "https://devries.example.org" in security.allowed_origins
    assert security.enable_dns_rebinding_protection


def test_the_registry_counts_what_is_in_flight():
    reg = RunRegistry()
    a = reg.create("audit", "s", "scn:s", "s")
    b = reg.create("audit", "s", "scn:s", "s")
    b.status = "done"
    assert reg.active_count() == 1 and not reg.is_hydrated("scn:s")
    a.status = "awaiting_approval"
    assert reg.active_count() == 1


def test_two_servers_whose_names_differ_only_in_punctuation_keep_two_ids(tmp_path: Path):
    config = tmp_path / "mcp.json"
    config.write_text(json.dumps({"mcpServers": {"my-server": {"command": "a"}, "my_server": {"command": "b"}, "other": {"command": "c"}}}))
    ids = [s.id for s in _from_config(config)]
    assert len(ids) == len(set(ids)) == 3 and "srv:my-server" in ids and "srv:my-server-2" in ids
