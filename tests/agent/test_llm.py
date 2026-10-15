"""The Claude adapter, the tool definitions the model is shown, and the grounding check.

No request leaves the machine here: the SDK call is replaced by a stub. What is checked
is the request this code builds and how it reads a response, not the provider.
"""

from types import SimpleNamespace

import anthropic
import pytest

from cistern.agent import grounding, phases
from cistern.agent.llm import (
    AssistantTurn, ClaudeLLM, LLMError, LLMRefused, Spend, ToolResult, ToolResults, ToolSpec, UserText, configured_llm, cost_usd,
)
from cistern.config import Settings

TOOLS = [ToolSpec("scan", "Scan a scenario.", {"type": "object", "properties": {"scenario": {"type": "string"}}})]


def usage(**kw):
    base = dict(input_tokens=0, output_tokens=0, cache_read_input_tokens=0, cache_creation_input_tokens=0, iterations=None)
    return SimpleNamespace(**(base | kw))


def response(*blocks, stop_reason="end_turn", model="claude-opus-5-5", stop_details=None, **use):
    return SimpleNamespace(content=list(blocks), stop_reason=stop_reason, stop_details=stop_details, model=model,
                           usage=usage(**use))


def stubbed(answer):
    llm = ClaudeLLM("test-key", "claude-opus-5-5", "medium")
    sent = []

    async def create(**kwargs):
        sent.append(kwargs)
        if isinstance(answer, Exception):
            raise answer
        return answer

    llm._client = SimpleNamespace(beta=SimpleNamespace(messages=SimpleNamespace(create=create)))
    return llm, sent


def test_the_request_carries_what_this_model_accepts_and_nothing_it_rejects():
    llm = ClaudeLLM("test-key", "claude-opus-5-5", "medium")
    body = llm.request("system text", [UserText("hello")], TOOLS)
    assert body["model"] == "claude-opus-5-5" and body["system"] == "system text"
    assert body["thinking"] == {"type": "adaptive"} and body["output_config"] == {"effort": "medium"}
    assert body["fallbacks"] == "default" and body["betas"] == ["server-side-fallback-2026-07-01"]
    assert body["cache_control"] == {"type": "ephemeral"} and body["max_tokens"] == 16_000
    # sampling parameters and a forced tool choice are both rejected by this model
    assert not {"temperature", "top_p", "top_k", "tool_choice"} & set(body)
    assert body["tools"] == [{"name": "scan", "description": "Scan a scenario.", "input_schema": TOOLS[0].input_schema}]
    assert "tools" not in llm.request("s", [UserText("write the report")], [])       # the report phase offers none
    assert "output_config" not in ClaudeLLM("k", "some-model", None).request("s", [UserText("x")], [])


def test_history_goes_back_exactly_as_it_arrived():
    llm = ClaudeLLM("test-key", "claude-opus-5-5", "medium")
    thinking = SimpleNamespace(type="thinking", thinking="", signature="opaque")
    raw = [thinking, SimpleNamespace(type="tool_use", id="tu_1", name="scan", input={"scenario": "s"})]
    messages = [UserText("brief"), AssistantTurn(raw),
                ToolResults([ToolResult("tu_1", '{"open": 1}'), ToolResult("tu_2", '{"error": {}}', is_error=True)], note="2 steps left")]
    sent = llm.request("s", messages, TOOLS)["messages"]
    assert sent[0] == {"role": "user", "content": "brief"}
    assert sent[1]["role"] == "assistant" and sent[1]["content"] is raw and sent[1]["content"][0] is thinking
    assert sent[2] == {"role": "user", "content": [
        {"type": "tool_result", "tool_use_id": "tu_1", "content": '{"open": 1}', "is_error": False},
        {"type": "tool_result", "tool_use_id": "tu_2", "content": '{"error": {}}', "is_error": True},
        {"type": "text", "text": "2 steps left"},                                    # after every result, never before
    ]}


