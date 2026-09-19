"""Spec 6.1 guard chain. Pure functions: the first failing guard decides, every guard run is traced."""
from dataclasses import asdict, dataclass
from datetime import datetime
from typing import Literal

from app.fmt import inr
from app.settings_model import TradingSettings


@dataclass(frozen=True)
class Check:
    name: str
    ok: bool
    detail: str

    def as_dict(self) -> dict:
        return asdict(self)


@dataclass(frozen=True)
class OpenPos:
    symbol: str
    status: Literal["OPEN", "EXITING"]
    deployed: float


@dataclass(frozen=True)
class GuardContext:
    settings: TradingSettings
    now: datetime
    market_open: bool
    is_test: bool
    recent: tuple[tuple[str, str, datetime], ...]
    positions: tuple[OpenPos, ...]
    working_buy_deployed: float


@dataclass(frozen=True)
class Verdict:
    status: str | None
    reason: str
    checks: tuple[Check, ...]

    @property
    def passed(self) -> bool:
        return self.status is None


def _automation(sym, act, c):
    if not c.settings.automation_on:
        return "REJECTED", Check("Automation ON", False, "Automation is OFF (kill switch).")
    return None, Check("Automation ON", True, "Kill switch is off")


def _market(sym, act, c):
    if c.is_test:
        return None, Check("Market open", True, "Skipped for test alerts so setup can be checked after hours")
    if not c.market_open:
        return "REJECTED", Check("Market open", False, "Market closed. Orders only Mon-Fri 09:15-15:30 IST.")
    return None, Check("Market open", True, "NSE session 09:15-15:30 IST")


def _duplicate(sym, act, c):
    s = c.settings
    if s.duplicate_protection:
        for r_sym, r_act, r_at in c.recent:
            age = (c.now - r_at).total_seconds()
            if r_sym == sym and r_act == act and 0 <= age < s.duplicate_window_sec:
                return "DUPLICATE", Check("Not a duplicate", False,
                                          f"Same {act} for {sym} {int(age)} s ago (window {s.duplicate_window_sec} s).")
    return None, Check("Not a duplicate", True, f"No same alert in last {s.duplicate_window_sec} s")


def _buy_rules(sym, act, c):
    s = c.settings
    if s.one_position_per_stock and any(p.symbol == sym for p in c.positions):
        return "IGNORED", Check("One position per stock", False, f"Already holding {sym} (one open position per stock).")
    if len(c.positions) >= s.max_open_positions:
        n = len(c.positions)
        return "REJECTED", Check("Max open positions", False, f"Max open positions reached ({n} of {s.max_open_positions}).")
    used = sum(p.deployed for p in c.positions) + c.working_buy_deployed
    if used + s.amount_per_trade > s.capital_cap:
        return "REJECTED", Check("Capital cap", False,
                                 f"Capital cap reached: {inr(used)} deployed of {inr(s.capital_cap, 0)}.")
    return None, Check("Risk limits", True, f"{len(c.positions)} of {s.max_open_positions} positions, "
                                            f"{inr(used)} of {inr(s.capital_cap, 0)} used")


def _sell_rules(sym, act, c):
    pos = next((p for p in c.positions if p.symbol == sym), None)
    if pos is None:
        return "IGNORED", Check("Open position exists", False, f"No open MTF position in {sym}. Nothing to square off.")
    if pos.status == "EXITING":
        return "IGNORED", Check("Exit not already working", False, f"Exit for {sym} already in progress.")
    return None, Check("Open position exists", True, f"{sym} held, squaring off in full")


def evaluate(symbol: str, action: Literal["BUY", "SELL"], ctx: GuardContext) -> Verdict:
    chain = [_automation, _market, _duplicate, _buy_rules if action == "BUY" else _sell_rules]
    checks: list[Check] = []
    for guard in chain:
        status, check = guard(symbol, action, ctx)
        checks.append(check)
        if status:
            return Verdict(status, check.detail, tuple(checks))
    return Verdict(None, "", tuple(checks))
