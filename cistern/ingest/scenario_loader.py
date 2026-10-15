"""Scenario YAML + MCP manifests -> a scenario graph, then a scan checked against the file's own expectations."""

import json
from pathlib import Path

import yaml
from pydantic import BaseModel, Field, ValidationError

from cistern.analysis import findings as findings_mod
from cistern.analysis.models import ScanResult
from cistern.errors import InvalidScenario
from cistern.graph import keys, schema
from cistern.graph.client import GraphClient
from cistern.ingest.manifests import (capability_from_annotations, clean_description, definition_changes, load_manifest,
                                      manifest_hash, poison_flags, tool_hashes)
from cistern.ingest.models import ScenarioFile, server_suffix, tool_id


class Resolved(BaseModel):
    """A validated scenario, flattened into the rows the ingest queries take."""
    spec: ScenarioFile
    nodes: dict[str, list[dict]]
    edges: dict[str, list[dict]]


class LoadReport(BaseModel):
    scenario: str
    graph: str
    nodes: dict[str, int]
    edges: dict[str, int]
    scan: ScanResult
    mismatches: list[str] = Field(default_factory=list)   # where the scan disagrees with `expect`
    drift: list[str] = Field(default_factory=list)        # drift findings opened: a manifest changed since the last load
    poisoned: list[str] = Field(default_factory=list)     # findings opened for descriptions that read as tool poisoning

    @property
    def ok(self) -> bool:
        return not self.mismatches


def read_scenario(path: Path, root: Path | None = None) -> Resolved:
    """Validate the file, resolve every tool against its manifest, and build the rows."""
    path = Path(path)
    root = root or path.resolve().parent.parent
    try:
        raw = yaml.safe_load(path.read_text(encoding="utf-8"))
        spec = ScenarioFile.model_validate(raw)
    except FileNotFoundError as e:
        raise InvalidScenario(f"scenario file not found: {path}") from e
    except yaml.YAMLError as e:
        raise InvalidScenario(f"{path.name} is not valid YAML: {e}") from e
    except ValidationError as e:
        first = e.errors()[0]
        where = ".".join(str(p) for p in first["loc"])
        raise InvalidScenario(f"{path.name}: {where + ': ' if where else ''}{first['msg']}") from e

    if path.stem != spec.scenario:
        raise InvalidScenario(f"{path.name}: the file must be named after its scenario ({spec.scenario}.yaml)")

    facts = {t.id: t for t in spec.tools}
    servers, tools = [], []
    manifests = {}
    for server in spec.servers:
        manifest_path = Path(server.manifest)
        manifests[server.id] = load_manifest(manifest_path if manifest_path.is_absolute() else root / manifest_path)
    for server in spec.servers:
        manifest = manifests[server.id]
        others = {t.name for sid, m in manifests.items() if sid != server.id for t in m.tools}
        servers.append({
            "id": server.id, "name": server.name or server_suffix(server.id),
            "source_url": None if server.synthetic else (server.source_url or manifest.source_url),
            "synthetic": server.synthetic, "manifest_hash": manifest_hash(manifest),
        })
        for entry in manifest.tools:
            tid = tool_id(server.id, entry.name)
            fact = facts.get(tid)
            from_hints = capability_from_annotations(entry.annotations)
            if fact is not None and fact.capability is not None:
                capability, source = fact.capability, "manual"
            elif from_hints is not None:
                capability, source = from_hints, "manifest"
            else:
                capability, source = "unknown", "none"
            hashes = tool_hashes(entry)
            tools.append({
                "id": tid, "name": entry.name, "server_id": server.id,
                "description": clean_description(entry.description),
                "capability": capability, "capability_source": source,
                "h_description": hashes["description"], "h_schema": hashes["schema"], "h_annotations": hashes["annotations"],
                "poison_flags": json.dumps(poison_flags(entry.description, others)),
            })

    known_tools = {t["id"] for t in tools}
    missing = sorted(set(facts) - known_tools)
    if missing:
        raise InvalidScenario(f"{path.name}: tools declared in the file but absent from their manifests: {missing}")
    for agent in spec.agents:
        unknown = sorted({g.id for g in agent.can_call} - known_tools)
        if unknown:
            raise InvalidScenario(f"{path.name}: {agent.id} can_call refers to unknown tools: {unknown}")
    for wf in spec.workflows:
        unknown = sorted(set(wf.needs) - known_tools)
        if unknown:
            raise InvalidScenario(f"{path.name}: {wf.id} needs unknown tools: {unknown}")

    nodes = {
        "servers": servers,
        "tools": tools,
        "data_sources": [{"id": d.id, "name": d.name, "trust": d.trust} for d in spec.data_sources],
        "resources": [{"id": r.id, "name": r.name, "impact": r.impact, "external": r.external} for r in spec.resources],
        "agents": [{"id": a.id, "name": a.name, "owner": a.owner} for a in spec.agents],
        "workflows": [{"id": w.id, "name": w.name or w.id.split(":", 1)[1], "description": w.description, "mode": w.mode}
                      for w in spec.workflows],
    }
    edges = {
        "can_call": [{"from_id": a.id, "to_id": g.id, "gate": g.gate, "origin": "scenario"}
                     for a in spec.agents for g in a.can_call],
        "delegates_to": [{"from_id": a.id, "to_id": d.id, "gate": d.gate, "origin": "scenario"}
                         for a in spec.agents for d in a.delegates_to],
        "reads": [{"from_id": t.id, "to_id": s} for t in spec.tools for s in t.reads],
        "writes": [{"from_id": t.id, "to_id": r} for t in spec.tools for r in t.writes],
        "feeds": [{"from_id": r.id, "to_id": s} for r in spec.resources for s in r.feeds],
        "run_by": [{"from_id": w.id, "to_id": w.run_by} for w in spec.workflows],
        "needs": [{"from_id": w.id, "to_id": t} for w in spec.workflows for t in w.needs],
        "needs_data": [{"from_id": w.id, "to_id": s} for w in spec.workflows for s in w.reads],
    }
    return Resolved(spec=spec, nodes=nodes, edges=edges)


