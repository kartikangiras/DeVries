"""From a tested plan to the change in the real configuration it came from.

A mitigation speaks the graph's language: gate this grant, revoke that one. The system a scenario was
imported from speaks its own. A Claude Code project has permission rules in a settings file, where an
`ask` rule is exactly a gate and a `deny` rule exactly a revoke. A Claude Desktop or Cursor config lists
servers whole, so a tool can only go with its server. A Docker MCP Gateway profile enables tools by name
with a command. A scenario file is YAML with the grant in it. A Draft is the plan translated into one of
those: the text that would be written, a diff a person can read, and a note on what the target can and
cannot say. Nothing here writes a file; `write.py` does, after a person has read the draft.
"""

import difflib
import json
import re
from dataclasses import dataclass, field
from hashlib import sha1, sha256
from pathlib import Path
from typing import Any

import yaml

from cistern.config import ROOT
from cistern.mitigation.dsl import config_patch, describe, reader_id

KINDS = ("claude-code", "claude-desktop", "cursor", "vscode", "docker-mcp-gateway", "scenario", "tools-list")
SECRET_KEYS = {"env", "headers", "auth", "token", "secret", "password", "api_key", "apikey", "authorization"}
CLIENT_WORDS = {"claude-desktop": "Claude Desktop", "cursor": "Cursor", "vscode": "VS Code", "claude-code": "Claude Code",
                "docker-mcp-gateway": "Docker MCP Gateway", "scenario": "the scenario file", "tools-list": "a saved tools/list"}


@dataclass
class Origin:
    """Where a scenario came from, enough to write a change back."""
    kind: str
    path: str | None = None                    # the config file (or the scenario file)
    settings_path: str | None = None           # claude-code: the settings file the permission rules go to
    hash: str | None = None                    # sha256 of `path` as it was imported
    servers: dict[str, str] = field(default_factory=dict)   # srv:<slug> -> the config's own key for the server
    profile: str | None = None                 # docker-mcp-gateway: the profile the commands act on

    @classmethod
    def from_dict(cls, data: dict | None) -> "Origin | None":
        if not data or not data.get("kind"):
            return None
        return cls(kind=str(data["kind"]), path=data.get("path"), settings_path=data.get("settings_path"), hash=data.get("hash"),
                   servers=dict(data.get("servers") or {}), profile=data.get("profile"))

    def to_dict(self) -> dict:
        return {"kind": self.kind, "path": self.path, "settings_path": self.settings_path, "hash": self.hash,
                "servers": self.servers, "profile": self.profile}


@dataclass
class Draft:
    id: str
    kind: str                                  # one of KINDS
    path: str | None                           # the file the text goes to; None for commands and briefs
    before: str
    after: str
    diff: str                                  # unified, secrets redacted
    note: str                                  # what the target can and cannot say about this plan
    commands: list[str] = field(default_factory=list)   # docker-mcp-gateway: what the person runs
    writable: bool = False                     # True when `after` can be written to `path` by write.py
    edited: bool = False

    @property
    def before_hash(self) -> str:
        return sha256(self.before.encode()).hexdigest()

    @property
    def after_hash(self) -> str:
        return sha256(self.after.encode()).hexdigest()

    def view(self) -> dict[str, Any]:
        return {"id": self.id, "kind": self.kind, "path": self.path, "after": self.after, "diff": self.diff, "note": self.note,
                "commands": self.commands, "writable": self.writable, "edited": self.edited,
                "before_hash": self.before_hash, "after_hash": self.after_hash, "changes": self.after != self.before}


def file_hash(path: Path) -> str:
    return sha256(path.read_bytes()).hexdigest()


def draft_id(mitigation_id: str, kind: str, path: str | None) -> str:
    return "drf:" + sha1(f"{mitigation_id}|{kind}|{path or ''}".encode()).hexdigest()[:10]


