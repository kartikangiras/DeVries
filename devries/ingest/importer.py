"""Import the tools of a real install into a draft scenario.

Sources: a client's config file (Claude Code, Claude Desktop, Cursor, VS Code), any JSON with an `mcpServers`
block, one stdio command, a streamable-HTTP URL, or a saved `tools/list` result. Each server is
launched or called, `tools/list` is taken as its manifest, and a scenario is drafted around one
agent, the client, that holds every tool. Trust and impact are `unknown` until a person labels
them, so an import yields no finding by itself: nothing in it is a finding until someone says what
is untrusted and what matters.

The draft remembers its origin: which file it came from, the file's hash, and the name the file uses
for each server. That is what a fix is written back to, once a person has read the change. For a
Claude Code project the permission rules are read as well: an `ask` rule on a tool is a gate, a
`deny` rule means no grant, so a fix written to the settings file comes back as a closed finding on
the next import.

Launching a server runs it with this user's environment and credentials. The command says so.
"""

import asyncio
import fnmatch
import json
import os
import re
import shlex
import time
from dataclasses import dataclass, field
from hashlib import sha256
from pathlib import Path

import yaml
from mcp import Client, StdioServerParameters

from devries.errors import InvalidScenario
from devries.ingest.manifests import TOOL_NAME_RE, Manifest, ManifestTool, capability_from_annotations, load_manifest

CLIENT_CONFIGS: dict[str, list[Path]] = {
    "claude-code": [Path.cwd() / ".mcp.json", Path.home() / ".claude.json"],
    "claude-desktop": [
        Path.home() / "Library" / "Application Support" / "Claude" / "claude_desktop_config.json",
        Path(os.environ.get("APPDATA", "")) / "Claude" / "claude_desktop_config.json",
        Path.home() / ".config" / "Claude" / "claude_desktop_config.json",
    ],
    "cursor": [Path.cwd() / ".cursor" / "mcp.json", Path.home() / ".cursor" / "mcp.json"],
    "vscode": [Path.cwd() / ".vscode" / "mcp.json"],
}
# Claude Code reads permission rules from every one of these; a rule in any applies.
CLAUDE_CODE_SETTINGS = [Path.cwd() / ".claude" / "settings.json", Path.cwd() / ".claude" / "settings.local.json",
                        Path.home() / ".claude" / "settings.json"]
FETCH_TIMEOUT_S = 20.0

# Guesses from a server's name, offered as guesses: a person confirms them before they mean anything.
UNTRUSTED_NAMES = ("github", "gitlab", "jira", "linear", "fetch", "http", "web", "brave", "search", "browser",
                   "puppeteer", "playwright", "mail", "gmail", "email", "slack", "discord", "issues", "reddit", "youtube")
PRIVATE_NAMES = ("filesystem", "file", "postgres", "sqlite", "mysql", "mongo", "database", "db", "secret", "vault",
                 "keychain", "1password", "aws", "gcp", "azure", "memory", "notes", "drive", "calendar", "contacts", "obsidian")
EXTERNAL_NAMES = ("fetch", "http", "slack", "gmail", "mail", "email", "discord", "telegram", "sms", "twilio", "webhook",
                  "browser", "puppeteer", "playwright", "twitter", "x", "github", "gitlab", "jira", "linear")
HIGH_NAMES = ("filesystem", "postgres", "mysql", "mongo", "database", "db", "aws", "gcp", "azure", "kubernetes", "k8s",
              "docker", "shell", "terminal", "exec", "git", "deploy", "payments", "stripe")


@dataclass
class ServerSource:
    id: str                            # srv:<slug>
    name: str                          # the config's own key for the server, or the name it was given
    command: str | None = None
    args: list[str] = field(default_factory=list)
    env: dict[str, str] = field(default_factory=dict)
    url: str | None = None
    manifest_path: Path | None = None

    @property
    def origin(self) -> str:
        if self.manifest_path:
            return str(self.manifest_path)
        if self.url:
            return self.url
        return " ".join([self.command or "", *self.args]).strip()


@dataclass
class Origin:
    """Where an import came from: the file a fix can be written back to."""
    kind: str                           # claude-code | claude-desktop | cursor | vscode | tools-list | scenario
    path: str | None = None
    settings_path: str | None = None    # claude-code: where permission rules go
    hash: str | None = None             # sha256 of `path` when imported
    servers: dict[str, str] = field(default_factory=dict)   # srv:<slug> -> the config's key for the server

    def to_dict(self) -> dict:
        return {"kind": self.kind, "path": self.path, "settings_path": self.settings_path, "hash": self.hash, "servers": self.servers}


