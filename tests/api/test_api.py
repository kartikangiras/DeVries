"""The REST API and the event stream, over real HTTP against the app, with no model configured.

`test_the_day_2_gate_over_http` is the Day 2 gate without a browser: an audit run finds the
finding, proposes a verified fix, and after a person approves it the finding closes.
"""

import asyncio
import json
import socket
from pathlib import Path

import httpx2 as httpx
import pytest
import pytest_asyncio
import uvicorn

from devries.agent.llm import spend
from devries.app import create_app
from devries.config import get_settings
from devries.graph.catalog import CATALOG
from devries.ingest.scenario_loader import load_scenario

ROOT = Path(__file__).resolve().parents[2]


@pytest_asyncio.fixture(loop_scope="session")
async def base(client, monkeypatch):
    """The app on a free port. No model key, so every run is scripted and the tests cost nothing."""
    monkeypatch.setattr(get_settings(), "anthropic_api_key", None)
    monkeypatch.setattr(get_settings(), "prerun_audits", False)   # the start-up pass is tested on its own; here the shared graphs stay as loaded
    monkeypatch.setattr(spend, "_usd", 0.0)               # other tests' pretend model steps are not today's spend
    for name in ("acme_support", "acme_exec"):
        await load_scenario(client, ROOT / "scenarios" / f"{name}.yaml", strict=True)
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(create_app(), host="127.0.0.1", port=port, log_level="warning"))
    task = asyncio.create_task(server.serve())
    for _ in range(200):
        if server.started:
            break
        await asyncio.sleep(0.05)
    assert server.started
    yield f"http://127.0.0.1:{port}"
    server.should_exit = True
    await task
    for key in await client.list_graphs():
        if key.startswith("ses:"):
            await client.delete(key)


def visitor(base: str) -> httpx.AsyncClient:
    """A browser: it keeps its cookie."""
    return httpx.AsyncClient(base_url=base, timeout=30)


class Stream:
    """The event stream of one visitor, read in the background.

    Open it with `await Stream.open(http)`: the visitor's first request has to finish before
    anything else is sent, or two requests without a cookie are given two different sessions.
    The UI does the same on load.
    """

    def __init__(self, http: httpx.AsyncClient):
        self.events: list[dict] = []
        self._task = asyncio.create_task(self._read(http))

    @classmethod
    async def open(cls, http: httpx.AsyncClient) -> "Stream":
        await http.get("/api/session")                    # takes the cookie
        stream = cls(http)
        await stream.until(lambda e: e["type"] == "hello")
        return stream

    async def _read(self, http: httpx.AsyncClient) -> None:
        async with http.stream("GET", "/api/events", timeout=None) as response:
            async for line in response.aiter_lines():
                if line.startswith("data: "):
                    self.events.append(json.loads(line[6:]))

    async def until(self, wanted, timeout: float = 30) -> dict:
        async def wait() -> dict:
            while True:
                for event in self.events:
                    if wanted(event):
                        return event
                await asyncio.sleep(0.02)
        return await asyncio.wait_for(wait(), timeout)

    def types(self) -> list[str]:
        return [e["type"] for e in self.events]

    async def close(self) -> None:
        self._task.cancel()
        await asyncio.gather(self._task, return_exceptions=True)


async def open_ids(http: httpx.AsyncClient, scenario: str) -> list[str]:
    return [f["id"] for f in (await http.get(f"/api/scenarios/{scenario}/findings")).json()["findings"]]


# ---------------------------------------------------------------------- reading

async def test_health_reports_the_graph_the_model_and_how_sandboxes_are_made(base):
    async with visitor(base) as http:
        body = (await http.get("/api/health")).json()
        assert body["ok"] and body["canary"]["ok"]
        assert body["scenarios"] == {"acme_dev": True, "acme_exec": True, "acme_support": True, "devries_self": True}
        assert body["model"] == {"configured": False, "name": None, "budget_spent": False, "spent_today_usd": 0.0}
        assert body["sessions"]["max"] == 30


