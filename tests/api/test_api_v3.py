"""Revision 2 of the API: the overview, the taxonomy, the brief and figure, the cut as policy, drafts and the write,
imports from the browser (private on a public site), audits that start by themselves, and the pass at start."""

import asyncio
import json
import secrets
import shutil
import socket
from pathlib import Path

import httpx2 as httpx
import pytest
import pytest_asyncio
import uvicorn

from cistern.agent.llm import spend
from cistern.app import create_app
from cistern.config import get_settings
from cistern.ingest.scenario_loader import load_scenario
from test_api import Stream, base, open_ids, visitor  # noqa: F401  (the fixture and helpers of the first API file)

ROOT = Path(__file__).resolve().parents[2]


# ---------------------------------------------------------------------- reading

async def test_the_overview_is_one_sentence_and_three_columns(base):
    async with visitor(base) as http:
        view = (await http.get("/api/scenarios/acme_support/overview")).json()
        assert view["sentence"] == "One untrusted source reaches one high-impact resource through one agent, in 4 hops."
        assert [s["id"] for s in view["columns"]["sources"]] == ["src:customer-tickets"]
        assert [a["id"] for a in view["columns"]["agents"]] == ["agent:support-bot"] and view["columns"]["agents"][0]["properties"] == ["A", "C"]
        assert [a["id"] for a in view["columns"]["actions"]] == ["res:payments-api"]
        ribbon = view["ribbons"][0]
        assert (ribbon["id"], ribbon["kind"], ribbon["hops"], ribbon["agent_ids"]) == ("fnd:dce0910d42", "injection", 4, ["agent:support-bot"])
        assert view["counts"]["untrusted_sources"] == 1 and view["counts"]["open_findings"] == 1 and view["counts"]["cut_cost"] == 1
        assert "src:payment-records" in view["folded"]["sources"] and "overview.counts" in view["queries"]
        clean = (await http.get("/api/scenarios/cistern_self/overview")).json()
        assert clean["ribbons"] == [] and "Nothing untrusted reaches" in clean["sentence"]
        dev = (await http.get("/api/scenarios/acme_dev/overview")).json()
        assert "agents hold untrusted input, private data and a way out" in dev["sentence"] and len(dev["ribbons"]) == 7


async def test_findings_carry_their_owasp_class_and_export_as_a_brief_and_a_figure(base):
    async with visitor(base) as http:
        one = (await http.get("/api/scenarios/acme_support/findings/fnd:dce0910d42")).json()["finding"]
        assert [t["code"] for t in one["taxonomy"]] == ["ASI01", "ASI02"]
        brief = await http.get("/api/scenarios/acme_support/findings/fnd:dce0910d42/brief.md")
        assert brief.status_code == 200 and brief.headers["content-type"].startswith("text/markdown")
        text = brief.text
        assert text.startswith("# Customer tickets can reach Payments API.") and "## The path" in text
        assert "1. rule 1: get_ticket reads Customer tickets" in text and "ASI01 Agent goal hijack" in text
        assert "no model wrote this brief" in text
        figure = await http.get("/api/scenarios/acme_support/findings/fnd:dce0910d42/figure.svg")
        assert figure.status_code == 200 and figure.headers["content-type"].startswith("image/svg+xml")
        assert figure.text.startswith("<svg") and "Payments API" in figure.text and figure.text.count("<circle") == 5
        assert (await http.get("/api/scenarios/acme_support/findings/fnd:nope/brief.md")).status_code == 404


async def test_the_cut_is_offered_as_rules(base):
    async with visitor(base) as http:
        policy = (await http.get("/api/scenarios/acme_support/cut/policy")).json()
        assert policy["cost"] == 1 and policy["claude_code"] == {"permissions": {"deny": ["mcp__helpdesk__get_ticket"]}}
        assert policy["docker_mcp_gateway"] == ["docker mcp profile tools default --disable helpdesk.get_ticket"]
        assert '"deny"' in policy["claude_code_text"]


# ---------------------------------------------------------------------- drafts

async def test_a_plan_is_drafted_as_the_change_to_the_scenario_file_and_a_visitor_can_edit_it(base):
    async with visitor(base) as http:
        found = (await http.post("/api/scenarios/acme_support/mitigations/search")).json()
        gate = next(m for m in found["passing"] if m["plan"]["fixes"][0]["kind"] == "gate_call")
        drafted = (await http.get(f"/api/scenarios/acme_support/mitigations/{gate['id']}/draft")).json()
        d = drafted["draft"]
        assert d["kind"] == "scenario" and d["path"].endswith("scenarios/acme_support.yaml") and d["writable"] and drafted["can_write"]
        assert "+      - {id: tool:payments.issue_refund, gate: human_approval}" in d["diff"] and not d["edited"]
        edited = (await http.put(f"/api/scenarios/acme_support/mitigations/{gate['id']}/draft", json={"after": d["after"].replace("order: 1", "order: 9")})).json()
        assert edited["draft"]["edited"] and "+order: 9" in edited["draft"]["diff"]
        again = (await http.get(f"/api/scenarios/acme_support/mitigations/{gate['id']}/draft")).json()["draft"]
        assert again["edited"] and "order: 9" in again["after"]
        bad = (await http.put(f"/api/scenarios/acme_support/mitigations/{gate['id']}/draft", json={"after": "scenario: ["})).json()
        assert bad["draft"]["writable"] is False and "does not load" in bad["draft"]["note"]
        assert (await http.get("/api/scenarios/acme_support/mitigations/mit:0000000000/draft")).status_code == 404
        # the bundled file is not written by a test: the public switch refuses the write before anything is touched
        get_settings().cistern_public = True
        try:
            refused = await http.post(f"/api/scenarios/acme_support/mitigations/{gate['id']}/draft/write", json={"approver": "Tester"})
            assert refused.status_code == 403 and refused.json()["error"]["code"] == "forbidden_write"
        finally:
            get_settings().cistern_public = False