def slug(text: str) -> str:
    """A server id from a name: lower case, letters, digits and dashes, as an id's tail allows."""
    text = re.sub(r"^(?:@[\w.-]+/)?(?:mcp-server-|server-|mcp-)", "", text.strip().lower())
    text = re.sub(r"[^a-z0-9]+", "-", text).strip("-")
    return text[:40] or "server"


def discover(source: str) -> tuple[str, list[ServerSource]]:
    """What a source names: (the client's name, its servers). Raises InvalidScenario when it names nothing."""
    if source in CLIENT_CONFIGS:
        for path in CLIENT_CONFIGS[source]:
            if path.is_file():
                return source, _from_config(path)
        raise InvalidScenario(f"no config file for {source} at " + ", ".join(str(p) for p in CLIENT_CONFIGS[source]))
    if source.startswith(("http://", "https://")):
        return "client", [ServerSource(id=f"srv:{slug(source.split('//', 1)[1].split('/')[0])}", name=source.split("//", 1)[1].split("/")[0], url=source)]
    path = Path(source).expanduser()
    if path.is_file() and path.suffix == ".json":
        data = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(data, dict) and ("mcpServers" in data or "servers" in data):
            return path.stem, _from_config(path)
        if isinstance(data, dict) and "tools" in data:
            return "client", [ServerSource(id=f"srv:{slug(path.stem.replace('.tools', ''))}", name=path.stem.replace(".tools", ""), manifest_path=path)]
        raise InvalidScenario(f"{path} is neither a client config (mcpServers) nor a saved tools/list (tools)")
    parts = shlex.split(source)
    if not parts:
        raise InvalidScenario("an empty command")
    # a command is named after the last word that looks like a package or a module, not after "npx" or "python"
    words = [w for w in parts if not w.startswith("-")]
    name = next((w for w in reversed(words) if re.search(r"server|mcp", w, re.I)), words[-1]).rsplit("/", 1)[-1]
    return "client", [ServerSource(id=f"srv:{slug(name)}", name=slug(name), command=parts[0], args=parts[1:])]


def origin_of(source: str, client_name: str, servers: list[ServerSource]) -> Origin:
    """The file behind a source, with its hash and the names it uses, so that a fix can be written back to it."""
    names = {s.id: s.name for s in servers}
    if source in CLIENT_CONFIGS:
        path = next((p for p in CLIENT_CONFIGS[source] if p.is_file()), None)
        settings = None
        if source == "claude-code":
            # the project's settings file when the servers came from the project, the user's otherwise
            settings = str(Path.cwd() / ".claude" / "settings.json") if path and path.name == ".mcp.json" else str(Path.home() / ".claude" / "settings.json")
        return Origin(kind=source, path=str(path) if path else None, settings_path=settings,
                      hash=sha256(path.read_bytes()).hexdigest() if path else None, servers=names)
    path = Path(source).expanduser()
    if path.is_file() and path.suffix == ".json":
        data = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(data, dict) and "tools" in data and "mcpServers" not in data:
            return Origin(kind="tools-list", path=str(path), hash=sha256(path.read_bytes()).hexdigest(), servers=names)
        kind = {".mcp.json": "claude-code", "claude_desktop_config.json": "claude-desktop", ".claude.json": "claude-code"}.get(path.name)
        if kind is None:
            kind = "cursor" if ".cursor" in path.parts else "vscode" if ".vscode" in path.parts else "claude-desktop"
        settings = str(path.parent / ".claude" / "settings.json") if kind == "claude-code" else None
        return Origin(kind=kind, path=str(path), settings_path=settings, hash=sha256(path.read_bytes()).hexdigest(), servers=names)
    return Origin(kind="tools-list", path=None, servers=names)


def _from_config(path: Path) -> list[ServerSource]:
    data = json.loads(path.read_text(encoding="utf-8"))
    return _from_config_data(data, str(path))