def split_tool(tool_id: str) -> tuple[str, str]:
    """tool:<server>.<name> -> (srv:<server>, <name>)."""
    body = tool_id.split(":", 1)[1]
    server, _, name = body.partition(".")
    return f"srv:{server}", name


def server_key(origin: Origin | None, server_id: str) -> str:
    """The name the real config uses for a server: what the import recorded, else the id's tail."""
    if origin and server_id in origin.servers:
        return origin.servers[server_id]
    return server_id.split(":", 1)[1]


def _redact(value: Any, under_secret: bool = False) -> Any:
    """A copy with every value under a secret-looking key replaced, for a diff a person may paste anywhere."""
    if isinstance(value, dict):
        return {k: _redact(v, under_secret or str(k).lower() in SECRET_KEYS) for k, v in value.items()}
    if isinstance(value, list):
        return [_redact(v, under_secret) for v in value]
    return "•••" if under_secret and isinstance(value, str) and value else value


def _unified(before: str, after: str, path: str | None) -> str:
    """A unified diff whose headers name the file the way git would: by its path inside the project, or its name,
    never the whole absolute path."""
    name = "config"
    if path:
        here = Path(path)
        try:
            name = str(here.relative_to(ROOT))
        except ValueError:
            name = "/".join(here.parts[-2:]) if here.parent.name in (".claude", ".cursor", ".vscode", "Claude", "Code") else here.name
    return "".join(difflib.unified_diff(before.splitlines(keepends=True), after.splitlines(keepends=True),
                                        fromfile=f"a/{name}", tofile=f"b/{name}"))


def _json_text(data: Any) -> str:
    return json.dumps(data, indent=2, ensure_ascii=False) + "\n"


def _read_json(path: Path | None) -> tuple[str, Any]:
    if path is None or not path.is_file():
        return "", {}
    text = path.read_text(encoding="utf-8")
    try:
        return text, json.loads(text) if text.strip() else {}
    except json.JSONDecodeError:
        return text, None


def _rule(origin: Origin | None, tool_id: str) -> str:
    server, name = split_tool(tool_id)
    return f"mcp__{server_key(origin, server)}__{name}"


# ---------------------------------------------------------------------- the targets

def _claude_code(origin: Origin, mitigation_id: str, fixes: list, names: dict[str, str]) -> Draft:
    """Permission rules: `ask` is a gate, `deny` is a revoke. Evaluated deny, then ask, then allow, so an `ask`
    rule prompts the person on every call whatever the allow list says."""
    path = Path(origin.settings_path or ".claude/settings.json")
    before, data = _read_json(path)
    notes: list[str] = []
    if data is None:
        return Draft(id=draft_id(mitigation_id, "claude-code", str(path)), kind="claude-code", path=str(path), before=before,
                     after=before, diff="", note=f"{path} is not valid JSON, so no rule can be added to it by hand here. Fix the file, then draft again.")
    perms = data.setdefault("permissions", {})
    ask = perms.setdefault("ask", [])
    deny = perms.setdefault("deny", [])

    def add(where: list, rule: str) -> None:
        if rule not in where:
            where.append(rule)

    for fix in fixes:
        if fix.kind == "gate_call":
            add(ask, _rule(origin, fix.tool_id))
            notes.append(f"`{_rule(origin, fix.tool_id)}` under `permissions.ask`: Claude Code asks you before every call of it, "
                         "even in auto mode, because ask rules outrank allow rules.")
        elif fix.kind == "revoke_call":
            add(deny, _rule(origin, fix.tool_id))
            notes.append(f"`{_rule(origin, fix.tool_id)}` under `permissions.deny`: the tool leaves Claude's context altogether.")
        elif fix.kind == "drop_read":
            notes.append(f"Claude Code has no rule for what {names.get(fix.tool_id, fix.tool_id)} reads. The read is a property of the "
                         "server; change the server, or deny the tool.")
        elif fix.kind == "split_agent":
            for tool in sorted(fix.reader_tool_ids):
                add(ask, _rule(origin, tool))
            notes.append("A split is a design change Claude Code cannot express: one session is one agent. The nearest rule is to ask "
                         "before each of the reading tools, which is what is added here; the quarantined reader is yours to build.")
        elif fix.kind == "quarantine_delegation":
            notes.append(f"Claude Code has no rule for what a delegate returns to {names.get(fix.from_agent_id, fix.from_agent_id)}. "
                         "A PreToolUse hook on the delegate's tools can return `permissionDecision: \"ask\"`; the rule file cannot.")
    if not ask:
        perms.pop("ask")
    if not deny:
        perms.pop("deny")
    after = _json_text(data)
    changed = after != (before if before.strip() else "")
    writable = changed
    note = " ".join(notes) or "This plan has no equivalent in Claude Code's permission rules."
    if not before:
        note = f"{path} does not exist yet; it will be created with these rules. " + note
    return Draft(id=draft_id(mitigation_id, "claude-code", str(path)), kind="claude-code", path=str(path), before=before,
                 after=after if changed else before, diff=_unified(before, after, str(path)) if changed else "", note=note, writable=writable)