def compare(spec: ScenarioFile, scan: ScanResult) -> list[str]:
    """Where a scan disagrees with the file's `expect` block. Empty means it agrees."""
    found_injection = {(f.source_id, f.target_id) for f in scan.findings if f.kind == "injection"}
    found_trifecta = {f.agent_id for f in scan.findings if f.kind == "trifecta"}
    want_injection = {tuple(pair) for pair in spec.expect.injection}
    want_trifecta = set(spec.expect.trifecta)
    problems = []
    for source, target in sorted(want_injection - found_injection):
        problems.append(f"expected injection {source} -> {target} was not found")
    for source, target in sorted(found_injection - want_injection):
        problems.append(f"unexpected injection {source} -> {target}")
    for agent in sorted(want_trifecta - found_trifecta):
        problems.append(f"expected trifecta agent {agent} was not found")
    for agent in sorted(found_trifecta - want_trifecta):
        problems.append(f"unexpected trifecta agent {agent}")
    for finding in scan.findings:
        if not finding.evidence:
            problems.append(f"finding {finding.id} has no evidence path")
    return problems


async def write_graph(client: GraphClient, graph_key: str, resolved: Resolved) -> tuple[dict[str, int], dict[str, int]]:
    """Write the resolved rows into an existing (bootstrapped or empty) graph."""
    node_counts, edge_counts = {}, {}
    for name, rows in resolved.nodes.items():           # servers before tools: tools tie to their server
        node_counts[name] = (await client.run(f"ingest.{name}", graph_key, rows=rows))[0]["written"] if rows else 0
    for name, rows in resolved.edges.items():
        edge_counts[name] = (await client.run(f"ingest.{name}", graph_key, rows=rows))[0]["written"] if rows else 0
        if edge_counts[name] != len(rows):
            raise InvalidScenario(f"{name}: wrote {edge_counts[name]} of {len(rows)} edges; an endpoint is missing")
    return node_counts, edge_counts


async def load_scenario(client: GraphClient, path: Path, *, strict: bool = False, root: Path | None = None,
                        graph_key: str | None = None) -> LoadReport:
    """Replace scn:<scenario> (or the working graph named) with the contents of the file, scan it, and compare with `expect`."""
    resolved = read_scenario(Path(path), root)
    graph_key = graph_key or keys.scenario_key(resolved.spec.scenario)

    # what each server's tools looked like last time, read before the graph is replaced
    before: dict[str, dict] = {}
    if await client.exists(graph_key):
        before = {row["server_id"]: row for row in await client.run("drift.before", graph_key)}

    await client.delete(graph_key)
    await schema.bootstrap(client, graph_key)
    node_counts, edge_counts = await write_graph(client, graph_key, resolved)

    scan = await findings_mod.scan(client, graph_key)     # rebuilds the projection first
    mismatches = compare(resolved.spec, scan)
    if strict and mismatches:
        raise InvalidScenario(f"{resolved.spec.scenario}: the scan disagrees with expect: " + "; ".join(mismatches))

    # a manifest that is not the one loaded before is a finding of its own, until a person accepts it
    drift: list[str] = []
    for server in resolved.nodes["servers"]:
        old = before.get(server["id"])
        if old is None or not old.get("manifest_hash") or old["manifest_hash"] == server["manifest_hash"]:
            continue
        now = [{"id": t["id"], "description": t["h_description"], "schema": t["h_schema"], "annotations": t["h_annotations"]}
               for t in resolved.nodes["tools"] if t["server_id"] == server["id"]]
        changes = definition_changes(old["tools"], now)
        finding = await findings_mod.open_drift(client, graph_key, server["id"], server["manifest_hash"], changes)
        drift.append(finding.id)

    # a description that reads as an instruction to the model is a finding too, higher when its tool is on a path
    on_paths = {node for f in scan.findings for p in f.evidence for node in p.node_ids}
    poisoned: list[str] = []
    for tool in resolved.nodes["tools"]:
        flags = json.loads(tool["poison_flags"])
        if flags:
            finding = await findings_mod.open_poisoned(client, graph_key, tool["id"], tool["h_description"], flags,
                                                      on_path=tool["id"] in on_paths)
            poisoned.append(finding.id)
    return LoadReport(scenario=resolved.spec.scenario, graph=graph_key, nodes=node_counts, edges=edge_counts,
                      scan=scan, mismatches=mismatches, drift=drift, poisoned=poisoned)