def _from_config_data(data, where: str) -> list[ServerSource]:
    entries = data.get("mcpServers") or data.get("servers") or {} if isinstance(data, dict) else {}
    if not isinstance(entries, dict) or not entries:
        raise InvalidScenario(f"{where} lists no servers")
    out = []
    for name, entry in entries.items():
        if not isinstance(entry, dict):
            continue
        src = ServerSource(id=f"srv:{slug(name)}", name=name)
        if entry.get("url"):
            src.url = str(entry["url"])
        elif entry.get("command"):
            src.command, src.args = str(entry["command"]), [str(a) for a in entry.get("args", [])]
            src.env = {str(k): str(v) for k, v in (entry.get("env") or {}).items()}
        else:
            continue
        out.append(src)
    if not out:
        raise InvalidScenario(f"{where}: no server has a command or a url")
    return out


async def fetch_tools(server: ServerSource, timeout: float = FETCH_TIMEOUT_S) -> Manifest:
    """The server's `tools/list`, as a manifest. A stdio server is launched with this user's environment."""
    if server.manifest_path:
        return load_manifest(server.manifest_path)
    if server.url:
        target: object = server.url
    else:
        env = {**os.environ, **server.env}
        target = StdioServerParameters(command=server.command or "", args=server.args, env=env)
    try:
        async with asyncio.timeout(timeout):
            async with Client(target) as session:   # type: ignore[arg-type]
                listed = (await session.list_tools()).tools
    except TimeoutError as e:
        raise InvalidScenario(f"{server.name}: no tools/list within {timeout:g} s") from e
    except Exception as e:                           # a launch that fails surfaces as an exception group
        raise InvalidScenario(f"{server.name}: {type(e).__name__}: {str(e)[:200]}") from e
    tools = []
    for t in listed:
        if not TOOL_NAME_RE.fullmatch(t.name):
            continue                                 # a name that cannot be an id is left out, and said so by the caller
        # by alias: the SDK's model holds read_only_hint, the wire and the manifests say readOnlyHint
        annotations = t.annotations.model_dump(by_alias=True, exclude_none=True) if getattr(t, "annotations", None) else None
        tools.append(ManifestTool(name=t.name, description=t.description or "", inputSchema=t.input_schema or {}, annotations=annotations))
    return Manifest(tools=tools)


def guess(server_name: str) -> dict:
    """Labels guessed from the words of a server's name. Offered as guesses; a person confirms them."""
    words = set(re.split(r"[^a-z0-9]+", server_name.lower())) - {""}
    has = lambda names: bool(words & set(names))  # noqa: E731
    return {
        "trust": "untrusted" if has(UNTRUSTED_NAMES) else "private" if has(PRIVATE_NAMES) else None,
        "impact": "high" if has(HIGH_NAMES) else None,
        "external": has(EXTERNAL_NAMES),
    }


# ---------------------------------------------------------------------- Claude Code permission rules

def read_permissions(paths: list[Path] | None = None) -> dict[str, list[str]]:
    """The `ask` and `deny` rules of every Claude Code settings file that exists among `paths`."""
    rules: dict[str, list[str]] = {"ask": [], "deny": []}
    for path in paths if paths is not None else CLAUDE_CODE_SETTINGS:
        try:
            data = json.loads(Path(path).read_text(encoding="utf-8")) if Path(path).is_file() else {}
        except (OSError, json.JSONDecodeError):
            continue
        perms = data.get("permissions") if isinstance(data, dict) else None
        if not isinstance(perms, dict):
            continue
        for which in ("ask", "deny"):
            rules[which] += [r for r in perms.get(which, []) if isinstance(r, str)]
    return rules


def rule_matches(rule: str, server: str, tool: str) -> bool:
    """Does a Claude Code permission rule cover mcp__<server>__<tool>? `mcp__<server>` covers every tool of the
    server; a glob in the tool position matches by fnmatch; `mcp__*` and `*` cover every MCP tool."""
    full = f"mcp__{server}__{tool}"
    if rule in ("*", "mcp__*", f"mcp__{server}", f"mcp__{server}__*"):
        return True
    if "(" in rule:
        return False                                 # a rule with a parameter pattern is skipped by Claude Code for MCP tools
    return fnmatch.fnmatchcase(full, rule)


def grants_from_rules(rules: dict[str, list[str]], server: str, tool: str) -> str | None:
    """What the rules say about one tool: 'deny' (no grant), 'ask' (a gated grant), or None (an ordinary grant).
    Deny outranks ask, as Claude Code evaluates them."""
    if any(rule_matches(r, server, tool) for r in rules.get("deny", [])):
        return "deny"
    if any(rule_matches(r, server, tool) for r in rules.get("ask", [])):
        return "ask"
    return None


