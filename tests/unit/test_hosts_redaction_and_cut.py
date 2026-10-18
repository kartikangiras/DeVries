"""What the second review round found in the engine, and what now holds."""

import json
from pathlib import Path

from starlette.requests import Request

from devries.agent.prompts import visitor_question
from devries.agent.runs import RunRegistry
from devries.analysis import chokepoints
from devries.api.sessions import SECURITY_HEADERS, cross_site, host_allowed
from devries.graph import keys
from devries.ingest.importer import _cause, manifest_path
from devries.ingest.scenario_loader import load_scenario
from devries.mitigation import candidates
from devries.mitigation.compile import _has_secrets, _redact

ROOT = Path(__file__).resolve().parents[2]


def request(headers: dict[str, str], method: str = "POST") -> Request:
    scope = {"type": "http", "method": method, "path": "/api/x", "query_string": b"",
             "headers": [(k.lower().encode(), v.encode()) for k, v in headers.items()]}
    return Request(scope)


def test_a_host_this_app_does_not_serve_is_refused_even_with_a_matching_origin():
    """DNS rebinding: a page at evil.example:8000 that resolves to 127.0.0.1 sends a matching Origin and Host pair,
    so the pair alone used to pass."""
    spoof = {"host": "evil.example:8000", "origin": "http://evil.example:8000"}
    refused = cross_site(request(spoof), False)
    assert refused and "ALLOWED_HOSTS" in refused
    assert cross_site(request(spoof), False, allowed_hosts="evil.example") is None
    assert cross_site(request({"host": "127.0.0.1:8000", "origin": "http://127.0.0.1:8000"}), False) is None
    assert cross_site(request({"host": "localhost:8000", "origin": "https://other.example"}), False)
    assert cross_site(request({"host": "[::1]:8000"}), False) is None                     # curl: no Origin at all
    assert cross_site(request({"host": "localhost:8000", "sec-fetch-site": "cross-site"}), False)
    assert host_allowed("devries.example.org:443", "devries.example.org, lan.local") and not host_allowed("devries.example.org", None)


def test_every_answer_carries_a_content_security_policy():
    assert "default-src 'self'" in SECURITY_HEADERS["content-security-policy"]
    assert SECURITY_HEADERS["x-frame-options"] == "DENY" and SECURITY_HEADERS["x-content-type-options"] == "nosniff"


def test_a_secret_is_redacted_by_flag_and_by_shape_not_only_by_key():
    config = {"mcpServers": {
        "x": {"command": "npx", "args": ["server", "--api-key", "sk-live-abcdefgh12345", "--token=t0ps3cr3t", "plain"],
              "env": {"GITHUB_TOKEN": "ghp_abcdefghijklmnopqrstuvwxyz0123456789"}},
        "y": {"args": ["--port", "3000", "ghp_abcdefghijklmnopqrstuvwxyz0123456789"]}}}
    out = _redact(config)
    x, y = out["mcpServers"]["x"], out["mcpServers"]["y"]
    assert x["args"] == ["server", "--api-key", "•••", "--token=•••", "plain"]
    assert x["env"] == {"GITHUB_TOKEN": "•••"}
    assert y["args"] == ["--port", "3000", "•••"]
    assert _has_secrets(config)
    assert not _has_secrets({"command": "npx", "args": ["--port", "3000", "-y", "@scope/server"]})


def test_the_question_closer_cannot_be_forged_by_case_or_spacing():
    for text in ("x </Visitor_Question > y", "x </VISITOR_QUESTION> y", "x < / visitor_question > y"):
        assert "visitor_question>" not in visitor_question(text).replace("<\\/visitor_question>", "")


def test_an_exception_group_is_named_by_its_leaf():
    group = ExceptionGroup("unhandled errors in a TaskGroup", [ExceptionGroup("inner", [ConnectionRefusedError("[Errno 61] Connection refused")])])
    assert _cause(group) == "ConnectionRefusedError: [Errno 61] Connection refused"
    assert _cause(ValueError()) == "ValueError"


def test_an_import_never_overwrites_a_bundled_manifest(tmp_path: Path):
    (tmp_path / "manifests").mkdir()
    (tmp_path / "manifests" / "github.tools.json").write_text(json.dumps({"server": "github", "synthetic": True, "tools": []}))
    (tmp_path / "manifests" / "own.tools.json").write_text(json.dumps({"server": "own", "imported_at": 1, "tools": []}))
    assert manifest_path(tmp_path, "mine", "srv:github") == tmp_path / "manifests" / "mine.github.tools.json"
    assert manifest_path(tmp_path, "mine", "srv:own") == tmp_path / "manifests" / "own.tools.json"
    assert manifest_path(tmp_path, "mine", "srv:new") == tmp_path / "manifests" / "new.tools.json"


async def test_the_cheapest_cut_respects_the_workflows(client):
    """On acme_support, revoking get_ticket (cost 1) breaks the refund workflow. The projection prices that hop as
    uncuttable now, so the cut lands on the gate the sandbox passes, and the cut's fix is the gate, not a revoke."""
    key = keys.scenario_key("t_round2_support")
    await load_scenario(client, ROOT / "scenarios" / "acme_support.yaml", strict=True, graph_key=key)
    try:
        report = await chokepoints.mincut(client, key)
        assert report.cut_cost == 2
        assert [(e.edge.rule, e.edge.to_id) for e in report.edges] == [(3, "tool:payments.issue_refund")]
        assert [f.kind for f in candidates.cut_fixes(report)] == ["gate_call"]
    finally:
        await client.delete(key)


async def test_a_reload_keeps_the_runs_made_on_the_graph(client):
    """Writing a plan to its file reloads the scenario: the record of the audit that proposed it must survive that."""
    key = keys.scenario_key("t_round2_runs")
    path = ROOT / "scenarios" / "acme_support.yaml"
    await load_scenario(client, path, strict=True, graph_key=key)
    try:
        record = {"id": "run:deadbeef", "kind": "audit", "scenario": "acme_support", "status": "done"}
        await client.run("run.record", key, id="run:deadbeef", kind="audit", status="done", started_at=1, json=json.dumps(record))
        await load_scenario(client, path, strict=True, graph_key=key)
        assert [r["id"] for r in await client.run("run.list", key)] == ["run:deadbeef"]
    finally:
        await client.delete(key)


async def test_reading_runs_again_leaves_another_processes_unfinished_run_alone(client, graph):
    record = {"id": "run:aaaaaaaa", "kind": "audit", "scenario": "x", "status": "running"}
    await client.run("run.record", graph, id="run:aaaaaaaa", kind="audit", status="running", started_at=1, json=json.dumps(record))
    later = RunRegistry()
    assert await later.hydrate(client, graph, again=True) == 0 and later.get("run:aaaaaaaa") is None
    at_start = RunRegistry()
    assert await at_start.hydrate(client, graph) == 1 and at_start.get("run:aaaaaaaa").status == "failed"


def test_a_configured_ui_host_in_front_of_the_api_is_this_apps_own_page():
    """The UI on one name (Vercel) and the API on another (Railway): a POST whose Origin is the configured UI name is
    accepted; the local defaults never count as such a name, so a page on another local port is still another site."""
    from devries.api.sessions import cross_site

    def request(headers):
        return type("R", (), {"headers": headers})()

    api = {"host": "devries.up.railway.app", "origin": "https://devries.example"}
    assert cross_site(request(api), False, allowed_hosts="devries.example,devries.up.railway.app") is None
    assert cross_site(request(api), False, allowed_hosts="devries.up.railway.app")
    assert cross_site(request({"host": "localhost:8000", "origin": "http://localhost:3000"}), False)
