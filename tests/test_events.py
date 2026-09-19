import asyncio

from sqlalchemy import select

from app.events import EventBus, log_event
from app.models import EventRow


async def test_publish_reaches_subscriber():
    bus = EventBus()
    q = bus.subscribe()
    bus.publish("tick", {"SBIN": 842.7})
    assert await asyncio.wait_for(q.get(), 1) == ("tick", {"SBIN": 842.7})


async def test_slow_subscriber_is_dropped_not_blocking():
    bus = EventBus(queue_size=2)
    slow = bus.subscribe()
    for i in range(5):
        bus.publish("tick", {"i": i})
    assert slow not in bus._subscribers  # noqa: SLF001 - asserting the drop policy


async def test_log_event_persists_and_publishes(session):
    bus = EventBus()
    q = bus.subscribe()
    log_event(session, bus, "WARN", "broker", "Angel rate limit (AB1021)", {"cooldown": 45})
    row = session.scalars(select(EventRow)).one()
    assert (row.level, row.category) == ("WARN", "broker")
    kind, payload = await asyncio.wait_for(q.get(), 1)
    assert kind == "log" and payload["message"].startswith("Angel rate limit")