def _servers_config(origin: Origin, mitigation_id: str, fixes: list, names: dict[str, str], tools_of: dict[str, list[str]]) -> Draft:
    """Claude Desktop, Cursor, VS Code: a server is listed whole. A revoke removes the server and every other tool on it;
    a gate is the client's own approval prompt, which is on by default and which this draft asks you to keep."""
    client = CLIENT_WORDS.get(origin.kind, origin.kind)
    path = Path(origin.path) if origin.path else None
    before, data = _read_json(path)
    notes: list[str] = []
    if data is None or not isinstance(data, dict):
        return Draft(id=draft_id(mitigation_id, origin.kind, str(path)), kind=origin.kind, path=str(path) if path else None, before=before,
                     after=before, diff="", note=f"{path} is not valid JSON, so nothing can be changed in it by hand here.")
    key = "mcpServers" if "mcpServers" in data or "servers" not in data else "servers"
    servers = data.setdefault(key, {})
    display = _redact(data)
    removed: set[str] = set()
    for fix in fixes:
        if fix.kind in ("revoke_call", "gate_call", "drop_read"):
            server_id, _ = split_tool(fix.tool_id)
            raw = server_key(origin, server_id)
            if fix.kind == "revoke_call":
                others = [t for t in tools_of.get(server_id, []) if t != fix.tool_id]
                if raw in servers and raw not in removed:
                    servers.pop(raw)
                    _redact(display).get(key, {}).pop(raw, None)
                    removed.add(raw)
                notes.append(f"{client} cannot remove one tool of a server, so the server `{raw}` goes, and with it "
                             + (f"{len(others)} other tool(s): {', '.join(names.get(t, t) for t in others)}." if others else "nothing else: it had only that tool."))
            elif fix.kind == "gate_call":
                if origin.kind == "cursor":
                    notes.append(f"Cursor asks before every MCP tool by default. Keep that on and do not allowlist "
                                 f"`{names.get(fix.tool_id, fix.tool_id)}` (Settings → MCP, or the team dashboard's allowlist). The file cannot gate one tool.")
                else:
                    notes.append(f"{client} asks before each tool call unless you chose \"Allow always\". Do not allow "
                                 f"`{names.get(fix.tool_id, fix.tool_id)}` always; the file itself cannot gate one tool.")
            else:
                notes.append(f"{client} cannot change what `{names.get(fix.tool_id, fix.tool_id)}` reads; that belongs to the server `{raw}`.")
        elif fix.kind == "split_agent":
            notes.append(f"{client} is one agent with every grant; a split means running the reading tools in a second client that returns "
                         "only structured fields. The file cannot say that.")
        elif fix.kind == "quarantine_delegation":
            notes.append(f"{client} has no delegations in its file; a quarantine is a change to the agents, not to this config.")
    after = _json_text(data) if removed else before
    diff = _unified(_json_text(_redact(json.loads(before))) if before.strip() else "", _json_text(_redact(data)), str(path)) if removed else ""
    note = " ".join(notes) or f"This plan changes nothing {client} can read from its file."
    return Draft(id=draft_id(mitigation_id, origin.kind, str(path)), kind=origin.kind, path=str(path) if path else None, before=before,
                 after=after, diff=diff, note=note, writable=bool(removed))


