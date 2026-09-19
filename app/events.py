"""In-process pub/sub feeding the SSE endpoint, plus the persistent event log."""
import asyncio
import logging

from sqlalchemy.orm import Session

from app.clock import now_ist
from app.models import EventRow

log = logging.getLogger("mtf.events")


class EventBus:
    def __init__(self, queue_size: int = 200):
        self._queue_size = queue_size
        self._subscribers: set[asyncio.Queue] = set()

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=self._queue_size)
        self._subscribers.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        self._subscribers.discard(q)

    def publish(self, type_: str, payload: dict) -> None:
        for q in list(self._subscribers):
            try:
                q.put_nowait((type_, payload))
            except asyncio.QueueFull:
                # A stalled browser tab must never block trading; it reconnects and reloads.
                self._subscribers.discard(q)
                log.warning("dropped a slow SSE subscriber")


def log_event(s: Session, bus: EventBus, level: str, category: str, message: str,
              data: dict | None = None) -> None:
    row = EventRow(ts=now_ist(), level=level, category=category, message=message, data=data)
    s.add(row)
    s.flush()
    getattr(log, {"INFO": "info", "WARN": "warning", "ERROR": "error"}[level])("%s: %s", category, message)
    bus.publish("log", {"id": row.id, "ts": row.ts.isoformat(), "level": level,
                        "category": category, "message": message, "data": data})
