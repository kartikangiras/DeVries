"""Pivot C of the API: scan history, the posture page, the activity list, the inventory and the cut as one plan."""

import asyncio

from test_api import Stream, base, open_ids, visitor  # noqa: F401  (the fixture and helpers of the first API file)


# ---------------------------------------------------------------------- scans over time

async def test_each_scan_is_kept_and_listed_oldest_first(base):
    async with visitor(base) as http:
        before = (await http.get("/api/scenarios/acme_support/scans")).json()
        assert before["queries"] == ["scan.history"] and len(before["scans"]) >= 1      # the load's own scan
        first = before["scans"][0]
        assert first["scan_id"].startswith("scan:") and first["open"] == 1 and (first["injection"], first["trifecta"]) == (1, 0)
        assert first["partial"] is False and first["at"] > 1_700_000_000_000 and first["duration_ms"] >= 0
        scanned = (await http.post("/api/scenarios/acme_support/scan")).json()
        after = (await http.get("/api/scenarios/acme_support/scans")).json()["scans"]
        assert len(after) == len(before["scans"]) + 1 and after[-1]["scan_id"] == scanned["scan_id"]
        assert [s["at"] for s in after] == sorted(s["at"] for s in after)
        # the shared graph did not gain the visitor's scan
        async with visitor(base) as other:
            assert len((await other.get("/api/scenarios/acme_support/scans")).json()["scans"]) == len(before["scans"])


# ---------------------------------------------------------------------- the posture page

async def test_the_posture_page_is_one_call(base):
    async with visitor(base) as http:
        view = (await http.get("/api/scenarios/acme_support/posture")).json()
        overview = (await http.get("/api/scenarios/acme_support/overview")).json()
        assert view["sentence"] == overview["sentence"] and view["counts"] == overview["counts"]
        assert view["facts"]["nodes"] == 12 and view["facts"]["workflows"] == 1 and view["facts"]["flows"] > 0
        assert view["facts"]["last_scan"]["at"] > 1_700_000_000_000
        assert view["exposure"] == {"high_reached": 1, "high_total": 1, "external_reached": 1, "external_total": 1,
                                    "agents_reached": 1, "agents_total": 1}
        assert view["rule_of_two"]["tally"] == {"0": 0, "1": 0, "2": 1, "3": 0} and view["rule_of_two"]["unattended_three"] == 0
        assert view["rule_of_two"]["agents"][0]["agent_id"] == "agent:support-bot" and view["rule_of_two"]["agents"][0]["properties"] == ["A", "C"]
        blast = view["blast"][0]
        assert (blast["id"], blast["high"], blast["agents"], blast["external"]) == ("src:customer-tickets", 1, 1, 1)
        assert "res:payments-api" in blast["ids"] and "src:customer-tickets" not in blast["ids"] and blast["reached"] == len(blast["ids"])
        target = view["targets"][0]
        assert (target["id"], target["reaching"], target["sources"], target["impact"]) == ("res:payments-api", 1, ["src:customer-tickets"], "high")
        assert view["chokes"][0]["id"] == "agent:support-bot" and view["chokes"][0]["routes"] == 1 and view["chokes"][0]["findings"] == 1
        assert all(c["label"] in ("Agent", "Tool") for c in view["chokes"])
        assert view["cut"]["cost"] == 1 and view["cut"]["cuttable"] is True and view["cut"]["hops"][0]["rule"] == 2
        assert view["scans"] and view["scans"][-1]["open"] == 1
        owasp = {o["code"]: o for o in view["owasp"]}
        assert len(owasp) == 10 and owasp["ASI01"]["open"] == 1 and owasp["ASI01"]["checked"] is True
        assert owasp["ASI05"]["checked"] is False and owasp["ASI05"]["open"] == 0
        assert {"reach.from", "reach.into", "choke.betweenness", "scan.history", "choke.maxflow"} <= set(view["queries"])

        clean = (await http.get("/api/scenarios/devries_self/posture")).json()       # untrusted sources, nothing reached that matters
        assert clean["chokes"] == [] and clean["exposure"]["high_reached"] == 0 and all(b["high"] == 0 for b in clean["blast"])
        assert clean["cut"]["hops"] == [] and clean["targets"][0]["reaching"] == 0 and all(o["open"] == 0 for o in clean["owasp"])
        dev = (await http.get("/api/scenarios/acme_dev/posture")).json()
        assert dev["rule_of_two"]["tally"]["3"] >= 3 and len(dev["blast"]) >= 2 and dev["chokes"]
        assert (await http.get("/api/scenarios/nope/posture")).status_code == 404


# ---------------------------------------------------------------------- the activity list

