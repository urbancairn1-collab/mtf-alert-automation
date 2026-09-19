"""Angel scrip master: download once a day (after 08:30 IST), map TradingView tickers to tokens."""
import json
import logging
from collections.abc import Callable
from datetime import datetime, time, timedelta
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
        skipped = 0
        for r in rows:
            exch = r.get("exch_seg")
            if exch not in ("NSE", "BSE") or r.get("instrumenttype"):
                continue
            sym = str(r.get("symbol", ""))
            if exch == "NSE" and not sym.endswith("-EQ"):
                continue

            # Validate token is present and non-empty
            token = r.get("token", "").strip()
            if not token:
                skipped += 1
                continue

            # Validate tick_size if present is numeric
            tick_size_str = r.get("tick_size")
            if tick_size_str:
                try:
                    tick = float(tick_size_str) / 100
                except (ValueError, TypeError):
                    skipped += 1
                    continue
            else:
                tick = 5 / 100

            key = sym.removesuffix("-EQ").upper() if exch == "NSE" else sym.upper()
            self._index[(exch, key)] = Instrument(key, exch, token, sym, tick)

        if skipped > 0:
            log.warning("scrip master: skipped %d malformed rows", skipped)

    @classmethod
    def load(cls, cache_path: Path, url: str, now: datetime,
             fetch: Callable[[str], list[dict]] = _download) -> "InstrumentMaster":
        now_ist = now.astimezone(IST)
        today_cutoff = datetime.combine(now_ist.date(), REFRESH_AFTER, IST)
        # Compute last_cutoff: today's 08:30 IST if now >= today's 08:30, else yesterday's 08:30 IST
        if now_ist >= today_cutoff:
            last_cutoff = today_cutoff
        else:
            last_cutoff = today_cutoff - timedelta(days=1)

        # Try to use cache if it exists and is fresh
        if cache_path.exists():
            cache_mtime_ist = datetime.fromtimestamp(cache_path.stat().st_mtime, IST)
            if cache_mtime_ist >= last_cutoff:
                try:
                    rows = json.loads(cache_path.read_text(encoding="utf-8"))
                    return cls(rows)
                except (ValueError, OSError) as e:
                    log.warning("scrip master cache corrupted: %s", e)

        # Cache is stale or corrupted; fetch fresh copy
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
