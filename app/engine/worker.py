"""Single sequential consumer of accepted alerts (spec 6). One alert at a time, so the
capital cap and one-position-per-stock checks can never race each other."""
import asyncio
import logging
from datetime import timedelta

from app.brokers.base import Broker, BrokerError, Instrument, OrderOutcomeUnknown, OrderRequest, Quote
from app.brokers.instruments import UnknownSymbol
from app.clock import is_market_open, now_ist
from app.context import AppContext
from app.db import session_scope
from app.engine.guards import Check, GuardContext, OpenPos, evaluate
from app.engine.ledger import open_positions, position_for, recent_alerts, working_buy_deployed
from app.engine.sizing import SizeResult, limit_price, size_order
from app.events import log_event
from app.fmt import inr
from app.models import Alert, Order, Position
from app.repo_settings import load_settings
from app.settings_model import TradingSettings

log = logging.getLogger("mtf.engine")
LEVEL = {"REJECTED": "WARN", "DUPLICATE": "WARN", "IGNORED": "INFO", "FAILED": "ERROR", "PENDING": "INFO"}


def order_tag(alert_id: int) -> str:
    return f"MTF{alert_id}"


class Engine:
    def __init__(self, ctx: AppContext):
        self.ctx = ctx

    async def run(self) -> None:
        while True:
            alert_id = await self.ctx.alert_queue.get()
            try:
                await self.process(alert_id)
            except Exception as err:  # noqa: BLE001 - one bad alert must never stop the engine
                log.exception("alert %s crashed", alert_id)
                self._finish(alert_id, "FAILED", "Engine error", f"Internal error: {err}")
            finally:
                self.ctx.alert_queue.task_done()

    async def process(self, alert_id: int) -> None:
        decided = self._decide(alert_id)
        if decided is None:
            return
        inst, action, alert_price, settings = decided
        broker = self.ctx.hub.for_mode(settings.mode)
        if action == "BUY":
            await self._buy(alert_id, inst, alert_price, settings, broker)
        else:
            await self._sell(alert_id, inst, alert_price, settings, broker)

    # ---- decision (guards + symbol) -------------------------------------------------
    def _decide(self, alert_id: int):
        with session_scope(self.ctx.db) as s:
            alert = s.get(Alert, alert_id)
            settings = load_settings(s)
            verdict = evaluate(alert.symbol, alert.action, self._guard_ctx(s, alert, settings))
            alert.checks = [*alert.checks, *(c.as_dict() for c in verdict.checks)]
            if not verdict.passed:
                self._set(s, alert, verdict.status, "No order", verdict.reason)
                return None
            try:
                inst = self.ctx.instruments.resolve(alert.symbol, alert.exchange)
            except UnknownSymbol as err:
                alert.checks = [*alert.checks, Check("Symbol", False, str(err)).as_dict()]
                self._set(s, alert, "REJECTED", "No order", str(err))
                return None
            return inst, alert.action, alert.alert_price, settings

    def _guard_ctx(self, s, alert: Alert, settings: TradingSettings) -> GuardContext:
        at = alert.received_at
        return GuardContext(
            settings=settings, now=at, market_open=is_market_open(at), is_test=alert.is_test,
            recent=tuple(recent_alerts(s, alert.id, at - timedelta(hours=1))),
            positions=tuple(OpenPos(p.symbol, p.status, p.deployed_amount) for p in open_positions(s, settings.mode)),
            working_buy_deployed=working_buy_deployed(s, settings.mode),
        )

    # ---- BUY / SELL -------------------------------------------------------------------
    async def _quote(self, broker: Broker, inst: Instrument, alert_price: float | None) -> Quote | None:
        note = getattr(broker, "note_price", None)
        if note and alert_price:
            note(inst.token, alert_price)
        quotes = await asyncio.to_thread(broker.quotes, [inst])
        return quotes.get(inst.token)

    async def _buy(self, alert_id, inst, alert_price, settings: TradingSettings, broker: Broker) -> None:
        quote = await self._quote(broker, inst, alert_price)
        if quote is None:
            return self._finish(alert_id, "FAILED", "No order", f"No live price for {inst.symbol}. Connect Angel One.")
        limit = limit_price(quote.ltp, "BUY", settings.limit_buffer_pct, inst.tick_size,
                            quote.upper_circuit, quote.lower_circuit)
        margin = await asyncio.to_thread(broker.margin_per_share, inst, limit)
        funds = await asyncio.to_thread(broker.funds)
        size = size_order(settings.sizing_mode, settings.amount_per_trade, limit, margin.per_share,
                          funds.available if funds else None)
        suffix = " (paper estimate)" if margin.source == "paper estimate" else ""
        check = Check("Qty from amount", size.qty >= 1, size.note + suffix)
        if size.qty < 1:
            return self._finish(alert_id, "REJECTED", "No order", "Amount too small for one share.", check)
        req = OrderRequest(inst, "BUY", size.qty, limit, order_tag(alert_id))
        await self._send(alert_id, broker, settings, req, size, None, check)

    async def _sell(self, alert_id, inst, alert_price, settings: TradingSettings, broker: Broker) -> None:
        with session_scope(self.ctx.db) as s:
            pos = position_for(s, settings.mode, inst.symbol)
            pos.status = "EXITING"
            pos_id, qty = pos.id, pos.qty
        quote = await self._quote(broker, inst, alert_price)
        if quote is None:
            self._reopen(pos_id)
            return self._finish(alert_id, "FAILED", "No order", f"No live price for {inst.symbol}. Connect Angel One.")
        limit = limit_price(quote.ltp, "SELL", settings.limit_buffer_pct, inst.tick_size,
                            quote.upper_circuit, quote.lower_circuit)
        check = Check("Square-off", True, f"LIMIT SELL {qty} @ {inr(limit)} (full position)")
        req = OrderRequest(inst, "SELL", qty, limit, order_tag(alert_id))
        await self._send(alert_id, broker, settings, req, None, pos_id, check)

    # ---- sending ----------------------------------------------------------------------
    async def _send(self, alert_id, broker, settings, req: OrderRequest, size: SizeResult | None,
                    position_id: int | None, check: Check) -> None:
        order_id = self._create_order(alert_id, settings, req, size, position_id)
        try:
            broker_id = await self._place(broker, req)
        except BrokerError as err:
            return self._order_failed(order_id, alert_id, position_id, str(err))
        with session_scope(self.ctx.db) as s:
            s.get(Order, order_id).broker_order_id = broker_id
            alert = s.get(Alert, alert_id)
            alert.order_id = order_id
            alert.checks = [*alert.checks, check.as_dict()]
            self._set(s, alert, "PENDING", f"LIMIT {req.side} sent", f"Qty {req.qty} @ {inr(req.limit_price)}")
        self.ctx.bus.publish("order", {"id": order_id})

    async def _place(self, broker: Broker, req: OrderRequest) -> str:
        try:
            return await asyncio.to_thread(broker.place_limit, req)
        except OrderOutcomeUnknown:
            found = await asyncio.to_thread(broker.find_by_tag, req.tag)
            if found is None:
                raise BrokerError("Order outcome unknown after a timeout and not found in the order book. "
                                  "Check Angel One before sending the alert again.") from None
            return found.broker_order_id

    def _create_order(self, alert_id, settings, req, size, position_id) -> int:
        now, i = now_ist(), req.instrument
        with session_scope(self.ctx.db) as s:
            o = Order(alert_id=alert_id, mode=settings.mode, ordertag=req.tag, symbol=i.symbol, exchange=i.exchange,
                      token=i.token, trading_symbol=i.trading_symbol, side=req.side, qty=req.qty,
                      limit_price=req.limit_price, status="OPEN", sizing_mode=settings.sizing_mode,
                      margin_per_share=size.margin_per_share if size else 0.0,
                      deployed_estimate=size.deployed if size else 0.0,
                      position_id=position_id, created_at=now, updated_at=now)
            s.add(o)
            s.flush()
            return o.id

    def _order_failed(self, order_id, alert_id, position_id, message: str) -> None:
        with session_scope(self.ctx.db) as s:
            o = s.get(Order, order_id)
            o.status, o.reason, o.updated_at = "REJECTED", message, now_ist()
            if position_id:
                s.get(Position, position_id).status = "OPEN"
            alert = s.get(Alert, alert_id)
            alert.order_id = order_id
            self._set(s, alert, "FAILED", "Broker rejected", message)
        self.ctx.bus.publish("order", {"id": order_id})

    def _reopen(self, position_id: int) -> None:
        with session_scope(self.ctx.db) as s:
            s.get(Position, position_id).status = "OPEN"

    # ---- alert bookkeeping ------------------------------------------------------------
    def _set(self, s, alert: Alert, status: str, taken: str, detail: str) -> None:
        alert.status, alert.action_taken, alert.detail = status, taken, detail
        log_event(s, self.ctx.bus, LEVEL.get(status, "INFO"), "engine",
                  f"{alert.action} {alert.symbol}: {taken}. {detail}", {"alert_id": alert.id, "status": status})
        self.ctx.bus.publish("alert", {"id": alert.id, "status": status})

    def _finish(self, alert_id: int, status: str, taken: str, detail: str, check: Check | None = None) -> None:
        with session_scope(self.ctx.db) as s:
            alert = s.get(Alert, alert_id)
            if check:
                alert.checks = [*alert.checks, check.as_dict()]
            self._set(s, alert, status, taken, detail)