def _settings_for(origin: Origin | None) -> list[Path]:
    if origin is None or origin.kind != "claude-code":
        return []
    paths = [Path(origin.settings_path)] if origin.settings_path else []
    if origin.settings_path and Path(origin.settings_path).name == "settings.json" and ".claude" in Path(origin.settings_path).parts:
        paths.append(Path(origin.settings_path).with_name("settings.local.json"))
    paths.append(Path.home() / ".claude" / "settings.json")
    return list(dict.fromkeys(paths))


# ---------------------------------------------------------------------- the draft

def draft(name: str, client_name: str, source: str, servers: list[tuple[ServerSource, Manifest]],
          labels: dict[str, str] | None = None, origin: Origin | None = None, rules: dict[str, list[str]] | None = None) -> str:
    """The scenario file for an import: one agent, the client, holding every tool; one source and one resource
    per server; trust and impact unknown until labelled (or given in `labels` as id=value). With Claude Code rules,
    a denied tool is not granted and an asked-about one is granted behind a gate."""
    labels = labels or {}
    lines = [
        f"# Imported from {source} on {time.strftime('%Y-%m-%d %H:%M')}. One agent, the client, holds every tool: that is what a",
        "# desktop client is. Each server reads one data source and acts on one resource, both unknown until you label them;",
        "# an unknown label yields no finding. A tool with no annotations is taken to both read and act, which errs on the side",
        "# a security tool should. Declare workflows for what must keep working, or every fix will pass the workflow check.",
        f"scenario: {name}",
        f"title: {client_name} (imported)",
        "order: 50",
        f"description: Imported from {source}; {len(servers)} server(s), {sum(len(m.tools) for _, m in servers)} tools. Label the sources and resources to find anything",
        f"imported: {{source: {json.dumps(source)}, client: {json.dumps(client_name)}, at: {int(time.time() * 1000)}}}",
    ]
    if origin is not None:
        lines.append(f"origin: {json.dumps(origin.to_dict())}")
    lines += ["", "servers:"]
    for server, _ in servers:
        lines.append(f"  - {{id: {server.id}, name: {json.dumps(server.name)}, manifest: manifests/{server.id[4:]}.tools.json, synthetic: false, source_url: {json.dumps(server.origin)}}}")
    lines += ["", "tools:"]
    for server, manifest in servers:
        tail = server.id[4:]
        for tool in manifest.tools:
            capability = capability_from_annotations(tool.annotations)
            reads = capability == "read" or capability is None
            writes = capability != "read"
            parts = []
            if reads:
                parts.append(f"reads: [src:{tail}]")
            if writes:
                parts.append(f"writes: [res:{tail}]")
            note = "" if capability else "    # no annotations: taken to read and to act"
            lines.append(f"  - {{id: tool:{tail}.{tool.name}, {', '.join(parts)}}}{note}")
    lines += ["", "data_sources:"]
    for server, _ in servers:
        g = guess(server.name)
        trust = labels.get(f"src:{server.id[4:]}", "unknown")
        hint = f"    # guess from the name: {g['trust']}" if trust == "unknown" and g["trust"] else ""
        lines.append(f"  - {{id: src:{server.id[4:]}, name: {json.dumps('What ' + server.name + ' reads')}, trust: {trust}}}{hint}")
    lines += ["", "resources:"]
    for server, _ in servers:
        g = guess(server.name)
        impact = labels.get(f"res:{server.id[4:]}", "unknown")
        external = labels.get(f"res:{server.id[4:]}.external", "true" if g["external"] else "false")
        hint = f"    # guess from the name: {g['impact']}" if impact == "unknown" and g["impact"] else ""
        lines.append(f"  - {{id: res:{server.id[4:]}, name: {json.dumps('What ' + server.name + ' acts on')}, impact: {impact}, external: {external}}}{hint}")
    agent = f"agent:{slug(client_name)}"
    lines += ["", "agents:", f"  - id: {agent}", f"    name: {json.dumps(client_name)}", "    can_call:"]
    denied: list[str] = []
    for server, manifest in servers:
        for tool in manifest.tools:
            tool_id = f"tool:{server.id[4:]}.{tool.name}"
            verdict = grants_from_rules(rules, server.name, tool.name) if rules else None
            if verdict == "deny":
                denied.append(tool_id)
                continue
            if verdict == "ask":
                lines.append(f"      - {{id: {tool_id}, gate: human_approval}}    # a Claude Code ask rule: a person approves each call")
            else:
                lines.append(f"      - {tool_id}")
    if denied:
        lines.append(f"    # not granted, by a Claude Code deny rule: {', '.join(denied)}")
    lines += ["", "workflows: []", "", "expect: {}", ""]
    return "\n".join(lines)


