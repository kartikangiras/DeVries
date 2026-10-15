"""Writing a tested plan back to the file it came from, and seeing the finding close on the reload.

The scenario files are copied under a temporary root with a test name, so nothing in scenarios/ is touched.
"""

import json
import secrets
import shutil
import sys
from pathlib import Path

import pytest

from devries.config import get_settings
from devries.errors import ForbiddenWrite
from devries.ingest.importer import import_install
from devries.ingest.scenario_loader import load_scenario
from devries.mitigation import search, store
from devries.mitigation import write as write_mod
from devries.mitigation.sandbox import StaleTarget

ROOT = Path(__file__).resolve().parents[2]
OWN = f"{sys.executable} -m devries.mcp_server"


def _copy_support(tmp_path: Path) -> tuple[str, Path]:
    """acme_support under a test name, with the manifests it needs, in a root of its own."""
    name = f"t_{secrets.token_hex(4)}"
    (tmp_path / "scenarios").mkdir()
    (tmp_path / "manifests").mkdir()
    for manifest in ("helpdesk", "payments"):
        shutil.copy(ROOT / "manifests" / f"{manifest}.tools.json", tmp_path / "manifests")
    text = (ROOT / "scenarios" / "acme_support.yaml").read_text().replace("scenario: acme_support", f"scenario: {name}")
    path = tmp_path / "scenarios" / f"{name}.yaml"
    path.write_text(text)
    return name, path


async def _names(client, key) -> dict[str, str]:
    return {row["id"]: row["name"] or row["id"] for row in await client.run("node.names", key)}


async def test_a_gate_written_to_the_scenario_file_closes_the_finding_on_reload(client, tmp_path):
    name, path = _copy_support(tmp_path)
    key = f"scn:{name}"
    try:
        report = await load_scenario(client, path, root=tmp_path)
        finding = report.scan.findings[0]
        found = await search.search(client, key)
        gate = next(m for m in found.passing if m.plan.fixes[0].kind == "gate_call")
        names = await _names(client, key)

        draft = await write_mod.draft_for(client, key, path, gate.id, names)
        assert draft.kind == "scenario" and draft.writable and "gate: human_approval" in draft.diff

        receipt = await write_mod.write(client, key, key, path, gate.id, names, "Tester", root=tmp_path)
        assert receipt.path == str(path) and Path(receipt.backup).is_file() and receipt.reloaded
        assert receipt.closed == [finding.id] and receipt.open_after == []
        assert "{id: tool:payments.issue_refund, gate: human_approval}" in path.read_text()
        assert "# manual label beats every other source" in path.read_text()          # comments survived the write
        assert "gate: human_approval" not in Path(receipt.backup).read_text()           # the backup is the file as it was

        # the reloaded graph tells the story: the plan applied, the finding mitigated, the draft written
        plan = await store.get(client, key, gate.id)
        assert plan.status == "applied" and plan.approved_by == "Tester"
        rows = {r["id"]: r["status"] for r in await client.run("finding.list", key)}
        assert rows[finding.id] == "mitigated"
        drafts = await client.run("draft.for_mitigation", key, mitigation_id=gate.id)
        assert len(drafts) == 1 and drafts[0]["status"] == "written" and json.loads(drafts[0]["receipt_json"])["written_by"] == "Tester"
        # and a second draft of the same plan has nothing left to change
        again = await write_mod.draft_for(client, key, path, gate.id, names)
        assert not again.writable and "Written to" in again.note
    finally:
        await client.delete(key)


async def test_an_edited_draft_is_what_gets_written_and_a_bad_edit_is_refused(client, tmp_path):
    name, path = _copy_support(tmp_path)
    key = f"scn:{name}"
    try:
        await load_scenario(client, path, root=tmp_path)
        found = await search.search(client, key)
        gate = next(m for m in found.passing if m.plan.fixes[0].kind == "gate_call")
        names = await _names(client, key)
        draft = await write_mod.draft_for(client, key, path, gate.id, names)
        edited = await write_mod.edit(client, key, path, gate.id, names, draft.after.replace("order: 1", "order: 7"))
        assert edited.edited and edited.writable and "+order: 7" in edited.diff
        kept = await write_mod.draft_for(client, key, path, gate.id, names)
        assert kept.edited and "order: 7" in kept.after                                # the edit is kept on the graph
        broken = await write_mod.edit(client, key, path, gate.id, names, "scenario: [not valid")
        assert not broken.writable and "does not load" in broken.note
        with pytest.raises(write_mod.NotWritable):
            await write_mod.write(client, key, key, path, gate.id, names, "Tester", root=tmp_path)
        receipt = await write_mod.write(client, key, key, path, gate.id, names, "Tester", after_text=edited.after, root=tmp_path)
        assert "order: 7" in path.read_text() and receipt.closed
    finally:
        await client.delete(key)


async def test_nothing_is_written_on_a_public_site(client, tmp_path, monkeypatch):
    name, path = _copy_support(tmp_path)
    key = f"scn:{name}"
    try:
        await load_scenario(client, path, root=tmp_path)
        found = await search.search(client, key)
        gate = next(m for m in found.passing if m.plan.fixes[0].kind == "gate_call")
        monkeypatch.setattr(get_settings(), "devries_public", True)
        before = path.read_text()
        with pytest.raises(ForbiddenWrite):
            await write_mod.write(client, key, key, path, gate.id, await _names(client, key), "Tester", root=tmp_path)
        assert path.read_text() == before
    finally:
        await client.delete(key)


