"""The auditor loop.

The model makes the choices that have more than one reasonable answer: which
graph question to ask next, which findings to fix first, which plans to test,
which passing plan to propose. The loop does the steps that have exactly one:
scan, wait for a person, apply, rescan. The graph settles every factual
question, and a person approves every change.

Every tool call goes through an MCP client session to the same server any
other client uses; the tool definitions the model sees come from `tools/list`.
When no model is available, or one stops being available part-way, the run
carries on scripted and says so.
"""

import asyncio
import json
import logging
import time
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

from mcp import Client

from cistern import ops, views
from cistern.agent import grounding, phases, prompts, scripted
from cistern.agent.llm import (
    LLM, AssistantTurn, LLMError, Message, Step, ToolCall, ToolResult, ToolResults, ToolSpec, UserText, spend,
)
from cistern.agent.runs import Run
from cistern.config import get_settings
from cistern.errors import CisternError
from cistern.events import bus
from cistern.graph.client import GraphClient
from cistern.graph.keys import SCENARIO_RE
from cistern.mitigation import store

log = logging.getLogger("cistern.agent")

Handler = Callable[[ToolCall], Awaitable[tuple[dict[str, Any], Any]]]


class FellBack(Exception):
    """The model can no longer drive this run; the scripted path takes over from the current phase."""


@dataclass
class Ctx:
    run: Run
    mcp: Client
    specs: dict[str, ToolSpec]                                    # every MCP tool, as a definition for the model
    known: set[str] = field(default_factory=set)                  # ids seen in tool results: what model text may cite
    findings: dict[str, dict[str, Any]] = field(default_factory=dict)   # findings as tools returned them, by id
    rounds: list[dict[str, Any]] = field(default_factory=list)    # the record the report is written from


def _error(code: str, message: str) -> dict[str, Any]:
    return {"error": {"code": code, "message": message, "retryable": True}}


