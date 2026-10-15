"""DeVries: a graph-backed security auditor for multi-agent LLM systems."""

import logging
import os

__version__ = "0.1.0"

# One JSON line per query is logged at INFO. Quiet by default; DEVRIES_LOG=info shows them.
logging.getLogger("devries").setLevel(os.environ.get("DEVRIES_LOG", "WARNING").upper())