NOTES = ROOT / "tests" / "fixtures" / "notes_server.py"


async def _propose(client, key, fix) -> str:
    """A plan with one fix, verified in a sandbox and stored as proposed: what the search or the model would leave."""
    from devries.mitigation import sandbox
    from devries.mitigation.dsl import FixPlan

    targets = sorted((await sandbox.measure(client, key)).findings)
    verdict = await sandbox.verify(client, key, FixPlan(fixes=[fix]), targets)
    assert verdict.passed, verdict.reason
    stored = await store.record(client, key, verdict, config_hash=await sandbox.config_hash(client, key), source="test")
    return stored.id


async def test_a_claude_code_project_gets_an_ask_rule_and_the_finding_closes_on_the_reimport(client, tmp_path):
    """A project with .mcp.json and an empty .claude/settings.json: the gate becomes an ask rule, the re-import reads
    the rule as a gate on the grant, and the finding is gone."""
    from devries.mitigation.dsl import GateCall

    project = tmp_path / "project"
    (project / ".claude").mkdir(parents=True)
    (project / ".mcp.json").write_text(json.dumps({"mcpServers": {"notes": {"command": sys.executable, "args": [str(NOTES)]}}}))
    (project / ".claude" / "settings.json").write_text("{}\n")
    name = f"t_{secrets.token_hex(4)}"
    key = f"scn:{name}"
    try:
        result = await import_install(str(project / ".mcp.json"), tmp_path, name=name, labels={"src:notes": "untrusted", "res:notes": "high"})
        assert result.origin and result.origin.kind == "claude-code" and result.origin.settings_path == str(project / ".claude" / "settings.json")
        assert result.tools == 2
        report = await load_scenario(client, result.scenario_path, root=tmp_path)
        open_ids = [f.id for f in report.scan.findings if f.status == "open"]
        assert open_ids, "an import labelled untrusted and high has a finding to fix"
        agent = report.scan.findings[0].path_ids[2]

        mid = await _propose(client, key, GateCall(kind="gate_call", agent_id=agent, tool_id="tool:notes.send_note"))
        names = await _names(client, key)
        draft = await write_mod.draft_for(client, key, result.scenario_path, mid, names)
        assert draft.kind == "claude-code" and draft.path == str(project / ".claude" / "settings.json") and draft.writable
        assert json.loads(draft.after)["permissions"]["ask"] == ["mcp__notes__send_note"]

        receipt = await write_mod.write(client, key, key, result.scenario_path, mid, names, "Tester", root=tmp_path)
        assert json.loads((project / ".claude" / "settings.json").read_text())["permissions"]["ask"] == ["mcp__notes__send_note"]
        assert receipt.reloaded and receipt.closed == open_ids and receipt.open_after == []
        # the re-import read the rule back as a gate in the scenario file, and the graph shows the finding mitigated
        assert "{id: tool:notes.send_note, gate: human_approval}" in result.scenario_path.read_text()
        rows = {r["id"]: r["status"] for r in await client.run("finding.list", key)}
        assert rows[open_ids[0]] == "mitigated"
        assert (await store.get(client, key, mid)).status == "applied"
    finally:
        await client.delete(key)


async def test_a_desktop_config_that_moved_on_since_the_import_is_not_written(client, tmp_path):
    from devries.mitigation.dsl import RevokeCall

    config = tmp_path / "claude_desktop_config.json"
    config.write_text(json.dumps({"mcpServers": {
        "notes": {"command": sys.executable, "args": [str(NOTES)], "env": {"TOKEN": "hunter2"}},
        "notes-two": {"command": sys.executable, "args": [str(NOTES)]},
    }}, indent=2))
    name = f"t_{secrets.token_hex(4)}"
    key = f"scn:{name}"
    try:
        result = await import_install(str(config), tmp_path, name=name, labels={"src:notes": "untrusted", "res:notes": "high"})
        assert result.origin and result.origin.kind == "claude-desktop" and result.origin.hash and result.tools == 4
        report = await load_scenario(client, result.scenario_path, root=tmp_path)
        agent = report.scan.findings[0].path_ids[2]
        mid = await _propose(client, key, RevokeCall(kind="revoke_call", agent_id=agent, tool_id="tool:notes.send_note"))
        names = await _names(client, key)
        draft = await write_mod.draft_for(client, key, result.scenario_path, mid, names)
        assert draft.kind == "claude-desktop" and draft.writable
        assert "notes" not in json.loads(draft.after)["mcpServers"] and "notes-two" in json.loads(draft.after)["mcpServers"]
        assert "hunter2" not in draft.diff                                                 # the secret stays out of the diff
        config.write_text(config.read_text() + "\n")                                      # someone edited it meanwhile
        with pytest.raises(StaleTarget):
            await write_mod.write(client, key, key, result.scenario_path, mid, names, "Tester", root=tmp_path)
        assert "hunter2" in config.read_text()                                             # untouched
    finally:
        await client.delete(key)
