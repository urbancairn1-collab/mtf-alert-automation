from datetime import datetime, timedelta

from app.clock import IST
from app.engine.guards import GuardContext, OpenPos, evaluate
from app.settings_model import TradingSettings

NOW = datetime(2026, 9, 18, 11, 0, tzinfo=IST)


def ctx(**over):
    base = dict(settings=TradingSettings(), now=NOW, market_open=True, is_test=False,
                recent=(), positions=(), working_buy_deployed=0.0)
    return GuardContext(**{**base, **over})


def test_clean_buy_passes_with_trace():
    v = evaluate("SBIN", "BUY", ctx())
    assert v.passed and [c.name for c in v.checks][:2] == ["Automation ON", "Market open"]


def test_kill_switch_first():
    v = evaluate("SBIN", "BUY", ctx(settings=TradingSettings(automation_on=False), market_open=False))
    assert v.status == "REJECTED" and "Automation is OFF" in v.reason


def test_market_closed_rejects_but_test_alert_skips():
    assert evaluate("SBIN", "BUY", ctx(market_open=False)).status == "REJECTED"
    v = evaluate("SBIN", "BUY", ctx(market_open=False, is_test=True))
    assert v.passed and any("Skipped" in c.detail for c in v.checks)


def test_duplicate_within_window():
    recent = (("SBIN", "BUY", NOW - timedelta(seconds=20)),)
    assert evaluate("SBIN", "BUY", ctx(recent=recent)).status == "DUPLICATE"


def test_duplicate_outside_window_or_protection_off_passes():
    old = (("SBIN", "BUY", NOW - timedelta(seconds=90)),)
    assert evaluate("SBIN", "BUY", ctx(recent=old)).passed
    recent = (("SBIN", "BUY", NOW - timedelta(seconds=5)),)
    assert evaluate("SBIN", "BUY", ctx(recent=recent, settings=TradingSettings(duplicate_protection=False))).passed


def test_buy_on_held_stock_ignored():
    v = evaluate("SBIN", "BUY", ctx(positions=(OpenPos("SBIN", "OPEN", 9000.0),)))
    assert v.status == "IGNORED" and "Already holding" in v.reason


def test_max_positions():
    held = tuple(OpenPos(s, "OPEN", 9000.0) for s in ["A", "B", "C", "D", "E"])
    v = evaluate("SBIN", "BUY", ctx(positions=held))
    assert v.status == "REJECTED" and "5 of 5" in v.reason


def test_capital_cap_counts_working_buys():
    held = (OpenPos("A", "OPEN", 45000.0), OpenPos("B", "OPEN", 45000.0))
    v = evaluate("SBIN", "BUY", ctx(positions=held, working_buy_deployed=1000.0))
    assert v.status == "REJECTED" and "Capital cap" in v.reason


def test_sell_without_position_ignored():
    assert evaluate("SBIN", "SELL", ctx()).status == "IGNORED"


def test_sell_while_exiting_ignored():
    v = evaluate("SBIN", "SELL", ctx(positions=(OpenPos("SBIN", "EXITING", 9000.0),)))
    assert v.status == "IGNORED" and "already in progress" in v.reason


def test_sell_with_open_position_passes():
    assert evaluate("SBIN", "SELL", ctx(positions=(OpenPos("SBIN", "OPEN", 9000.0),))).passed


def test_sell_ignored_when_any_same_symbol_position_is_exiting():
    v = evaluate("SBIN", "SELL", ctx(positions=(OpenPos("SBIN", "OPEN", 9000.0), OpenPos("SBIN", "EXITING", 9000.0))))
    assert v.status == "IGNORED" and "already in progress" in v.reason
    v = evaluate("SBIN", "SELL", ctx(positions=(OpenPos("SBIN", "EXITING", 9000.0), OpenPos("SBIN", "OPEN", 9000.0))))
    assert v.status == "IGNORED" and "already in progress" in v.reason


def test_sell_passes_with_two_open_same_symbol_positions():
    assert evaluate("SBIN", "SELL", ctx(positions=(OpenPos("SBIN", "OPEN", 9000.0), OpenPos("SBIN", "OPEN", 4500.0)))).passed
