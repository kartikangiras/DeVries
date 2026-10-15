"""A plan as the change to the configuration it came from, target by target. No database needed."""

import json
from pathlib import Path

import yaml

from cistern.ingest.importer import grants_from_rules, read_permissions, rule_matches
from cistern.mitigation.compile import Origin, compile_draft, policy_from_cut, split_tool
from cistern.mitigation.dsl import DropRead, GateCall, QuarantineDelegation, RevokeCall, SplitAgent

ROOT = Path(__file__).resolve().parents[2]
GATE = GateCall(kind="gate_call", agent_id="agent:support-bot", tool_id="tool:payments.issue_refund")
REVOKE = RevokeCall(kind="revoke_call", agent_id="agent:support-bot", tool_id="tool:helpdesk.get_ticket")
NAMES = {"tool:payments.issue_refund": "issue_refund", "tool:helpdesk.get_ticket": "get_ticket", "tool:helpdesk.reply": "reply", "agent:support-bot": "Support bot"}


# ---------------------------------------------------------------------- Claude Code rules, read and written

def test_claude_code_rules_cover_one_tool_a_server_or_a_glob_and_deny_outranks_ask():
    assert rule_matches("mcp__github__push_files", "github", "push_files")
    assert rule_matches("mcp__github", "github", "anything") and rule_matches("mcp__github__*", "github", "anything")
    assert rule_matches("mcp__github__get_*", "github", "get_user") and not rule_matches("mcp__github__get_*", "github", "push_files")
    assert rule_matches("mcp__*", "x", "y") and rule_matches("*", "x", "y")
    assert not rule_matches("mcp__github__push_files(x)", "github", "push_files")      # a parameter pattern is skipped for MCP tools
    rules = {"ask": ["mcp__github__push_files", "mcp__fetch"], "deny": ["mcp__github__push_files"]}
    assert grants_from_rules(rules, "github", "push_files") == "deny"
    assert grants_from_rules(rules, "fetch", "fetch") == "ask" and grants_from_rules(rules, "github", "get_issue") is None


def test_permissions_are_read_from_every_settings_file_that_exists(tmp_path):
    (tmp_path / "a.json").write_text(json.dumps({"permissions": {"ask": ["mcp__a__x"], "allow": ["Bash"]}}))
    (tmp_path / "b.json").write_text(json.dumps({"permissions": {"deny": ["mcp__b"]}}))
    (tmp_path / "bad.json").write_text("{not json")
    rules = read_permissions([tmp_path / "a.json", tmp_path / "b.json", tmp_path / "bad.json", tmp_path / "missing.json"])
    assert rules == {"ask": ["mcp__a__x"], "deny": ["mcp__b"]}


def test_a_gate_is_an_ask_rule_and_a_revoke_a_deny_rule_in_claude_code(tmp_path):
    settings = tmp_path / ".claude" / "settings.json"
    settings.parent.mkdir()
    settings.write_text(json.dumps({"permissions": {"allow": ["Bash(git status)"], "deny": ["mcp__helpdesk__get_ticket"]}}, indent=2) + "\n")
    origin = Origin(kind="claude-code", path=str(tmp_path / ".mcp.json"), settings_path=str(settings),
                    servers={"srv:payments": "payments", "srv:helpdesk": "helpdesk"})
    draft = compile_draft(origin, None, "mit:1", [GATE, REVOKE], NAMES)
    after = json.loads(draft.after)
    assert after["permissions"]["ask"] == ["mcp__payments__issue_refund"]
    assert after["permissions"]["deny"] == ["mcp__helpdesk__get_ticket"]            # already there: not added twice
    assert after["permissions"]["allow"] == ["Bash(git status)"]                     # untouched
    assert draft.kind == "claude-code" and draft.path == str(settings) and draft.writable and draft.changes if hasattr(draft, "changes") else True
    assert '+      "mcp__payments__issue_refund"' in draft.diff and "ask rules outrank allow rules" in draft.note
    # no settings file yet: it is created
    fresh = Origin(kind="claude-code", settings_path=str(tmp_path / "none" / "settings.json"), servers=origin.servers)
    made = compile_draft(fresh, None, "mit:2", [GATE], NAMES)
    assert json.loads(made.after) == {"permissions": {"ask": ["mcp__payments__issue_refund"]}} and "does not exist yet" in made.note
    # a split asks before each reading tool, and says the split itself is the person's to build
    split = SplitAgent(kind="split_agent", agent_id="agent:support-bot", reader_tool_ids=["tool:helpdesk.get_ticket"])
    drafted = compile_draft(origin, None, "mit:3", [split], NAMES)
    assert "mcp__helpdesk__get_ticket" in json.loads(drafted.after)["permissions"]["ask"] and "design change" in drafted.note


# ---------------------------------------------------------------------- the clients that list servers whole

def test_a_desktop_config_can_only_lose_a_server_and_its_secrets_never_reach_the_diff(tmp_path):
    config = tmp_path / "claude_desktop_config.json"
    config.write_text(json.dumps({"mcpServers": {
        "helpdesk": {"command": "npx", "args": ["-y", "helpdesk"], "env": {"TOKEN": "hunter2"}},
        "payments": {"command": "npx", "args": ["-y", "payments"]},
    }}, indent=2))
    origin = Origin(kind="claude-desktop", path=str(config), servers={"srv:helpdesk": "helpdesk", "srv:payments": "payments"})
    tools_of = {"srv:helpdesk": ["tool:helpdesk.get_ticket", "tool:helpdesk.reply"]}
    draft = compile_draft(origin, None, "mit:1", [REVOKE], NAMES, tools_of)
    after = json.loads(draft.after)
    assert "helpdesk" not in after["mcpServers"] and "payments" in after["mcpServers"]
    assert draft.writable and "hunter2" not in draft.diff and "•••" in draft.diff
    assert "with it 1 other tool(s): reply" in draft.note
    # a gate is the client's own prompt: nothing to write, a note on what to keep
    gated = compile_draft(origin, None, "mit:2", [GATE], NAMES, tools_of)
    assert gated.after == gated.before and not gated.writable and "Allow always" in gated.note
    cursor = compile_draft(Origin(kind="cursor", path=str(config), servers=origin.servers), None, "mit:3", [GATE], NAMES, tools_of)
    assert "allowlist" in cursor.note and cursor.kind == "cursor"


