"""How engine results are shown. One place, so the MCP tools, the API and the event stream agree.

Everything here is built from our own ids. Names that came from a manifest are
added by the caller, which knows whether its reader is a model or a person.
"""

from typing import Any

from cistern.analysis.models import EdgeScore, Finding, PathEvidence, finding_id
from cistern.mitigation.dsl import Broken, Diff, FindingRef, Verdict, config_patch, describe
from cistern.mitigation.store import Mitigation


def hop_sentence(rule: int, a: str, b: str) -> str:
    """One hop of a path, a -> b, as a sentence."""
    return {
        1: f"rule 1: {b} reads {a}",
        2: f"rule 2: {b} calls {a}, so what it returns enters {b}'s context",
        3: f"rule 3: {a} can call {b}",
        4: f"rule 4: {a} delegates to {b}, passing its context down",
        5: f"rule 5: {a} acts on {b}",
        6: f"rule 6: {a} returns its results to {b}",
        7: f"rule 7: what is written to {a} is read back from {b}",
    }.get(rule, f"rule {rule}: {a} -> {b}")


# The config relationship each flow rule is derived from, as (type, whether it runs against the hop's direction).
_BEHIND = {1: ("READS", True), 2: ("CAN_CALL", True), 3: ("CAN_CALL", False),
           4: ("DELEGATES_TO", False), 5: ("WRITES", False), 6: ("DELEGATES_TO", True), 7: ("FEEDS", False)}


def behind_hop(rule: int, a: str, b: str) -> dict[str, Any]:
    """What sits behind the flow hop a -> b: the config edge it was derived from, and the fixes that can cut it.

    `fixes` empty means the hop cannot be cut at all (rules 4, 5 and 7: context always passes down, a tool
    always acts, and what is stored is read back)."""
    from cistern.analysis.chokepoints import FIXES

    rel, reversed_ = _BEHIND[rule]
    return {
        "config": {"rel": rel, "from_id": b if reversed_ else a, "to_id": a if reversed_ else b},
        "fixes": list(FIXES.get(rule, [])),
    }


def cut_hop(score: EdgeScore) -> dict[str, Any]:
    """One edge of a min cut: the flow hop it is, the config edge behind it, and what cutting it costs."""
    edge = score.edge
    _, reversed_ = _BEHIND[edge.rule]
    a, b = (edge.to_id, edge.from_id) if reversed_ else (edge.from_id, edge.to_id)
    return {"from_id": a, "to_id": b, "rule": edge.rule, "sentence": hop_sentence(edge.rule, a, b),
            "config": {"rel": edge.rel, "from_id": edge.from_id, "to_id": edge.to_id},
            "capacity": int(score.score), "fixes": score.fixes}


def path_view(path: PathEvidence) -> dict[str, Any]:
    return {
        "node_ids": path.node_ids,
        "rules": path.rules,
        "hops": [hop_sentence(rule, path.node_ids[i], path.node_ids[i + 1]) for i, rule in enumerate(path.rules)],
    }


# OWASP Top 10 for Agentic Applications (2026): the classes a finding belongs to, for people who read risk by that list.
TAXONOMY: dict[str, list[tuple[str, str]]] = {
    "injection": [("ASI01", "Agent goal hijack"), ("ASI02", "Tool misuse and exploitation")],
    "trifecta": [("ASI03", "Identity and privilege abuse"), ("ASI02", "Tool misuse and exploitation")],
    "drift": [("ASI04", "Agentic supply chain")],
    "poisoned_description": [("ASI04", "Agentic supply chain"), ("ASI01", "Agent goal hijack")],
}


def taxonomy_view(kind: str) -> list[dict[str, str]]:
    return [{"code": code, "name": name} for code, name in TAXONOMY.get(kind, [])]