async def test_the_activity_list_tells_the_story_newest_first(base):
    async with visitor(base) as http:
        stream = await Stream.open(http)
        run = (await http.post("/api/agent/runs", json={"scenario": "acme_support"})).json()["run"]
        proposed = await stream.until(lambda e: e["type"] == "mitigation.proposed" and e["data"]["rationale"])
        await stream.until(lambda e: e["type"] == "agent.run" and e["data"]["status"] == "awaiting_approval")
        await http.post(f"/api/scenarios/acme_support/mitigations/{proposed['data']['id']}/approve", json={"approver": "Kartik"})
        await stream.until(lambda e: e["type"] == "agent.run" and e["data"]["status"] in ("done", "failed"))
        await stream.close()

        listed = (await http.get("/api/scenarios/acme_support/activity")).json()
        items = listed["items"]
        assert "scan.history" in listed["queries"] and "draft.for_mitigation" in listed["queries"]
        assert [i["at"] for i in items] == sorted((i["at"] for i in items), reverse=True)
        assert all(set(i) >= {"at", "kind", "sentence", "who", "status", "refs"} for i in items)
        by_kind = {}
        for item in items:
            by_kind.setdefault(item["kind"], []).append(item)
        assert {"scan", "run", "tested", "proposal", "decision", "applied"} <= set(by_kind)
        assert by_kind["scan"][-1]["sentence"] == "Scan found 1 open finding in " + by_kind["scan"][-1]["sentence"].split(" in ")[1]
        assert by_kind["scan"][0]["sentence"].startswith("Scan found 0 open findings") and by_kind["scan"][0]["refs"]["finding_ids"] == []
        audit = by_kind["run"][0]
        assert (audit["who"], audit["status"], audit["refs"]["run_id"]) == ("scripted", "done", run["id"])
        assert audit["sentence"] == "Audit run, scripted: fix applied" and audit["refs"]["mitigation_id"] == proposed["data"]["id"]
        decision = by_kind["decision"][0]
        assert (decision["who"], decision["status"], decision["reason"]) == ("Kartik", "approved", None)
        assert decision["sentence"].startswith("Approved: require human approval before agent:support-bot calls tool:payments.issue_refund")
        assert decision["refs"] == {"mitigation_id": proposed["data"]["id"], "finding_ids": ["fnd:dce0910d42"]}
        applied = by_kind["applied"][0]
        assert applied["who"] is None and applied["sentence"].startswith("Applied: require human approval")
        plan = next(i for i in by_kind["proposal"] if i["sentence"].startswith("Require human approval"))
        assert plan["who"] == "the scripted search" and plan["status"] == "proposed" and plan["sentence"].endswith(": passed, cost 2")
        failed = next(i for i in by_kind["tested"] if "revoke tool:payments.issue_refund" in i["sentence"].lower())
        assert failed["status"] == "failed" and failed["sentence"].startswith("Revoke") and "failed in a sandbox, cost 1" in failed["sentence"]
        assert "written" not in by_kind                                                 # nothing was written to a file

        asked = (await http.post("/api/agent/ask", json={"scenario": "acme_support", "question": "Can a ticket reach the payments API?"})).json()["run"]
        for _ in range(100):
            question = next((i for i in (await http.get("/api/scenarios/acme_support/activity")).json()["items"] if i["refs"].get("run_id") == asked["id"]), None)
            if question and question["status"] == "done":
                break
            await asyncio.sleep(0.05)
        assert question["sentence"] == "A question: Can a ticket reach the payments API?" and question["who"] == "scripted"

        clean = (await http.get("/api/scenarios/devries_self/activity")).json()
        assert all(i["kind"] in ("scan", "run") for i in clean["items"])


# ---------------------------------------------------------------------- the inventory

