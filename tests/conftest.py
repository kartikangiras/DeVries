import secrets
import sys
from pathlib import Path

import pytest
import pytest_asyncio

sys.path.insert(0, str(Path(__file__).parent))

from cistern.graph import keys  # noqa: E402
from cistern.graph.client import GraphClient  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent


@pytest_asyncio.fixture(scope="session", loop_scope="session")
async def client():
    c = GraphClient()
    if not await c.ping():
        pytest.exit("FalkorDB is not reachable. Start it with `make up` (and check .env).", returncode=2)
    yield c
    for key in await c.list_graphs():
        if key.startswith("scn:t_") or key.startswith("sbx:"):
            await c.delete(key)
    await c.close()


@pytest_asyncio.fixture(loop_scope="session")
async def graph(client):
    """A fresh, empty working graph, deleted afterwards."""
    key = keys.scenario_key(f"t_{secrets.token_hex(5)}")
    yield key
    await client.delete(key)


@pytest_asyncio.fixture(loop_scope="session")
async def sandbox(client):
    """A fresh sandbox key, deleted afterwards."""
    key = keys.sandbox_key()
    yield key
    await client.delete(key)
