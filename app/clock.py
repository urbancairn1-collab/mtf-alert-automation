"""IST time helpers. NSE cash session is Mon-Fri 09:15 <= t < 15:30 IST."""
from datetime import datetime, time
from zoneinfo import ZoneInfo

IST = ZoneInfo("Asia/Kolkata")
MARKET_OPEN = time(9, 15)
MARKET_CLOSE = time(15, 30)


def now_ist() -> datetime:
    return datetime.now(IST)


def _ist(at: datetime | None) -> datetime:
    return now_ist() if at is None else at.astimezone(IST)


def is_market_open(at: datetime | None = None) -> bool:
    t = _ist(at)
    return t.weekday() < 5 and MARKET_OPEN <= t.time() < MARKET_CLOSE


def market_label(at: datetime | None = None) -> str:
    t = _ist(at)
    if t.weekday() >= 5:
        return "Market closed (weekend)"
    return "Market open" if is_market_open(t) else "Market closed"
