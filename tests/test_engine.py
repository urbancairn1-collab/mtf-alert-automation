import asyncio
from datetime import timedelta

import pytest

from app.brokers.base import OrderOutcomeUnknown
from app.engine.worker import Engine
from app.models import Alert, Order, Position
from tests.factory import MARKET, SATURDAY, add_alert, fetch, make_world, seed_position


@pytest.fixture
def w(tmp_path):
    world = make_world(tmp_path)
    world.engine = Engine(world.ctx)
    return world


async def test_buy_places_mtf_limit_sized_from_amount(w):
    aid = add_alert(w.ctx)
    await w.engine.process(aid)
    [alert] = fetch(w.ctx, Alert, id=aid)
    [order] = fetch(w.ctx, Order)
    assert (alert.status, alert.action_taken) == ("PENDING", "LIMIT BUY sent")
    assert (order.side, order.product, order.order_type) == ("BUY", "MTF", "LIMIT")
    assert order.limit_price == 845.25                    # 842.70 * 1.003 rounded up to 0.05
    assert order.qty == 47                                # 10000 / (845.25 * 25%) = 47.32
    assert order.ordertag == f"MTF{aid}" and order.broker_order_id.startswith("PAPER-")
    assert any("paper estimate" in c["detail"] for c in alert.checks)


async def test_buy_on_held_stock_is_ignored_without_order(w):
    seed_position(w.ctx)
    aid = add_alert(w.ctx)
    await w.engine.process(aid)
    assert fetch(w.ctx, Alert, id=aid)[0].status == "IGNORED"
    assert fetch(w.ctx, Order) == []


async def test_market_closed_rejects_but_test_alert_trades(w):
    closed = add_alert(w.ctx, at=SATURDAY)
    # 5 minutes later: outside the 60 s duplicate window, so only the market-hours rule differs.
    test = add_alert(w.ctx, at=SATURDAY.replace(minute=5), is_test=True, symbol="SBIN")
    await w.engine.process(closed)
    await w.engine.process(test)
    assert fetch(w.ctx, Alert, id=closed)[0].status == "REJECTED"
    assert fetch(w.ctx, Alert, id=test)[0].status == "PENDING"


async def test_index_symbol_rejected(w):
    aid = add_alert(w.ctx, symbol="NIFTY")
    await w.engine.process(aid)
    a = fetch(w.ctx, Alert, id=aid)[0]
    assert a.status == "REJECTED" and "index" in a.detail


async def test_no_price_fails_with_reason(w):
    w.prices.clear()
    aid = add_alert(w.ctx)
    await w.engine.process(aid)
    a = fetch(w.ctx, Alert, id=aid)[0]
    assert a.status == "FAILED" and "No live price" in a.detail


async def test_sell_marks_exiting_and_sends_full_qty(w):
    seed_position(w.ctx, qty=47)
    aid = add_alert(w.ctx, action="SELL")
    await w.engine.process(aid)
    [pos] = fetch(w.ctx, Position)
    [order] = fetch(w.ctx, Order)
    assert pos.status == "EXITING"
    assert (order.side, order.qty, order.limit_price, order.position_id) == ("SELL", 47, 840.15, pos.id)


async def test_sell_squares_off_oldest_open_position_first(w):
    older = seed_position(w.ctx, symbol="SBIN", qty=10, opened_at=MARKET - timedelta(hours=1))
    newer = seed_position(w.ctx, symbol="SBIN", qty=20, opened_at=MARKET)
    aid = add_alert(w.ctx, action="SELL")
    await w.engine.process(aid)
    [order] = fetch(w.ctx, Order)
    assert order.qty == 10
    [pos_older] = fetch(w.ctx, Position, id=older)
    [pos_newer] = fetch(w.ctx, Position, id=newer)
    assert pos_older.status == "EXITING"
    assert pos_newer.status == "OPEN"


async def test_timeout_recovers_order_by_tag_without_duplicate(w):
    real = w.paper.place_limit

    def flaky(req):
        real(req)
        raise OrderOutcomeUnknown("read timeout")

    w.paper.place_limit = flaky
    aid = add_alert(w.ctx)
    await w.engine.process(aid)
    assert fetch(w.ctx, Alert, id=aid)[0].status == "PENDING"
    assert len(w.paper._orders) == 1  # noqa: SLF001 - proves no second placeOrder


async def test_timeout_not_found_fails_safely(w):
    def lost(req):
        raise OrderOutcomeUnknown("connection reset")

    w.paper.place_limit = lost
    aid = add_alert(w.ctx)
    await w.engine.process(aid)
    a = fetch(w.ctx, Alert, id=aid)[0]
    [o] = fetch(w.ctx, Order)
    assert a.status == "FAILED" and o.status == "REJECTED" and "unknown" in o.reason.lower()


async def test_worker_survives_a_crashing_alert(w, monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("scrip master corrupt")

    monkeypatch.setattr(w.ctx.instruments, "resolve", boom)
    task = asyncio.create_task(w.engine.run())
    aid = add_alert(w.ctx)
    w.ctx.alert_queue.put_nowait(aid)
    await asyncio.wait_for(w.ctx.alert_queue.join(), 2)
    task.cancel()
    a = fetch(w.ctx, Alert, id=aid)[0]
    assert a.status == "FAILED" and "scrip master corrupt" in a.detail
