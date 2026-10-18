"""The model behind the auditor, behind one small interface so the provider can be swapped.

The loop speaks in the neutral types below. `ClaudeLLM` turns them into Claude
Messages API requests. Its constraints shape the loop, so they are stated here:

- no sampling parameters and no forced tool choice (both are rejected), so
  `tool_choice` stays at its default, auto, and single-answer steps belong to the loop
- thinking is always on; depth is set with `output_config.effort`
- history is append-only: an assistant turn goes back exactly as it arrived,
  thinking blocks included, and every phase is its own conversation with a
  fixed system prompt and a fixed tool list
- a refusal is an ordinary outcome: `stop_reason` is checked before anything is read
"""

import asyncio
import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Protocol

import anthropic

from devries.config import Settings, get_settings


@dataclass(frozen=True)
class ToolSpec:
    name: str
    description: str
    input_schema: dict[str, Any]


@dataclass
class ToolCall:
    id: str
    name: str
    arguments: dict[str, Any]


@dataclass
class Usage:
    input_tokens: int = 0            # everything sent: uncached, cache writes and cache reads
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cost_usd: float = 0.0            # an estimate from list prices: a budget guard, not an invoice

    def add(self, other: "Usage") -> None:
        self.input_tokens += other.input_tokens
        self.output_tokens += other.output_tokens
        self.cache_read_tokens += other.cache_read_tokens
        self.cost_usd += other.cost_usd


@dataclass
class Step:
    text: str | None                 # visible text, if any
    tool_calls: list[ToolCall]       # zero or more; the loop runs them and returns every result in one message
    raw: Any                         # the provider's full response content, appended to the conversation unchanged
    stop_reason: str
    usage: Usage = field(default_factory=Usage)
    model: str | None = None         # the model that produced it; a refusal fallback may have answered


# The conversation, provider-neutral. An assistant turn is opaque: only the adapter that made it reads it.
@dataclass
class UserText:
    text: str


@dataclass
class AssistantTurn:
    raw: Any


@dataclass
class ToolResult:
    call_id: str
    content: str
    is_error: bool = False


@dataclass
class ToolResults:
    results: list[ToolResult]
    note: str | None = None          # text for the model after the results, e.g. a budget reminder


Message = UserText | AssistantTurn | ToolResults


class LLMError(Exception):
    """The provider could not answer, after its own retries."""


class LLMRefused(LLMError):
    """A safety classifier declined, and the server-side fallback did not rescue it."""


class LLM(Protocol):
    name: str

    async def step(self, system: str, messages: list[Message], tools: list[ToolSpec]) -> Step: ...


# USD per million tokens: (input, output, cache read, 5-minute cache write). List prices, October 2026.
log = logging.getLogger("devries.llm")

PRICES = {
    "claude-opus-5-5": (4.00, 20.00, 0.20, 5.00),
    "claude-opus-5": (5.00, 25.00, 0.50, 6.25),
}
_DEAREST = max(PRICES.values(), key=lambda p: p[1])   # an unknown model is costed at the dearest known output rate: a ceiling


def priced(model: str | None) -> bool:
    """Whether the estimate for this model is a price or a ceiling."""
    return (model or "") in PRICES


def cost_usd(model: str | None, uncached: int, output: int, cache_read: int, cache_write: int) -> float:
    price_in, price_out, price_read, price_write = PRICES.get(model or "", _DEAREST)
    return (uncached * price_in + output * price_out + cache_read * price_read + cache_write * price_write) / 1_000_000


