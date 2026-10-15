"""The one write to a person's file Cistern makes: a draft, after a person has read it and said yes.

It is refused on a public site, refused when the file is not the one that was imported, and done
with a backup beside the file and an atomic replace. Afterwards the shared scenario is read again
from the file and rescanned; the plan and the findings it closed are recorded on the new graph so
the story survives the reload; and the receipt (hashes before and after, what closed) is kept on
the draft. No tool reaches this: only the API, behind a person's click, and the command line.
"""

import json
import os
import time
from dataclasses import dataclass, field
from pathlib import Path

from cistern.config import get_settings
from cistern.errors import CisternError, ForbiddenWrite, NotFound
from cistern.events import bus
from cistern.graph import keys
from cistern.graph.client import GraphClient
from cistern.ingest.importer import refresh_from_origin
from cistern.ingest.scenario_loader import load_scenario, read_scenario
from cistern.mitigation import sandbox, store
from cistern.mitigation.compile import Draft, Origin, _check_scenario, _unified, compile_draft, file_hash
from cistern.mitigation.sandbox import StaleTarget


class NotWritable(CisternError):
    code = "not_writable"


@dataclass
class Receipt:
    draft_id: str
    path: str
    backup: str
    before_hash: str
    after_hash: str
    written_at: int
    written_by: str
    open_after: list[str] = field(default_factory=list)
    closed: list[str] = field(default_factory=list)
    reloaded: bool = False

    def to_dict(self) -> dict:
        return dict(self.__dict__)


def scenario_file(scenario: str, extra_dirs: list[Path] | None = None) -> Path | None:
    """The scenario's own file, wherever it was written: the bundled directory first, then the directories given."""
    for base in [get_settings().scenarios_dir, *(extra_dirs or [])]:
        path = base / f"{keys.scenario_key(scenario)[4:]}.yaml"
        if path.is_file():
            return path
    return None


def origin_of(scenario_path: Path | None) -> Origin | None:
    if scenario_path is None:
        return None
    return Origin.from_dict(read_scenario(scenario_path).spec.origin)


async def _tools_of(client: GraphClient, key: str) -> dict[str, list[str]]:
    out: dict[str, list[str]] = {}
    for row in await client.run("node.names", key):
        if row["label"] == "Tool" and row.get("server_id"):
            out.setdefault(row["server_id"], []).append(row["id"])
    return out


async def draft_for(client: GraphClient, key: str, scenario_path: Path | None, mitigation_id: str, names: dict[str, str],
                    record_it: bool = False) -> Draft:
    """Compile the plan into its draft, or read back the text a person edited, from the graph `key`."""
    mitigation = await store.get(client, key, mitigation_id)
    draft = compile_draft(origin_of(scenario_path), scenario_path, mitigation_id, list(mitigation.plan.fixes), names,
                          await _tools_of(client, key))
    stored = {d["id"]: d for d in await client.run("draft.for_mitigation", key, mitigation_id=mitigation_id)}
    kept = stored.get(draft.id)
    if kept and kept.get("edited") and kept.get("after_text") and kept.get("status") != "written":
        draft.after = kept["after_text"]
        draft.edited = True
        draft.diff = _unified(draft.before, draft.after, draft.path)
        draft.writable = bool(kept.get("writable"))
    if kept and kept.get("status") == "written":
        draft.note = f"Written to {draft.path} by {kept.get('written_by') or 'a person'}. " + draft.note
        draft.writable = False
    if record_it:
        await record(client, key, mitigation_id, draft)
    return draft


async def record(client: GraphClient, key: str, mitigation_id: str, draft: Draft) -> None:
    await client.run("draft.record", key, mitigation_id=mitigation_id, id=draft.id, now=int(time.time() * 1000), kind=draft.kind,
                     path=draft.path, before_hash=draft.before_hash, after_hash=draft.after_hash, diff=draft.diff, note=draft.note,
                     commands_json=json.dumps(draft.commands), after_text=draft.after, writable=draft.writable, edited=draft.edited)


async def edit(client: GraphClient, key: str, scenario_path: Path | None, mitigation_id: str, names: dict[str, str],
               after_text: str) -> Draft:
    """A person's edit of the text that would be written. Kept on the graph until it is written, or edited again."""
    draft = await draft_for(client, key, scenario_path, mitigation_id, names)
    if not draft.path:
        raise NotWritable("this draft is commands or a brief, not a file, so there is nothing to edit")
    draft.after = after_text
    draft.edited = after_text != draft.before
    draft.diff = _unified(draft.before, draft.after, draft.path)
    draft.writable = draft.edited
    if draft.kind == "scenario":
        problem = _check_scenario(after_text, Path(draft.path))
        if problem:
            draft.writable = False
            draft.note = f"The edited text does not load as a scenario: {problem}"
    elif draft.kind in ("claude-code", "claude-desktop", "cursor", "vscode"):
        try:
            json.loads(after_text)
        except json.JSONDecodeError as e:
            draft.writable = False
            draft.note = f"The edited text is not valid JSON: {e}"
    await record(client, key, mitigation_id, draft)
    return draft


