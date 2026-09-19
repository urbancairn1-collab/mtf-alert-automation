"""Shared test world: temp DB, paper broker with settable prices, fixture scrip master."""
import json
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace

from sqlalchemy import select

from app.brokers.base import Quote
from app.brokers.hub import BrokerHub
from app.brokers.instruments import InstrumentMaster
from app.brokers.paper import PaperBroker
from app.clock import IST
from app.config import AppConfig
from app.context import AppContext
from app.crypto import SecretBox
from app.db import init_db, make_engine, session_scope
from app.events import EventBus
from app.models import Alert, Position

ROWS = json.loads((Path(__file__).parent / "fixtures" / "scripmaster_sample.json").read_text())
MARKET = datetime(2026, 9, 18, 11, 0, tzinfo=IST)    # Friday
SATURDAY = datetime(2026, 9, 19, 11, 0, tzinfo=IST)


def make_world(tmp_path: Path) -> SimpleNamespace:
    db = make_engine(tmp_path / "w.db")
    init_db(db)
    prices = {"3045": Quote("3045", 842.70)}
    paper = PaperBroker(price_source=lambda insts: dict(prices), margin_source=lambda i, p: None,
                        paper_margin_pct=lambda: 25.0)
    ctx = AppContext(config=AppConfig(data_dir=tmp_path), db=db, box=SecretBox(tmp_path / "k"), bus=EventBus())
    ctx.hub = BrokerHub(paper, None)
    ctx.instruments = InstrumentMaster(ROWS)
    return SimpleNamespace(ctx=ctx, paper=paper, prices=prices)


def add_alert(ctx, symbol="SBIN", action="BUY", at=MARKET, is_test=False, price=None) -> int:
    with session_scope(ctx.db) as s:
        a = Alert(received_at=at, symbol=symbol, exchange="NSE", action=action, alert_price=price,
                  is_test=is_test, status="PENDING", checks=[{"name": "Secret and format", "ok": True, "detail": "ok"}])
        s.add(a)
        s.flush()
        return a.id


def seed_position(ctx, symbol="SBIN", qty=47, avg=842.70, opened_at=MARKET) -> int:
    with session_scope(ctx.db) as s:
        p = Position(mode="PAPER", symbol=symbol, exchange="NSE", token="3045", trading_symbol="SBIN-EQ",
                     qty=qty, avg_price=avg, deployed_amount=9931.57, margin_per_share=211.31,
                     status="OPEN", entry_order_id=0, opened_at=opened_at)
        s.add(p)
        s.flush()
        return p.id


def fetch(ctx, model, **where):
    with session_scope(ctx.db) as s:
        return list(s.scalars(select(model).filter_by(**where)))