def test_the_gateway_gets_commands_and_a_gate_becomes_a_disable_with_a_note():
    origin = Origin(kind="docker-mcp-gateway", profile="work", servers={"srv:payments": "payments"})
    draft = compile_draft(origin, None, "mit:1", [GATE], NAMES)
    assert draft.commands == ["docker mcp profile tools work --disable payments.issue_refund"]
    assert not draft.writable and draft.path is None and "no approval step" in draft.note


# ---------------------------------------------------------------------- the scenario file, changed in place

def _scenario_draft(fixes, name="acme_support"):
    path = ROOT / "scenarios" / f"{name}.yaml"
    return path, compile_draft(None, path, "mit:x", fixes, NAMES)


def test_a_gate_is_one_line_of_the_scenario_file_and_the_comments_stay():
    path, draft = _scenario_draft([GATE])
    assert draft.kind == "scenario" and draft.path == str(path) and draft.writable
    assert "- {id: tool:payments.issue_refund, gate: human_approval}" in draft.after
    assert "# manual label beats every other source" in draft.after                  # a comment elsewhere survives
    assert draft.after.count("tool:payments.issue_refund") == draft.before.count("tool:payments.issue_refund")
    spec = yaml.safe_load(draft.after)
    grants = {g["id"] if isinstance(g, dict) else g: g for g in spec["agents"][0]["can_call"]}
    assert grants["tool:payments.issue_refund"] == {"id": "tool:payments.issue_refund", "gate": "human_approval"}
    assert "+      - {id: tool:payments.issue_refund, gate: human_approval}" in draft.diff


def test_a_revoke_removes_the_line_and_a_dropped_read_shortens_the_list():
    _, revoked = _scenario_draft([REVOKE])
    assert "      - tool:helpdesk.get_ticket\n" not in revoked.after and revoked.writable
    assert "tool:helpdesk.get_ticket" in revoked.after                              # the tool's own entry stays
    drop = DropRead(kind="drop_read", tool_id="tool:helpdesk.get_ticket", source_id="src:customer-tickets")
    _, dropped = _scenario_draft([drop])
    spec = yaml.safe_load(dropped.after)
    tool = next(t for t in spec["tools"] if t["id"] == "tool:helpdesk.get_ticket")
    assert tool["reads"] == [] and dropped.writable


def test_a_quarantine_and_a_split_change_the_delegation_and_the_agents():
    exec_path = ROOT / "scenarios" / "acme_exec.yaml"
    spec = yaml.safe_load(exec_path.read_text())
    boss = next(a for a in spec["agents"] if a.get("delegates_to"))
    delegate = boss["delegates_to"][0]
    delegate_id = delegate["id"] if isinstance(delegate, dict) else delegate
    q = QuarantineDelegation(kind="quarantine_delegation", from_agent_id=boss["id"], to_agent_id=delegate_id)
    draft = compile_draft(None, exec_path, "mit:q", [q], {})
    after = yaml.safe_load(draft.after)
    boss_after = next(a for a in after["agents"] if a["id"] == boss["id"])
    assert any(isinstance(d, dict) and d["id"] == delegate_id and d["gate"] == "quarantine" for d in boss_after["delegates_to"])
    assert draft.writable
    split = SplitAgent(kind="split_agent", agent_id="agent:support-bot", reader_tool_ids=["tool:helpdesk.get_ticket"])
    _, drafted = _scenario_draft([split])
    after = yaml.safe_load(drafted.after)
    ids = {a["id"] for a in after["agents"]}
    assert "agent:support-bot.reader" in ids and "YAML library" in drafted.note and drafted.writable


def test_a_change_the_file_cannot_take_is_said_not_hidden():
    bad = RevokeCall(kind="revoke_call", agent_id="agent:nobody", tool_id="tool:payments.issue_refund")
    _, draft = _scenario_draft([bad])
    assert draft.after == draft.before and not draft.writable and "Could not find where" in draft.note


def test_the_cut_as_policy_and_a_tool_id_split():
    assert split_tool("tool:helpdesk.get_ticket") == ("srv:helpdesk", "get_ticket")
    hops = [{"config": {"rel": "CAN_CALL", "from_id": "agent:a", "to_id": "tool:helpdesk.get_ticket"}, "fixes": ["revoke_call"]},
            {"config": {"rel": "CAN_CALL", "from_id": "agent:a", "to_id": "tool:payments.issue_refund"}, "fixes": ["revoke_call", "gate_call"]},
            {"config": {"rel": "WRITES", "from_id": "tool:x.y", "to_id": "res:z"}, "fixes": []}]
    policy = policy_from_cut(Origin(kind="claude-code", servers={"srv:helpdesk": "Helpdesk"}), hops, {})
    assert policy["claude_code"] == {"permissions": {"ask": ["mcp__payments__issue_refund"], "deny": ["mcp__Helpdesk__get_ticket"]}}
    assert policy["docker_mcp_gateway"] == ["docker mcp profile tools default --disable Helpdesk.get_ticket",
                                            "docker mcp profile tools default --disable payments.issue_refund"]
