"""Pure pricing and sizing maths (spec 6.2). No I/O, fully unit-tested."""
import math
from dataclasses import dataclass
from typing import Literal

from app.fmt import inr

EPS = 1e-6


def round_to_tick(price: float, tick: float, direction: Literal["up", "down"]) -> float:
    steps = price / tick
    n = math.ceil(steps - EPS) if direction == "up" else math.floor(steps + EPS)
    return round(n * tick, 2)


def limit_price(ltp: float, side: Literal["BUY", "SELL"], buffer_pct: float, tick: float,
                upper: float | None = None, lower: float | None = None) -> float:
    if side == "BUY":
        px = round_to_tick(ltp * (1 + buffer_pct / 100), tick, "up")
        return min(px, round_to_tick(upper, tick, "down")) if upper else px
    px = round_to_tick(ltp * (1 - buffer_pct / 100), tick, "down")
    return max(px, round_to_tick(lower, tick, "up")) if lower else px


@dataclass(frozen=True)
class SizeResult:
    qty: int
    deployed: float
    margin_per_share: float
    note: str


def size_order(mode: Literal["margin", "value"], amount: float, limit: float,
               margin_per_share: float, available: float | None) -> SizeResult:
    if mode == "margin":
        qty = math.floor(amount / margin_per_share + EPS)
        note = f"{inr(amount, 0)} / {inr(margin_per_share)} MTF margin per share = {qty}"
    else:
        qty = math.floor(amount / limit + EPS)
        note = f"{inr(amount, 0)} / {inr(limit)} order value = {qty}"
    if available is not None and qty * margin_per_share > available + EPS:
        qty = math.floor(available / margin_per_share + EPS)
        note += f"; reduced to {qty} by available margin {inr(available)}"
    deployed = qty * margin_per_share if mode == "margin" else qty * limit
    return SizeResult(qty, round(deployed, 2), margin_per_share, note)
