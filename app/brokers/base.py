"""Broker-neutral types. Engine code depends only on this module."""
from dataclasses import dataclass
from typing import Literal, Protocol, Sequence

Side = Literal["BUY", "SELL"]
OrderStatus = Literal["OPEN", "COMPLETE", "PARTIAL", "CANCELLED", "REJECTED"]


@dataclass(frozen=True)
class Instrument:
    symbol: str
    exchange: str
    token: str
    trading_symbol: str
    tick_size: float


@dataclass(frozen=True)
class Quote:
    token: str
    ltp: float
    upper_circuit: float | None = None
    lower_circuit: float | None = None


@dataclass(frozen=True)
class OrderRequest:
    instrument: Instrument
    side: Side
    qty: int
    limit_price: float
    tag: str


@dataclass(frozen=True)
class OrderState:
    broker_order_id: str
    status: OrderStatus
    filled_qty: int
    avg_price: float | None
    message: str = ""


@dataclass(frozen=True)
class Funds:
    available: float
    used: float
    net: float


@dataclass(frozen=True)
class MarginInfo:
    per_share: float
    source: Literal["broker", "paper estimate"]


class BrokerError(Exception):
    def __init__(self, message: str, code: str = ""):
        super().__init__(message)
        self.code = code


class RateLimited(BrokerError):
    pass


class SessionExpired(BrokerError):
    pass


class OrderOutcomeUnknown(BrokerError):
    """placeOrder timed out or the connection dropped: the order may or may not exist.
    Callers must search by tag before deciding anything. Never retry placeOrder blindly."""


class Broker(Protocol):
    name: str

    def connected(self) -> bool: ...
    def quotes(self, instruments: Sequence[Instrument]) -> dict[str, Quote]: ...
    def margin_per_share(self, instrument: Instrument, price: float) -> MarginInfo: ...
    def funds(self) -> Funds | None: ...
    def place_limit(self, req: OrderRequest) -> str: ...
    def modify_limit(self, broker_order_id: str, req: OrderRequest) -> None: ...
    def cancel(self, broker_order_id: str) -> None: ...
    def order_state(self, broker_order_id: str) -> OrderState: ...
    def find_by_tag(self, tag: str) -> OrderState | None: ...
    def account_positions(self) -> list[dict]: ...
    def account_orders(self) -> list[dict]: ...
