"""Simulated broker: same interface as Angel, no orders leave this PC."""
import itertools
from collections.abc import Callable, Sequence
from dataclasses import dataclass, replace

from app.brokers.base import BrokerError, Funds, Instrument, MarginInfo, OrderRequest, OrderState, Quote


@dataclass
class _PaperOrder:
    req: OrderRequest
    state: OrderState


class PaperBroker:
    name = "Paper"

    def __init__(self, price_source: Callable[[Sequence[Instrument]], dict[str, Quote]],
                 margin_source: Callable[[Instrument, float], MarginInfo | None],
                 paper_margin_pct: Callable[[], float]):
        self._price_source = price_source
        self._margin_source = margin_source
        self._paper_margin_pct = paper_margin_pct
        self._orders: dict[str, _PaperOrder] = {}
        self._fallback: dict[str, float] = {}
        self._ids = itertools.count(1)

    def connected(self) -> bool:
        return True

    def note_price(self, token: str, price: float) -> None:
        self._fallback[token] = price

    def quotes(self, instruments: Sequence[Instrument]) -> dict[str, Quote]:
        live = self._price_source(instruments)
        out = {i.token: live[i.token] for i in instruments if i.token in live}
        for i in instruments:
            if i.token not in out and i.token in self._fallback:
                out[i.token] = Quote(i.token, self._fallback[i.token])
        return out

    def margin_per_share(self, instrument: Instrument, price: float) -> MarginInfo:
        broker = self._margin_source(instrument, price)
        if broker is not None:
            return broker
        return MarginInfo(round(price * self._paper_margin_pct() / 100, 2), "paper estimate")

    def funds(self) -> Funds | None:
        return None  # paper money is bounded by the capital cap, not by a cash balance

    def place_limit(self, req: OrderRequest) -> str:
        oid = f"PAPER-{next(self._ids):06d}"
        self._orders[oid] = _PaperOrder(req, OrderState(oid, "OPEN", 0, None))
        return oid

    def _get(self, broker_order_id: str) -> _PaperOrder:
        try:
            return self._orders[broker_order_id]
        except KeyError:
            # Paper orders live in memory; after an app restart the tracker may ask for an old id.
            raise BrokerError(f"Paper order {broker_order_id} not found (lost on restart).") from None

    def modify_limit(self, broker_order_id: str, req: OrderRequest) -> None:
        self._get(broker_order_id).req = req

    def cancel(self, broker_order_id: str) -> None:
        o = self._get(broker_order_id)
        if o.state.status == "OPEN":
            o.state = replace(o.state, status="CANCELLED", message="Cancelled")

    def order_state(self, broker_order_id: str) -> OrderState:
        o = self._get(broker_order_id)
        if o.state.status != "OPEN":
            return o.state
        quote = self.quotes([o.req.instrument]).get(o.req.instrument.token)
        if quote is None:
            return o.state
        marketable = o.req.limit_price >= quote.ltp if o.req.side == "BUY" else o.req.limit_price <= quote.ltp
        if marketable:
            o.state = OrderState(broker_order_id, "COMPLETE", o.req.qty, quote.ltp, "Paper fill")
        return o.state

    def find_by_tag(self, tag: str) -> OrderState | None:
        for oid, o in self._orders.items():
            if o.req.tag == tag:
                return self.order_state(oid)
        return None

    def account_positions(self) -> list[dict]:
        return []

    def account_orders(self) -> list[dict]:
        return []