async def test_a_visitor_gets_one_http_only_session_cookie(base):
    async with visitor(base) as http:
        first = await http.get("/api/scenarios")
        cookie = first.headers["set-cookie"]
        assert cookie.startswith("devries_session=") and "HttpOnly" in cookie and "SameSite=Lax" in cookie
        assert len(http.cookies["devries_session"]) == 22            # 128 random bits
        assert "set-cookie" not in (await http.get("/api/scenarios")).headers
        info = (await http.get("/api/session")).json()
        assert info["copies"] == [] and info["model"]["configured"] is False


async def test_scenarios_graph_and_findings_read_the_shared_graphs(base):
    async with visitor(base) as http:
        listed = {s["id"]: s for s in (await http.get("/api/scenarios")).json()["scenarios"]}
        assert listed["acme_support"]["open_findings"] == 1 and listed["acme_exec"]["open_findings"] == 2
        assert listed["acme_support"]["own_copy"] is False and "refund" in listed["acme_support"]["description"].lower()

        flow = (await http.get("/api/scenarios/acme_support/graph")).json()
        by_id = {n["data"]["id"]: n for n in flow["nodes"]}
        assert by_id["agent:support-bot"]["label"] == "Agent" and by_id["agent:support-bot"]["data"]["blast"] is True
        assert by_id["src:customer-tickets"]["data"]["trust"] == "untrusted" and isinstance(by_id["agent:support-bot"]["id"], int)
        assert {link["rel"] for link in flow["links"]} == {"FLOWS_TO"}
        refund = next(l for l in flow["links"] if (l["data"]["from_id"], l["data"]["to_id"]) == ("agent:support-bot", "tool:payments.issue_refund"))
        assert refund["data"]["sentence"] == "rule 3: agent:support-bot can call tool:payments.issue_refund"
        assert {"ui.nodes", "ui.links", "zones.communities", "reach.untrusted_nodes", "choke.pagerank"} <= set(flow["queries"])
        assert by_id["agent:support-bot"]["data"]["pagerank_rank"] >= 1 and by_id["agent:support-bot"]["data"]["pagerank"] > 0
        # what untrusted text reaches is FalkorDB's answer, carried on each node: the page only colours it
        tainted = {n["data"]["id"] for n in flow["nodes"] if n["data"].get("tainted")}
        assert {"src:customer-tickets", "tool:helpdesk.get_ticket", "agent:support-bot", "tool:payments.issue_refund", "res:payments-api"} <= tainted
        assert tainted < set(by_id) and all(n["data"]["trust"] == "untrusted" for n in flow["nodes"] if n["label"] == "DataSource" and n["data"].get("tainted"))
        # each flow hop says which config edge it comes from and which fixes can cut it
        assert refund["data"]["config"] == {"rel": "CAN_CALL", "from_id": "agent:support-bot", "to_id": "tool:payments.issue_refund"}
        assert refund["data"]["fixes"] == ["revoke_call", "gate_call"] and "fixes_later" not in refund["data"]
        behind = {l["data"]["rule"]: l["data"] for l in flow["links"]}
        assert behind[1]["config"]["rel"] == "READS" and behind[1]["config"]["to_id"].startswith("src:")
        assert behind[1]["fixes"] == ["drop_read"]
        assert behind[2]["config"]["from_id"] == "agent:support-bot" and behind[2]["fixes"] == ["revoke_call"]
        assert behind[5]["config"]["rel"] == "WRITES" and behind[5]["fixes"] == []   # cannot be cut
        assert flow["workflows"][0] == {"id": "wf:refund-request", "name": flow["workflows"][0]["name"], "description": flow["workflows"][0]["description"],
                                        "mode": "supervised", "run_by": "agent:support-bot",
                                        "needs": ["tool:payments.issue_refund"], "reads": ["src:customer-tickets"]}

        config = (await http.get("/api/scenarios/acme_support/graph", params={"layer": "config"})).json()
        assert {link["rel"] for link in config["links"]} == {"CAN_CALL", "READS", "WRITES"}
        assert any(l["data"]["sentence"] == "agent:support-bot can call tool:payments.issue_refund" for l in config["links"])

        found = (await http.get("/api/scenarios/acme_support/findings")).json()
        assert [f["id"] for f in found["findings"]] == ["fnd:dce0910d42"] and found["past"] == []
        assert found["names"]["agent:support-bot"] == "Support bot"
        one = (await http.get("/api/scenarios/acme_support/findings/fnd:dce0910d42")).json()["finding"]
        assert one["paths"][0]["hops"][0] == "rule 1: tool:helpdesk.get_ticket reads src:customer-tickets"
        assert (await http.get("/api/session")).json()["copies"] == []                 # reading copied nothing