def finding_view(finding: Finding, max_paths: int | None = None) -> dict[str, Any]:
    base: dict[str, Any] = {"id": finding.id, "kind": finding.kind, "severity": finding.severity, "status": finding.status,
                            "taxonomy": taxonomy_view(finding.kind)}
    if finding.kind == "drift":
        base |= {"server_id": finding.server_id, "drift": finding.drift or {}, "accepted_by": finding.accepted_by, "paths": []}
        return base
    if finding.kind == "poisoned_description":
        base |= {"tool_id": finding.tool_id, "flags": finding.flags, "accepted_by": finding.accepted_by, "paths": []}
        return base
    if finding.kind == "injection":
        base |= {
            "source_id": finding.source_id, "target_id": finding.target_id,
            "paths": [path_view(p) for p in finding.evidence[:max_paths]],
            "paths_found": finding.routes if finding.routes is not None else len(finding.evidence),
            "paths_capped": finding.routes_capped,
        }
    else:
        legs = {p.leg: path_view(p) for p in finding.evidence}
        base |= {
            "agent_id": finding.agent_id,
            "untrusted_ids": finding.untrusted_ids, "private_ids": finding.private_ids, "exit_ids": finding.exit_ids,
            "legs": {"untrusted_in": legs.get("untrusted"), "private_in": legs.get("private"), "exit_out": legs.get("exit")},
        }
    if finding.evidence_lifted:
        base["note"] = "no path within 12 hops; the hop limit was raised to find this one"
    return base


def finding_ref_view(ref: FindingRef) -> dict[str, Any]:
    out: dict[str, Any] = {"id": ref.id, "kind": ref.kind}
    if ref.kind == "injection":
        out |= {"source_id": ref.source_id, "target_id": ref.target_id}
    else:
        out |= {"agent_id": ref.agent_id}
    if ref.path_ids:
        out["path_ids"] = ref.path_ids
    return out


def broken_view(item: Broken) -> dict[str, Any]:
    return {"workflow_id": item.workflow_id, "kind": item.kind, "missing_id": item.missing_id, "mode": item.mode,
            "why": item.sentence()}


def diff_view(d: Diff) -> dict[str, Any]:
    return {
        "resolved": [d.findings[fp].id for fp in d.resolved],
        "introduced": [finding_ref_view(d.findings[fp]) for fp in d.introduced],
        "newly_broken": [broken_view(b) for b in d.newly_broken],
        "open_before": [d.findings[fp].id for fp in d.open_before],
        "open_after": [d.findings[fp].id for fp in d.open_after],
        "sandbox_ms": d.sandbox_ms,
    }


def verdict_view(v: Verdict) -> dict[str, Any]:
    return {
        "passed": v.passed,
        "reason": v.reason,
        "plan": v.plan.model_dump(), "cost": v.plan.cost,
        "summary": [describe(f) for f in v.plan.fixes],
        "targets": [finding_id(fp) for fp in v.targets],
        "remaining": [finding_id(fp) for fp in v.remaining],
    } | diff_view(v.diff)


def mitigation_view(m: Mitigation) -> dict[str, Any]:
    out: dict[str, Any] = {
        "id": m.id, "status": m.status, "passed": m.passed, "cost": m.cost, "source": m.source,
        "plan": m.plan.model_dump(), "summary": [describe(f) for f in m.plan.fixes],
        "patch": [config_patch(f) for f in m.plan.fixes],
        "targets": [finding_id(fp) for fp in m.targets],
        "reason": m.reason, "rationale": m.rationale,
        "approved_by": m.approved_by, "decision_reason": m.decision_reason,
        "created_at": m.created_at, "applied_at": m.applied_at, "config_hash": m.config_hash,
    }
    if m.verdict is not None:
        out |= {k: v for k, v in diff_view(m.verdict.diff).items()}
    return out


# ---------------------------------------------------------------------- a finding as a document, and as a picture

KIND_WORDS = {"injection": "Injection path", "trifecta": "Lethal trifecta", "drift": "Manifest drift", "poisoned_description": "Poisoned description"}


def path_ids_of(view: dict[str, Any]) -> list[str]:
    """One path a person can follow, from a finding view: the first route, or the untrusted leg joined to the exit leg."""
    if view["kind"] == "injection":
        return view["paths"][0]["node_ids"] if view.get("paths") else []
    if view["kind"] == "trifecta":
        legs = view.get("legs") or {}
        into, out = legs.get("untrusted_in"), legs.get("exit_out")
        return (into["node_ids"] if into else []) + (out["node_ids"][1:] if out else [])
    if view["kind"] == "poisoned_description":
        return [view["tool_id"]] if view.get("tool_id") else []
    return [view["server_id"]] if view.get("server_id") else []


