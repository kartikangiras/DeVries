"""What the product is made of, in figures the pages quote: read from the code and the files, never typed twice."""

import json
from contextlib import suppress
from pathlib import Path
from typing import Any

from devries.config import ROOT, get_settings
from devries.graph.catalog import CATALOG
from devries.graph.projection import RULES
from devries.mitigation.dsl import COST


def version() -> str:
    """The one version string: the package's own, from its metadata."""
    try:
        from importlib.metadata import version as installed
        return installed("devries")
    except Exception:  # noqa: BLE001 - not installed as a package: read the project file
        import tomllib

        with suppress(OSError, tomllib.TOMLDecodeError, KeyError):
            return tomllib.loads((ROOT / "pyproject.toml").read_text())["project"]["version"]
        return "0.0.0"


EVAL_PATH = ROOT / "docs" / "eval.json"
MANIFEST_PATH = ROOT / "manifests" / "devries.tools.json"


def eval_results(path: Path = EVAL_PATH) -> dict[str, Any] | None:
    """The last `make agent-eval` with a model, as it wrote it, or None when none was kept."""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return data if isinstance(data, dict) and data.get("model") else None


def mcp_tool_count(path: Path = MANIFEST_PATH) -> int:
    """How many tools the MCP server publishes, from the manifest it writes of itself (a test fails when that is stale)."""
    try:
        return len(json.loads(path.read_text(encoding="utf-8")).get("tools", []))
    except (OSError, json.JSONDecodeError, AttributeError):
        return 0


def describe(version: str, model: str | None, scenarios: int) -> dict[str, Any]:
    return {
        "version": version,
        "rules": len(RULES),
        "fix_costs": dict(COST),
        "mcp_tools": mcp_tool_count(),
        "queries": len(CATALOG),
        "scenarios": scenarios,
        "model": model,
        "model_default": get_settings().llm_model,
        "eval": eval_results(),
    }