async def test_the_catalog_is_published(base):
    async with visitor(base) as http:
        listed = {q["name"]: q for q in (await http.get("/api/queries")).json()["queries"]}
        assert set(listed) == set(CATALOG) and "algo.bfs" in listed["reach.untrusted_to_high"]["cypher"]
        assert listed["fix.gate_call"]["mode"] == "rw" and listed["wf.broken"]["mode"] == "ro"


@pytest.mark.parametrize("method, path, status, code", [
    ("GET", "/api/scenarios/nope/graph", 404, "unknown_scenario"),
    ("GET", "/api/scenarios/Not%20A%20Name/findings", 404, "unknown_scenario"),
    ("GET", "/api/scenarios/acme_support/findings/fnd:0000000000", 404, "not_found"),
    ("GET", "/api/scenarios/acme_support/mitigations/mit:0000000000", 404, "not_found"),
    ("POST", "/api/scenarios/acme_support/mitigations/mit:0000000000/approve", 404, "not_found"),
    ("GET", "/api/agent/runs/run:00000000", 404, "not_found"),
])
async def test_errors_are_structured(base, method, path, status, code):
    async with visitor(base) as http:
        response = await http.request(method, path)
        assert response.status_code == status and response.json()["error"]["code"] == code
    async with visitor(base) as http:
        assert (await http.get("/api/scenarios/acme_support/graph", params={"layer": "everything"})).status_code == 422


# ---------------------------------------------------------------------- the Day 2 gate

@pytest.mark.parametrize("scenario, fix, closes", [
    ("acme_support", "gate_call", 1),
    ("acme_exec", "quarantine_delegation", 2),
])
async def test_the_day_2_gate_over_http(base, client, scenario, fix, closes):
    async with visitor(base) as http, visitor(base) as other:
        before = await open_ids(http, scenario)
        stream = await Stream.open(http)

        run = (await http.post("/api/agent/runs", json={"scenario": scenario})).json()["run"]
        assert run["status"] == "running" and run["kind"] == "audit"
        proposed = await stream.until(lambda e: e["type"] == "mitigation.proposed" and e["data"]["rationale"])
        mitigation_id = proposed["data"]["id"]
        assert proposed["data"]["plan"]["fixes"][0]["kind"] == fix and proposed["data"]["passed"] is True
        await stream.until(lambda e: e["type"] == "agent.run" and e["data"]["status"] == "awaiting_approval")

        # a second run on the same copy is refused while this one waits for a person
        again = await http.post("/api/agent/runs", json={"scenario": scenario})
        assert again.status_code == 409 and again.json()["error"] == {
            "code": "run_active", "message": again.json()["error"]["message"], "retryable": False, "run_id": run["id"]}

        approved = await http.post(f"/api/scenarios/{scenario}/mitigations/{mitigation_id}/approve", json={"approver": "Kartik"})
        assert approved.status_code == 200 and approved.json()["mitigation"]["approved_by"] == "Kartik"
        done = await stream.until(lambda e: e["type"] == "agent.run" and e["data"]["status"] in ("done", "failed"))
        assert (done["data"]["outcome"], done["data"]["mode"], done["data"]["error"]) == ("applied", "scripted", None)

        # the finding is closed in this visitor's copy
        after = (await http.get(f"/api/scenarios/{scenario}/findings")).json()
        assert after["findings"] == [] and after["own_copy"] is True
        assert sorted(f["id"] for f in after["past"]) == sorted(before) and {f["status"] for f in after["past"]} == {"mitigated"}
        assert len(before) == closes
        record = (await http.get(f"/api/agent/runs/{run['id']}")).json()["run"]
        assert record["answer_by"] == "template" and "Kartik approved it and it was applied" in record["answer"]
        assert [s["tool"] for s in record["steps"] if s["by"] == "loop" and s["tool"]] == ["scan", "apply_fix", "scan"]
        types = stream.types()
        order = [types.index(t) for t in ("scan.finished", "mitigation.simulated", "mitigation.proposed", "mitigation.approved",
                                          "mitigation.applied", "finding.closed", "agent.answer")]
        assert order == sorted(order)
        await stream.close()

        # and nowhere else: another visitor, and the scenario graph itself, still have it open
        assert await open_ids(other, scenario) == before
        assert (await other.get("/api/session")).json()["copies"] == []
        shared = await client.run("finding.list", f"scn:{scenario}")
        assert {row["status"] for row in shared} == {"open"}
        assert (await other.get(f"/api/agent/runs/{run['id']}")).status_code == 404    # a run belongs to its session


