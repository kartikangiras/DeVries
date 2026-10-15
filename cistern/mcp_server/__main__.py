"""python -m cistern.mcp_server: the MCP server over stdio, for Claude Desktop or any local MCP client.

stdout carries the protocol; logs go to stderr and stay quiet unless CISTERN_LOG=info.

    python -m cistern.mcp_server --manifest         print this server's own tools/list result as a manifest
    python -m cistern.mcp_server --client-config    print the entry to paste into an MCP client's config file
"""

import asyncio
import json
import shutil
import sys
from pathlib import Path

from cistern.mcp_server.server import build_server, mcp


async def own_manifest() -> dict:
    """What this server answers to tools/list, in the shape of the files in manifests/.
    scenarios/cistern_self.yaml audits Cistern from it, and a test fails if the two drift apart."""
    from mcp import Client

    async with Client(build_server()) as client:
        tools = (await client.list_tools()).tools
    return {
        "server": "cistern",
        "synthetic": False,
        "note": "Cistern's own MCP server, as it answers tools/list. Regenerate with `make self-manifest`.",
        "tools": [{"name": t.name, "description": " ".join((t.description or "").split()), "inputSchema": t.input_schema}
                  for t in sorted(tools, key=lambda t: t.name)],
    }


def client_config() -> dict:
    """The entry for claude_desktop_config.json, or any client that launches a stdio server from a config file.

    Both paths are absolute on purpose. A desktop app is not started from a shell, so it does not have the
    shell's PATH: a bare `uv` is not found when uv lives in ~/.local/bin, which is where its installer puts it.
    `--directory` tells uv which project to run, whatever directory the app starts it in; .env is read from
    the project folder either way."""
    root = Path(__file__).resolve().parents[2]
    uv = shutil.which("uv")
    if uv is None:
        raise SystemExit("uv is not on this PATH; install it (https://docs.astral.sh/uv/) or edit the command by hand")
    return {"mcpServers": {"cistern": {
        "command": uv, "args": ["run", "--directory", str(root), "python", "-m", "cistern.mcp_server"]}}}


if __name__ == "__main__":
    if "--manifest" in sys.argv[1:]:
        print(json.dumps(asyncio.run(own_manifest()), indent=2))
    elif "--client-config" in sys.argv[1:]:
        print(json.dumps(client_config(), indent=2))
    else:
        mcp.run()