def _docker_gateway(origin: Origin, mitigation_id: str, fixes: list, names: dict[str, str]) -> Draft:
    """Profiles: a tool is enabled or disabled by a command. The gateway has no approval step, so a gate is a disable with a note."""
    profile = origin.profile or "default"
    commands: list[str] = []
    notes: list[str] = []
    for fix in fixes:
        if fix.kind in ("revoke_call", "gate_call"):
            server_id, tool = split_tool(fix.tool_id)
            commands.append(f"docker mcp profile tools {profile} --disable {server_key(origin, server_id)}.{tool}")
            if fix.kind == "gate_call":
                notes.append(f"The gateway has no approval step, so `{names.get(fix.tool_id, fix.tool_id)}` is disabled instead of gated; "
                             "the client in front of it is where a person can approve a call.")
        elif fix.kind == "split_agent":
            for tool in sorted(fix.reader_tool_ids):
                server_id, name = split_tool(tool)
                commands.append(f"docker mcp profile tools {profile} --disable {server_key(origin, server_id)}.{name}   # move to the reader's profile")
            notes.append("A split is two profiles: the reading tools in one, the acting tools in the other, each behind its own client.")
        else:
            notes.append(f"The gateway cannot express: {describe(fix)}.")
    after = "\n".join(commands) + ("\n" if commands else "")
    note = " ".join(notes) or "Run these against the gateway's profile; the gateway re-reads it on the next connection."
    return Draft(id=draft_id(mitigation_id, "docker-mcp-gateway", None), kind="docker-mcp-gateway", path=None, before="", after=after,
                 diff="", note=note, commands=commands, writable=False)


# ---- the scenario file itself: the grant is in the YAML, so the change can be made in place

def _item_pattern(item_id: str) -> re.Pattern:
    """One list item naming `item_id`: `- tool:x`, or `- {id: tool:x, ...}`, with an optional comment after it."""
    esc = re.escape(item_id)
    return re.compile(r"(?P<indent>[ \t]*)-[ \t]*(?:\{[ \t]*id:[ \t]*" + esc + r"[ \t]*(?P<rest>,[^}]*)?\}|" + esc
                      + r")[ \t]*(?P<comment>#[^\n]*)?\n", re.M)


def _agent_block(text: str, agent_id: str) -> tuple[int, int] | None:
    """The span of one agent's entry under `agents:`."""
    m = re.search(rf"^([ \t]*)-[ \t]*id:[ \t]*{re.escape(agent_id)}[ \t]*(?:#[^\n]*)?$", text, re.M)
    if not m:
        return None
    indent = m.group(1)
    rest = text[m.end():]
    nxt = re.search(rf"^{re.escape(indent)}-[ \t]*id:|^\S", rest, re.M)
    return m.start(), m.end() + (nxt.start() if nxt else len(rest))