def headline_of(view: dict[str, Any], names: dict[str, str]) -> str:
    name = lambda i: names.get(i, i) if i else "?"  # noqa: E731
    if view["kind"] == "injection":
        return f"{name(view.get('source_id'))} can reach {name(view.get('target_id'))}."
    if view["kind"] == "trifecta":
        return f"{name(view.get('agent_id'))} holds untrusted input, private data and a way out."
    if view["kind"] == "drift":
        return f"{name(view.get('server_id'))} changed its tool definitions."
    return f"{name(view.get('tool_id'))} carries instructions in its description."


def brief_markdown(scenario: str, view: dict[str, Any], names: dict[str, str], plans: list[dict[str, Any]],
                   draft: dict[str, Any] | None = None) -> str:
    """The finding as a document to forward: the headline, the path, every plan a sandbox was asked about, the change
    to the configuration if one was drafted, and the queries it rests on. No model wrote any of it."""
    name = lambda i: names.get(i, i)  # noqa: E731
    out = [f"# {headline_of(view, names)}", "",
           f"**{view['id']}** · {KIND_WORDS.get(view['kind'], view['kind'])} · severity {view['severity']} · {view['status']} · scenario `{scenario}`",
           ""]
    taxonomy = ", ".join(f"{t['code']} {t['name']}" for t in view.get("taxonomy", []))
    if taxonomy:
        out += [f"OWASP Top 10 for Agentic Applications: {taxonomy}.", ""]
    if view["kind"] == "injection" and view.get("paths"):
        path = view["paths"][0]
        out += [f"Whatever an outsider writes into {name(view['source_id'])} can end up acting on {name(view['target_id'])}, "
                f"in {len(path['rules'])} hops with no person in between. "
                f"{view.get('paths_found', len(view['paths']))} route(s) were found{' or more' if view.get('paths_capped') else ''}.", "",
                "## The path", ""]
        out += [f"{i + 1}. {hop_sentence(rule, name(path['node_ids'][i]), name(path['node_ids'][i + 1]))}" for i, rule in enumerate(path["rules"])]
        out.append("")
    elif view["kind"] == "trifecta":
        out += [f"{name(view['agent_id'])} is reached by untrusted text ({', '.join(name(i) for i in view.get('untrusted_ids', []))}) and by "
                f"private data ({', '.join(name(i) for i in view.get('private_ids', []))}), and can reach a way out "
                f"({', '.join(name(i) for i in view.get('exit_ids', []))}). That is all three properties of Meta's Agents Rule of Two in one context.", ""]
        legs = view.get("legs") or {}
        for label, key in (("Untrusted input reaches the agent", "untrusted_in"), ("Private data reaches the agent", "private_in"), ("The agent can reach a way out", "exit_out")):
            leg = legs.get(key)
            if leg:
                out += [f"## {label}", ""] + [f"{i + 1}. {hop_sentence(rule, name(leg['node_ids'][i]), name(leg['node_ids'][i + 1]))}" for i, rule in enumerate(leg["rules"])] + [""]
    elif view["kind"] == "drift":
        d = view.get("drift") or {}
        out += ["## What changed", ""] + [f"- `{t}`: {', '.join(parts)} changed" for t, parts in (d.get("changed") or {}).items()]
        out += [f"- `{t}`: added" for t in d.get("added", [])] + [f"- `{t}`: removed" for t in d.get("removed", [])] + [""]
    elif view["kind"] == "poisoned_description":
        out += ["## What was found", ""] + [f"- {f['detail']}: “{f['span']}”" if f.get("span") else f"- {f['detail']}" for f in view.get("flags", [])] + [""]
    if plans:
        out += ["## Plans tested in sandbox graphs", ""]
        for m in plans:
            mark = "✓" if m.get("passed") else "✕"
            what = ", and ".join(name(x) if x in names else x for x in m.get("summary", []))
            why = (f"resolves {len(m.get('resolved') or [])} · introduces {len(m.get('introduced') or [])} · breaks {len(m.get('newly_broken') or [])}"
                   if m.get("passed") else (m.get("reason") or "did not pass"))
            status = m.get("status", "")
            who = f" · {status} by {m['approved_by']}" if m.get("approved_by") else f" · {status}" if status in ("applied", "approved") else ""
            out.append(f"- {mark} {what} · cost {m.get('cost')} · {why}{who}")
        out.append("")
    if draft and draft.get("after"):
        out += [f"## The change to the configuration ({draft.get('kind')})", ""]
        if draft.get("diff"):
            out += ["```diff", draft["diff"].rstrip("\n"), "```", ""]
        elif draft.get("commands"):
            out += ["```sh", *draft["commands"], "```", ""]
        else:
            out += [draft["after"].rstrip("\n"), ""]
        if draft.get("note"):
            out += [draft["note"], ""]
    queries = {"injection": "reach.untrusted_to_high and evidence.pair_paths", "trifecta": "find.trifecta and evidence.pair_paths",
               "drift": "drift.before", "poisoned_description": "ingest.tools"}[view["kind"]]
    out += ["---", f"Put together by Cistern from FalkorDB queries ({queries}); no model wrote this brief. Nothing changes a configuration until a person approves it.", ""]
    return "\n".join(out)