async def test_a_write_from_the_browser_changes_the_file_reloads_the_shared_graph_and_drops_the_copy(base, client, tmp_path, monkeypatch):
    """The scenario is a copy of acme_support under a test name, in a scenarios directory of its own."""
    name = f"t_{secrets.token_hex(4)}"
    (tmp_path / "scenarios").mkdir()
    (tmp_path / "manifests").mkdir()
    for manifest in ("helpdesk", "payments"):
        shutil.copy(ROOT / "manifests" / f"{manifest}.tools.json", tmp_path / "manifests")
    path = tmp_path / "scenarios" / f"{name}.yaml"
    path.write_text((ROOT / "scenarios" / "acme_support.yaml").read_text().replace("scenario: acme_support", f"scenario: {name}"))
    monkeypatch.setattr(get_settings(), "scenarios_dir", tmp_path / "scenarios")
    try:
        await load_scenario(client, path, root=tmp_path)
        async with visitor(base) as http:
            stream = await Stream.open(http)
            found = (await http.post(f"/api/scenarios/{name}/mitigations/search")).json()
            gate = next(m for m in found["passing"] if m["plan"]["fixes"][0]["kind"] == "gate_call")
            assert (await http.get("/api/session")).json()["copies"] == [name]
            written = await http.post(f"/api/scenarios/{name}/mitigations/{gate['id']}/draft/write", json={"approver": "Kartik"})
            assert written.status_code == 200, written.text
            receipt = written.json()["receipt"]
            assert receipt["written_by"] == "Kartik" and receipt["closed"] == ["fnd:dce0910d42"] and receipt["open_after"] == []
            assert "gate: human_approval" in path.read_text() and Path(receipt["backup"]).is_file()
            # the visitor reads the shared graph again, and it shows the finding mitigated by the plan
            assert (await http.get("/api/session")).json()["copies"] == []
            after = (await http.get(f"/api/scenarios/{name}/findings")).json()
            assert after["findings"] == [] and [f["status"] for f in after["past"]] == ["mitigated"] and after["own_copy"] is False
            plans = (await http.get(f"/api/scenarios/{name}/mitigations")).json()["mitigations"]
            assert [m["status"] for m in plans if m["id"] == gate["id"]] == ["applied"]
            await stream.until(lambda e: e["type"] == "draft.written")
            await stream.close()
    finally:
        await client.delete(f"scn:{name}")


# ---------------------------------------------------------------------- imports from the browser, and audits that start by themselves

TOOLS_LIST = {"server": "pastebox", "tools": [
    {"name": "read_note", "description": "Read a note", "annotations": {"readOnlyHint": True}},
    {"name": "send_note", "description": "Send a note somewhere", "annotations": {"destructiveHint": True}},
]}


async def test_a_pasted_tools_list_becomes_a_scenario_and_labelling_starts_an_audit(base, client):
    name = f"t_{secrets.token_hex(4)}"
    root = get_settings().scenarios_dir.parent
    try:
        async with visitor(base) as http:
            stream = await Stream.open(http)
            made = await http.post("/api/import", json={"config": TOOLS_LIST, "name": name})
            assert made.status_code == 200, made.text
            body = made.json()
            assert body["scenario"] == name and body["private"] is False and body["tools"] == 2 and body["run"] is None   # unlabelled: nothing to audit
            assert body["servers"][0]["id"] == "srv:pastebox" and body["origin"]["kind"] == "tools-list"
            listed = {s["id"]: s for s in (await http.get("/api/scenarios")).json()["scenarios"]}
            assert listed[name]["imported"] is True and listed[name]["private"] is False
            labelled = await http.post(f"/api/scenarios/{name}/labels", json={
                "data_sources": {"src:pastebox": "untrusted"}, "resources": {"res:pastebox": {"impact": "high", "external": True}}})
            assert labelled.status_code == 200 and labelled.json()["run"]["kind"] == "audit"
            done = await stream.until(lambda e: e["type"] == "agent.run" and e["data"]["status"] in ("done", "failed"), timeout=60)
            assert (done["data"]["outcome"], done["data"]["mode"]) == ("proposed", "scripted")
            plans = (await http.get(f"/api/scenarios/{name}/mitigations")).json()["mitigations"]
            assert any(m["status"] == "proposed" and m["passed"] for m in plans)       # a plan waits, nobody was asked
            assert await open_ids(http, name)                                            # and nothing was applied
            await stream.close()
            assert (await http.post("/api/import", json={})).status_code == 422
    finally:
        (root / "scenarios" / f"{name}.yaml").unlink(missing_ok=True)
        (root / "manifests" / "pastebox.tools.json").unlink(missing_ok=True)
        await client.delete(f"scn:{name}")