async def test_a_response_is_read_by_block_type():
    blocks = [SimpleNamespace(type="thinking", thinking="", signature="x"),
              SimpleNamespace(type="text", text="Looking at the path."),
              SimpleNamespace(type="tool_use", id="tu_1", name="scan", input={"scenario": "s", "because": "first"}),
              SimpleNamespace(type="tool_use", id="tu_2", name="trust_zones", input={"scenario": "s", "because": "second"})]
    llm, sent = stubbed(response(*blocks, stop_reason="tool_use", input_tokens=1000, output_tokens=200,
                                 cache_read_input_tokens=4000, cache_creation_input_tokens=500))
    step = await llm.step("system", [UserText("go")], TOOLS)
    assert sent[0]["model"] == "claude-opus-5-5" and len(sent) == 1
    assert step.text == "Looking at the path." and step.stop_reason == "tool_use" and step.raw is not None
    assert [(c.id, c.name, c.arguments) for c in step.tool_calls] == [
        ("tu_1", "scan", {"scenario": "s", "because": "first"}), ("tu_2", "trust_zones", {"scenario": "s", "because": "second"})]
    assert (step.usage.input_tokens, step.usage.output_tokens, step.usage.cache_read_tokens) == (5500, 200, 4000)
    # 1000 uncached at $4, 200 out at $20, 4000 read at $0.20, 500 written at $5, per million
    assert step.usage.cost_usd == pytest.approx((1000 * 4 + 200 * 20 + 4000 * 0.2 + 500 * 5) / 1e6)


async def test_a_refusal_is_noticed_before_any_content_is_read():
    declined = response(stop_reason="refusal", stop_details=SimpleNamespace(category="cyber"), input_tokens=900)
    llm, _ = stubbed(declined)
    with pytest.raises(LLMRefused, match="cyber"):
        await llm.step("s", [UserText("go")], TOOLS)
    for reason in ("max_tokens", "model_context_window_exceeded"):
        llm, _ = stubbed(response(SimpleNamespace(type="text", text="half an ans"), stop_reason=reason))
        with pytest.raises(LLMError, match=reason):
            await llm.step("s", [UserText("go")], TOOLS)


async def test_a_fallback_answer_is_costed_per_attempt_at_each_models_price():
    attempts = [SimpleNamespace(type="message", model="claude-opus-5-5", input_tokens=1000, output_tokens=0,
                                cache_read_input_tokens=0, cache_creation_input_tokens=0),
                SimpleNamespace(type="fallback_message", model="claude-opus-5", input_tokens=1000, output_tokens=100,
                                cache_read_input_tokens=0, cache_creation_input_tokens=0)]
    llm, _ = stubbed(response(SimpleNamespace(type="text", text="ok"), model="claude-opus-5", input_tokens=1000,
                              output_tokens=100, iterations=attempts))
    step = await llm.step("s", [UserText("go")], [])
    assert step.model == "claude-opus-5" and step.usage.input_tokens == 2000
    assert step.usage.cost_usd == pytest.approx((1000 * 4 + 1000 * 5 + 100 * 25) / 1e6)
    assert cost_usd("a-model-nobody-priced", 1_000_000, 0, 0, 0) == 5.0              # unknown: the dearest known rate


async def test_provider_errors_become_one_error_the_loop_understands():
    request = SimpleNamespace(method="POST", url="https://api.anthropic.com/v1/messages", headers={})
    overloaded = anthropic.APIStatusError("overloaded", response=SimpleNamespace(status_code=529, headers={}, request=request), body=None)
    llm, _ = stubbed(overloaded)
    with pytest.raises(LLMError, match="529"):
        await llm.step("s", [UserText("go")], TOOLS)
    llm, _ = stubbed(anthropic.APIConnectionError(request=request))
    with pytest.raises(LLMError, match="could not be reached"):
        await llm.step("s", [UserText("go")], TOOLS)


