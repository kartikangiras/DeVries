"""The grounding check: model text may only cite ids that a tool returned in the same run.

It checks ids, not sentences. A model can still say something false about a
real id; what it cannot do is invent a path through nodes that do not exist,
or cite a finding or a mitigation that was never produced.
"""

import json
import re
from typing import Any

# every id Cistern issues: node ids, finding ids, mitigation ids, scan ids
ID_RE = re.compile(r"\b(?:agent|tool|src|res|wf|srv|fnd|mit|scan):[A-Za-z0-9][A-Za-z0-9_.\-]*")


def ids_in(text: str | None) -> set[str]:
    """Id-shaped tokens in a piece of text. Sentence punctuation after an id is not part of it."""
    return {m.rstrip(".-_") for m in ID_RE.findall(text or "")}


def ids_of(value: Any) -> set[str]:
    """Every id anywhere in a tool result, or in anything else that serialises to JSON."""
    return ids_in(value if isinstance(value, str) else json.dumps(value, default=str))


def ungrounded(text: str | None, known: set[str]) -> list[str]:
    """Ids the text cites that no tool result in this run contains."""
    return sorted(ids_in(text) - known)


def correction(unknown: list[str]) -> str:
    return ("Your last message cited ids that no tool returned in this run: " + ", ".join(unknown) + ". "
            "Write it again, citing only ids that appear in the tool results above, exactly as returned.")
