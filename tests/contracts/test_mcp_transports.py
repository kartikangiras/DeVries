"""The same server over the two transports people will use: stdio and Streamable HTTP inside the app."""

import asyncio
import json
import socket
import sys
import urllib.request
from pathlib import Path

import uvicorn
from mcp import Client, StdioServerParameters

from cistern.app import create_app
from cistern.ingest.scenario_loader import load_scenario

ROOT = Path(__file__).resolve().parents[2]


def payload(result) -> dict:
    assert not result.is_error, result.content
    return result.structured_content if result.structured_content is not None else json.loads(result.content[0].text)


async def test_stdio_server_answers_like_claude_desktop_would_see_it(client):
    await load_scenario(client, ROOT / "scenarios" / "acme_support.yaml", strict=True)
    server = StdioServerParameters(command=sys.executable, args=["-m", "cistern.mcp_server"], cwd=str(ROOT))
    async with Client(server) as session:
        assert {t.name for t in (await session.list_tools()).tools} >= {"scan", "find_injection_paths"}
        scanned = payload(await session.call_tool("scan", {"scenario": "acme_support"}))
        assert scanned["open"] == {"injection": 1, "trifecta": 0}
        found = payload(await session.call_tool("find_injection_paths", {"scenario": "acme_support"}))
        assert found["findings"][0]["paths"][0]["rules"] == [1, 2, 3, 5]


async def test_the_config_entry_launches_the_server_without_a_shell(client):
    """A desktop app starts the server from its config file with no shell behind it: a bare PATH, its own
    working directory. The entry `make mcp-config` prints has to work there, which a bare `uv` does not."""
    import os
    import shutil

    import pytest

    from cistern.mcp_server.__main__ import client_config

    if shutil.which("uv") is None:
        pytest.skip("uv is not installed here")
    await load_scenario(client, ROOT / "scenarios" / "acme_support.yaml", strict=True)
    entry = client_config()["mcpServers"]["cistern"]
    assert Path(entry["command"]).is_absolute() and str(ROOT) in entry["args"]
    bare = {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": os.environ["HOME"]}
    server = StdioServerParameters(command=entry["command"], args=entry["args"], env=bare, cwd="/")
    async with Client(server) as session:
        assert len((await session.list_tools()).tools) == 11
        scanned = payload(await session.call_tool("scan", {"scenario": "acme_support"}))
        assert scanned["open"] == {"injection": 1, "trifecta": 0}


async def test_mcp_is_mounted_in_the_app_and_health_runs_the_canary(client):
    """Probe Q16: the MCP server's Streamable HTTP endpoint lives inside the FastAPI app."""
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
        assert server.started

        def get_health() -> tuple[int, dict]:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health", timeout=20) as response:
                return response.status, json.loads(response.read())

        status, body = await asyncio.to_thread(get_health)
        assert status == 200, body
        assert body["ok"] and body["falkordb"] and body["canary"]["ok"] and body["scenarios"]["acme_support"]

        async with Client(f"http://127.0.0.1:{port}/mcp") as session:
            assert len((await session.list_tools()).tools) == 11
            listed = payload(await session.call_tool("list_scenarios", {}))
            assert any(s["id"] == "acme_support" for s in listed["scenarios"])
    finally:
        server.should_exit = True
        await task
