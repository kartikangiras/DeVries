"""Settings from the environment and from .env at the project root."""

from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict

ROOT = Path(__file__).resolve().parent.parent


class Settings(BaseSettings):
    # An empty value means "not set": docker compose passes VAR="" for a variable the host leaves unset.
    model_config = SettingsConfigDict(env_file=ROOT / ".env", extra="ignore", env_parse_none_str="")

    falkordb_host: str = "localhost"
    falkordb_port: int = 6380
    falkordb_username: str | None = None
    falkordb_password: str | None = None

    scenarios_dir: Path = ROOT / "scenarios"

    # how long a passing canary is trusted before it is run again
    canary_ttl_s: int = 300

    sandbox_budget: int = 20            # sandbox runs one baseline search may spend
    sandbox_ttl_min: int = 10           # a sandbox older than this was left behind by a crash

    # external MCP clients of /mcp must send this as a bearer token; unset leaves /mcp open (local use only)
    devries_mcp_token: str | None = None

    # the auditor's model; with no key every run is scripted
    anthropic_api_key: str | None = None
    llm_model: str = "claude-opus-5-5"
    llm_effort: Literal["low", "medium", "high", "xhigh", "max", "none"] = "medium"   # none: do not send the parameter
    llm_daily_budget_usd: float | None = None      # past this, new runs are scripted; unset means no ceiling
    approval_timeout_s: int = 900                  # how long an audit run waits for a person to decide

    # visitor sessions: private copies of the scenario graphs
    session_ttl_min: int = 60
    session_max: int = 30
    session_runs: int = 3                          # audit runs with a model, per session
    session_questions: int = 10                    # questions with a model, per session
    cookie_secure: bool = False                    # set on the public deployment, which is served over https

    # a public address: visitors never launch commands, an import is private to the session that made it, and
    # imports and runs are rationed per address. Nothing is ever written to a file on a public site.
    devries_public: bool = False
    import_dir: Path = ROOT / ".imports"          # per-session imports on a public site (scenarios/ and manifests/ under each)
    import_timeout_s: float = 10.0                 # tools/list over HTTPS from a pasted config
    import_max_tools: int = 200                    # tools kept per server from a pasted config
    rate_imports_per_hour: int = 6                 # per address, public only
    rate_runs_per_hour: int = 30                   # audit runs and questions per address, public only
    falkordb_memory_ceiling_mb: int | None = None  # past this, the janitor drops the oldest idle copies
    prerun_audits: bool = True                     # at start, audit each shared scenario to its proposal, scripted
    startup_db_wait_s: int = 60                    # how long the app waits for FalkorDB before starting without it

    # the built UI, served by the app when the directory exists
    ui_dist: Path = ROOT / "ui" / "dist"


@lru_cache
def get_settings() -> Settings:
    return Settings()