class Auditor:
    def __init__(self, client: GraphClient, llm: LLM | None, server: Any = None,
                 ref_for: Callable[[str], str] | None = None, no_model_reason: str = "no model is configured",
                 stop_after_proposal: bool = False):
        if server is None:
            from cistern.mcp_server.server import mcp as server
        self.client = client
        self.llm = llm
        self.server = server
        self.ref_for = ref_for            # ask runs only: the reference for another scenario the model names
        self.no_model_reason = no_model_reason
        # an audit that runs by itself (at start, after an import) ends once a plan waits for a person, and does not wait
        self.stop_after_proposal = stop_after_proposal

    # ------------------------------------------------------------------ entry

    async def run(self, run: Run) -> None:
        """Drive a run to its end. Never raises: a failure ends the run as failed, with the reason on it."""
        try:
            run.changed()                                 # the stream hears of the run before any of its steps
            if self.llm is None:
                self._scripted(run, self.no_model_reason)
            elif spend.exhausted():
                self._scripted(run, "today's model budget is spent")
            else:
                run.model = self.llm.name
                run.changed()
            async with Client(self.server) as mcp:
                try:
                    listed = (await mcp.list_tools()).tools
                    specs = {t.name: phases.tool_spec(t.name, t.description or "", t.input_schema) for t in listed}
                    ctx = Ctx(run=run, mcp=mcp, specs=specs)
                    await (self._audit(ctx) if run.kind == "audit" else self._ask(ctx))
                except Exception as e:                    # caught here so the MCP session still closes cleanly
                    log.exception("run %s failed", run.id)
                    run.finish(None, error=f"{type(e).__name__}: {e}"[:300])
        except asyncio.CancelledError:
            if run.status not in ("done", "failed"):
                run.finish(None, error="the run was cancelled")
            raise
        except Exception as e:
            log.exception("run %s failed outside its session", run.id)
            if run.status not in ("done", "failed"):
                run.finish(None, error=f"{type(e).__name__}: {e}"[:300])
        finally:
            log.info(json.dumps({
                "event": "run", "id": run.id, "kind": run.kind, "scenario": run.scenario, "mode": run.mode, "status": run.status,
                "outcome": run.outcome, "model": run.model, "steps": len(run.steps), "model_steps": run.usage.model_steps,
                "simulations": run.usage.simulations, "cost_usd": round(run.usage.cost_usd, 4),
                "ms": (run.finished_at or int(time.time() * 1000)) - run.started_at,
            }))

    def _scripted(self, run: Run, reason: str) -> None:
        run.mode, run.scripted_reason = "scripted", reason
        run.step(phase=run.phase, by="loop", kind="note",
                 text=f"No model is driving this run from here: {reason}. The steps that follow are scripted.")
        run.changed()

    # ------------------------------------------------------------------ tools

    def _ref(self, run: Run, wanted: Any) -> str:
        """The scenario reference a call is forwarded with. The model writes plain names; the session is added here."""
        if run.kind == "ask" and self.ref_for and isinstance(wanted, str) and wanted != run.scenario \
                and SCENARIO_RE.fullmatch(wanted):
            return self.ref_for(wanted)
        return run.ref

    async def _tool(self, ctx: Ctx, phase: str, name: str, arguments: dict[str, Any], *, by: str,
                    because: str | None) -> dict[str, Any]:
        """One MCP tool call, recorded as a step."""
        run = ctx.run
        shown = {k: v for k, v in arguments.items() if k != "scenario"}
        send = dict(shown)
        if "scenario" in ctx.specs[name].input_schema.get("properties", {}):
            send["scenario"] = self._ref(run, arguments.get("scenario"))
            shown["scenario"] = send["scenario"].partition("@")[0]
        t0 = time.monotonic()
        try:
            result = await ctx.mcp.call_tool(name, send)
            if result.is_error:                           # the SDK refused the arguments before the tool ran
                text = result.content[0].text if result.content else "the tool call failed"
                data = _error("invalid_arguments", text[:600])
            elif result.structured_content is not None:
                data = result.structured_content
            else:
                data = json.loads(result.content[0].text)
        except Exception as e:                            # the transport, not the tool
            data = _error("tool_unavailable", f"{name} could not be called ({type(e).__name__})")
        ms = int((time.monotonic() - t0) * 1000)

        ctx.known |= grounding.ids_of(data)
        for finding in data.get("findings", []) if isinstance(data.get("findings"), list) else []:
            ctx.findings[finding["id"]] = finding
        run.step(phase=phase, by=by, kind="tool", tool=name, arguments=shown, because=because,
                 headline=scripted.headline(name, data), result=scripted.trim(name, data),
                 error=data["error"].get("code") if "error" in data else None,
                 cited_ids=sorted(grounding.ids_in(because)), queries=list(data.get("queries", [])), ms=ms)
        return data

    async def _model_tool(self, ctx: Ctx, phase: str, call: ToolCall, offered: list[str]) -> dict[str, Any]:
        """A tool call the model asked for: `because` is taken off, checked and recorded; the rest is forwarded."""
        arguments = dict(call.arguments)
        because = arguments.pop("because", None)
        problem = None
        if call.name not in offered or call.name not in ctx.specs:
            problem = _error("not_offered", f"{call.name} is not available in this phase. Available: {', '.join(offered)}.")
        elif not isinstance(because, str) or not because.strip():
            problem = _error("because_missing", "Every tool call needs `because`: one sentence naming the earlier "
                                                "result that makes this the next call.")
        else:
            unknown = grounding.ungrounded(because, ctx.known)
            if unknown:
                problem = _error("ungrounded", f"`because` cites ids that no tool returned in this run: "
                                               f"{', '.join(unknown)}. Cite only ids from tool results.")
        if problem:
            ctx.run.step(phase=phase, by="model", kind="tool", tool=call.name,
                         arguments={k: v for k, v in arguments.items() if k != "scenario"},
                         because=because if isinstance(because, str) else None,
                         headline=scripted.headline(call.name, problem), error=problem["error"]["code"])
            return problem
        return await self._tool(ctx, phase, call.name, arguments, by="model", because=because.strip())

    # ------------------------------------------------------------------ the model's turn

    async def _model_step(self, ctx: Ctx, messages: list[Message], specs: list[ToolSpec]) -> Step:
        run = ctx.run
        if run.usage.model_steps >= phases.MAX_STEPS_PER_RUN:
            raise FellBack(f"the run used its {phases.MAX_STEPS_PER_RUN} model steps")
        if spend.exhausted():
            raise FellBack("today's model budget is spent")
        try:
            step = await self.llm.step(prompts.SYSTEM, messages, specs)
        except LLMError as e:                             # includes a refusal that survived the fallback
            raise FellBack(str(e)) from e
        run.usage.model_steps += 1
        run.usage.input_tokens += step.usage.input_tokens
        run.usage.output_tokens += step.usage.output_tokens
        run.usage.cache_read_tokens += step.usage.cache_read_tokens
        run.usage.cost_usd = round(run.usage.cost_usd + step.usage.cost_usd, 6)
        spend.add(step.usage.cost_usd)
        if step.model and run.model and step.model != run.model:
            run.step(phase=run.phase, by="loop", kind="note",
                     text=f"This step was answered by {step.model}: the provider's refusal fallback switched models.")
            run.model = step.model
        return step

    def _say(self, ctx: Ctx, phase: str, text: str | None) -> None:
        """Publish a note the model wrote, if every id in it came from a tool."""
        if not text:
            return
        unknown = grounding.ungrounded(text, ctx.known)
        if unknown:
            ctx.run.step(phase=phase, by="loop", kind="note",
                         text=f"A note from the model is withheld: it cited ids no tool returned ({', '.join(unknown)}).")
        else:
            ctx.run.step(phase=phase, by="model", kind="text", text=text, cited_ids=sorted(grounding.ids_in(text)))

    async def _converse(self, ctx: Ctx, phase: str, brief: str, offered: list[str], extra: list[ToolSpec],
                        handle: Handler | None, *, nudge: str | None = None, final_text: bool = False) -> Any:
        """One phase, one conversation: a fixed tool list and an append-only history.

        Ends with whatever `handle` returns as its outcome, with the model's closing text when
        `final_text` is set, or with None when the step budget runs out first.
        """
        specs = [ctx.specs[name] for name in offered if name in ctx.specs] + list(extra)
        messages: list[Message] = [UserText(brief)]
        nudged = corrected = False
        for i in range(phases.MAX_STEPS_PER_PHASE):
            step = await self._model_step(ctx, messages, specs)
            messages.append(AssistantTurn(step.raw))      # unchanged, whatever it contains
            left = phases.MAX_STEPS_PER_PHASE - i - 1

            if not step.tool_calls:
                if final_text:
                    unknown = grounding.ungrounded(step.text, ctx.known)
                    if step.text and not unknown:
                        return step.text
                    if corrected or not left:
                        return None                       # the caller falls back to a template
                    corrected = True
                    messages.append(UserText(grounding.correction(unknown) if unknown else "Give your answer as plain text."))
                    ctx.run.step(phase=phase, by="loop", kind="note",
                                 text="The model's text cited ids no tool returned"
                                      + (f" ({', '.join(unknown)})" if unknown else "") + "; it was asked to write it again.")
                    continue
                self._say(ctx, phase, step.text)
                if nudge and not nudged and left:
                    nudged = True
                    messages.append(UserText(nudge))
                    continue
                return None

            self._say(ctx, phase, step.text)
            results, outcome = [], None
            for call in step.tool_calls:                  # every call gets a result, in one message
                data, done = await handle(call)
                results.append(ToolResult(call.id, json.dumps(data, default=str), is_error="error" in data))
                if done is not None and outcome is None:
                    outcome = done
            if outcome is not None:
                return outcome
            note = prompts.STEPS_LEFT.format(n=left, s="" if left == 1 else "s") if 0 < left <= 2 else None
            messages.append(ToolResults(results, note=note))
        return None

    async def _drive(self, ctx: Ctx, by_model: Callable[..., Awaitable[Any]], by_script: Callable[..., Awaitable[Any]],
                     *args: Any) -> Any:
        if ctx.run.mode == "agent":
            try:
                return await by_model(ctx, *args)
            except FellBack as e:
                self._scripted(ctx.run, str(e))
        return await by_script(ctx, *args)

    # ------------------------------------------------------------------ audit runs

    async def _audit(self, ctx: Ctx) -> None:
        run = ctx.run
        outcome = "clean"
        for round_no in range(phases.MAX_ROUNDS + 1):
            run.enter("scan")
            scan = await self._tool(ctx, "scan", "scan", {}, by="loop",
                                    because="Every round starts from a fresh scan of the graph.")
            if "error" in scan:
                raise RuntimeError(f"the scan failed: {scan['error'].get('message')}")
            open_ids = [i for i in scan["finding_ids"] if i not in scan.get("accepted_ids", [])]
            round_: dict[str, Any] = {"scan_open": open_ids}
            ctx.rounds.append(round_)
            if not open_ids:
                break
            if round_no == phases.MAX_ROUNDS:
                run.step(phase="scan", by="loop", kind="note",
                         text=f"Findings remain after {phases.MAX_ROUNDS} rounds; this run stops here.")
                break

            run.enter("investigate")
            targets, why = await self._drive(ctx, self._investigate_model, self._investigate_scripted, open_ids, scan)
            round_["targets"], round_["why"] = targets, why

            outcome = await self._fix(ctx, targets, why, round_)
            if outcome != "applied":
                break
        await self._report(ctx, outcome)

    async def _fix(self, ctx: Ctx, targets: list[str], why: str, round_: dict[str, Any]) -> str:
        """Mitigate, wait for a person, apply. One retry if the config moved under an approved plan."""
        run = ctx.run
        for attempt in (1, 2):
            run.enter("mitigate")
            proposal = await self._drive(ctx, self._mitigate_model, self._mitigate_scripted, targets, why, round_)
            if proposal is None:
                round_.pop("proposed", None)
                return "no_plan"
            run.mitigation_id = proposal
            if self.stop_after_proposal:
                round_["decision"] = "pending"
                run.step(phase="approval", by="loop", kind="note",
                         text=f"{proposal} waits for a person to approve or reject it. This run stops here; no tool can approve it.")
                return "proposed"

            decision, status = await self._await_decision(ctx, proposal, round_)
            if decision != "approved":
                return decision
            if status == "applied":                       # a person applied it through the API already
                round_["applied"] = True
                return "applied"

            run.enter("apply")
            applied = await self._tool(ctx, "apply", "apply_fix", {"mitigation_id": proposal}, by="loop",
                                       because=f"{round_.get('decided_by') or 'A person'} approved {proposal}.")
            if "error" not in applied:
                round_["applied"] = True
                return "applied"
            if applied["error"].get("code") == "stale" and attempt == 1:
                run.step(phase="apply", by="loop", kind="note",
                         text="The config changed after the plan was verified, so it is not applied. Looking for a plan again.")
                continue
            round_["apply_error"] = applied["error"].get("message")
            return "apply_failed"
        return "apply_failed"

    # -- investigate

    async def _investigate_model(self, ctx: Ctx, open_ids: list[str], scan: dict[str, Any]) -> tuple[list[str], str]:
        run = ctx.run

        async def handle(call: ToolCall) -> tuple[dict[str, Any], Any]:
            if call.name != "choose_targets":
                return await self._model_tool(ctx, "investigate", call, phases.INVESTIGATE), None
            ids = call.arguments.get("finding_ids") or []
            because = str(call.arguments.get("because") or "").strip()
            unknown = grounding.ungrounded(because, ctx.known)
            problem = None
            if not isinstance(ids, list) or not ids or [i for i in ids if i not in open_ids]:
                problem = _error("invalid_targets", f"Choose from the open findings: {', '.join(open_ids)}.")
            elif not because:
                problem = _error("because_missing", "Say why these findings come first.")
            elif unknown:
                problem = _error("ungrounded", f"`because` cites ids that no tool returned: {', '.join(unknown)}.")
            if problem:
                run.step(phase="investigate", by="model", kind="tool", tool="choose_targets",
                         arguments={"finding_ids": ids}, because=because or None,
                         headline=scripted.headline("choose_targets", problem), error=problem["error"]["code"])
                return problem, None
            ids = list(dict.fromkeys(ids))
            run.step(phase="investigate", by="model", kind="tool", tool="choose_targets", arguments={"finding_ids": ids},
                     because=because, headline=f"targets: {', '.join(ids)}", cited_ids=sorted(grounding.ids_in(because)))
            return {"ok": True}, (ids, because)

        brief = prompts.INVESTIGATE.format(scenario=run.scenario, scan=prompts.compact(scripted.trim("scan", scan)))
        chosen = await self._converse(ctx, "investigate", brief, phases.INVESTIGATE, [phases.CHOOSE_TARGETS], handle,
                                      nudge=prompts.NUDGE_CHOOSE)
        if chosen is not None:
            return chosen
        run.step(phase="investigate", by="loop", kind="note",
                 text="The model did not choose targets within its steps, so the most severe finding is taken.")
        return await self._investigate_scripted(ctx, open_ids, scan)

    async def _investigate_scripted(self, ctx: Ctx, open_ids: list[str], scan: dict[str, Any]) -> tuple[list[str], str]:
        found = (await self._tool(ctx, "investigate", "find_injection_paths", {}, by="scripted",
                                  because=scripted.BECAUSE_INJECTION)).get("findings", [])
        if not scripted.choose(found):
            found = (await self._tool(ctx, "investigate", "find_trifecta_agents", {}, by="scripted",
                                      because=scripted.BECAUSE_TRIFECTA)).get("findings", [])
        # the two graph algorithms a person would look at before choosing: zones, and the cheapest cut
        await self._tool(ctx, "investigate", "trust_zones", {}, by="scripted", because=scripted.BECAUSE_ZONES)
        cut = await self._tool(ctx, "investigate", "rank_chokepoints", {"method": "mincut"}, by="scripted",
                               because=scripted.BECAUSE_CUT)
        if ctx.rounds and "error" not in cut:
            ctx.rounds[-1]["cut_cost"] = cut.get("cut_cost")
        targets = scripted.choose(found) or open_ids[:1]
        ctx.run.step(phase="investigate", by="scripted", kind="tool", tool="choose_targets",
                     arguments={"finding_ids": targets}, because=scripted.WHY_FIRST, headline=f"targets: {', '.join(targets)}")
        return targets, scripted.WHY_FIRST

    # -- mitigate

    async def _target_findings(self, ctx: Ctx, targets: list[str]) -> list[dict[str, Any]]:
        """The targets as tools returned them; fetched now if the investigation never looked at one."""
        for tool in ("find_injection_paths", "find_trifecta_agents"):
            if all(t in ctx.findings for t in targets):
                break
            await self._tool(ctx, "mitigate", tool, {}, by="loop", because="The plan search needs the targets' paths.")
        return [ctx.findings[t] for t in targets if t in ctx.findings]

    async def _mitigate_model(self, ctx: Ctx, targets: list[str], why: str, round_: dict[str, Any]) -> str | None:
        run = ctx.run
        budget = phases.MAX_SIMULATIONS_PER_TARGET * len(targets)
        used = 0
        tested: list[dict[str, Any]] = round_.setdefault("tested", [])

        def note_verdict(verdict: dict[str, Any]) -> None:
            tested.append({"plan": " and ".join(verdict["summary"]), "cost": verdict["cost"],
                           "passed": verdict["passed"], "reason": verdict["reason"]})

        async def handle(call: ToolCall) -> tuple[dict[str, Any], Any]:
            nonlocal used
            if call.name == "simulate_mitigation" and used >= budget:
                spent = _error("budget_spent", f"All {budget} simulations are used. Propose the cheapest plan that passed, "
                                               f"or say that none did.")
                run.step(phase="mitigate", by="model", kind="tool", tool=call.name, headline=scripted.headline(call.name, spent),
                         error="budget_spent")
                return spent, None
            data = await self._model_tool(ctx, "mitigate", call, phases.MITIGATE)
            if call.name == "simulate_mitigation" and "passed" in data:
                used += 1
                run.usage.simulations += 1
                note_verdict(data)
            elif call.name == "propose_fix":
                if data.get("status") in ("proposed", "approved"):
                    round_["proposed"] = {"mitigation_id": data["mitigation_id"], "plan": " and ".join(data["verdict"]["summary"]),
                                          "cost": data["verdict"]["cost"], "rationale": call.arguments.get("rationale")}
                    return data, data["mitigation_id"]
                if data.get("error", {}).get("code") == "fix_failed":
                    note_verdict(data["error"]["verdict"])
            return data, None

        brief = prompts.MITIGATE.format(
            scenario=run.scenario, targets=", ".join(targets), why=why, simulations=budget,
            findings=prompts.compact(await self._target_findings(ctx, targets)))
        return await self._converse(ctx, "mitigate", brief, phases.MITIGATE, [], handle, nudge=prompts.NUDGE_PROPOSE)

    async def _mitigate_scripted(self, ctx: Ctx, targets: list[str], why: str, round_: dict[str, Any]) -> str | None:
        run = ctx.run
        t0 = time.monotonic()
        try:
            result = await ops.search(self.client, run.graph, targets, source="scripted")
        except CisternError as e:
            run.step(phase="mitigate", by="scripted", kind="tool", tool="baseline_search", arguments={"finding_ids": targets},
                     because=scripted.BECAUSE_SEARCH, headline=f"{e.code}: {e.message}", error=e.code)
            return None
        run.usage.simulations += result.sandbox_runs
        round_["tested"] = [{"plan": scripted.plan_words(m), "cost": m.cost, "passed": m.passed, "reason": m.reason}
                            for m in result.failed + result.passing]
        data = {"sandbox_runs": result.sandbox_runs,
                "passing": [{"id": m.id, "plan": scripted.plan_words(m), "cost": m.cost} for m in result.passing],
                "failed": [{"plan": scripted.plan_words(m), "cost": m.cost, "reason": m.reason} for m in result.failed]}
        ctx.known |= grounding.ids_of(data)
        best_words = f"cheapest that passes: {data['passing'][0]['plan']}" if result.passing else "none passed"
        run.step(phase="mitigate", by="scripted", kind="tool", tool="baseline_search", arguments={"finding_ids": targets},
                 because=scripted.BECAUSE_SEARCH, result=data, ms=int((time.monotonic() - t0) * 1000),
                 headline=f"{result.sandbox_runs} plan(s) tested in sandboxes; {best_words}")

        for best in result.passing:
            if best.status == "rejected":                 # a person already said no to this exact plan
                continue
            try:
                mitigation = await ops.propose(self.client, run.graph, best.plan, targets,
                                               scripted.rationale(best, result.failed), source="scripted")
            except CisternError as e:
                run.step(phase="mitigate", by="scripted", kind="tool", tool="propose_fix",
                         headline=f"{e.code}: {e.message}", error=e.code)
                continue
            view = views.mitigation_view(mitigation)
            ctx.known |= grounding.ids_of(view)
            run.step(phase="mitigate", by="scripted", kind="tool", tool="propose_fix",
                     arguments={"finding_ids": targets, "plan": view["plan"]}, because=scripted.BECAUSE_PROPOSE,
                     headline=f"{mitigation.status} {mitigation.id}: {scripted.plan_words(mitigation)}",
                     result={"mitigation_id": mitigation.id, "status": mitigation.status, "summary": view["summary"]})
            round_["proposed"] = {"mitigation_id": mitigation.id, "plan": scripted.plan_words(mitigation),
                                  "cost": mitigation.cost, "rationale": mitigation.rationale}
            return mitigation.id
        return None

    # -- approval

    async def _await_decision(self, ctx: Ctx, mitigation_id: str, round_: dict[str, Any]) -> tuple[str, str]:
        """Wait on the event stream for a person. Returns (decision, the mitigation's status)."""
        run = ctx.run
        run.enter("approval")

        def about_this(event) -> bool:
            return (event.graph == run.graph and event.data.get("id") == mitigation_id
                    and event.type in ("mitigation.approved", "mitigation.rejected", "mitigation.applied"))

        with bus.subscribe(about_this) as decisions:      # subscribed before looking, so a decision cannot slip between
            current = await store.get(self.client, run.graph, mitigation_id)
            if current.status == "proposed":
                run.status = "awaiting_approval"
                run.step(phase="approval", by="loop", kind="note",
                         text=f"Waiting for a person to approve or reject {mitigation_id}. No tool can approve it.")
                run.changed()
                await decisions.get(timeout=get_settings().approval_timeout_s)
                current = await store.get(self.client, run.graph, mitigation_id)
                run.status = "running"
                run.changed()

        decision = {"approved": "approved", "applied": "approved", "rejected": "rejected"}.get(current.status, "undecided")
        round_["decision"], round_["decided_by"] = decision, current.approved_by
        round_["decision_reason"] = current.decision_reason
        who = current.approved_by or "A person"
        text = {"approved": f"{who} approved {mitigation_id}.",
                "rejected": f"{who} rejected {mitigation_id}" + (f": {current.decision_reason}" if current.decision_reason else "."),
                "undecided": f"Nobody decided on {mitigation_id} in time. It stays proposed and can still be approved."}[decision]
        run.step(phase="approval", by="person" if decision != "undecided" else "loop", kind="note", text=text)
        return decision, current.status

    # -- report

    async def _report(self, ctx: Ctx, outcome: str) -> None:
        run = ctx.run
        run.enter("report")
        record = {"mode": run.mode, "outcome": outcome, "rounds": ctx.rounds, "open_at_end": ctx.rounds[-1]["scan_open"]}
        text = None
        if run.mode == "agent":
            try:
                brief = prompts.REPORT.format(scenario=run.scenario, record=prompts.compact(prompts.for_model(record)))
                text = await self._converse(ctx, "report", brief, [], [], None, final_text=True)
            except FellBack as e:
                self._scripted(run, str(e))
        run.answer, run.answer_by = (text, "model") if text else (scripted.report(record), "template")
        bus.publish(run.graph, "agent.answer", {"run_id": run.id, "kind": "report", "text": run.answer, "by": run.answer_by})
        run.finish(outcome)

    # ------------------------------------------------------------------ ask runs

    async def _ask(self, ctx: Ctx) -> None:
        run = ctx.run
        run.enter("ask")
        ctx.known |= grounding.ids_in(run.question)       # the visitor's own ids may be said back to them
        made: list[str] = []
        simulations = 0
        text = None

        async def handle(call: ToolCall) -> tuple[dict[str, Any], Any]:
            nonlocal simulations
            if call.name in ("simulate_mitigation", "what_if"):
                if simulations >= phases.MAX_SIMULATIONS_PER_TARGET:
                    return _error("budget_spent", "The sandbox budget for this question is used. Answer from what you have."), None
                simulations += 1
                run.usage.simulations += 1
            made.append(call.name)
            return await self._model_tool(ctx, "ask", call, phases.ASK), None

        answered_by: str | None = None
        if run.mode == "agent":
            try:
                brief = prompts.ASK.format(scenario=run.scenario, question=prompts.visitor_question(run.question or ""))
                text = await self._converse(ctx, "ask", brief, phases.ASK, [], handle, final_text=True)
                answered_by = "model" if text else None
            except FellBack as e:
                self._scripted(run, str(e))
        if not text:                                      # no model, or a model that gave nothing: the graph alone
            text = await self._ask_scripted(ctx)
            answered_by = "template" if text else None
        if text:
            run.answer, run.answer_by = text, answered_by
        else:
            reason = run.scripted_reason or "it did not give an answer that the tool results support"
            run.answer, run.answer_by = scripted.no_answer(reason, made, scripted=run.mode == "scripted"), "template"
        bus.publish(run.graph, "agent.answer", {"run_id": run.id, "kind": "answer", "text": run.answer, "by": run.answer_by})
        run.finish("answered" if answered_by else "unanswered")

    async def _ask_scripted(self, ctx: Ctx) -> str | None:
        """Four kinds of question a graph answers by itself, each one catalog query and a template that cites ids.
        Anything else returns None. Every step says the query it ran, so the trace shows the algorithm."""
        run = ctx.run
        parsed = scripted.parse_question(run.question or "")
        if parsed is None:
            return None
        kind, terms = parsed
        nodes = await self.client.run("config.nodes", run.graph)
        nodes = [n for n in nodes if n["label"] in ("Agent", "Tool", "DataSource", "Resource")]
        label_of = {n["id"]: n["label"] for n in nodes}
        facts = {n["id"]: n for n in nodes}
        ids = [scripted.resolve(t, nodes) for t in terms]
        if any(len(found) != 1 for found in ids):
            missing = [t for t, found in zip(terms, ids) if len(found) != 1]
            run.step(phase="ask", by="scripted", kind="note",
                     text=f"Nothing in this scenario is called {', '.join(repr(t) for t in missing)}. Use an id (agent:…, tool:…, src:…, res:…) or a name from the graph.")
            return None
        ids = [found[0] for found in ids]
        depth = max(1, (await self.client.run("graph.node_count", run.graph))[0]["nodes"])
        t0 = time.monotonic()

        def word(node_id: str) -> str:
            n = facts.get(node_id, {})
            tag = {"DataSource": n.get("trust"), "Resource": n.get("impact") and f"{n['impact']} impact"}.get(n.get("label"))
            return f"{node_id} ({tag})" if tag else node_id

        if kind == "into":
            target = ids[0]
            reaching = sorted((await self.client.run("reach.into", run.graph, id=target, max_depth=depth))[0]["reaching"])
            run.step(phase="ask", by="scripted", kind="tool", tool="reach.into", arguments={"id": target},
                     because=f"The question asks what can reach {target}: one BFS from every node over the flow layer, kept where it arrives.",
                     headline=f"{len(reaching)} node(s) reach {target}", result={"reaching": reaching},
                     cited_ids=[target, *reaching], queries=["config.nodes", "graph.node_count", "reach.into"], ms=int((time.monotonic() - t0) * 1000))
            if not reaching:
                return f"Nothing reaches {target} over the flow layer: no text or data can arrive there."
            untrusted = [i for i in reaching if label_of.get(i) == "DataSource" and facts[i].get("trust") == "untrusted"]
            text = f"{len(reaching)} thing(s) can reach {target}: {', '.join(word(i) for i in reaching)}."
            text += (f" Among them {len(untrusted)} untrusted source(s): {', '.join(untrusted)}, so what outsiders write can arrive at {target}."
                     if untrusted else " No untrusted source is among them.")
            return text + " Worked out by reach.into (algo.bfs), not by a model."
        if kind == "from":
            start = ids[0]
            reached = sorted((await self.client.run("reach.from", run.graph, id=start, max_depth=depth))[0]["reached"])
            run.step(phase="ask", by="scripted", kind="tool", tool="reach.from", arguments={"id": start},
                     because=f"The question asks what {start} reaches: one BFS from it over the flow layer.",
                     headline=f"{start} reaches {len(reached)} node(s)", result={"reached": reached},
                     cited_ids=[start, *reached], queries=["config.nodes", "graph.node_count", "reach.from"], ms=int((time.monotonic() - t0) * 1000))
            if not reached:
                return f"{start} reaches nothing over the flow layer."
            high = [i for i in reached if label_of.get(i) == "Resource" and facts[i].get("impact") == "high"]
            text = f"{start} reaches {len(reached)} thing(s): {', '.join(word(i) for i in reached)}."
            text += (f" {len(high)} of them high-impact: {', '.join(high)}." if high else " None of them is a high-impact resource.")
            return text + " Worked out by reach.from (algo.bfs), not by a model."
        if kind == "path":
            a, b = ids
            rows = await self.client.run("evidence.pair_paths", run.graph, source_id=a, target_id=b, max_len=depth, k=1)
            path = rows[0] if rows else None
            run.step(phase="ask", by="scripted", kind="tool", tool="evidence.pair_paths", arguments={"source_id": a, "target_id": b},
                     because=f"The question asks whether {a} reaches {b}: the shortest path between them, if there is one.",
                     headline=(f"yes, {len(path['rules'])} hop(s)" if path else "no path"), result={"path": path},
                     cited_ids=[a, b, *(path["node_ids"] if path else [])], queries=["config.nodes", "graph.node_count", "evidence.pair_paths"], ms=int((time.monotonic() - t0) * 1000))
            if not path:
                return f"No. Nothing flows from {a} to {b} over the flow layer, so {a} cannot reach {b}. Worked out by evidence.pair_paths (algo.SPpaths), not by a model."
            hops = " → ".join(path["node_ids"])
            return (f"Yes, in {len(path['rules'])} hop(s): {hops}, by rules {', '.join(str(r) for r in path['rules'])}. "
                    "This is the shortest route; there may be others. Worked out by evidence.pair_paths (algo.SPpaths), not by a model.")
        thing = ids[0]
        rows = await self.client.run("wf.needing", run.graph, id=thing)
        run.step(phase="ask", by="scripted", kind="tool", tool="wf.needing", arguments={"id": thing},
                 because=f"The question asks which workflows need {thing}: the NEEDS and NEEDS_DATA edges into it.",
                 headline=f"{len(rows)} workflow(s)", result={"workflows": rows},
                 cited_ids=[thing, *(r["workflow"] for r in rows), *(r["run_by"] for r in rows if r.get("run_by"))],
                 queries=["config.nodes", "wf.needing"], ms=int((time.monotonic() - t0) * 1000))
        if not rows:
            return f"No workflow declares that it needs {thing}, so a fix that takes it away breaks nothing that was declared. Read from the NEEDS edges, not by a model."
        said = "; ".join(f"{r['workflow']} ({r['mode']}, run by {r['run_by']}) " + ("reads it" if r["how"] == "NEEDS_DATA" else "calls it") for r in rows)
        return f"{len(rows)} workflow(s) need {thing}: {said}. A fix that takes it from them would be rejected in the sandbox. Read from the NEEDS edges, not by a model."
