import pytest

from app.brokers.base import BrokerError, Instrument, MarginInfo, OrderRequest, Quote
from app.brokers.hub import BrokerHub
from app.brokers.paper import PaperBroker

SBIN = Instrument("SBIN", "NSE", "3045", "SBIN-EQ", 0.05)


def make(ltp=None, broker_margin=None):
    prices = {} if ltp is None else {"3045": Quote("3045", ltp)}
    return PaperBroker(price_source=lambda insts: {t: q for t, q in prices.items()},
                       margin_source=lambda inst, px: broker_margin,
                       paper_margin_pct=lambda: 25.0), prices


def test_buy_fills_at_ltp_when_limit_is_marketable():
    b, _ = make(ltp=842.70)
    oid = b.place_limit(OrderRequest(SBIN, "BUY", 10, 845.25, "A1"))
    s = b.order_state(oid)
    assert (s.status, s.filled_qty, s.avg_price) == ("COMPLETE", 10, 842.70)


def test_buy_stays_open_below_market_then_cancel():
    b, _ = make(ltp=842.70)
    oid = b.place_limit(OrderRequest(SBIN, "BUY", 10, 840.00, "A2"))
    assert b.order_state(oid).status == "OPEN"
    b.cancel(oid)
    assert b.order_state(oid).status == "CANCELLED"


def test_sell_reprice_then_fill():
    b, prices = make(ltp=842.70)
    req = OrderRequest(SBIN, "SELL", 10, 845.00, "A3")
    oid = b.place_limit(req)
    assert b.order_state(oid).status == "OPEN"
    b.modify_limit(oid, OrderRequest(SBIN, "SELL", 10, 840.15, "A3"))
    assert b.order_state(oid).status == "COMPLETE"


def test_fallback_price_from_alert():
    b, _ = make(ltp=None)
    b.note_price("3045", 842.70)
    oid = b.place_limit(OrderRequest(SBIN, "BUY", 1, 845.25, "A4"))
    assert b.order_state(oid).status == "COMPLETE"


def test_margin_prefers_broker_then_paper_estimate():
    b, _ = make(ltp=800.0, broker_margin=MarginInfo(210.0, "broker"))
    assert b.margin_per_share(SBIN, 800.0) == MarginInfo(210.0, "broker")
    b2, _ = make(ltp=800.0, broker_margin=None)
    assert b2.margin_per_share(SBIN, 800.0) == MarginInfo(200.0, "paper estimate")


def test_find_by_tag_and_no_funds_in_paper():
    b, _ = make(ltp=842.70)
    b.place_limit(OrderRequest(SBIN, "BUY", 1, 845.0, "A5"))
    assert b.find_by_tag("A5") is not None and b.find_by_tag("nope") is None
    assert b.funds() is None


def test_unknown_order_id_is_a_broker_error_not_keyerror():
    b, _ = make(ltp=842.70)
    with pytest.raises(BrokerError, match="lost on restart"):
        b.order_state("PAPER-999999")


def test_hub_routes_by_mode():
    paper, _ = make(ltp=1.0)

    class FakeAngel:
        name = "Angel One"
        def connected(self): return False

    hub = BrokerHub(paper, FakeAngel())
    assert hub.for_mode("PAPER") is paper
    assert hub.for_mode("LIVE").name == "Angel One"
    assert hub.data() is None