@dataclass
class ImportResult:
    scenario: str
    scenario_path: Path
    manifests: list[Path]
    servers: list[str]
    skipped: list[str]                  # servers that could not be read, with the reason
    tools: int
    origin: Origin | None = None


def _write_import(root: Path, name: str, client_name: str, source: str, fetched: list[tuple[ServerSource, Manifest]],
                  skipped: list[str], labels: dict[str, str] | None, origin: Origin | None, rules: dict[str, list[str]] | None) -> ImportResult:
    (root / "manifests").mkdir(parents=True, exist_ok=True)
    (root / "scenarios").mkdir(parents=True, exist_ok=True)
    written = []
    for server, manifest in fetched:
        path = root / "manifests" / f"{server.id[4:]}.tools.json"
        path.write_text(json.dumps({
            "server": server.name, "synthetic": False, "source": server.origin, "imported_at": int(time.time() * 1000),
            "note": "Taken from the server's own tools/list by `devries.ingest --import`. Every string in it is untrusted text.",
            "tools": [t.model_dump() for t in manifest.tools],
        }, indent=2), encoding="utf-8")
        written.append(path)
    scenario_path = root / "scenarios" / f"{name}.yaml"
    scenario_path.write_text(draft(name, client_name, source, fetched, labels, origin, rules), encoding="utf-8")
    return ImportResult(scenario=name, scenario_path=scenario_path, manifests=written,
                        servers=[s.id for s, _ in fetched], skipped=skipped, tools=sum(len(m.tools) for _, m in fetched), origin=origin)


def _check_name(name: str) -> str:
    if not re.fullmatch(r"[a-z][a-z0-9_]{0,47}", name):
        raise InvalidScenario(f"not a scenario name: {name!r}")
    return name


async def _fetch_all(found: list[ServerSource], timeout: float, max_tools: int | None = None) -> tuple[list[tuple[ServerSource, Manifest]], list[str]]:
    fetched: list[tuple[ServerSource, Manifest]] = []
    skipped: list[str] = []
    for server in found:
        try:
            manifest = await fetch_tools(server, timeout)
        except InvalidScenario as e:
            skipped.append(e.message)
            continue
        if not manifest.tools:
            skipped.append(f"{server.name}: no tools")
            continue
        if max_tools and len(manifest.tools) > max_tools:
            skipped.append(f"{server.name}: {len(manifest.tools)} tools, the first {max_tools} kept")
            manifest = Manifest(tools=manifest.tools[:max_tools], source_url=manifest.source_url)
        fetched.append((server, manifest))
    return fetched, skipped


async def import_install(source: str, root: Path, name: str | None = None, labels: dict[str, str] | None = None,
                         timeout: float = FETCH_TIMEOUT_S) -> ImportResult:
    """Discover, fetch, draft and write. The caller loads the file afterwards (so that it can say what it found)."""
    client_name, found = discover(source)
    name = _check_name(name or f"import_{slug(client_name).replace('-', '_')}")
    origin = origin_of(source, client_name, found)
    rules = read_permissions(_settings_for(origin)) if origin.kind == "claude-code" else None
    fetched, skipped = await _fetch_all(found, timeout)
    if not fetched:
        raise InvalidScenario("nothing could be imported: " + "; ".join(skipped))
    return _write_import(root, name, client_name, source, fetched, skipped, labels, origin, rules)


