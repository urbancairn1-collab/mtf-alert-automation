from datetime import datetime

from app.clock import IST, is_market_open, market_label


def at(y, mo, d, h, mi):
    return datetime(y, mo, d, h, mi, tzinfo=IST)


def test_open_at_0915_on_weekday():
    assert is_market_open(at(2026, 9, 18, 9, 15)) is True  # Friday


def test_closed_at_1530_exactly():
    assert is_market_open(at(2026, 9, 18, 15, 30)) is False


def test_closed_before_open():
    assert is_market_open(at(2026, 9, 18, 9, 14)) is False


def test_closed_on_saturday():
    assert is_market_open(at(2026, 9, 19, 11, 0)) is False


def test_utc_input_is_converted_to_ist():
    from datetime import timezone
    utc = datetime(2026, 9, 18, 4, 0, tzinfo=timezone.utc)  # 09:30 IST
    assert is_market_open(utc) is True


def test_labels():
    assert market_label(at(2026, 9, 18, 10, 0)) == "Market open"
    assert market_label(at(2026, 9, 19, 10, 0)) == "Market closed (weekend)"
    assert market_label(at(2026, 9, 18, 16, 0)) == "Market closed"
