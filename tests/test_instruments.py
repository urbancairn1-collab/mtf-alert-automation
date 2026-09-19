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
