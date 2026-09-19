"""Ledger queries shared by the engine, the order tracker and the API."""
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Alert, Order, Position

LIVE_POSITION = ("OPEN", "EXITING")
WORKING = ("OPEN", "PARTIAL")


def open_positions(s: Session, mode: str) -> list[Position]:
    q = select(Position).where(Position.mode == mode, Position.status.in_(LIVE_POSITION)).order_by(Position.opened_at)
    return list(s.scalars(q))


def position_for(s: Session, mode: str, symbol: str) -> Position | None:
    # When one_position_per_stock is off, a symbol can have several open positions; one SELL
    # squares off the OLDEST OPEN one first (FIFO), never an EXITING one already being closed.
    q = (select(Position)
        .where(Position.mode == mode, Position.symbol == symbol, Position.status == "OPEN")
        .order_by(Position.opened_at, Position.id))
    return s.scalars(q).first()


def recent_alerts(s: Session, exclude_id: int, since: datetime) -> list[tuple[str, str, datetime]]:
    rows = s.scalars(select(Alert).where(Alert.id != exclude_id, Alert.received_at >= since))
    # Only alerts that passed secret/format count as repeats; garbage must not block a real alert.
    return [(a.symbol, a.action, a.received_at) for a in rows if a.checks and a.checks[0].get("ok")]


def working_buy_deployed(s: Session, mode: str) -> float:
    q = select(Order).where(Order.mode == mode, Order.side == "BUY", Order.status.in_(WORKING))
    return round(sum(o.deployed_estimate for o in s.scalars(q)), 2)


def working_orders(s: Session) -> list[Order]:
    q = select(Order).where(Order.status.in_(WORKING), Order.broker_order_id.is_not(None))
    return list(s.scalars(q))