async def test_on_a_public_site_an_import_is_pasted_only_private_and_rationed(base, client, tmp_path, monkeypatch):
    monkeypatch.setattr(get_settings(), "cistern_public", True)
    monkeypatch.setattr(get_settings(), "import_dir", tmp_path / "imports")
    monkeypatch.setattr(get_settings(), "rate_imports_per_hour", 1)
    async with visitor(base) as http, visitor(base) as other:
        refused = await http.post("/api/import", json={"source": "claude-desktop"})
        assert refused.status_code == 422 and "launches nothing" in refused.json()["error"]["message"]
        command_only = await http.post("/api/import", json={"config": {"mcpServers": {"x": {"command": "npx", "args": ["-y", "x"]}}}})
        assert command_only.status_code == 422 and "public site" in command_only.json()["error"]["message"]
        made_resp = await http.post("/api/import", json={"config": TOOLS_LIST, "name": "mine", "labels": {"src:pastebox": "untrusted", "res:pastebox": "high"}})
        assert made_resp.status_code == 200, made_resp.text
        made = made_resp.json()
        assert made["private"] is True and made["run"] is not None and made["findings"]
        session = http.cookies["cistern_session"]
        assert f"ses:{session}:mine" in await client.list_graphs() and "scn:mine" not in await client.list_graphs()
        listed = {s["id"]: s for s in (await http.get("/api/scenarios")).json()["scenarios"]}
        assert listed["mine"]["private"] is True and listed["mine"]["own_copy"] is True
        assert "mine" not in {s["id"] for s in (await other.get("/api/scenarios")).json()["scenarios"]}   # nobody else sees it
        assert (tmp_path / "imports").is_dir() and not (ROOT / "scenarios" / "mine.yaml").exists()
        third = await http.post("/api/import", json={"config": TOOLS_LIST, "name": "again"})
        assert third.status_code == 429 and third.json()["error"]["code"] == "rate_limited"
        # a public visitor may read the draft of a plan, and never write it
        await asyncio.sleep(0.5)
        plans = (await http.get("/api/scenarios/mine/mitigations")).json()["mitigations"]
        if plans:
            drafted = (await http.get(f"/api/scenarios/mine/mitigations/{plans[0]['id']}/draft")).json()
            assert drafted["can_write"] is False
        assert (await http.post("/api/session/reset")).json()["reset"] == ["mine"]


async def test_the_app_audits_each_shared_scenario_to_a_proposal_at_start(client, monkeypatch):
    """Its own app: pre-run audits on, no model. Afterwards the scenario files are loaded again, which drops the plans."""
    monkeypatch.setattr(get_settings(), "anthropic_api_key", None)
    monkeypatch.setattr(get_settings(), "prerun_audits", True)
    monkeypatch.setattr(spend, "_usd", 0.0)
    for name in ("acme_support", "acme_exec"):
        await load_scenario(client, ROOT / "scenarios" / f"{name}.yaml", strict=True)
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(create_app(), host="127.0.0.1", port=port, log_level="warning"))
    task = asyncio.create_task(server.serve())
    try:
        for _ in range(200):
            if server.started:
                break
            await asyncio.sleep(0.05)
        async with httpx.AsyncClient(base_url=f"http://127.0.0.1:{port}", timeout=30) as http:
            for _ in range(300):                                                       # the pass runs in the background
                runs = (await http.get("/api/scenarios/acme_support/runs")).json()["runs"]
                if runs and runs[0]["status"] == "done":
                    break
                await asyncio.sleep(0.1)
            assert runs and runs[0]["outcome"] == "proposed" and runs[0]["mode"] == "scripted"
            plans = (await http.get("/api/scenarios/acme_support/mitigations")).json()["mitigations"]
            waiting = [m for m in plans if m["status"] == "proposed" and m["passed"]]
            assert waiting and any(m["plan"]["fixes"][0]["kind"] == "gate_call" for m in waiting)
            assert await open_ids(http, "acme_support") == ["fnd:dce0910d42"]            # proposed, not applied
            assert (await http.get("/api/session")).json()["copies"] == []
            health = (await http.get("/api/health")).json()
            assert health["ok"] and "runs" in health and health["public"] is False
    finally:
        server.should_exit = True
        await task
        for name in ("acme_support", "acme_exec", "acme_dev", "cistern_self"):
            await load_scenario(client, ROOT / "scenarios" / f"{name}.yaml")
        for key in await client.list_graphs():
            if key.startswith("ses:"):
                await client.delete(key)