def _patch_list_item(block: str, list_key: str, item_id: str, replacement: str | None) -> str | None:
    """Within an agent's block, rewrite (or delete when `replacement` is None) one item of a list such as can_call.
    Handles the block form (`- tool:x` / `- {id: tool:x}`) and the inline form (`can_call: [tool:x, ...]`)."""
    esc = re.escape(item_id)
    item = _item_pattern(item_id)
    head = re.search(rf"^[ \t]*{list_key}:[ \t]*(?P<inline>\[[^\]]*\])?[ \t]*(?:#[^\n]*)?\n", block, re.M)
    if not head:
        return None
    if head.group("inline"):
        inline = head.group("inline")
        items = [i.strip() for i in inline[1:-1].split(",") if i.strip()]
        if item_id not in items and not any(i.startswith("{") and item_id in i for i in items):
            return None
        new_items = []
        for i in items:
            if i == item_id or (i.startswith("{") and re.search(rf"id:[ \t]*{esc}\b", i)):
                if replacement is not None:
                    new_items.append(replacement)
            else:
                new_items.append(i)
        return block[:head.start("inline")] + "[" + ", ".join(new_items) + "]" + block[head.end("inline"):]
    tail_start = head.end()
    m = item.search(block, tail_start)
    if not m:
        return None
    # stop at the next key of the agent (same indent as the list key or less)
    key_indent = len(head.group(0)) - len(head.group(0).lstrip())
    between = block[tail_start:m.start()]
    if re.search(rf"^[ \t]{{0,{key_indent}}}\w", between, re.M):
        return None
    if replacement is None:
        return block[:m.start()] + block[m.end():]
    return block[:m.start()] + f"{m.group('indent')}- {replacement}{('  ' + m.group('comment')) if m.group('comment') else ''}\n" + block[m.end():]


def _patch_reads(text: str, tool_id: str, source_id: str) -> str | None:
    """Remove a source from a tool's `reads` list, in the inline or the block form of the tools: entries."""
    esc_tool, esc_src = re.escape(tool_id), re.escape(source_id)
    # inline map: - {id: tool:x, reads: [src:a, src:b], writes: [...]}
    m = re.search(rf"^([ \t]*)-[ \t]*\{{[ \t]*id:[ \t]*{esc_tool}[ \t]*,(?P<body>[^}}]*)\}}", text, re.M)
    if m:
        body = m.group("body")
        reads = re.search(r"reads:[ \t]*\[(?P<list>[^\]]*)\]", body)
        if reads and re.search(rf"(?<![\w:.-]){esc_src}(?![\w.-])", reads.group("list")):
            items = [i.strip() for i in reads.group("list").split(",") if i.strip() and i.strip() != source_id]
            new_body = body[:reads.start("list")] + ", ".join(items) + body[reads.end("list"):]
            return text[:m.start("body")] + new_body + text[m.end("body"):]
        return None
    # block form: - id: tool:x \n reads: [src:a]
    m = re.search(rf"^([ \t]*)-[ \t]*id:[ \t]*{esc_tool}[ \t]*(?:#[^\n]*)?\n", text, re.M)
    if not m:
        return None
    rest = text[m.end():]
    nxt = re.search(rf"^{re.escape(m.group(1))}-|^\S", rest, re.M)
    block = rest[: nxt.start() if nxt else len(rest)]
    reads = re.search(r"reads:[ \t]*\[(?P<list>[^\]]*)\]", block)
    if not reads or not re.search(rf"(?<![\w:.-]){esc_src}(?![\w.-])", reads.group("list")):
        return None
    items = [i.strip() for i in reads.group("list").split(",") if i.strip() and i.strip() != source_id]
    new_block = block[:reads.start("list")] + ", ".join(items) + block[reads.end("list"):]
    return text[:m.end()] + new_block + rest[len(block):]