async def write(client: GraphClient, source_key: str, shared_key: str, scenario_path: Path | None, mitigation_id: str,
                names: dict[str, str], who: str, after_text: str | None = None, root: Path | None = None) -> Receipt:
    """Write the draft of a plan (read from `source_key`, the graph where the plan was tested) to its file, then read the
    shared scenario again from that file. Only a person reaches this."""
    settings = get_settings()
    if settings.cistern_public:
        raise ForbiddenWrite("this is a public site: it offers the change to copy or download, and never writes a file here")
    mitigation = await store.get(client, source_key, mitigation_id)
    draft = await draft_for(client, source_key, scenario_path, mitigation_id, names)
    if after_text is not None and after_text != draft.after:
        draft = await edit(client, source_key, scenario_path, mitigation_id, names, after_text)
    if not draft.path:
        raise NotWritable(f"a {draft.kind} draft is commands or a brief, not a file; copy it where it goes")
    if not draft.writable:
        raise NotWritable(draft.note)
    path = Path(draft.path)
    origin = origin_of(scenario_path)
    if path.is_file():
        now = file_hash(path)
        if origin and origin.kind != "claude-code" and origin.hash and now != origin.hash:
            raise StaleTarget(f"{path} is not the file that was imported: it changed since. Import it again, then draft again.")
        if draft.before and now != draft.before_hash:
            raise StaleTarget(f"{path} changed after this draft was made. Draft again.")

    before_rows = await client.run("finding.list", shared_key) if await client.exists(shared_key) else []

    # the backup, then the atomic replace
    path.parent.mkdir(parents=True, exist_ok=True)
    backup = path.with_name(path.name + ".cistern.bak")
    if path.is_file():
        backup.write_bytes(path.read_bytes())
    tmp = path.with_name(path.name + ".cistern.tmp")
    tmp.write_text(draft.after, encoding="utf-8")
    os.replace(tmp, path)
    written_at = int(time.time() * 1000)

    # the shared scenario, read again from what was written, and scanned
    open_after: list[str] = []
    closed: list[str] = []
    reloaded = False
    if scenario_path is not None:
        base = root or scenario_path.parent.parent
        if draft.kind == "scenario":
            report = await load_scenario(client, scenario_path, root=base, graph_key=shared_key)
        else:
            assert origin is not None
            result = await refresh_from_origin(origin, base, keys.scenario_of(shared_key), labels_from=scenario_path)
            report = await load_scenario(client, result.scenario_path, root=base, graph_key=shared_key)
        reloaded = True
        present = {f.fingerprint for f in report.scan.findings}
        open_after = [f.id for f in report.scan.findings if f.status == "open"]
        gone = [row for row in before_rows if row["status"] == "open" and row["fingerprint"] not in present
                and row["kind"] in ("injection", "trifecta")]
        closed = sorted(row["id"] for row in gone)
        await _carry_over(client, shared_key, mitigation, gone, present, who, written_at)
        bus.publish(shared_key, "scan.finished", {"scan_id": report.scan.scan_id, "duration_ms": report.scan.duration_ms,
                                                  "partial": report.scan.partial, "open": open_after, "closed": closed})

    receipt = Receipt(draft_id=draft.id, path=str(path), backup=str(backup), before_hash=draft.before_hash, after_hash=file_hash(path),
                      written_at=written_at, written_by=who, open_after=open_after, closed=closed, reloaded=reloaded)
    try:
        await store.get(client, shared_key, mitigation_id)
    except NotFound:
        pass
    else:
        await record(client, shared_key, mitigation_id, draft)
        await client.run("draft.set_written", shared_key, id=draft.id, status="written", written_at=written_at, written_by=who,
                         receipt_json=json.dumps(receipt.to_dict()))
    return receipt


def announce(shared_key: str, mitigation_id: str, receipt: Receipt) -> None:
    """Tell the stream a draft was written: called once the writer's own copy is gone, so they hear it on the shared graph."""
    bus.publish(shared_key, "draft.written", {"mitigation_id": mitigation_id, **receipt.to_dict()})


async def _carry_over(client: GraphClient, shared_key: str, mitigation: store.Mitigation, gone: list[dict], present: set[str],
                      who: str, written_at: int) -> None:
    """A reload replaces the graph. The plan that was written, and the findings it closed, are put back on the new one
    so the ledger and the Done list still tell what happened: the plan applied, the findings mitigated."""
    if mitigation.verdict is None:
        return
    await store.record(client, shared_key, mitigation.verdict, config_hash=await sandbox.config_hash(client, shared_key),
                       source=mitigation.source, rationale=mitigation.rationale)
    await store.set_status(client, shared_key, mitigation.id, "approved", allowed=["proposed"], approved_by=who)
    await store.set_status(client, shared_key, mitigation.id, "applied", allowed=["approved"], applied_at=written_at)
    for row in gone:
        await client.run("finding.upsert", shared_key, fingerprint=row["fingerprint"], id=row["id"], kind=row["kind"],
                         severity=row["severity"], source_id=row.get("source_id"), target_id=row.get("target_id"),
                         agent_id=row.get("agent_id"), path_ids=[], evidence_json=row.get("evidence_json"), now=written_at)
    if gone:
        await client.run("mitigation.link_fixes", shared_key, id=mitigation.id, fingerprints=[row["fingerprint"] for row in gone])
        await client.run("finding.close_stale", shared_key, present=sorted(present), now=written_at)