async def test_reset_gives_the_visitor_the_shared_scenario_back(base, client):
    async with visitor(base) as http:
        found = (await http.post("/api/scenarios/acme_support/mitigations/search")).json()
        best = found["passing"][0]
        assert best["plan"]["fixes"][0]["kind"] == "gate_call" and len(found["failed"]) == 3
        assert (await http.post(f"/api/scenarios/acme_support/mitigations/{best['id']}/apply")).json()["error"]["code"] == "needs_approval"
        await http.post(f"/api/scenarios/acme_support/mitigations/{best['id']}/approve", json={"approver": "<b>Kartik</b>"})
        applied = (await http.post(f"/api/scenarios/acme_support/mitigations/{best['id']}/apply")).json()
        assert applied["open"] == [] and applied["patch"]["changes"][0]["gate"] == "human_approval"
        stored = (await http.get(f"/api/scenarios/acme_support/mitigations/{best['id']}")).json()["mitigation"]
        assert stored["status"] == "applied" and stored["approved_by"] == "bKartikb"      # markup never reaches the record
        session = http.cookies["devries_session"]
        assert f"ses:{session}:acme_support" in await client.list_graphs()

        assert (await http.post("/api/session/reset")).json() == {"reset": ["acme_support"]}
        assert f"ses:{session}:acme_support" not in await client.list_graphs()
        assert await open_ids(http, "acme_support") == ["fnd:dce0910d42"]
        assert (await http.get("/api/scenarios/acme_support/mitigations")).json()["mitigations"] == []


async def test_a_rejection_is_recorded_with_its_reason_and_ends_the_run(base):
    async with visitor(base) as http:
        stream = await Stream.open(http)
        run = (await http.post("/api/agent/runs", json={"scenario": "acme_support"})).json()["run"]
        proposed = await stream.until(lambda e: e["type"] == "mitigation.proposed" and e["data"]["rationale"])
        await stream.until(lambda e: e["type"] == "agent.run" and e["data"]["status"] == "awaiting_approval")
        await http.post(f"/api/scenarios/acme_support/mitigations/{proposed['data']['id']}/reject",
                        json={"approver": "Kartik", "reason": "Refunds over $50 only."})
        done = await stream.until(lambda e: e["type"] == "agent.run" and e["data"]["status"] == "done")
        assert done["data"]["outcome"] == "rejected"
        answer = (await http.get(f"/api/agent/runs/{run['id']}")).json()["run"]["answer"]
        assert "Kartik rejected it: Refunds over $50 only." in answer
        assert await open_ids(http, "acme_support") == ["fnd:dce0910d42"]
        await stream.close()


async def test_a_question_without_a_model_says_so(base):
    async with visitor(base) as http:
        stream = await Stream.open(http)
        asked = await http.post("/api/agent/ask", json={"scenario": "acme_support", "question": "Can a ticket reach the payments API?"})
        run_id = asked.json()["run"]["id"]
        answer = await stream.until(lambda e: e["type"] == "agent.answer" and e["data"]["run_id"] == run_id)
        assert answer["data"]["by"] == "template" and "no model is configured" in answer["data"]["text"]
        assert (await http.get("/api/session")).json()["copies"] == []                 # a question copies nothing
        assert (await http.post("/api/agent/ask", json={"scenario": "acme_support", "question": "x"})).status_code == 422
        await stream.close()


# ---------------------------------------------------------------------- limits and tokens