async def test_the_inventory_lists_every_node_once_with_what_the_graph_says_about_it(base):
    async with visitor(base) as http:
        listed = (await http.get("/api/scenarios/acme_exec/inventory")).json()
        graph = (await http.get("/api/scenarios/acme_exec/graph")).json()
        expected = {n["data"]["id"] for n in graph["nodes"] if n["label"] in ("Agent", "Tool", "DataSource", "Resource")}
        ids = [row["id"] for key in ("agents", "tools", "sources", "resources") for row in listed[key]]
        assert sorted(ids) == sorted(expected) and len(ids) == len(set(ids))
        assert listed["servers"] == (await http.get("/api/scenarios/acme_exec/servers")).json()["servers"]
        assert {"inventory.rows", "reach.untrusted_nodes", "choke.pagerank", "reach.from", "reach.into", "server.summary"} <= set(listed["queries"])
        assistant = next(a for a in listed["agents"] if a["id"] == "agent:exec-assistant")
        assert assistant == {"id": "agent:exec-assistant", "name": "Executive assistant", "owner": "office-of-the-ceo",
                             "properties": ["A", "B", "C"], "count": 3, "autonomous": True, "workflows": 1, "grants": 3, "gated": 0,
                             "delegates_to": 1, "reached": True, "findings": 2, "pagerank_rank": assistant["pagerank_rank"]}
        assert assistant["pagerank_rank"] >= 1
        reader = next(t for t in listed["tools"] if t["id"] == "tool:mail.read_inbox")
        assert (reader["server_id"], reader["held_by"], reader["reads"], reader["acts_on"], reader["reached"], reader["findings"]) == ("srv:mail", 1, 1, 0, True, 2)
        inbox = next(s for s in listed["sources"] if s["id"] == "src:inbound-email")
        assert (inbox["trust"], inbox["read_by"], inbox["reaches_agents"], inbox["findings"]) == ("untrusted", 1, 2, 2)
        out = listed["resources"][0]
        assert (out["id"], out["external"], out["acted_on_by"], out["reached_by_untrusted"], out["reaching_sources"]) == ("res:outbound-email", True, 1, True, 1)
        for key in ("agents", "tools", "sources", "resources"):
            assert [r["id"] for r in listed[key]] == [r["id"] for r in sorted(listed[key], key=lambda r: (-r["findings"], r["id"]))]
        assert (await http.get("/api/session")).json()["copies"] == []                 # reading copied nothing

        support = (await http.get("/api/scenarios/acme_support/inventory")).json()
        refund = next(t for t in support["tools"] if t["id"] == "tool:payments.issue_refund")
        assert (refund["capability"], refund["gated"], refund["findings"]) == ("write", 0, 1)
        assert next(s for s in support["sources"] if s["id"] == "src:payment-records")["findings"] == 0


# ---------------------------------------------------------------------- the cut as one plan

async def test_the_cut_is_proposed_as_one_plan_and_a_failing_verdict_is_the_answer(base):
    async with visitor(base) as http:
        answer = await http.post("/api/scenarios/acme_support/cut/propose")
        assert answer.status_code == 200, answer.text
        body = answer.json()
        assert body["proposed"] is None and body["summary"] == ["revoke tool:helpdesk.get_ticket from agent:support-bot"]
        verdict = body["verdict"]
        assert verdict["passed"] is False and "wf:refund-request" in verdict["reason"] and verdict["resolved"] == ["fnd:dce0910d42"]
        assert verdict["plan"]["fixes"][0]["kind"] == "revoke_call" and verdict["targets"] == ["fnd:dce0910d42"]
        assert {"choke.maxflow", "flow.edges", "wf.broken", "fix.revoke_call"} <= set(body["queries"])
        assert (await http.get("/api/session")).json()["copies"] == ["acme_support"]   # a proposal is made on the visitor's copy
        assert await open_ids(http, "acme_support") == ["fnd:dce0910d42"]                # and nothing was applied
        assert not any(m["source"] == "cut" for m in (await http.get("/api/scenarios/acme_support/mitigations")).json()["mitigations"])

        refused = await http.post("/api/scenarios/devries_self/cut/propose")
        assert refused.status_code == 409 and refused.json()["error"]["code"] == "invalid_fix"
        assert "no open injection finding" in refused.json()["error"]["message"]
        assert (await http.post("/api/scenarios/acme_exec/cut/propose")).status_code == 409    # trifectas are not a cut
        assert (await http.post("/api/scenarios/nope/cut/propose")).status_code == 404


def test_a_written_draft_and_a_rejection_are_activity_items():
    from devries.mitigation.dsl import FixPlan
    from devries.mitigation.store import Mitigation
    from devries.views import activity_of_mitigation

    plan = FixPlan(fixes=[{"kind": "quarantine_delegation", "from_agent_id": "agent:exec-assistant", "to_agent_id": "agent:inbox-reader"}])
    m = Mitigation(id="mit:1", status="rejected", plan=plan, cost=2, targets=["ab" * 20], passed=True, source="agent",
                   approved_by="Kartik", decision_reason="Not yet.", created_at=10, updated_at=20)
    items = activity_of_mitigation(m, [({"id": "drf:1", "written_at": 30, "written_by": "Kartik"}, "scenarios/acme_exec.yaml")])
    assert [(i["kind"], i["at"], i["who"], i["status"]) for i in items] == [
        ("proposal", 10, "the auditor", "proposed"), ("decision", 20, "Kartik", "rejected"), ("written", 30, "Kartik", "written")]
    assert items[0]["sentence"] == "Quarantine what agent:inbox-reader returns to agent:exec-assistant: passed, cost 2"
    assert items[1]["sentence"].startswith("Rejected: quarantine what") and items[1]["reason"] == "Not yet."
    assert items[2] == {"at": 30, "kind": "written", "sentence": "Written to scenarios/acme_exec.yaml, backup kept", "who": "Kartik",
                        "status": "written", "refs": {"mitigation_id": "mit:1", "draft_id": "drf:1", "path": "scenarios/acme_exec.yaml"}}
    assert items[0]["refs"] == {"mitigation_id": "mit:1", "finding_ids": ["fnd:ababababab"]}