class ClaudeLLM:
    """Claude through the Anthropic SDK. One request per step, no streaming: outputs here are short."""

    FALLBACK_BETA = "server-side-fallback-2026-07-01"     # the header for `fallbacks: "default"`

    def __init__(self, api_key: str, model: str, effort: str | None, max_tokens: int = 16_000):
        self.name = model
        self._model = model
        self._effort = effort
        self._max_tokens = max_tokens                     # thinking counts toward it
        # max_retries=2: the SDK tries three times, with backoff, on 408, 409, 429, 5xx and connection errors
        self._client = anthropic.AsyncAnthropic(api_key=api_key, max_retries=2, timeout=120.0)

    def request(self, system: str, messages: list[Message], tools: list[ToolSpec]) -> dict[str, Any]:
        """The request body. Built in one place so a test can check what is, and is not, sent."""
        body: dict[str, Any] = {
            "model": self._model,
            "max_tokens": self._max_tokens,
            "system": system,
            "messages": [self._message(m) for m in messages],
            "thinking": {"type": "adaptive"},
            "cache_control": {"type": "ephemeral"},       # the prefix repeats on every step of a phase
            "betas": [self.FALLBACK_BETA],
            "fallbacks": "default",                       # a classifier decline is retried on the recommended model
        }
        if self._effort:
            body["output_config"] = {"effort": self._effort}
        if tools:                                         # tool_choice is left at auto: forcing a tool is rejected
            body["tools"] = [{"name": t.name, "description": t.description, "input_schema": t.input_schema} for t in tools]
        return body

    @staticmethod
    def _message(message: Message) -> dict[str, Any]:
        if isinstance(message, UserText):
            return {"role": "user", "content": message.text}
        if isinstance(message, AssistantTurn):
            return {"role": "assistant", "content": message.raw}      # unchanged, thinking blocks included
        content: list[dict[str, Any]] = [
            {"type": "tool_result", "tool_use_id": r.call_id, "content": r.content, "is_error": r.is_error}
            for r in message.results
        ]
        if message.note:
            content.append({"type": "text", "text": message.note})   # after the results, never before
        return {"role": "user", "content": content}

    async def step(self, system: str, messages: list[Message], tools: list[ToolSpec]) -> Step:
        try:
            response = await self._client.beta.messages.create(**self.request(system, messages, tools))
        except anthropic.APIStatusError as e:
            raise LLMError(f"the model provider answered {e.status_code} ({type(e).__name__})") from e
        except anthropic.APIError as e:                   # connection errors and timeouts, after the SDK's retries
            raise LLMError(f"the model provider could not be reached ({type(e).__name__})") from e

        usage = self._usage(response)
        if response.stop_reason == "refusal":             # before reading content: it may be empty or partial
            category = getattr(response.stop_details, "category", None)
            raise LLMRefused(f"the model declined the request (category: {category or 'not given'})")
        if response.stop_reason in ("max_tokens", "model_context_window_exceeded"):
            raise LLMError(f"the model stopped early ({response.stop_reason})")

        text = "\n".join(b.text for b in response.content if b.type == "text" and b.text).strip() or None
        calls = [ToolCall(id=b.id, name=b.name, arguments=dict(b.input or {})) for b in response.content if b.type == "tool_use"]
        return Step(text=text, tool_calls=calls, raw=response.content, stop_reason=response.stop_reason or "end_turn",
                    usage=usage, model=response.model)

    @staticmethod
    def _usage(response: Any) -> Usage:
        """Tokens and an estimated cost. With a fallback, each attempt is costed at the model that ran it."""
        attempts = response.usage.iterations or [response.usage]
        out = Usage()
        for attempt in attempts:
            uncached, output = attempt.input_tokens or 0, attempt.output_tokens or 0
            read, write = attempt.cache_read_input_tokens or 0, attempt.cache_creation_input_tokens or 0
            model = getattr(attempt, "model", None) or response.model
            out.add(Usage(input_tokens=uncached + read + write, output_tokens=output, cache_read_tokens=read,
                          cost_usd=cost_usd(model, uncached, output, read, write)))
        return out


class Spend:
    """What the model has cost today against LLM_DAILY_BUDGET_USD. The day's total lives in FalkorDB under one key, so the
    app, a second app process and `make audit` share one budget and a restart forgets nothing; this object mirrors it.
    Without a client attached (tests, a tool run outside the app) it counts in memory."""

    KEY = "devries:spend:{day}"
    KEEP_S = 2 * 86400

    def __init__(self) -> None:
        self._day = ""
        self._usd = 0.0
        self._client: Any = None

    def _roll(self) -> None:
        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        if today != self._day:
            self._day, self._usd = today, 0.0

    def attach(self, client: Any) -> None:
        """Keep the day's total in this client's database from now on."""
        self._client = client

    async def load(self) -> float:
        """Read today's total back from the database, if one is attached."""
        self._roll()
        if self._client is not None:
            try:
                value = await self._client.connection.get(self.KEY.format(day=self._day))
                self._usd = float(value or 0.0)
            except Exception as e:  # noqa: BLE001 - a database that is away: the mirror stands
                log.debug("spend not read: %s", type(e).__name__)
        return self._usd

    async def _write(self, usd: float) -> None:
        key = self.KEY.format(day=self._day)
        try:
            await self._client.connection.incrbyfloat(key, usd)
            await self._client.connection.expire(key, self.KEEP_S)
        except Exception as e:  # noqa: BLE001 - a lost increment is a logged fact; the mirror holds it
            log.debug("spend not written: %s", type(e).__name__)

    def add(self, usd: float) -> None:
        self._roll()
        self._usd += usd
        if self._client is not None and usd:
            try:
                asyncio.get_running_loop().create_task(self._write(usd))
            except RuntimeError:
                pass

    @property
    def today_usd(self) -> float:
        self._roll()
        return self._usd

    def exhausted(self, settings: Settings | None = None) -> bool:
        ceiling = (settings or get_settings()).llm_daily_budget_usd
        return ceiling is not None and self.today_usd >= ceiling


spend = Spend()


def configured_llm(settings: Settings | None = None) -> LLM | None:
    """The model the auditor uses, or None when no key is configured: every run is then scripted."""
    s = settings or get_settings()
    if not s.anthropic_api_key:
        return None
    return ClaudeLLM(s.anthropic_api_key, s.llm_model, None if s.llm_effort == "none" else s.llm_effort)