async def test_when_every_copy_is_in_use_a_new_visitor_can_still_read(base, monkeypatch):
    monkeypatch.setattr(get_settings(), "session_max", 1)
    async with visitor(base) as first, visitor(base) as second:
        assert (await first.post("/api/scenarios/acme_support/scan")).status_code == 200
        refused = await second.post("/api/scenarios/acme_support/scan")
        assert refused.status_code == 503 and refused.json()["error"]["code"] == "session_limit"
        assert await open_ids(second, "acme_support") == ["fnd:dce0910d42"]            # the shared view still works
        assert (await first.post("/api/scenarios/acme_exec/scan")).status_code == 200  # a holder may copy more


async def test_mcp_over_http_needs_the_bearer_token_when_one_is_set(base, monkeypatch):
    from mcp import Client
    monkeypatch.setattr(get_settings(), "devries_mcp_token", "s3cret-token")
    async with visitor(base) as http:
        refused = await http.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
        assert refused.status_code == 401 and refused.json()["error"]["code"] == "unauthorized"
        wrong = await http.post("/mcp", json={}, headers={"Authorization": "Bearer nope"})
        assert wrong.status_code == 401
        assert (await http.get("/api/health")).status_code == 200                      # the API is not behind it
    monkeypatch.setattr(get_settings(), "devries_mcp_token", None)
    async with Client(f"{base}/mcp") as session:
        assert len((await session.list_tools()).tools) == 11


async def test_a_visitor_only_hears_about_their_own_copy(base):
    async with visitor(base) as mine, visitor(base) as theirs:
        my_stream, their_stream = await Stream.open(mine), await Stream.open(theirs)
        await mine.post("/api/scenarios/acme_support/scan")
        await my_stream.until(lambda e: e["type"] == "scan.finished")
        await asyncio.sleep(0.2)
        assert "scan.finished" not in their_stream.types() and their_stream.types() == ["hello"]
        assert all(set(e) == {"id", "type", "scenario", "at", "data"} for e in my_stream.events[1:])   # no graph key, no session
        assert mine.cookies["devries_session"] not in json.dumps(my_stream.events)
        await my_stream.close()
        await their_stream.close()


async def test_health_names_the_falkordb_version_and_findings_say_when_they_were_scanned(base):
    async with visitor(base) as http:
        version = (await http.get("/api/health")).json()["falkordb_version"]
        assert version and all(part.isdigit() for part in version.split(".")) and len(version.split(".")) == 3
        scanned = (await http.get("/api/scenarios/acme_support/findings")).json()["last_scan"]
        assert scanned["at"] > 1_700_000_000_000 and scanned["duration_ms"] >= 0
        assert (scanned["injection"], scanned["trifecta"], scanned["partial"]) == (1, 0, False)
        assert scanned["scan_id"].startswith("scan:")
        nodes = {s["id"]: s["nodes"] for s in (await http.get("/api/scenarios")).json()["scenarios"]}
        assert nodes["acme_support"] == 15                           # the scan record is not one of the scenario's nodes


async def test_a_what_if_is_answered_from_a_sandbox_and_makes_no_copy(base, client):
    async with visitor(base) as http:
        # the release bot already reads what untrusted text put on main, and CI secrets with it (rule 7).
        # Give it the HTTP tool and it has a way out as well: a fourth trifecta agent
        grant = {"changes": [{"kind": "grant_call", "agent_id": "agent:release-bot", "tool_id": "tool:http.request"}]}
        opened = (await http.post("/api/scenarios/acme_dev/whatif", json=grant)).json()
        assert opened["changes"] == ["grant tool:http.request to agent:release-bot"]
        assert [(f["kind"], f["agent_id"]) for f in opened["introduced"]] == [("trifecta", "agent:release-bot")]
        path = opened["introduced"][0]["path_ids"]                   # one path in and out, read before the sandbox went
        assert path[0].startswith("src:") and "agent:release-bot" in path and path[-2:] == ["tool:http.request", "res:internet"]
        assert opened["resolved"] == [] and opened["newly_broken"] == [] and opened["sandbox_ms"] >= 0

        # a fix asked as a question: what it would close, and what it would break
        revoke = {"changes": [{"kind": "revoke_call", "agent_id": "agent:support-bot", "tool_id": "tool:payments.issue_refund"}]}
        cut = (await http.post("/api/scenarios/acme_support/whatif", json=revoke)).json()
        assert cut["resolved"] == ["fnd:dce0910d42"] and cut["introduced"] == []
        assert [b["workflow_id"] for b in cut["newly_broken"]] == ["wf:refund-request"]

        assert (await http.get("/api/session")).json()["copies"] == []          # nothing was written, so no copy was made
        assert not [k for k in await client.list_graphs() if k.startswith("ses:")]
        assert await open_ids(http, "acme_support") == ["fnd:dce0910d42"]

        nothing = await http.post("/api/scenarios/acme_support/whatif", json={"changes": []})
        assert nothing.status_code == 422
        unknown = await http.post("/api/scenarios/acme_support/whatif", json={"changes": [
            {"kind": "grant_call", "agent_id": "agent:nobody", "tool_id": "tool:payments.issue_refund"}]})
        assert unknown.status_code == 404 and unknown.json()["error"]["code"] == "not_found"


