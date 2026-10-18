"""What the review found and what now holds: a change is refused from another site, a decision is bound to the
session that made it, a file is written only for an approved plan, runs survive the process that made them, and the
body of a decision is required."""

import httpx2 as httpx
from test_api import Stream, base, visitor  # noqa: F401 - `base` is the app fixture

from devries.agent.runs import runs
from devries.mitigation import store


async def test_a_change_asked_for_from_another_site_is_refused(base):
    async with visitor(base) as http:
        found = (await http.post("/api/scenarios/acme_support/mitigations/search", json={})).json()
        best = found["passing"][0]
        evil = {"Origin": "https://evil.example"}
        for path in (f"/api/scenarios/acme_support/mitigations/{best['id']}/approve",
                     f"/api/scenarios/acme_support/mitigations/{best['id']}/draft/write",
                     "/api/scenarios/acme_support/mitigations/search"):
            refused = await http.post(path, json={"approver": "Mallory"}, headers=evil)
            assert refused.status_code == 403 and refused.json()["error"]["code"] == "cross_site", path
        # the page's own origin is fine, whatever the scheme the proxy spoke
        host = httpx.URL(base).netloc.decode()
        ok = await http.post(f"/api/scenarios/acme_support/mitigations/{best['id']}/approve", json={"approver": "Kartik"},
                             headers={"Origin": f"http://{host}"})
        assert ok.status_code == 200 and ok.json()["mitigation"]["status"] == "approved"
        # reads are not changes
        assert (await http.get("/api/scenarios/acme_support/findings", headers=evil)).status_code == 200


async def test_a_decision_needs_a_body_and_records_its_session(base):
    async with visitor(base) as http, visitor(base) as other:
        found = (await http.post("/api/scenarios/acme_support/mitigations/search", json={})).json()
        best = found["passing"][0]
        assert (await http.post(f"/api/scenarios/acme_support/mitigations/{best['id']}/approve")).status_code == 422
        assert (await http.post(f"/api/scenarios/acme_support/mitigations/{best['id']}/reject")).status_code == 422
        assert (await http.post("/api/scenarios/acme_support/mitigations/search")).status_code == 422
        approved = (await http.post(f"/api/scenarios/acme_support/mitigations/{best['id']}/approve", json={"approver": "Kartik"})).json()
        mine = approved["mitigation"]["approved_session"]
        assert mine == store.session_hash(http.cookies["devries_session"]) and mine != http.cookies["devries_session"]
        # another visitor's copy is their own graph, so their decision is their own record
        theirs = (await other.post("/api/scenarios/acme_support/mitigations/search", json={})).json()["passing"][0]
        rejected = (await other.post(f"/api/scenarios/acme_support/mitigations/{theirs['id']}/reject",
                                     json={"approver": "Priya", "reason": "no"})).json()
        assert rejected["mitigation"]["approved_session"] == store.session_hash(other.cookies["devries_session"]) != mine


async def test_runs_come_back_from_the_graph_after_the_process_forgets_them(base):
    async with visitor(base) as http:
        stream = await Stream.open(http)
        run = (await http.post("/api/agent/runs", json={"scenario": "acme_support"})).json()["run"]
        proposed = await stream.until(lambda e: e["type"] == "mitigation.proposed")
        await stream.until(lambda e: e["type"] == "agent.run" and e["data"]["status"] == "awaiting_approval")
        await http.post(f"/api/scenarios/acme_support/mitigations/{proposed['data']['id']}/reject", json={"approver": "Kartik", "reason": "no"})
        await stream.until(lambda e: e["type"] == "agent.run" and e["data"]["status"] == "done")
        await stream.close()
        if runs.persister is not None:
            await runs.persister.flush()
        steps_before = (await http.get(f"/api/agent/runs/{run['id']}")).json()["run"]["steps"]
        assert len(steps_before) >= 5

        # the process restarts: nothing is remembered
        kept = dict(runs._runs)
        runs._runs.clear()
        runs._hydrated.clear()
        try:
            listed = (await http.get("/api/scenarios/acme_support/runs")).json()["runs"]
            assert run["id"] in [r["id"] for r in listed]              # beside the runs kept on the shared graph by earlier passes
            back = (await http.get(f"/api/agent/runs/{run['id']}")).json()["run"]
            assert back["status"] == "done" and back["outcome"] == "rejected" and len(back["steps"]) == len(steps_before)
            assert back["answer"] and "rejected" in back["answer"] and back["answer_by"] == "template"
            assert back["steps"][-1]["by"] == "person"                                   # the decision is the last step recorded
        finally:
            runs._runs.update(kept)


async def test_a_plan_says_when_nothing_constrained_its_verdict(base):
    async with visitor(base) as http:
        found = (await http.post("/api/scenarios/acme_support/mitigations/search", json={})).json()
        assert all(m["unconstrained"] is False for m in found["passing"] + found["failed"])    # acme_support declares a workflow
