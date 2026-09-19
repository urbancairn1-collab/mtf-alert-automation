import pytest

from app.engine.sizing import limit_price, round_to_tick, size_order
from app.fmt import inr


@pytest.mark.parametrize("value,decimals,expected", [
    (100000, 0, "₹1,00,000"), (9886.8, 2, "₹9,886.80"), (-174.6, 2, "-₹174.60"),
    (12345678.9, 2, "₹1,23,45,678.90"), (999, 0, "₹999"),
])
def test_inr(value, decimals, expected):
    assert inr(value, decimals) == expected


def test_round_to_tick_handles_float_noise():
    assert round_to_tick(845.2500000001, 0.05, "up") == 845.25
    assert round_to_tick(845.2400001, 0.05, "up") == 845.25
    assert round_to_tick(845.2499, 0.05, "down") == 845.20


def test_buy_limit_is_ltp_plus_buffer_rounded_up():
    assert limit_price(842.70, "BUY", 0.3, 0.05) == 845.25  # 845.228 -> 845.25


def test_sell_limit_is_ltp_minus_buffer_rounded_down():
    assert limit_price(842.70, "SELL", 0.3, 0.05) == 840.15  # 840.172 -> 840.15


def test_buy_limit_capped_at_upper_circuit():
    assert limit_price(100.0, "BUY", 2.0, 0.05, upper=101.0) == 101.0


def test_sell_limit_floored_at_lower_circuit():
    assert limit_price(100.0, "SELL", 2.0, 0.05, lower=99.5) == 99.5


def test_margin_mode_uses_margin_per_share():
    r = size_order("margin", 10000, 1416.65, 354.16, available=None)
    assert r.qty == 28
    assert r.deployed == pytest.approx(28 * 354.16)
    assert "MTF margin per share = 28" in r.note


def test_value_mode_uses_limit_price():
    r = size_order("value", 10000, 842.70, 210.68, available=None)
    assert r.qty == 11
    assert r.deployed == pytest.approx(11 * 842.70)


def test_available_funds_reduce_qty_and_say_so():
    r = size_order("margin", 10000, 800.0, 200.0, available=3000.0)
    assert r.qty == 15
    assert "reduced to 15" in r.note


def test_amount_too_small_gives_zero_qty():
    assert size_order("value", 500, 3612.0, 900.0, available=None).qty == 0
