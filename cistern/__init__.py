"""Cistern: a graph-backed security auditor for multi-agent LLM systems."""

import logging
import os

__version__ = "0.1.0"

# One JSON line per query is logged at INFO. Quiet by default; CISTERN_LOG=info shows them.
logging.getLogger("cistern").setLevel(os.environ.get("CISTERN_LOG", "WARNING").upper())
