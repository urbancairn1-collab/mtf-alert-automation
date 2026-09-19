"""Angel scrip master: download once a day (after 08:30 IST), map TradingView tickers to tokens."""
import json
import logging
from collections.abc import Callable
from datetime import datetime, time
from pathlib import Path

import httpx

from app.brokers.base import Instrument
from app.clock import IST

log = logging.getLogger("mtf.instruments")
REFRESH_AFTER = time(8, 30)
INDEX_NAMES = {"NIFTY", "NIFTY50", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "NIFTYNXT50", "SENSEX", "BANKEX"}


class UnknownSymbol(Exception):
    pass


def _download(url: str) -> list[dict]:
    resp = httpx.get(url, timeout=60.0)
    resp.raise_for_status()
    return resp.json()


class InstrumentMaster:
    def __init__(self, rows: list[dict]):
        self._index: dict[tuple[str, str], Instrument] = {}
        for r in rows:
            exch = r.get("exch_seg")
            if exch not in ("NSE", "BSE") or r.get("instrumenttype"):
                continue
            sym = str(r.get("symbol", ""))
            if exch == "NSE" and not sym.endswith("-EQ"):
                continue
            key = sym.removesuffix("-EQ").upper() if exch == "NSE" else sym.upper()
            tick = float(r.get("tick_size") or 5) / 100
            self._index[(exch, key)] = Instrument(key, exch, str(r["token"]), sym, tick)

    @classmethod
    def load(cls, cache_path: Path, url: str, now: datetime,
             fetch: Callable[[str], list[dict]] = _download) -> "InstrumentMaster":
        today_cutoff = datetime.combine(now.astimezone(IST).date(), REFRESH_AFTER, IST)
        fresh = cache_path.exists() and (
            datetime.fromtimestamp(cache_path.stat().st_mtime, IST) >= today_cutoff or now < today_cutoff
        )
        if fresh:
            return cls(json.loads(cache_path.read_text(encoding="utf-8")))
        rows = fetch(url)
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        cache_path.write_text(json.dumps(rows), encoding="utf-8")
        log.info("scrip master refreshed: %d rows", len(rows))
        return cls(rows)

    def __len__(self) -> int:
        return len(self._index)

    def resolve(self, ticker: str, exchange: str) -> Instrument:
        key = ticker.strip().upper().replace("_", "-")
        if key in INDEX_NAMES:
            raise UnknownSymbol(f"{ticker} is an index. Only NSE/BSE equity (-EQ) stocks can be bought in MTF.")
        inst = self._index.get((exchange, key))
        if inst is None:
            raise UnknownSymbol(f"{ticker} not found in the {exchange} equity master.")
        return inst
