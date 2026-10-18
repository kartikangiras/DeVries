"""Running without a model: fixed choices and templated narration.

A scripted run makes the same moves as the baseline search and says so. It
exists so that a demo never depends on a model being up, and it is never
passed off as an agent run: the run record and the UI both name the mode.
"""

import re
from typing import Any

from devries.mitigation.dsl import describe
from devries.mitigation.store import Mitigation

BECAUSE_INJECTION = "A scripted run starts with injection paths: they are the most severe kind of finding."
BECAUSE_TRIFECTA = "No injection path is open, so a scripted run looks at trifecta agents next."
BECAUSE_ZONES = "Which parts of the graph can affect each other at all: a zone with no untrusted source needs no fix."
BECAUSE_CUT = "The cheapest set of hops that separates every untrusted source from every high-impact resource, by max flow: a guide for the search, never a verdict."
BECAUSE_SEARCH = "A scripted run tests the candidate fixes on the finding's own path, cheapest first."
BECAUSE_PROPOSE = "It is the cheapest plan that passed in a sandbox."
WHY_FIRST = "It is the most severe open finding: an injection path outranks a trifecta, and ties go to the lowest id."


def choose(findings: list[dict[str, Any]]) -> list[str]:
    """The single most severe open finding among those a tool returned."""
    open_ = [f for f in findings if f.get("status") == "open" and f.get("kind") in ("injection", "trifecta")]   # the rest is accepted, not fixed
    open_.sort(key=lambda f: (f["kind"] != "injection", f.get("source_id") or "", f.get("target_id") or "", f.get("agent_id") or ""))
    return [open_[0]["id"]] if open_ else []


def plan_words(mitigation: Mitigation) -> str:
    return " and ".join(describe(f) for f in mitigation.plan.fixes)


def rationale(best: Mitigation, failed: list[Mitigation]) -> str:
    text = f"Cheapest plan that passed sandbox verification (cost {best.cost}): {plan_words(best)}."
    cheaper = [m for m in failed if m.cost <= best.cost]
    if cheaper:
        text += " Rejected first: " + "; ".join(f"{plan_words(m)} ({m.reason})" for m in cheaper[:4]) + "."
    return text + " Chosen by the scripted baseline search, not by a model."


def headline(tool: str, data: dict[str, Any]) -> str:
    """A tool result in one line, built from the result alone."""
    if "error" in data:
        return f"{data['error'].get('code', 'error')}: {data['error'].get('message', '')}"[:300]
    if tool == "list_scenarios":
        return f"{len(data['scenarios'])} scenario(s): " + ", ".join(s["id"] for s in data["scenarios"])
    if tool == "scan":
        ids = data.get("finding_ids", [])
        return f"{len(ids)} open finding(s): {', '.join(ids)}" if ids else "no open findings"
    if tool == "trust_zones":
        return f"{data['total']} zone(s), {sum(z['is_blast_zone'] for z in data['zones'])} of them a blast zone"
    if tool == "find_injection_paths":
        return f"{data['total']} injection finding(s)" + "".join(
            f"; {f['id']}: {f['source_id']} reaches {f['target_id']}" for f in data["findings"][:3])
    if tool == "find_trifecta_agents":
        return f"{data['total']} trifecta agent(s)" + "".join(f"; {f['id']}: {f['agent_id']}" for f in data["findings"][:3])
    if tool == "rank_chokepoints":
        if data.get("method") == "betweenness":
            return "most central: " + ", ".join(n["id"] for n in data["nodes"][:3])
        if data.get("method") == "mincut":
            hops = "; ".join(f"{e['from_id']} -> {e['to_id']}" for e in data["edges"][:3])
            return f"cheapest cut costs {data.get('cut_cost')}: {hops}" if hops else "nothing to cut"
        return "; ".join(f"{e['from_id']} -> {e['to_id']} ({' or '.join(e['fixes'])})" for e in data["edges"][:3]) or "no edges"
    if tool == "simulate_mitigation":
        plan = " and ".join(data["summary"])
        return f"passes: {plan}" if data["passed"] else f"fails: {plan}. It {data['reason']}"
    if tool == "what_if":
        return (f"would introduce {len(data['introduced'])}, resolve {len(data['resolved'])} "
                f"and break {len(data['newly_broken'])}: " + " and ".join(data["changes"]))
    if tool == "propose_fix":
        return f"{data['status']} {data['mitigation_id']}: " + " and ".join(data["verdict"]["summary"])
    if tool == "apply_fix":
        return f"applied {data['patch']['mitigation_id']}"
    return tool


def trim(tool: str, data: dict[str, Any]) -> dict[str, Any]:
    """A tool result small enough for the event stream: display names and rule texts go, facts stay."""
    out = {k: v for k, v in data.items() if k not in ("names", "rules", "queries", "scenario")}
    if "findings" in out:
        out["findings"] = [
            {k: f[k] for k in ("id", "kind", "status", "source_id", "target_id", "agent_id") if k in f}
            | ({"path_ids": f["paths"][0]["node_ids"]} if f.get("paths") else {})
            for f in out["findings"]
        ]
    if tool == "propose_fix" and "verdict" in out:
        out["verdict"] = {k: out["verdict"][k] for k in ("passed", "summary", "cost", "resolved", "open_after")}
    return out