async def test_a_plan_can_be_previewed_before_anyone_approves_it(base):
    async with visitor(base) as http:
        found = (await http.post("/api/scenarios/acme_support/mitigations/search", json={})).json()
        gate = found["passing"][0]
        after = (await http.get(f"/api/scenarios/acme_support/mitigations/{gate['id']}/preview")).json()
        assert after["applied"] is False and after["layer"] == "flow"
        blocked = [(l["data"]["from_id"], l["data"]["to_id"], l["data"]["gate"]) for l in after["links"] if l["rel"] == "GATED_FLOW"]
        assert blocked == [("agent:support-bot", "tool:payments.issue_refund", "human_approval")]
        # the visitor's graph is as it was: the preview was read from a sandbox
        now = (await http.get("/api/scenarios/acme_support/graph")).json()
        assert {l["rel"] for l in now["links"]} == {"FLOWS_TO"} and await open_ids(http, "acme_support") == ["fnd:dce0910d42"]

        # a failed plan can be looked at too: the revoke takes the grant away altogether
        revoke = next(m for m in found["failed"] if m["plan"]["fixes"][0] == {"kind": "revoke_call", "agent_id": "agent:support-bot", "tool_id": "tool:payments.issue_refund"})
        gone = (await http.get(f"/api/scenarios/acme_support/mitigations/{revoke['id']}/preview")).json()
        assert ("agent:support-bot", "tool:payments.issue_refund") not in {(l["data"]["from_id"], l["data"]["to_id"]) for l in gone["links"]}

        # once applied, the graph itself is the preview
        await http.post(f"/api/scenarios/acme_support/mitigations/{gate['id']}/approve", json={"approver": "Tester"})
        await http.post(f"/api/scenarios/acme_support/mitigations/{gate['id']}/apply")
        applied = (await http.get(f"/api/scenarios/acme_support/mitigations/{gate['id']}/preview")).json()
        assert applied["applied"] is True and any(l["rel"] == "GATED_FLOW" for l in applied["links"])


def test_sandbox_reads_are_rationed_by_the_minute():
    from devries.api.sessions import SANDBOX_READS_PER_MIN, RateLimited, Sessions

    sessions = Sessions()
    for _ in range(SANDBOX_READS_PER_MIN):
        sessions.count_sandbox_read("a" * 22)
    with pytest.raises(RateLimited):
        sessions.count_sandbox_read("a" * 22)
    sessions.count_sandbox_read("b" * 22)                            # another visitor is not held back


