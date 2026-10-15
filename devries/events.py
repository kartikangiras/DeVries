"""One in-process event bus. The engines stay silent; ops.py and the auditor publish; the API streams.

An event is about one working graph. Who may see it is decided from that graph
key by the subscriber's filter, and the key itself is never sent.
"""

import asyncio
import time
from collections import deque
from dataclasses import dataclass
from secrets import token_hex
from typing import Any, Callable

from devries.graph import keys

BOOT = token_hex(4)          # changes when the process restarts, so a client knows its event ids are void


@dataclass(frozen=True)
class Event:
    seq: int
    type: str
    graph: str               # the working graph this is about; filtered on, never serialised
    scenario: str
    at: int                  # epoch ms
    data: dict[str, Any]

    def public(self) -> dict[str, Any]:
        return {"id": self.seq, "type": self.type, "scenario": self.scenario, "at": self.at, "data": self.data}


class Subscription:
    def __init__(self, bus: "EventBus", wants: Callable[[Event], bool]):
        self._bus = bus
        self.wants = wants
        self.queue: asyncio.Queue[Event] = asyncio.Queue(maxsize=1000)
        self.lagged = False                      # an event was dropped because this consumer fell behind

    async def get(self, timeout: float | None = None) -> Event | None:
        """The next event, or None if none arrived within `timeout` seconds."""
        try:
            return await asyncio.wait_for(self.queue.get(), timeout)
        except asyncio.TimeoutError:
            return None

    def close(self) -> None:
        self._bus._subscriptions.discard(self)

    def __enter__(self) -> "Subscription":
        return self

    def __exit__(self, *exc) -> None:
        self.close()


class EventBus:
    def __init__(self, history: int = 500):
        self._seq = 0
        self._history: deque[Event] = deque(maxlen=history)
        self._subscriptions: set[Subscription] = set()

    @property
    def last_seq(self) -> int:
        return self._seq

    def publish(self, graph_key: str, type: str, data: dict[str, Any] | None = None) -> Event:
        self._seq += 1
        event = Event(seq=self._seq, type=type, graph=graph_key, scenario=keys.scenario_of(graph_key),
                      at=int(time.time() * 1000), data=data or {})
        self._history.append(event)
        for sub in list(self._subscriptions):
            if sub.wants(event):
                try:
                    sub.queue.put_nowait(event)
                except asyncio.QueueFull:
                    sub.lagged = True
        return event

    def subscribe(self, wants: Callable[[Event], bool], after: int | None = None) -> Subscription:
        """Events the filter accepts, from now on. With `after`, recent events newer than that id come first."""
        sub = Subscription(self, wants)
        if after is not None:
            for event in self._history:
                if event.seq > after and wants(event):
                    sub.queue.put_nowait(event)
        self._subscriptions.add(sub)
        return sub

    def recent(self, wants: Callable[[Event], bool], limit: int = 100) -> list[Event]:
        return [e for e in self._history if wants(e)][-limit:]


bus = EventBus()