def test_no_key_means_no_model_and_the_budget_resets_each_day(monkeypatch):
    assert configured_llm(Settings(anthropic_api_key=None, _env_file=None)) is None
    llm = configured_llm(Settings(anthropic_api_key="k", llm_model="claude-opus-5-5", llm_effort="low", _env_file=None))
    assert llm.name == "claude-opus-5-5" and llm.request("s", [UserText("x")], [])["output_config"] == {"effort": "low"}

    spend = Spend()
    capped = Settings(llm_daily_budget_usd=1.0, _env_file=None)
    spend.add(0.6)
    assert not spend.exhausted(capped)
    spend.add(0.5)
    assert spend.exhausted(capped) and not spend.exhausted(Settings(llm_daily_budget_usd=None, _env_file=None))
    spend._day = "2026-01-01"                                                          # a new day
    assert spend.today_usd == 0.0 and not spend.exhausted(capped)


# ---------------------------------------------------------------------- tool definitions

def test_a_tool_definition_stands_on_its_own_and_asks_why():
    schema = {
        "type": "object", "title": "simulateArguments",
        "$defs": {"Gate": {"title": "Gate", "type": "object", "description": "Gate a call.",
                           "properties": {"kind": {"const": "gate_call", "title": "Kind"}, "title": {"type": "string", "title": "Title"}},
                           "required": ["kind"]},
                  "Plan": {"title": "Plan", "type": "object",
                           "properties": {"fixes": {"type": "array", "minItems": 1, "items": {
                               "oneOf": [{"$ref": "#/$defs/Gate"}],
                               "discriminator": {"propertyName": "kind", "mapping": {"gate_call": "#/$defs/Gate"}}}}}}},
        "properties": {"scenario": {"type": "string", "title": "Scenario"}, "plan": {"$ref": "#/$defs/Plan"}},
        "required": ["scenario", "plan"],
    }
    spec = phases.tool_spec("simulate", "Test a plan\n        in a sandbox.", schema)
    assert spec.description == "Test a plan in a sandbox."
    text = str(spec.input_schema)
    assert "$ref" not in text and "$defs" not in text and "discriminator" not in text
    gate = spec.input_schema["properties"]["plan"]["properties"]["fixes"]["items"]["oneOf"][0]
    assert gate["properties"]["kind"] == {"const": "gate_call"} and gate["description"] == "Gate a call."
    assert gate["properties"]["title"] == {"type": "string"}          # a field that happens to be called `title` survives
    assert spec.input_schema["required"] == ["scenario", "plan", "because"]
    assert spec.input_schema["properties"]["because"]["type"] == "string"
    assert "$defs" in schema and "because" not in schema["properties"]           # the server's own schema is untouched


# ---------------------------------------------------------------------- grounding

def test_ids_are_read_out_of_prose_without_their_punctuation():
    text = ("fnd:dce0910d42 lets src:customer-tickets reach res:payments-api through agent:support-bot, "
            "which calls tool:payments.issue_refund. See mit:b68c44c5ab (wf:refund-request), srv:helpdesk.")
    assert grounding.ids_in(text) == {
        "fnd:dce0910d42", "src:customer-tickets", "res:payments-api", "agent:support-bot",
        "tool:payments.issue_refund", "mit:b68c44c5ab", "wf:refund-request", "srv:helpdesk"}
    assert grounding.ids_in("rule 3: the agent can call it; cost: 2; http://example.com") == set()
    assert grounding.ids_in(None) == set()


def test_ids_are_collected_from_anything_a_tool_returns():
    result = {"findings": [{"id": "fnd:1a2b3c4d5e", "paths": [{"node_ids": ["src:a", "tool:t.get", "agent:x"]}]}],
              "names": {"tool:t.get": '<untrusted source="manifest:srv:t">get</untrusted>'}, "queries": ["reach.untrusted_to_high"]}
    assert grounding.ids_of(result) == {"fnd:1a2b3c4d5e", "src:a", "tool:t.get", "agent:x", "srv:t"}


def test_text_is_ungrounded_exactly_when_it_cites_an_id_no_tool_returned():
    known = {"agent:a", "tool:t.refund", "fnd:1a2b3c4d5e"}
    assert grounding.ungrounded("agent:a calls tool:t.refund.", known) == []
    assert grounding.ungrounded("agent:a and agent:b share tool:t.payout.", known) == ["agent:b", "tool:t.payout"]
    assert grounding.ungrounded("Nothing is open.", known) == []
    assert "agent:b" in grounding.correction(["agent:b"])