def figure_svg(view: dict[str, Any], names: dict[str, str]) -> str:
    """The finding's path as one small picture: dots in a row, the source and the sink marked, the rule on each hop."""
    ids = path_ids_of(view)
    if not ids:
        ids = [view.get("source_id") or view.get("agent_id") or view.get("tool_id") or view.get("server_id") or "?"]
    rules: list[int] = []
    if view["kind"] == "injection" and view.get("paths"):
        rules = view["paths"][0]["rules"]
    elif view["kind"] == "trifecta":
        legs = view.get("legs") or {}
        rules = (legs.get("untrusted_in") or {}).get("rules", []) + (legs.get("exit_out") or {}).get("rules", [])
    step, left, y = 150, 80, 92
    width = left * 2 + step * (len(ids) - 1)
    esc = lambda t: t.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")  # noqa: E731
    parts = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="170" viewBox="0 0 {width} 170" '
             'font-family="Geist Sans, Inter, system-ui, sans-serif">',
             f'<rect width="{width}" height="170" rx="14" fill="#0c0b09"/>',
             f'<text x="{left}" y="30" fill="#e8e4dc" font-size="14" font-weight="500">{esc(headline_of(view, names))}</text>',
             f'<text x="{left}" y="48" fill="#8f8a80" font-size="10" font-family="Geist Mono, ui-monospace, monospace">'
             f'{esc(view["id"])} · {esc(KIND_WORDS.get(view["kind"], view["kind"]))} · {esc(view["severity"])} · {esc(view["status"])}</text>']
    for i in range(len(ids) - 1):
        x1, x2 = left + i * step + 8, left + (i + 1) * step - 8
        parts.append(f'<line x1="{x1}" y1="{y}" x2="{x2}" y2="{y}" stroke="#847ce2" stroke-width="1.4"/>')
        parts.append(f'<path d="M{x2 - 6} {y - 4} L{x2} {y} L{x2 - 6} {y + 4}" fill="none" stroke="#847ce2" stroke-width="1.4"/>')
        if i < len(rules):
            parts.append(f'<text x="{(x1 + x2) / 2}" y="{y - 8}" text-anchor="middle" fill="#8f8a80" font-size="9" '
                         f'font-family="Geist Mono, ui-monospace, monospace">rule {rules[i]}</text>')
    for i, node in enumerate(ids):
        x = left + i * step
        ends = i == 0 or i == len(ids) - 1
        fill = "#e0573f" if ends else "#847ce2"
        parts.append(f'<circle cx="{x}" cy="{y}" r="6" fill="{fill}" stroke="#0c0b09" stroke-width="2"/>')
        label = esc(names.get(node, node))
        parts.append(f'<text x="{x}" y="{y + 26}" text-anchor="middle" fill="#e8e4dc" font-size="11.5">{label[:22]}</text>')
        parts.append(f'<text x="{x}" y="{y + 40}" text-anchor="middle" fill="#6f6a62" font-size="9" '
                     f'font-family="Geist Mono, ui-monospace, monospace">{esc(node)[:26]}</text>')
    parts.append(f'<text x="{left}" y="156" fill="#6f6a62" font-size="9" font-family="Geist Mono, ui-monospace, monospace">'
                 'Cistern · the flow layer in FalkorDB · a path means text can flow, not that it did</text>')
    parts.append("</svg>")
    return "\n".join(parts)
