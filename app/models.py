"""Ledger tables (spec section 5). Times are timezone-aware IST datetimes."""
from datetime import datetime

from sqlalchemy import JSON, Float, ForeignKey, Integer, String, Text
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column
from sqlalchemy.types import TypeDecorator

from app.clock import IST


class AwareDateTime(TypeDecorator):
    """SQLite drops tz info from DateTime columns and hands back naive datetimes, which then
    crash when compared with aware ones. Store ISO-8601 in IST instead: always aware on read,
    and same-offset strings sort chronologically, so range filters on the column still work."""

    impl = String(40)
    cache_ok = True

    def process_bind_param(self, value, dialect):
        if value is None:
            return None
        if value.tzinfo is None:
            raise ValueError("naive datetime given to AwareDateTime")
        return value.astimezone(IST).isoformat()

    def process_result_value(self, value, dialect):
        return None if value is None else datetime.fromisoformat(value)


class Base(DeclarativeBase):
    pass


class SettingsRow(Base):
    __tablename__ = "settings"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    data: Mapped[dict] = mapped_column(JSON, default=dict)
    webhook_secret_enc: Mapped[str | None] = mapped_column(Text)


class BrokerAccount(Base):
    __tablename__ = "broker_accounts"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    broker: Mapped[str] = mapped_column(String(20), default="angelone")
    client_code: Mapped[str | None] = mapped_column(String(20))
    api_key_enc: Mapped[str | None] = mapped_column(Text)
    mpin_enc: Mapped[str | None] = mapped_column(Text)
    totp_secret_enc: Mapped[str | None] = mapped_column(Text)
    last_login_at: Mapped[datetime | None] = mapped_column(AwareDateTime())
    session_valid_till: Mapped[datetime | None] = mapped_column(AwareDateTime())
    last_error: Mapped[str | None] = mapped_column(Text)


class Alert(Base):
    __tablename__ = "alerts"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    received_at: Mapped[datetime] = mapped_column(AwareDateTime(), index=True)
    source_ip: Mapped[str] = mapped_column(String(64), default="")
    raw_payload: Mapped[dict] = mapped_column(JSON, default=dict)
    symbol: Mapped[str] = mapped_column(String(32), default="", index=True)
    exchange: Mapped[str] = mapped_column(String(8), default="NSE")
    action: Mapped[str] = mapped_column(String(4), default="")
    alert_price: Mapped[float | None] = mapped_column(Float)
    is_test: Mapped[bool] = mapped_column(default=False)
    status: Mapped[str] = mapped_column(String(16), default="PENDING", index=True)
    action_taken: Mapped[str] = mapped_column(String(64), default="Processing")
    detail: Mapped[str] = mapped_column(Text, default="")
    checks: Mapped[list] = mapped_column(JSON, default=list)
    order_id: Mapped[int | None] = mapped_column(ForeignKey("orders.id"))


class Order(Base):
    __tablename__ = "orders"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    alert_id: Mapped[int | None] = mapped_column(Integer, index=True)
    mode: Mapped[str] = mapped_column(String(5))
    broker_order_id: Mapped[str | None] = mapped_column(String(64), index=True)
    ordertag: Mapped[str] = mapped_column(String(20))
    symbol: Mapped[str] = mapped_column(String(32))
    exchange: Mapped[str] = mapped_column(String(8))
    token: Mapped[str] = mapped_column(String(16))
    trading_symbol: Mapped[str] = mapped_column(String(40))
    side: Mapped[str] = mapped_column(String(4))
    product: Mapped[str] = mapped_column(String(8), default="MTF")
    order_type: Mapped[str] = mapped_column(String(8), default="LIMIT")
    qty: Mapped[int] = mapped_column(Integer)
    limit_price: Mapped[float] = mapped_column(Float)
    filled_qty: Mapped[int] = mapped_column(Integer, default=0)
    avg_price: Mapped[float | None] = mapped_column(Float)
    status: Mapped[str] = mapped_column(String(10), default="OPEN", index=True)
    reason: Mapped[str] = mapped_column(Text, default="")
    reprice_count: Mapped[int] = mapped_column(Integer, default=0)
    margin_per_share: Mapped[float] = mapped_column(Float, default=0.0)
    sizing_mode: Mapped[str] = mapped_column(String(6), default="margin")
    deployed_estimate: Mapped[float] = mapped_column(Float, default=0.0)
    exit_pending_flagged: Mapped[bool] = mapped_column(default=False)
    position_id: Mapped[int | None] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(AwareDateTime())
    updated_at: Mapped[datetime] = mapped_column(AwareDateTime())


class Position(Base):
    __tablename__ = "positions"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    mode: Mapped[str] = mapped_column(String(5), index=True)
    symbol: Mapped[str] = mapped_column(String(32), index=True)
    exchange: Mapped[str] = mapped_column(String(8))
    token: Mapped[str] = mapped_column(String(16))
    trading_symbol: Mapped[str] = mapped_column(String(40))
    qty: Mapped[int] = mapped_column(Integer)
    avg_price: Mapped[float] = mapped_column(Float)
    deployed_amount: Mapped[float] = mapped_column(Float)
    margin_per_share: Mapped[float] = mapped_column(Float)
    status: Mapped[str] = mapped_column(String(8), default="OPEN", index=True)
    entry_order_id: Mapped[int] = mapped_column(Integer)
    opened_at: Mapped[datetime] = mapped_column(AwareDateTime())


class Trade(Base):
    __tablename__ = "trades"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    mode: Mapped[str] = mapped_column(String(5), index=True)
    position_id: Mapped[int] = mapped_column(Integer)
    symbol: Mapped[str] = mapped_column(String(32))
    qty: Mapped[int] = mapped_column(Integer)
    entry_price: Mapped[float] = mapped_column(Float)
    exit_price: Mapped[float] = mapped_column(Float)
    deployed_amount: Mapped[float] = mapped_column(Float)
    realised_pnl: Mapped[float] = mapped_column(Float)
    pnl_pct: Mapped[float] = mapped_column(Float)
    opened_at: Mapped[datetime] = mapped_column(AwareDateTime())
    closed_at: Mapped[datetime] = mapped_column(AwareDateTime(), index=True)
    exit_order_id: Mapped[int] = mapped_column(Integer)


class EventRow(Base):
    __tablename__ = "events"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    ts: Mapped[datetime] = mapped_column(AwareDateTime(), index=True)
    level: Mapped[str] = mapped_column(String(5))
    category: Mapped[str] = mapped_column(String(10))
    message: Mapped[str] = mapped_column(Text)
    data: Mapped[dict | None] = mapped_column(JSON)