async def test_the_cheapest_cut_is_read_from_max_flow_and_marks_flow_hops(base, client):
    async with visitor(base) as http:
        cut = (await http.get("/api/scenarios/acme_support/cut")).json()
        assert (cut["cost"], cut["cuttable"]) == (1, True) and cut["queries"] == ["choke.maxflow", "flow.edges"]
        # the hop is given the way it flows (tool to agent), with the grant behind it the other way round
        assert cut["hops"] == [{
            "from_id": "tool:helpdesk.get_ticket", "to_id": "agent:support-bot", "rule": 2,
            "sentence": "rule 2: agent:support-bot calls tool:helpdesk.get_ticket, so what it returns enters agent:support-bot's context",
            "config": {"rel": "CAN_CALL", "from_id": "agent:support-bot", "to_id": "tool:helpdesk.get_ticket"},
            "capacity": 1, "fixes": ["revoke_call"]}]
        # the cut is where it is cheapest to look, not a verdict: the sandbox refuses this very revoke
        found = (await http.post("/api/scenarios/acme_support/mitigations/search")).json()
        refused = [m for m in found["failed"] if m["summary"] == ["revoke tool:helpdesk.get_ticket from agent:support-bot"]]
        assert len(refused) == 1 and "wf:refund-request" in refused[0]["reason"]

        clean = (await http.get("/api/scenarios/devries_self/cut")).json()
        assert (clean["cost"], clean["hops"], clean["cuttable"]) == (0, [], True)
        assert (await http.get("/api/scenarios/no_such/cut")).status_code == 404


async def test_servers_are_listed_and_removing_one_is_a_what_if(base, client):
    async with visitor(base) as http:
        listed = (await http.get("/api/scenarios/acme_dev/servers")).json()
        assert listed["queries"] == ["server.summary"]
        by_id = {s["id"]: s for s in listed["servers"]}
        assert set(by_id) == {"srv:github", "srv:git", "srv:ci", "srv:http"}
        assert by_id["srv:http"]["tools"] == ["tool:http.request"] and by_id["srv:http"]["agents"] == ["agent:coder"]
        assert len(by_id["srv:http"]["findings"]) >= 3           # the three trifectas leave through it
        # removing the HTTP server closes every trifecta, and the two injections that come in from the web, and breaks nothing
        answer = (await http.post("/api/scenarios/acme_dev/whatif", json={"changes": [{"kind": "drop_server", "server_id": "srv:http"}]})).json()
        assert len(answer["resolved"]) == 5 and answer["introduced"] == [] and answer["newly_broken"] == []
        # removing git breaks the workflows that push and read files
        answer = (await http.post("/api/scenarios/acme_dev/whatif", json={"changes": [{"kind": "drop_server", "server_id": "srv:git"}]})).json()
        assert any(b["workflow_id"] == "wf:fix-bug" for b in answer["newly_broken"])
        refused = await http.post("/api/scenarios/acme_dev/whatif", json={"changes": [{"kind": "drop_server", "server_id": "srv:nope"}]})
        assert refused.status_code == 404


async def test_an_imported_scenario_is_labelled_from_the_ui_and_the_bundled_ones_cannot_be(base, client):
    """The importer writes a file with every label unknown; the labels route rewrites it and reloads the graph."""
    import sys
    from pathlib import Path

    from devries.ingest.importer import import_install
    from devries.ingest.scenario_loader import load_scenario

    root = Path(__file__).resolve().parents[2]
    name = "import_labels_test"
    result = await import_install(f"{sys.executable} -m devries.mcp_server", root, name=name)
    try:
        await load_scenario(client, result.scenario_path)
        async with visitor(base) as http:
            listed = {s["id"]: s for s in (await http.get("/api/scenarios")).json()["scenarios"]}
            assert listed[name]["imported"] is True and listed[name]["open_findings"] == 0
            server = result.servers[0][4:]
            saved = await http.post(f"/api/scenarios/{name}/labels", json={
                "data_sources": {f"src:{server}": "untrusted"},
                "resources": {f"res:{server}": {"impact": "high", "external": False}}})
            assert saved.status_code == 200 and any(f["kind"] == "injection" for f in saved.json()["findings"])
            assert "trust: untrusted" in result.scenario_path.read_text()
            refused = await http.post("/api/scenarios/acme_support/labels", json={"data_sources": {"src:customer-tickets": "internal"}})
            assert refused.status_code == 422 and "not imported" in refused.json()["error"]["message"]
            bad = await http.post(f"/api/scenarios/{name}/labels", json={"data_sources": {"src:nope": "untrusted"}})
            assert bad.status_code == 422
    finally:
        result.scenario_path.unlink(missing_ok=True)
        for path in result.manifests:
            path.unlink(missing_ok=True)
        await client.delete(f"scn:{name}")
