import json
from datetime import datetime
from pathlib import Path

import pytest

from app.brokers.instruments import InstrumentMaster, UnknownSymbol
from app.clock import IST

ROWS = json.loads((Path(__file__).parent / "fixtures" / "scripmaster_sample.json").read_text())


@pytest.fixture
def master():
    return InstrumentMaster(ROWS)


def test_nse_equity(master):
    i = master.resolve("SBIN", "NSE")
    assert (i.token, i.trading_symbol, i.tick_size) == ("3045", "SBIN-EQ", 0.05)


def test_tradingview_underscore_maps_to_hyphen(master):
    assert master.resolve("BAJAJ_AUTO", "NSE").trading_symbol == "BAJAJ-AUTO-EQ"


def test_ampersand_symbol(master):
    assert master.resolve("M&M", "NSE").token == "2031"


def test_bse_equity(master):
    assert master.resolve("SBIN", "BSE").token == "500112"


def test_index_rejected_with_reason(master):
    with pytest.raises(UnknownSymbol, match="index"):
        master.resolve("NIFTY", "NSE")


def test_unknown_symbol(master):
    with pytest.raises(UnknownSymbol, match="not found"):
        master.resolve("NOPE", "NSE")


def test_cache_used_when_fresh(tmp_path):
    cache = tmp_path / "sm.json"
    cache.write_text(json.dumps(ROWS))
    calls = []
    now = datetime(2026, 9, 18, 10, 0, tzinfo=IST)
    import os
    os.utime(cache, (now.timestamp(), now.timestamp()))
    InstrumentMaster.load(cache, "http://x", now, fetch=lambda url: calls.append(url) or ROWS)
    assert calls == []


def test_cache_refreshed_after_0830_when_old(tmp_path):
    cache = tmp_path / "sm.json"
    cache.write_text("[]")
    old = datetime(2026, 9, 17, 18, 0, tzinfo=IST).timestamp()
    import os
    os.utime(cache, (old, old))
    now = datetime(2026, 9, 18, 9, 0, tzinfo=IST)
    m = InstrumentMaster.load(cache, "http://x", now, fetch=lambda url: ROWS)
    assert m.resolve("SBIN", "NSE").token == "3045"
    assert json.loads(cache.read_text())[0]["token"] == "3045"


def test_corrupt_cache_triggers_download(tmp_path):
    cache = tmp_path / "sm.json"
    cache.write_text("{not json")
    calls = []
    now = datetime(2026, 9, 18, 10, 0, tzinfo=IST)
    import os
    os.utime(cache, (now.timestamp(), now.timestamp()))
    m = InstrumentMaster.load(cache, "http://x", now, fetch=lambda url: calls.append(url) or ROWS)
    assert calls == ["http://x"]
    assert m.resolve("SBIN", "NSE").token == "3045"


def test_malformed_rows_are_skipped():
    bad_rows = ROWS + [
        {"symbol": "BAD-EQ", "exch_seg": "NSE", "instrumenttype": "", "tick_size": "5"},
        {"token": "7", "symbol": "ODD-EQ", "exch_seg": "NSE", "instrumenttype": "", "tick_size": "abc"}
    ]
    m = InstrumentMaster(bad_rows)
    assert m.resolve("SBIN", "NSE").token == "3045"
    with pytest.raises(UnknownSymbol):
        m.resolve("BAD", "NSE")
    with pytest.raises(UnknownSymbol):
        m.resolve("ODD", "NSE")


def test_old_cache_before_0830_is_refreshed(tmp_path):
    cache = tmp_path / "sm.json"
    cache.write_text("[]")
    old = datetime(2026, 9, 14, 18, 0, tzinfo=IST).timestamp()
    import os
    os.utime(cache, (old, old))
    calls = []
    now = datetime(2026, 9, 18, 7, 0, tzinfo=IST)
    InstrumentMaster.load(cache, "http://x", now, fetch=lambda url: calls.append(url) or ROWS)
    assert calls == ["http://x"]


def test_yesterday_evening_cache_is_fresh_before_0830(tmp_path):
    cache = tmp_path / "sm.json"
    cache.write_text(json.dumps(ROWS))
    old = datetime(2026, 9, 17, 18, 0, tzinfo=IST).timestamp()
    import os
    os.utime(cache, (old, old))
    calls = []
    now = datetime(2026, 9, 18, 7, 0, tzinfo=IST)
    InstrumentMaster.load(cache, "http://x", now, fetch=lambda url: calls.append(url) or ROWS)
    assert calls == []