def _scenario_yaml(path: Path, mitigation_id: str, fixes: list, names: dict[str, str]) -> Draft:
    """The scenario file is the config: a grant, a delegation and a read are lines in it, changed in place so that the
    comments stay. A split rewrites the file through the YAML library, and says so."""
    before = path.read_text(encoding="utf-8") if path.is_file() else ""
    text = before
    notes: list[str] = []
    for fix in fixes:
        done: str | None = None
        if fix.kind in ("gate_call", "revoke_call"):
            span = _agent_block(text, fix.agent_id)
            if span:
                block = text[span[0]:span[1]]
                patched = _patch_list_item(block, "can_call", fix.tool_id,
                                           f"{{id: {fix.tool_id}, gate: human_approval}}" if fix.kind == "gate_call" else None)
                if patched is not None:
                    done = text[:span[0]] + patched + text[span[1]:]
        elif fix.kind == "quarantine_delegation":
            span = _agent_block(text, fix.from_agent_id)
            if span:
                block = text[span[0]:span[1]]
                patched = _patch_list_item(block, "delegates_to", fix.to_agent_id, f"{{id: {fix.to_agent_id}, gate: quarantine}}")
                if patched is not None:
                    done = text[:span[0]] + patched + text[span[1]:]
        elif fix.kind == "drop_read":
            done = _patch_reads(text, fix.tool_id, fix.source_id)
        if done is None:
            done = _yaml_round_trip(text, fix)
            if done is not None:
                notes.append(f"For “{describe(fix)}” the file was rewritten by the YAML library, so its comments are gone from this draft.")
        if done is None:
            notes.append(f"Could not find where to make “{describe(fix)}” in {path.name}; the patch is: {json.dumps(config_patch(fix))}.")
            continue
        text = done
    problem = _check_scenario(text, path)
    if problem:
        notes.append(f"The draft does not load as a scenario: {problem}")
    changed = text != before
    note = " ".join(notes) or "The grant lines of the scenario file, changed in place; the file is reloaded and rescanned after it is written."
    return Draft(id=draft_id(mitigation_id, "scenario", str(path)), kind="scenario", path=str(path), before=before, after=text,
                 diff=_unified(before, text, str(path)) if changed else "", note=note, writable=changed and not problem)


def _yaml_round_trip(text: str, fix) -> str | None:
    try:
        data = yaml.safe_load(text) or {}
    except yaml.YAMLError:
        return None
    agents = {a["id"]: a for a in data.get("agents", []) if isinstance(a, dict)}

    def grants(agent: dict) -> list:
        return [g if isinstance(g, dict) else {"id": g} for g in agent.get("can_call", [])]

    if fix.kind == "split_agent":
        agent = agents.get(fix.agent_id)
        if not agent:
            return None
        moved = [g for g in grants(agent) if g["id"] in fix.reader_tool_ids]
        if len(moved) != len(fix.reader_tool_ids):
            return None
        agent["can_call"] = [g["id"] if set(g) == {"id"} else g for g in grants(agent) if g["id"] not in fix.reader_tool_ids]
        dels = [d if isinstance(d, dict) else {"id": d} for d in agent.get("delegates_to", [])]
        agent["delegates_to"] = [*dels, {"id": reader_id(fix.agent_id), "gate": "quarantine"}]
        data.setdefault("agents", []).append({"id": reader_id(fix.agent_id), "name": f"{agent.get('name', fix.agent_id)} (reader)",
                                              "owner": agent.get("owner"), "can_call": [g["id"] if set(g) == {"id"} else g for g in moved],
                                              "delegates_to": []})
    elif fix.kind in ("gate_call", "revoke_call"):
        agent = agents.get(fix.agent_id)
        if not agent or not any(g["id"] == fix.tool_id for g in grants(agent)):
            return None
        kept = []
        for g in grants(agent):
            if g["id"] != fix.tool_id:
                kept.append(g["id"] if set(g) == {"id"} else g)
            elif fix.kind == "gate_call":
                kept.append({"id": g["id"], "gate": "human_approval"})
        agent["can_call"] = kept
    elif fix.kind == "quarantine_delegation":
        agent = agents.get(fix.from_agent_id)
        if not agent:
            return None
        dels = [d if isinstance(d, dict) else {"id": d} for d in agent.get("delegates_to", [])]
        if not any(d["id"] == fix.to_agent_id for d in dels):
            return None
        agent["delegates_to"] = [{"id": d["id"], "gate": "quarantine"} if d["id"] == fix.to_agent_id else (d["id"] if set(d) == {"id"} else d) for d in dels]
    elif fix.kind == "drop_read":
        tool = next((t for t in data.get("tools", []) if isinstance(t, dict) and t.get("id") == fix.tool_id), None)
        if not tool or fix.source_id not in tool.get("reads", []):
            return None
        tool["reads"] = [s for s in tool["reads"] if s != fix.source_id]
    else:
        return None
    return yaml.safe_dump(data, sort_keys=False, allow_unicode=True)


