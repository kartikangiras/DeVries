"""MCP tool manifests: snapshots of a server's `tools/list` result.

Everything in a manifest is untrusted text. Names are checked against a strict
pattern because they become part of a node id; descriptions are stored for
display only and reach a model only inside an untrusted-data block.
"""

import hashlib
import json
import re
import unicodedata
from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field

from cistern.errors import InvalidScenario

TOOL_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$")
MAX_DESCRIPTION = 2000


class ManifestTool(BaseModel):
    model_config = ConfigDict(extra="ignore")

    name: str
    description: str = ""
    inputSchema: dict = Field(default_factory=dict)
    annotations: dict | None = None


class Manifest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    tools: list[ManifestTool]
    source_url: str | None = None          # where a real public manifest was taken from


def _digest(value) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()[:16]


def tool_hashes(tool: ManifestTool) -> dict[str, str]:
    """A hash of each part of a tool's definition, so that a change can be named: its description, its
    input schema, its annotations. Stored on the Tool node; compared when the manifest is loaded again."""
    return {"description": _digest(tool.description), "schema": _digest(tool.inputSchema), "annotations": _digest(tool.annotations)}


def manifest_hash(manifest: Manifest) -> str:
    """One hash over every tool's name and parts, in name order: the manifest's identity for drift."""
    return _digest([[t.name, tool_hashes(t)] for t in sorted(manifest.tools, key=lambda t: t.name)])


def definition_changes(before: list[dict], after: list[dict]) -> dict:
    """What changed between two lists of {id, description, schema, annotations} hashes."""
    old = {t["id"]: t for t in before if t.get("id")}
    new = {t["id"]: t for t in after}
    changed = {}
    for tool_id in sorted(set(old) & set(new)):
        parts = [part for part in ("description", "schema", "annotations") if old[tool_id].get(part) != new[tool_id].get(part)]
        if parts:
            changed[tool_id] = parts
    return {"added": sorted(set(new) - set(old)), "removed": sorted(set(old) - set(new)), "changed": changed}


# The marks of a poisoned description: an instruction addressed to the model, text meant to be unseen,
# or a reach for other tools. Each pattern is named by what it is; the span found is quoted in the finding.
INSTRUCTION_PATTERNS = [
    ("ignores earlier instructions", re.compile(r"ignore (?:all |any )?(?:the )?(?:previous|prior|above|earlier) (?:instructions|messages|rules|context)", re.I)),
    ("hides something from the user", re.compile(r"(?:do not|don't|never|without) (?:tell|telling|mention|mentioning|reveal|revealing|inform|informing|show|showing|ask|asking)(?: this| it| that)?(?: to)? the user", re.I)),
    ("orders other tool calls", re.compile(r"(?:before|after) (?:calling|using|running|invoking) (?:(?:any|another|other|this|the|its|each|every) )+tools?", re.I)),
    ("orders the model", re.compile(r"\byou (?:must|should|need to|have to|are required to) (?:call|use|run|invoke|read|send|include|pass|first)", re.I)),
    ("orders the model", re.compile(r"\balways (?:call|use|run|invoke|include|send|pass|read)\b", re.I)),
    ("claims to be the system", re.compile(r"<\s*/?\s*(?:important|system|instructions?|hidden|secret|admin)\b[^>]*>", re.I)),
    ("claims to be the system", re.compile(r"\bsystem prompt\b", re.I)),
    ("sends data out", re.compile(r"\b(?:send|post|forward|upload|exfiltrate)\b[^.]{0,80}\bhttps?://", re.I)),
]
HIDDEN_RE = re.compile(r"[\u200b-\u200f\u2028-\u202f\u2060-\u2064\ufeff]")
COMMENT_RE = re.compile(r"<!--.*?-->", re.S)
PADDING_RE = re.compile(r"(?:[ \t]{40,}|\n{6,})")


def poison_flags(description: str, other_tool_names: set[str] = frozenset()) -> list[dict]:
    """What in a description reads as tool poisoning. Each flag: {kind, detail, span}. Empty is clean.
    `other_tool_names` are the tools of the other servers; a description that names one is reaching for it."""
    flags: list[dict] = []
    for detail, pattern in INSTRUCTION_PATTERNS:
        m = pattern.search(description)
        if m:
            flags.append({"kind": "instruction", "detail": detail, "span": _span(description, m.start(), m.end())})
    if HIDDEN_RE.search(description):
        chars = sorted({f"U+{ord(ch):04X}" for ch in HIDDEN_RE.findall(description)})
        flags.append({"kind": "hidden", "detail": "invisible characters", "span": ", ".join(chars[:6])})
    m = COMMENT_RE.search(description)
    if m:
        flags.append({"kind": "hidden", "detail": "an HTML comment", "span": _span(description, m.start(), m.end())})
    if PADDING_RE.search(description):
        flags.append({"kind": "hidden", "detail": "text pushed out of sight by blank space", "span": ""})
    for name in sorted(other_tool_names):
        if len(name) >= 4 and re.search(rf"(?<![\w.]){re.escape(name)}(?![\w])", description):
            flags.append({"kind": "shadowing", "detail": f"names another server's tool, {name}", "span": name})
    return flags


def _span(text: str, start: int, end: int, around: int = 30) -> str:
    a, b = max(0, start - around), min(len(text), end + around)
    return ("…" if a > 0 else "") + " ".join(text[a:b].split()) + ("…" if b < len(text) else "")


def clean_description(text: str) -> str:
    """Strip control characters (newlines and tabs become spaces) and cap the length."""
    out = []
    for ch in text:
        if ch in "\n\r\t":
            out.append(" ")
        elif unicodedata.category(ch).startswith("C"):
            continue
        else:
            out.append(ch)
    return re.sub(r" {2,}", " ", "".join(out)).strip()[:MAX_DESCRIPTION]


def capability_from_annotations(annotations: dict | None) -> str | None:
    """MCP annotations are hints from the server, so they may raise risk but are never taken as proof of safety."""
    if not annotations:
        return None
    if annotations.get("destructiveHint") is True:
        return "write"
    if annotations.get("readOnlyHint") is True:
        return "read"
    return None


def load_manifest(path: Path) -> Manifest:
    try:
        manifest = Manifest.model_validate(json.loads(path.read_text(encoding="utf-8")))
    except FileNotFoundError as e:
        raise InvalidScenario(f"manifest not found: {path}") from e
    except (json.JSONDecodeError, ValueError) as e:
        raise InvalidScenario(f"manifest {path.name} is not a valid tools/list result: {e}") from e
    names = [t.name for t in manifest.tools]
    for name in names:
        if not TOOL_NAME_RE.fullmatch(name):
            raise InvalidScenario(f"manifest {path.name}: tool name {name!r} is not usable as an id")
    dupes = sorted({n for n in names if names.count(n) > 1})
    if dupes:
        raise InvalidScenario(f"manifest {path.name}: duplicate tool names {dupes}")
    return manifest