def report(record: dict[str, Any]) -> str:
    """The run in a few plain sentences, from the record alone."""
    parts: list[str] = []
    for i, round_ in enumerate(record["rounds"], 1):
        open_ids = round_["scan_open"]
        if not open_ids:
            parts.append("The scan found no open findings." if i == 1 else "The rescan found no open findings.")
            continue
        parts.append(f"{'The scan' if i == 1 else 'The rescan'} found {len(open_ids)} open finding(s): {', '.join(open_ids)}.")
        if round_.get("targets"):
            parts.append(f"Chosen to fix first: {', '.join(round_['targets'])}.")
        failed = [t for t in round_.get("tested", []) if not t["passed"]]
        if failed:
            parts.append("Rejected in the sandbox: " + "; ".join(f"{t['plan']} ({t['reason']})" for t in failed[:5]) + ".")
        proposed = round_.get("proposed")
        if not proposed:
            parts.append("No plan passed verification, so nothing was proposed.")
            continue
        parts.append(f"Proposed {proposed['mitigation_id']}: {proposed['plan']} (cost {proposed['cost']}).")
        cut = round_.get("cut_cost")
        if cut == 0:
            parts.append("Max flow finds nothing left to cut between untrusted sources and high-impact resources; "
                         "what remains open is a trifecta, which a cut does not cover.")
        elif cut is not None:
            parts.append(f"The cheapest cut by max flow costs {cut}" + (
                "; the plan that passed costs the same." if proposed["cost"] <= cut else
                f"; the plan that passed costs {proposed['cost']}. The cut is a guide that knows nothing about workflows; the sandbox decides."))
        decision = round_.get("decision")
        if decision == "approved":
            parts.append(f"{round_.get('decided_by') or 'A person'} approved it"
                         + (" and it was applied." if round_.get("applied") else ", but it could not be applied: " + str(round_.get("apply_error")) + "."))
        elif decision == "rejected":
            parts.append(f"{round_.get('decided_by') or 'A person'} rejected it"
                         + (f": {round_['decision_reason']}." if round_.get("decision_reason") else "."))
        elif decision == "pending":
            parts.append("It waits for a person's approval; nothing has changed.")
        else:
            parts.append("Nobody decided on it in time; it is still waiting for approval.")
    still_open = record.get("open_at_end")
    if still_open is not None and record["rounds"] and record["rounds"][-1]["scan_open"]:
        parts.append(f"Still open: {', '.join(still_open)}." if still_open else "Nothing is open now.")
    return " ".join(parts)


CANNED_HELP = ("Without a model, a question is answered straight from the graph when it is one of four kinds: "
               "what can reach <something>; what does <something> reach; is there a path from <a> to <b>; "
               "which workflows need <a tool or a data source>. Name things by their id or their name.")


def no_answer(reason: str, calls: list[str], scripted: bool = False) -> str:
    text = f"This question was not answered by a model: {reason}."
    if calls:
        text += " Tool calls made before that: " + ", ".join(calls) + "; their results are in the steps above."
    if scripted:
        text += " " + CANNED_HELP
    return text


# ---------------------------------------------------------------------- questions a graph can answer alone

QUESTION_PATTERNS = [
    ("from", re.compile(r"^what\s+(?:does|can|could|do)\s+(.+?)\s+reach$")),
    ("path", re.compile(r"^(?:is|are)\s+there\s+(?:a|any)?\s*(?:paths?|ways?|routes?)\s+from\s+(.+?)\s+to\s+(.+)$")),
    ("path", re.compile(r"^(?:can|could|does)\s+(.+?)\s+reach\s+(.+)$")),
    ("needs", re.compile(r"^(?:which|what)\s+workflows?\s+(?:needs?|requires?|uses?|depends?\s+on)\s+(.+)$")),
    ("needs", re.compile(r"^what\s+(?:needs|requires|depends\s+on)\s+(.+)$")),
    ("into", re.compile(r"^(?:what|who|which\s+\w+)\s+(?:can|could)?\s*reach(?:es)?\s+(.+)$")),
]


def parse_question(question: str) -> tuple[str, list[str]] | None:
    """One of the four question kinds and the things it names, or None when the box cannot answer it alone."""
    text = " ".join(question.strip().rstrip("?.!").split()).lower()
    for kind, pattern in QUESTION_PATTERNS:
        m = pattern.match(text)
        if m:
            return kind, [g.strip().strip("`'\"") for g in m.groups()]
    return None


def resolve(term: str, nodes: list[dict[str, Any]]) -> list[str]:
    """The node ids a term names: its id, its name, or the part of its id after the kind; a unique partial match last."""
    wanted = term.lower()
    exact = [n["id"] for n in nodes if n["id"].lower() == wanted]
    if exact:
        return exact
    by_name = [n["id"] for n in nodes if (n.get("name") or "").lower() == wanted or n["id"].split(":", 1)[-1].lower() == wanted]
    if by_name:
        return sorted(set(by_name))
    partial = sorted({n["id"] for n in nodes if wanted in (n.get("name") or "").lower() or wanted in n["id"].lower()})
    return partial if len(partial) == 1 else []