def _check_scenario(text: str, path: Path) -> str | None:
    from pydantic import ValidationError

    from cistern.ingest.models import ScenarioFile
    try:
        ScenarioFile.model_validate(yaml.safe_load(text))
    except yaml.YAMLError as e:
        return f"not valid YAML ({str(e).splitlines()[0]})"
    except ValidationError as e:
        first = e.errors()[0]
        return f"{'.'.join(str(p) for p in first['loc'])}: {first['msg']}"
    return None


def _brief(origin: Origin | None, mitigation_id: str, fixes: list, names: dict[str, str]) -> Draft:
    lines = ["# The change, as the configuration would see it", ""]
    for fix in fixes:
        patch = config_patch(fix)
        lines.append(f"- {describe(fix)}")
        lines.append(f"  `{json.dumps(patch)}`")
    kind = origin.kind if origin else "tools-list"
    note = ("This scenario was built from a saved tools/list, so there is no file of grants to change: the brief above is the "
            "change in the graph's own terms, for whoever administers the real system.")
    return Draft(id=draft_id(mitigation_id, kind, None), kind=kind, path=None, before="", after="\n".join(lines) + "\n", diff="",
                 note=note, writable=False)


def compile_draft(origin: Origin | None, scenario_path: Path | None, mitigation_id: str, fixes: list, names: dict[str, str],
                  tools_of: dict[str, list[str]] | None = None) -> Draft:
    """The plan as the change to the configuration it came from. `tools_of` maps a server id to its tool ids, for the
    clients that can only remove a server whole."""
    if origin is not None and origin.kind == "claude-code":
        return _claude_code(origin, mitigation_id, fixes, names)
    if origin is not None and origin.kind in ("claude-desktop", "cursor", "vscode"):
        return _servers_config(origin, mitigation_id, fixes, names, tools_of or {})
    if origin is not None and origin.kind == "docker-mcp-gateway":
        return _docker_gateway(origin, mitigation_id, fixes, names)
    if scenario_path is not None and (origin is None or origin.kind == "scenario"):
        return _scenario_yaml(scenario_path, mitigation_id, fixes, names)
    return _brief(origin, mitigation_id, fixes, names)


def policy_from_cut(origin: Origin | None, hops: list[dict], names: dict[str, str]) -> dict[str, Any]:
    """The cheapest cut as the rules that would make it: a Claude Code permissions block and the gateway commands.
    A guide, like the cut itself: only a sandbox verdict says a fix is safe."""
    ask: list[str] = []
    deny: list[str] = []
    commands: list[str] = []
    profile = (origin.profile if origin else None) or "default"
    for hop in hops:
        config = hop.get("config") or {}
        fixes = hop.get("fixes") or []
        if config.get("rel") != "CAN_CALL" or not fixes:
            continue
        tool_id = config["to_id"]
        rule = _rule(origin, tool_id)
        server_id, tool = split_tool(tool_id)
        if "gate_call" in fixes and "revoke_call" in fixes:
            if rule not in ask:
                ask.append(rule)
        elif rule not in deny:
            deny.append(rule)
        commands.append(f"docker mcp profile tools {profile} --disable {server_key(origin, server_id)}.{tool}")
    permissions: dict[str, list[str]] = {}
    if ask:
        permissions["ask"] = ask
    if deny:
        permissions["deny"] = deny
    return {"claude_code": {"permissions": permissions}, "claude_code_text": _json_text({"permissions": permissions}),
            "docker_mcp_gateway": commands, "named": [names.get(r, r) for r in ask + deny]}