async def import_pasted(data: dict, root: Path, name: str, client_name: str = "pasted config", labels: dict[str, str] | None = None,
                        *, public: bool = False, timeout: float = FETCH_TIMEOUT_S, max_tools: int | None = None) -> ImportResult:
    """An import from JSON a person pasted: a client config (`mcpServers`) or a saved tools/list (`tools`).
    On a public site no command is ever launched: only servers with a `url` are asked for their tools."""
    name = _check_name(name)
    if not isinstance(data, dict):
        raise InvalidScenario("paste a JSON object: a client config with mcpServers, or a saved tools/list")
    skipped: list[str] = []
    if "tools" in data and "mcpServers" not in data and "servers" not in data:
        try:
            manifest = Manifest.model_validate(data)
        except Exception as e:
            raise InvalidScenario(f"not a tools/list result: {str(e)[:200]}") from e
        bad = [t.name for t in manifest.tools if not TOOL_NAME_RE.fullmatch(t.name)]
        manifest = Manifest(tools=[t for t in manifest.tools if TOOL_NAME_RE.fullmatch(t.name)][: max_tools or None])
        if bad:
            skipped.append(f"{len(bad)} tool name(s) that cannot be ids were left out")
        if not manifest.tools:
            raise InvalidScenario("the tools/list has no usable tools")
        server_name = str(data.get("server") or data.get("name") or "pasted")
        server = ServerSource(id=f"srv:{slug(server_name)}", name=server_name)
        origin = Origin(kind="tools-list", servers={server.id: server.name})
        return _write_import(root, name, client_name, "a pasted tools/list", [(server, manifest)], skipped, labels, origin, None)
    found = _from_config_data(data, "the pasted config")
    if public:
        launchable = [s for s in found if s.command]
        found = [s for s in found if s.url]
        skipped += [f"{s.name}: a command is not launched on a public site; run DeVries yourself to import it" for s in launchable]
        if not found:
            raise InvalidScenario("nothing here can be read on a public site: every server is a command. Paste a saved tools/list instead, "
                                  "or run DeVries on your own machine.")
    kind = "claude-code" if data.get("mcpServers") and client_name == "claude-code" else client_name if client_name in CLIENT_CONFIGS else "claude-desktop"
    origin = Origin(kind=kind, servers={s.id: s.name for s in found})
    fetched, more = await _fetch_all(found, timeout, max_tools)
    skipped += more
    if not fetched:
        raise InvalidScenario("nothing could be imported: " + "; ".join(skipped))
    return _write_import(root, name, client_name, "a pasted config", fetched, skipped, labels, origin, None)


def labels_of(scenario_path: Path) -> dict[str, str]:
    """The labels a scenario file holds now, so a refresh keeps them."""
    try:
        data = yaml.safe_load(scenario_path.read_text(encoding="utf-8")) or {}
    except (OSError, yaml.YAMLError):
        return {}
    out: dict[str, str] = {}
    for d in data.get("data_sources", []) or []:
        if isinstance(d, dict) and d.get("id") and d.get("trust"):
            out[d["id"]] = str(d["trust"])
    for r in data.get("resources", []) or []:
        if isinstance(r, dict) and r.get("id"):
            if r.get("impact"):
                out[r["id"]] = str(r["impact"])
            out[f"{r['id']}.external"] = "true" if r.get("external") else "false"
    return out


async def refresh_from_origin(origin: Origin, root: Path, name: str, labels_from: Path | None = None) -> ImportResult:
    """Read the origin's config again (the servers it names, and for Claude Code its permission rules), keep the
    manifests already saved for those servers so that nothing is launched, and write the scenario again with the
    labels it had. How a fix written to the real file is seen to have closed the finding."""
    if not origin.path or not Path(origin.path).is_file():
        raise InvalidScenario(f"the origin file is gone: {origin.path}")
    found = _from_config(Path(origin.path))
    rules = read_permissions(_settings_for(origin)) if origin.kind == "claude-code" else None
    fetched: list[tuple[ServerSource, Manifest]] = []
    skipped: list[str] = []
    for server in found:
        path = root / "manifests" / f"{server.id[4:]}.tools.json"
        if not path.is_file():
            skipped.append(f"{server.name}: no saved manifest; import again to fetch its tools")
            continue
        fetched.append((server, load_manifest(path)))
    if not fetched:
        raise InvalidScenario("no saved manifest for any server of the origin: " + "; ".join(skipped))
    labels = labels_of(labels_from) if labels_from else {}
    origin.hash = sha256(Path(origin.path).read_bytes()).hexdigest()
    origin.servers = {s.id: s.name for s in found}
    return _write_import(root, name, origin.kind, origin.path, fetched, skipped, labels, origin, rules)
