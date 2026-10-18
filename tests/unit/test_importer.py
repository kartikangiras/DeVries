"""Importing a real install: DeVries's own server over stdio stands in for one, so no network is needed."""

import json
import sys
from pathlib import Path

import pytest

from devries.analysis import findings
from devries.errors import InvalidScenario
from devries.ingest.importer import discover, draft, guess, import_install, slug
from devries.ingest.scenario_loader import load_scenario, read_scenario

ROOT = Path(__file__).resolve().parents[2]
OWN = f"{sys.executable} -m devries.mcp_server"


def test_sources_are_told_apart_and_servers_named(tmp_path):
    client, servers = discover("npx -y @modelcontextprotocol/server-filesystem /tmp")
    assert client == "client" and servers[0].id == "srv:filesystem" and servers[0].command == "npx"
    assert discover("https://host.example/mcp")[1][0].url == "https://host.example/mcp"
    config = tmp_path / "claude_desktop_config.json"
    config.write_text(json.dumps({"mcpServers": {"GitHub Issues": {"command": "npx", "args": ["-y", "x"], "env": {"TOKEN": "t"}},
                                                 "remote": {"url": "https://r.example/mcp"}, "broken": {}}}))
    client, servers = discover(str(config))
    assert client == "claude_desktop_config" and [s.id for s in servers] == ["srv:github-issues", "srv:remote"]
    assert servers[0].env == {"TOKEN": "t"} and servers[1].url == "https://r.example/mcp"
    saved = tmp_path / "helpdesk.tools.json"
    saved.write_text(json.dumps({"tools": [{"name": "get"}]}))
    assert discover(str(saved))[1][0].manifest_path == saved
    with pytest.raises(InvalidScenario):
        discover("claude-desktop" if not any(p.is_file() for p in __import__("devries.ingest.importer", fromlist=["CLIENT_CONFIGS"]).CLIENT_CONFIGS["claude-desktop"]) else "   ")
    assert slug("@modelcontextprotocol/server-filesystem") == "filesystem" and slug("My Server!") == "my-server"
    assert guess("github") == {"trust": "untrusted", "impact": None, "external": True}
    assert guess("filesystem")["trust"] == "private" and guess("filesystem")["impact"] == "high"


async def test_an_install_is_imported_labelled_and_scanned(client, tmp_path):
    result = await import_install(OWN, tmp_path, name="import_test", labels={"src:devries-mcp-server": "untrusted"})
    assert result.servers == ["srv:devries-mcp-server"]
    assert result.tools == 11 and result.skipped == []
    spec = read_scenario(result.scenario_path, root=tmp_path).spec
    assert spec.imported and spec.imported["client"] == "client" and spec.order == 50
    assert len(spec.agents) == 1 and len(spec.agents[0].can_call) == 11 and spec.workflows == []
    server = result.servers[0][4:]
    source = next(d for d in spec.data_sources if d.id == f"src:{server}")
    resource = next(r for r in spec.resources if r.id == f"res:{server}")
    assert source.trust == "untrusted" and resource.impact == "unknown"       # one label given, the other still unknown

    key = "scn:import_test"
    try:
        report = await load_scenario(client, result.scenario_path, root=tmp_path)
        assert report.scan.findings == []                                        # unknown impact: nothing is high, no finding
        text = result.scenario_path.read_text().replace("impact: unknown", "impact: high")
        result.scenario_path.write_text(text)
        report = await load_scenario(client, result.scenario_path, root=tmp_path)
        kinds = sorted(f.kind for f in report.scan.findings)
        assert "injection" in kinds                                              # labelled, the import has findings of its own
        current, _ = await findings.current(client, key)
        assert any(f.kind == "injection" for f in current)
    finally:
        await client.delete(key)


def test_a_draft_reads_like_a_scenario_file(tmp_path):
    from devries.ingest.importer import ServerSource
    from devries.ingest.manifests import Manifest, ManifestTool

    manifest = Manifest(tools=[ManifestTool(name="read_file", annotations={"readOnlyHint": True}),
                               ManifestTool(name="write_file", annotations={"destructiveHint": True}),
                               ManifestTool(name="search")])
    text = draft("import_x", "Claude Desktop", "claude-desktop", [(ServerSource(id="srv:filesystem", name="filesystem", command="npx"), manifest)])
    (tmp_path / "manifests").mkdir()
    (tmp_path / "manifests" / "filesystem.tools.json").write_text(json.dumps({"tools": [t.model_dump() for t in manifest.tools]}))
    (tmp_path / "scenarios").mkdir()
    path = tmp_path / "scenarios" / "import_x.yaml"
    path.write_text(text)
    spec = read_scenario(path, root=tmp_path).spec
    tools = {t.id: t for t in spec.tools}
    assert tools["tool:filesystem.read_file"].reads == ["src:filesystem"] and tools["tool:filesystem.read_file"].writes == []
    assert tools["tool:filesystem.write_file"].writes == ["res:filesystem"] and tools["tool:filesystem.write_file"].reads == []
    assert tools["tool:filesystem.search"].reads == ["src:filesystem"] and tools["tool:filesystem.search"].writes == ["res:filesystem"]
    assert spec.agents[0].id == "agent:claude-desktop" and "guess from the name: private" in text
