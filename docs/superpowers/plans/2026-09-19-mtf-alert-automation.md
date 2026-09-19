# MTF Alert Automation (Angel One) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Python backend that turns TradingView BUY/SELL alerts into Angel One MTF LIMIT orders, with every quotation control, and wire the already-built `web/` frontend to it.

**Architecture:** One Python process runs two FastAPI apps (webhook on 127.0.0.1:8001, dashboard + `/api` + static `web/` on 127.0.0.1:8000) plus asyncio tasks: a single sequential engine worker, an order tracker, an LTP poller and a reconciler. SQLite (WAL) is the ledger. Brokers sit behind one `Broker` protocol with `PaperBroker` and `AngelBroker`; blocking SDK calls run in `asyncio.to_thread`.

**Tech Stack:** Python 3.12, FastAPI, uvicorn, SQLAlchemy 2.0, pydantic v2 + pydantic-settings, httpx (Angel SmartAPI REST called directly), pyotp, cryptography (Fernet), openpyxl, tzdata, pytest, pytest-asyncio, respx, Playwright (Python).

**Why no smartapi-python SDK:** the SDK hides the HTTP status and raw body. Our rate-limit handling must tell a plain-text HTTP 403 apart from an HTTP 200 JSON `AB1021`, and must know when `placeOrder` timed out (outcome unknown). So `AngelBroker` calls the documented REST endpoints with httpx (Task 13).

**Spec:** `docs/superpowers/specs/2026-09-19-mtf-alert-automation-design.md` (read sections 4-11 before any task).

## Global Constraints

- Scope = quotation `UC/QTN/26-27/09/050`, nothing more (spec section 2). No charts, no strategy logic, no SL/target.
- Orders are **LIMIT only**, product `MARGIN` (MTF). Never MARKET, never IOC (Angel notice 1-Apr-2026).
- `placeOrder` is never blindly retried; on timeout search the order book by `ordertag` first.
- All times IST via `zoneinfo.ZoneInfo("Asia/Kolkata")`; `tzdata` must be a dependency (Windows has no IANA db).
- Market hours Mon-Fri 09:15 <= t < 15:30 IST. Test alerts skip only this guard.
- Dashboard binds `127.0.0.1` only. The tunnel forwards only the webhook port.
- API envelope: `{"ok": true, "data": ..., "error": null}` / `{"ok": false, "data": null, "error": {"code", "message", "fields"?}}`.
- Secrets (broker creds, webhook secret) are Fernet-encrypted at rest, write-only via API, masked on read.
- Rate-limit signals: HTTP 403 plain text containing "exceeding access rate" **and** HTTP 200 JSON `errorcode == "AB1021"`; both trigger cooldown 45 -> 90 -> 180 s. Session errors `AG8001/AG8002/AG8003` trigger relogin backoff 60 s -> 5 m -> 15 m -> 30 m.
- Settings ranges must equal `web/assets/js/mock/rules.js` (single source of truth listed in Task 2).
- Spreadsheet cells starting with `= + - @` (not plain numbers) are prefixed with `'`.
- Files < 400 lines, functions < 50 lines, no bare `except:`, no `print` in app code (use `logging`).
- Never commit to the parent `D:\rahul` repo; this folder is its own repo.

## File Map

```
app/config.py               AppConfig (paths, ports, URLs)                          Task 1
app/clock.py                IST, now_ist, is_market_open, market_label              Task 1
app/db.py                   make_engine (WAL), init_db, session_scope               Task 2
app/models.py               AwareDateTime + ledger tables                           Task 2
app/settings_model.py       TradingSettings (ranges = rules.js), EDITABLE_FIELDS    Task 2
app/repo_settings.py        load/update settings, set_mode, set_automation          Task 2
app/crypto.py               SecretBox (Fernet key file), mask                       Task 3
app/repo_broker.py          credentials (encrypted, write-only), webhook secret     Task 3
app/events.py               EventBus (SSE fan-out), log_event                       Task 4
app/context.py              AppContext (shared objects + live state)                Task 4
app/webhook/schema.py       AlertIn, parse_alert, SYMBOL_RE                         Task 5
app/webhook/intake.py       receive_alert (validate, persist, enqueue)              Task 5
app/webhook/app.py          create_webhook_app (only POST /webhook)                 Task 5
app/brokers/base.py         DTOs, Broker protocol, broker errors                    Task 6
app/brokers/instruments.py  InstrumentMaster (TV ticker -> Angel token)             Task 6
app/brokers/paper.py        PaperBroker                                             Task 7
app/brokers/hub.py          BrokerHub (mode -> broker, live data source)            Task 7
app/fmt.py                  inr, signed_inr                                         Tasks 8, 11
app/engine/sizing.py        round_to_tick, limit_price, size_order                  Task 8
app/engine/guards.py        GuardContext, evaluate                                  Task 9
app/engine/ledger.py        shared ledger queries                                   Task 10
app/engine/worker.py        Engine (sequential alert consumer)                      Task 10
app/engine/tracker.py       OrderTracker, cancel_all_working                        Task 11
app/brokers/angel_http.py   RateGate, Backoff, classify                             Task 12
app/brokers/angel.py        AngelBroker (SmartAPI REST)                             Task 13
app/services/ltp.py         LtpPoller                                               Task 14
app/services/reconcile.py   Reconciler (broker view, funds, mismatch)               Task 14
app/services/export.py      build_xlsx (formula guard)                              Task 14
app/api/app.py              create_dashboard_app, envelope, CSP, live config.js    Tasks 15, 16
app/api/serialize.py        row -> JSON shapes of spec section 8                    Task 15
app/api/queries.py          filtered list queries (API + export)                    Task 15
app/api/sse.py              sse_stream                                              Task 15
app/api/routes_ledger.py    status, dashboard, positions, alerts, orders, trades, logs, export, events  Task 15
app/api/routes_control.py   settings, automation, mode, broker, webhook, test alert Task 16
app/netinfo.py              public_ip, ngrok_public_url, NetWatcher                 Task 16
app/main.py                 process entry, recovery, daily login                    Task 17
scripts/*.bat, *.ps1        install, start, test alert                              Task 17
docs/HANDOVER.md            client setup + daily use                                Task 17
docs/LIVE-TEST.md           market-hours live checklist                             Task 18
tests/factory.py            shared test world                                       Task 10
tests/e2e/test_ui.py        real UI + paper backend                                 Task 18
```

---

### Task 1: Project scaffold, config and IST clock

**Files:**
- Create: `requirements.txt`, `requirements-dev.txt`, `pytest.ini`, `app/__init__.py`, `app/config.py`, `app/clock.py`
- Test: `tests/test_clock.py`

**Interfaces:**
- Produces: `AppConfig` (fields `data_dir: Path`, `dashboard_port: int`, `webhook_port: int`, `ngrok_api: str`, `scrip_master_url: str`, `version: str`; properties `db_path`, `key_path`, `log_dir`), `get_config() -> AppConfig`, `IST`, `now_ist() -> datetime`, `is_market_open(at: datetime | None = None) -> bool`, `market_label(at: datetime | None = None) -> str`.

- [ ] **Step 1: Create dependency files and pytest config**

`requirements.txt`:
```
fastapi==0.115.*
uvicorn[standard]==0.32.*
sqlalchemy==2.0.*
pydantic==2.*
pydantic-settings==2.*
pyotp==2.9.*
cryptography==43.*
httpx==0.27.*
openpyxl==3.1.*
tzdata
```
`requirements-dev.txt`:
```
-r requirements.txt
pytest==8.*
pytest-asyncio==0.24.*
pytest-cov==5.*
respx==0.21.*
playwright==1.*
```
`pytest.ini`:
```ini
[pytest]
testpaths = tests
asyncio_mode = auto
addopts = -q --strict-markers
markers =
    e2e: browser tests (need playwright install chromium)
```
Run: `python -m venv .venv && .venv\Scripts\pip install -r requirements-dev.txt`
Expected: installs without error.

- [ ] **Step 2: Write the failing clock tests**

`tests/test_clock.py`:
```python
from datetime import datetime

from app.clock import IST, is_market_open, market_label


def at(y, mo, d, h, mi):
    return datetime(y, mo, d, h, mi, tzinfo=IST)


def test_open_at_0915_on_weekday():
    assert is_market_open(at(2026, 9, 18, 9, 15)) is True  # Friday


def test_closed_at_1530_exactly():
    assert is_market_open(at(2026, 9, 18, 15, 30)) is False


def test_closed_before_open():
    assert is_market_open(at(2026, 9, 18, 9, 14)) is False


def test_closed_on_saturday():
    assert is_market_open(at(2026, 9, 19, 11, 0)) is False


def test_utc_input_is_converted_to_ist():
    from datetime import timezone
    utc = datetime(2026, 9, 18, 4, 0, tzinfo=timezone.utc)  # 09:30 IST
    assert is_market_open(utc) is True


def test_labels():
    assert market_label(at(2026, 9, 18, 10, 0)) == "Market open"
    assert market_label(at(2026, 9, 19, 10, 0)) == "Market closed (weekend)"
    assert market_label(at(2026, 9, 18, 16, 0)) == "Market closed"
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `.venv\Scripts\pytest tests/test_clock.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app'`

- [ ] **Step 4: Implement config and clock**

`app/__init__.py`: empty file.

`app/config.py`:
```python
"""Process configuration. Values can be overridden with MTF_* environment variables."""
from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class AppConfig(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="MTF_", env_file=".env", extra="ignore")

    data_dir: Path = Path("data")
    dashboard_port: int = 8000
    webhook_port: int = 8001
    ngrok_api: str = "http://127.0.0.1:4040/api/tunnels"
    scrip_master_url: str = (
        "https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json"
    )
    version: str = "1.0.0"

    @property
    def db_path(self) -> Path:
        return self.data_dir / "app.db"

    @property
    def key_path(self) -> Path:
        return self.data_dir / "secret.key"

    @property
    def log_dir(self) -> Path:
        return self.data_dir / "logs"


@lru_cache(maxsize=1)
def get_config() -> AppConfig:
    cfg = AppConfig()
    cfg.data_dir.mkdir(parents=True, exist_ok=True)
    cfg.log_dir.mkdir(parents=True, exist_ok=True)
    return cfg
```

`app/clock.py`:
```python
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
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `.venv\Scripts\pytest tests/test_clock.py -v`
Expected: 6 passed

- [ ] **Step 6: Commit**

```bash
git add requirements.txt requirements-dev.txt pytest.ini app/__init__.py app/config.py app/clock.py tests/test_clock.py
git commit -m "feat: project scaffold, config and IST market clock"
```

---

### Task 2: Database, models and validated settings

**Files:**
- Create: `app/db.py`, `app/models.py`, `app/settings_model.py`, `app/repo_settings.py`
- Test: `tests/conftest.py`, `tests/test_settings.py`

**Interfaces:**
- Consumes: `get_config()` (Task 1).
- Produces:
  - `make_engine(db_path: Path) -> Engine`, `init_db(engine) -> None`, `session_scope(engine) -> ContextManager[Session]`.
  - ORM classes `SettingsRow, BrokerAccount, Alert, Order, Position, Trade, EventRow` (columns below).
  - `TradingSettings` (pydantic), `EDITABLE_FIELDS: frozenset[str]`.
  - `load_settings(s) -> TradingSettings`, `update_settings(s, patch: dict) -> TradingSettings` (raises `SettingsError(fields: dict[str, str])`), `set_mode(s, mode: str) -> TradingSettings`, `set_automation(s, on: bool) -> TradingSettings`.

- [ ] **Step 1: Write the shared test fixtures**

`tests/conftest.py`:
```python
import pytest

from app.db import init_db, make_engine, session_scope


@pytest.fixture
def engine(tmp_path):
    eng = make_engine(tmp_path / "test.db")
    init_db(eng)
    return eng


@pytest.fixture
def session(engine):
    with session_scope(engine) as s:
        yield s
```

- [ ] **Step 2: Write the failing settings tests**

`tests/test_settings.py`:
```python
import pytest

from app.repo_settings import SettingsError, load_settings, set_automation, set_mode, update_settings


def test_defaults_match_frontend_rules(session):
    s = load_settings(session)
    assert s.amount_per_trade == 10000
    assert s.sizing_mode == "margin"
    assert s.capital_cap == 100000
    assert s.max_open_positions == 5
    assert s.limit_buffer_pct == 0.3
    assert s.mode == "PAPER"
    assert s.automation_on is True


def test_update_persists(session):
    update_settings(session, {"amount_per_trade": 25000, "capital_cap": 200000})
    assert load_settings(session).amount_per_trade == 25000


@pytest.mark.parametrize("field,value", [
    ("amount_per_trade", 499), ("max_open_positions", 0), ("limit_buffer_pct", 2.5),
    ("buy_fill_timeout_sec", 4), ("sizing_mode", "leverage"),
])
def test_out_of_range_is_a_field_error(session, field, value):
    with pytest.raises(SettingsError) as exc:
        update_settings(session, {field: value})
    assert field in exc.value.fields


def test_cap_below_amount_rejected(session):
    with pytest.raises(SettingsError) as exc:
        update_settings(session, {"amount_per_trade": 50000, "capital_cap": 40000})
    assert "capital_cap" in exc.value.fields


def test_mode_and_automation_not_editable_via_update(session):
    update_settings(session, {"mode": "LIVE", "automation_on": False})
    s = load_settings(session)
    assert s.mode == "PAPER" and s.automation_on is True


def test_dedicated_setters(session):
    set_mode(session, "LIVE")
    set_automation(session, False)
    s = load_settings(session)
    assert s.mode == "LIVE" and s.automation_on is False


def test_datetimes_round_trip_timezone_aware(session):
    from datetime import datetime, timezone
    from app.models import EventRow
    utc = datetime(2026, 9, 18, 4, 0, tzinfo=timezone.utc)
    session.add(EventRow(ts=utc, level="INFO", category="system", message="x"))
    session.flush()
    session.expire_all()
    row = session.query(EventRow).one()
    assert row.ts.tzinfo is not None and row.ts == utc and row.ts.utcoffset().total_seconds() == 19800
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `.venv\Scripts\pytest tests/test_settings.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.db'`

- [ ] **Step 4: Implement db and models**

`app/db.py`:
```python
"""SQLite (WAL) engine and session helpers."""
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from sqlalchemy import Engine, create_engine, event
from sqlalchemy.orm import Session, sessionmaker

from app.models import Base


def make_engine(db_path: Path) -> Engine:
    eng = create_engine(f"sqlite:///{db_path}", connect_args={"check_same_thread": False})

    @event.listens_for(eng, "connect")
    def _pragmas(dbapi_conn, _record):
        cur = dbapi_conn.cursor()
        cur.execute("PRAGMA journal_mode=WAL")
        cur.execute("PRAGMA synchronous=NORMAL")
        cur.execute("PRAGMA foreign_keys=ON")
        cur.close()

    return eng


def init_db(engine: Engine) -> None:
    Base.metadata.create_all(engine)


@contextmanager
def session_scope(engine: Engine) -> Iterator[Session]:
    factory = sessionmaker(engine, expire_on_commit=False)
    session = factory()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()
```

`app/models.py`:
```python
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
```

- [ ] **Step 5: Implement the settings model and repository**

`app/settings_model.py` (ranges copied from `web/assets/js/mock/rules.js`; keep both in sync):
```python
"""Trading settings with the exact ranges the frontend validates."""
from typing import Literal

from pydantic import BaseModel, Field, model_validator


class TradingSettings(BaseModel):
    amount_per_trade: int = Field(10000, ge=500, le=10_000_000)
    sizing_mode: Literal["margin", "value"] = "margin"
    capital_cap: int = Field(100000, ge=500, le=100_000_000)
    max_open_positions: int = Field(5, ge=1, le=50)
    one_position_per_stock: bool = True
    duplicate_protection: bool = True
    duplicate_window_sec: int = Field(60, ge=5, le=3600)
    limit_buffer_pct: float = Field(0.3, ge=0.05, le=2)
    buy_fill_timeout_sec: int = Field(30, ge=5, le=300)
    sell_reprice_attempts: int = Field(3, ge=0, le=10)
    sell_reprice_interval_sec: int = Field(15, ge=5, le=120)
    stale_alert_sec: int = Field(120, ge=10, le=3600)
    paper_margin_pct: float = Field(25, ge=10, le=100)
    mode: Literal["PAPER", "LIVE"] = "PAPER"
    automation_on: bool = True

    @model_validator(mode="after")
    def _cap_covers_one_trade(self) -> "TradingSettings":
        if self.capital_cap < self.amount_per_trade:
            raise ValueError("capital_cap: Capital cap cannot be lower than the amount per trade")
        return self


# mode and automation_on change only through /api/mode and /api/automation.
EDITABLE_FIELDS = frozenset(TradingSettings.model_fields) - {"mode", "automation_on"}
```

`app/repo_settings.py`:
```python
"""Read/write the single settings row."""
from pydantic import ValidationError
from sqlalchemy.orm import Session

from app.models import SettingsRow
from app.settings_model import EDITABLE_FIELDS, TradingSettings


class SettingsError(Exception):
    def __init__(self, fields: dict[str, str]):
        super().__init__("Please fix the highlighted fields.")
        self.fields = fields


def _row(s: Session) -> SettingsRow:
    row = s.get(SettingsRow, 1)
    if row is None:
        row = SettingsRow(id=1, data=TradingSettings().model_dump())
        s.add(row)
        s.flush()
    return row


def load_settings(s: Session) -> TradingSettings:
    return TradingSettings(**_row(s).data)


def _to_fields(err: ValidationError) -> dict[str, str]:
    fields: dict[str, str] = {}
    for e in err.errors():
        msg = str(e["msg"]).removeprefix("Value error, ")
        if e["loc"]:
            fields[str(e["loc"][0])] = msg
        elif ":" in msg:
            key, text = msg.split(":", 1)
            fields[key.strip()] = text.strip()
    return fields


def _save(s: Session, data: dict) -> TradingSettings:
    try:
        new = TradingSettings(**data)
    except ValidationError as err:
        raise SettingsError(_to_fields(err)) from err
    _row(s).data = new.model_dump()
    s.flush()
    return new


def update_settings(s: Session, patch: dict) -> TradingSettings:
    current = load_settings(s).model_dump()
    allowed = {k: v for k, v in patch.items() if k in EDITABLE_FIELDS}
    return _save(s, {**current, **allowed})


def set_mode(s: Session, mode: str) -> TradingSettings:
    return _save(s, {**load_settings(s).model_dump(), "mode": mode})


def set_automation(s: Session, on: bool) -> TradingSettings:
    return _save(s, {**load_settings(s).model_dump(), "automation_on": bool(on)})
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `.venv\Scripts\pytest tests/test_settings.py -v`
Expected: 11 passed

- [ ] **Step 7: Commit**

```bash
git add app/db.py app/models.py app/settings_model.py app/repo_settings.py tests/conftest.py tests/test_settings.py
git commit -m "feat: SQLite ledger schema and validated trading settings"
```

---

### Task 3: Secret encryption and broker credential store

**Files:**
- Create: `app/crypto.py`, `app/repo_broker.py`
- Test: `tests/test_crypto_broker_repo.py`

**Interfaces:**
- Consumes: `session` fixture, `BrokerAccount`, `SettingsRow` (Task 2).
- Produces:
  - `SecretBox(key_path: Path)` with `encrypt(str) -> str`, `decrypt(str) -> str`.
  - `mask(value: str, keep: int = 4) -> str`.
  - `Credentials` dataclass (`client_code, api_key, mpin, totp_secret`).
  - `validate_credentials(dict) -> dict[str, str] | None` (same regexes as `rules.js`).
  - `save_credentials(s, box, creds: Credentials) -> None`, `load_credentials(s, box) -> Credentials | None`, `broker_view(s) -> dict`.
  - `get_webhook_secret(s, box) -> str` (creates one on first call), `rotate_webhook_secret(s, box) -> str`.

- [ ] **Step 1: Write the failing tests**

`tests/test_crypto_broker_repo.py`:
```python
import pytest

from app.crypto import SecretBox, mask
from app.models import BrokerAccount
from app.repo_broker import (Credentials, broker_view, get_webhook_secret, load_credentials,
                             rotate_webhook_secret, save_credentials, validate_credentials)

GOOD = {"client_code": "A123456", "api_key": "abcDEF123", "mpin": "1234",
        "totp_secret": "JBSWY3DPEHPK3PXP"}


@pytest.fixture
def box(tmp_path):
    return SecretBox(tmp_path / "secret.key")


def test_round_trip_and_key_reuse(tmp_path):
    token = SecretBox(tmp_path / "k").encrypt("hello")
    assert SecretBox(tmp_path / "k").decrypt(token) == "hello"


def test_mask():
    assert mask("mtf_4f9a2c7e81d3b6") == "**************d3b6"


def test_validation_messages():
    assert validate_credentials(GOOD) is None
    bad = validate_credentials({**GOOD, "mpin": "12a4", "totp_secret": "short"})
    assert set(bad) == {"mpin", "totp_secret"}


def test_credentials_are_encrypted_at_rest(session, box):
    save_credentials(session, box, Credentials(**GOOD))
    row = session.get(BrokerAccount, 1)
    assert "1234" not in (row.mpin_enc or "")
    assert load_credentials(session, box) == Credentials(**GOOD)


def test_broker_view_never_leaks_secrets(session, box):
    save_credentials(session, box, Credentials(**GOOD))
    view = broker_view(session)
    assert view["configured"] is True
    assert view["client_code_masked"] == "A1****56"
    assert "1234" not in str(view) and "JBSWY" not in str(view)


def test_webhook_secret_created_once_then_rotated(session, box):
    first = get_webhook_secret(session, box)
    assert first == get_webhook_secret(session, box)
    assert rotate_webhook_secret(session, box) != first
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `.venv\Scripts\pytest tests/test_crypto_broker_repo.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.crypto'`

- [ ] **Step 3: Implement crypto**

`app/crypto.py`:
```python
"""Fernet encryption for secrets at rest. The key file is created once and git-ignored."""
from pathlib import Path

from cryptography.fernet import Fernet


class SecretBox:
    def __init__(self, key_path: Path):
        key_path.parent.mkdir(parents=True, exist_ok=True)
        if not key_path.exists():
            key_path.write_bytes(Fernet.generate_key())
        self._fernet = Fernet(key_path.read_bytes())

    def encrypt(self, value: str) -> str:
        return self._fernet.encrypt(value.encode()).decode()

    def decrypt(self, token: str) -> str:
        return self._fernet.decrypt(token.encode()).decode()


def mask(value: str, keep: int = 4) -> str:
    return "*" * max(0, len(value) - keep) + value[-keep:]
```

- [ ] **Step 4: Implement the broker/webhook secret repository**

`app/repo_broker.py`:
```python
"""Broker credentials and webhook secret: encrypted, write-only, masked on read."""
import re
import secrets
from dataclasses import dataclass

from sqlalchemy.orm import Session

from app.crypto import SecretBox, mask
from app.models import BrokerAccount, SettingsRow

_RULES = {
    "client_code": (r"^[A-Za-z0-9]{4,12}$", "Client ID is 4-12 letters or digits (e.g. your Angel login ID)"),
    "api_key": (r"^[A-Za-z0-9]{6,64}$", "Paste the API key from your SmartAPI app"),
    "mpin": (r"^\d{4}$", "MPIN is 4 digits"),
    "totp_secret": (r"^[A-Z2-7]{16,64}$", "TOTP secret is the 16+ character code shown when you enabled TOTP"),
}


@dataclass(frozen=True)
class Credentials:
    client_code: str
    api_key: str
    mpin: str
    totp_secret: str


def _normalise(data: dict) -> dict:
    out = {k: str(data.get(k, "")).strip() for k in _RULES}
    out["totp_secret"] = re.sub(r"\s", "", out["totp_secret"]).upper()
    return out


def validate_credentials(data: dict) -> dict[str, str] | None:
    clean = _normalise(data)
    errors = {k: msg for k, (pat, msg) in _RULES.items() if not re.match(pat, clean[k])}
    return errors or None


def _account(s: Session) -> BrokerAccount:
    acc = s.get(BrokerAccount, 1)
    if acc is None:
        acc = BrokerAccount(id=1)
        s.add(acc)
        s.flush()
    return acc


def save_credentials(s: Session, box: SecretBox, creds: Credentials) -> None:
    c = Credentials(**_normalise(creds.__dict__))
    acc = _account(s)
    acc.client_code = c.client_code
    acc.api_key_enc = box.encrypt(c.api_key)
    acc.mpin_enc = box.encrypt(c.mpin)
    acc.totp_secret_enc = box.encrypt(c.totp_secret)
    acc.last_error = None
    s.flush()


def load_credentials(s: Session, box: SecretBox) -> Credentials | None:
    acc = _account(s)
    if not (acc.client_code and acc.api_key_enc and acc.mpin_enc and acc.totp_secret_enc):
        return None
    return Credentials(acc.client_code, box.decrypt(acc.api_key_enc),
                       box.decrypt(acc.mpin_enc), box.decrypt(acc.totp_secret_enc))


def broker_view(s: Session) -> dict:
    acc = _account(s)
    code = acc.client_code or ""
    return {
        "configured": bool(acc.api_key_enc),
        "client_code_masked": f"{code[:2]}****{code[-2:]}" if code else None,
        "api_key_masked": "********" if acc.api_key_enc else None,
        "last_login_at": acc.last_login_at,
        "session_valid_till": acc.session_valid_till,
        "last_error": acc.last_error,
    }


def _settings_row(s: Session) -> SettingsRow:
    row = s.get(SettingsRow, 1)
    if row is None:
        row = SettingsRow(id=1, data={})
        s.add(row)
        s.flush()
    return row


def get_webhook_secret(s: Session, box: SecretBox) -> str:
    row = _settings_row(s)
    if not row.webhook_secret_enc:
        return rotate_webhook_secret(s, box)
    return box.decrypt(row.webhook_secret_enc)


def rotate_webhook_secret(s: Session, box: SecretBox) -> str:
    secret = f"mtf_{secrets.token_hex(8)}"
    _settings_row(s).webhook_secret_enc = box.encrypt(secret)
    s.flush()
    return secret
```
Note: `_settings_row` creating `data={}` is safe because `load_settings` (Task 2) fills defaults via `TradingSettings(**{})`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `.venv\Scripts\pytest tests/test_crypto_broker_repo.py -v`
Expected: 6 passed

- [ ] **Step 6: Commit**

```bash
git add app/crypto.py app/repo_broker.py tests/test_crypto_broker_repo.py
git commit -m "feat: encrypted broker credentials and webhook secret"
```

---

### Task 4: Event bus, event log and shared app context

**Files:**
- Create: `app/events.py`, `app/context.py`
- Test: `tests/test_events.py`

**Interfaces:**
- Consumes: `EventRow` (Task 2), `AppConfig` (Task 1), `SecretBox` (Task 3).
- Produces:
  - `EventBus` with `subscribe() -> asyncio.Queue`, `unsubscribe(q)`, `publish(type_: str, payload: dict) -> None`.
  - `log_event(s, bus, level: str, category: str, message: str, data: dict | None = None) -> None` (persists + publishes `"log"`).
  - `AppContext` dataclass: `config, db (Engine), box (SecretBox), bus (EventBus), alert_queue (asyncio.Queue[int]), hub (BrokerHub | None), instruments (InstrumentMaster | None), prices (dict[str, float]), broker_positions (list[dict]), mismatch (set[str]), public_ip (str), tunnel_url (str | None)`.
- SSE event types used everywhere: `status, alert, order, position, trade, tick, log`.

- [ ] **Step 1: Write the failing tests**

`tests/test_events.py`:
```python
import asyncio

from sqlalchemy import select

from app.events import EventBus, log_event
from app.models import EventRow


async def test_publish_reaches_subscriber():
    bus = EventBus()
    q = bus.subscribe()
    bus.publish("tick", {"SBIN": 842.7})
    assert await asyncio.wait_for(q.get(), 1) == ("tick", {"SBIN": 842.7})


async def test_slow_subscriber_is_dropped_not_blocking():
    bus = EventBus(queue_size=2)
    slow = bus.subscribe()
    for i in range(5):
        bus.publish("tick", {"i": i})
    assert slow not in bus._subscribers  # noqa: SLF001 - asserting the drop policy


async def test_log_event_persists_and_publishes(session):
    bus = EventBus()
    q = bus.subscribe()
    log_event(session, bus, "WARN", "broker", "Angel rate limit (AB1021)", {"cooldown": 45})
    row = session.scalars(select(EventRow)).one()
    assert (row.level, row.category) == ("WARN", "broker")
    kind, payload = await asyncio.wait_for(q.get(), 1)
    assert kind == "log" and payload["message"].startswith("Angel rate limit")
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `.venv\Scripts\pytest tests/test_events.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.events'`

- [ ] **Step 3: Implement**

`app/events.py`:
```python
"""In-process pub/sub feeding the SSE endpoint, plus the persistent event log."""
import asyncio
import logging

from sqlalchemy.orm import Session

from app.clock import now_ist
from app.models import EventRow

log = logging.getLogger("mtf.events")


class EventBus:
    def __init__(self, queue_size: int = 200):
        self._queue_size = queue_size
        self._subscribers: set[asyncio.Queue] = set()

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=self._queue_size)
        self._subscribers.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        self._subscribers.discard(q)

    def publish(self, type_: str, payload: dict) -> None:
        for q in list(self._subscribers):
            try:
                q.put_nowait((type_, payload))
            except asyncio.QueueFull:
                # A stalled browser tab must never block trading; it reconnects and reloads.
                self._subscribers.discard(q)
                log.warning("dropped a slow SSE subscriber")


def log_event(s: Session, bus: EventBus, level: str, category: str, message: str,
              data: dict | None = None) -> None:
    row = EventRow(ts=now_ist(), level=level, category=category, message=message, data=data)
    s.add(row)
    s.flush()
    getattr(log, {"INFO": "info", "WARN": "warning", "ERROR": "error"}[level])("%s: %s", category, message)
    bus.publish("log", {"id": row.id, "ts": row.ts.isoformat(), "level": level,
                        "category": category, "message": message, "data": data})
```

`app/context.py`:
```python
"""Objects shared by the webhook app, dashboard app and background tasks."""
import asyncio
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from sqlalchemy import Engine

from app.config import AppConfig
from app.crypto import SecretBox
from app.events import EventBus

if TYPE_CHECKING:
    from app.brokers.hub import BrokerHub
    from app.brokers.instruments import InstrumentMaster


@dataclass
class AppContext:
    config: AppConfig
    db: Engine
    box: SecretBox
    bus: EventBus
    alert_queue: asyncio.Queue = field(default_factory=asyncio.Queue)
    hub: "BrokerHub | None" = None
    instruments: "InstrumentMaster | None" = None
    # Live state written by background services (Tasks 14, 16), read by the API:
    prices: dict[str, float] = field(default_factory=dict)        # symbol -> last LTP
    broker_positions: list[dict] = field(default_factory=list)    # Angel account view
    mismatch: set[str] = field(default_factory=set)               # LIVE symbols Angel holds less of than tracked
    funds: object | None = None                                   # last Angel RMS Funds (refreshed every 60 s)
    public_ip: str = "unknown"
    tunnel_url: str | None = None
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv\Scripts\pytest tests/test_events.py -v`
Expected: 3 passed

- [ ] **Step 5: Commit**

```bash
git add app/events.py app/context.py tests/test_events.py
git commit -m "feat: SSE event bus, persistent event log, app context"
```

---

### Task 5: Webhook receiver (validate, persist, enqueue, fast 200)

**Files:**
- Create: `app/webhook/__init__.py`, `app/webhook/schema.py`, `app/webhook/intake.py`, `app/webhook/app.py`
- Test: `tests/test_webhook.py`

**Interfaces:**
- Consumes: `AppContext`, `log_event` (Task 4), `get_webhook_secret` (Task 3), `load_settings` (Task 2), `Alert` (Task 2), `now_ist` (Task 1).
- Produces:
  - `AlertIn` pydantic model (`secret, symbol, exchange, action, price, time`), `parse_alert(body: bytes) -> AlertIn` raising `AlertParseError(reason: str)`.
  - `receive_alert(ctx, body: bytes, source_ip: str, now: datetime | None = None) -> tuple[int, dict]` (HTTP status, JSON body). Accepted alerts are stored `PENDING` and their id is put on `ctx.alert_queue`.
  - `create_webhook_app(ctx) -> FastAPI` exposing only `POST /webhook`.

- [ ] **Step 1: Write the failing tests**

`tests/test_webhook.py`:
```python
import json
from datetime import timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.clock import now_ist
from app.config import AppConfig
from app.context import AppContext
from app.crypto import SecretBox
from app.db import init_db, make_engine, session_scope
from app.events import EventBus
from app.models import Alert
from app.repo_broker import get_webhook_secret
from app.webhook.app import create_webhook_app


@pytest.fixture
def ctx(tmp_path):
    db = make_engine(tmp_path / "w.db")
    init_db(db)
    return AppContext(config=AppConfig(data_dir=tmp_path), db=db,
                      box=SecretBox(tmp_path / "k"), bus=EventBus())


def secret(ctx):
    with session_scope(ctx.db) as s:
        return get_webhook_secret(s, ctx.box)


def post(ctx, payload):
    client = TestClient(create_webhook_app(ctx))
    body = payload if isinstance(payload, str) else json.dumps(payload)
    return client.post("/webhook", content=body, headers={"x-forwarded-for": "52.89.214.238"})


def alerts(ctx):
    with session_scope(ctx.db) as s:
        return list(s.scalars(select(Alert)))


def test_valid_alert_is_stored_pending_and_queued(ctx):
    r = post(ctx, {"secret": secret(ctx), "symbol": "sbin", "exchange": "NSE", "action": "buy", "price": 842.7})
    assert r.status_code == 200
    [a] = alerts(ctx)
    assert (a.symbol, a.action, a.status, a.source_ip) == ("SBIN", "BUY", "PENDING", "52.89.214.238")
    assert ctx.alert_queue.get_nowait() == a.id


def test_wrong_secret_is_401_and_logged_rejected(ctx):
    r = post(ctx, {"secret": "nope", "symbol": "SBIN", "action": "BUY"})
    assert r.status_code == 401
    [a] = alerts(ctx)
    assert a.status == "REJECTED" and "secret" in a.detail.lower()
    assert ctx.alert_queue.empty()


def test_secret_never_stored_in_raw_payload(ctx):
    post(ctx, {"secret": secret(ctx), "symbol": "SBIN", "action": "BUY"})
    assert alerts(ctx)[0].raw_payload["secret"] == "********"


def test_bad_json_is_stored_rejected_with_200(ctx):
    r = post(ctx, "BUY SBIN now")
    assert r.status_code == 200
    assert alerts(ctx)[0].status == "REJECTED"


def test_stale_alert_rejected(ctx):
    old = (now_ist() - timedelta(minutes=10)).isoformat()
    post(ctx, {"secret": secret(ctx), "symbol": "SBIN", "action": "BUY", "time": old})
    a = alerts(ctx)[0]
    assert a.status == "REJECTED" and "old" in a.detail.lower()


def test_naive_time_is_treated_as_utc_not_a_crash(ctx):
    r = post(ctx, {"secret": secret(ctx), "symbol": "SBIN", "action": "BUY", "time": "2020-01-01T09:00:00"})
    assert r.status_code == 200
    assert alerts(ctx)[0].status == "REJECTED"  # far in the past -> stale, but handled


def test_exchange_prefixed_symbol_is_split(ctx):
    post(ctx, {"secret": secret(ctx), "symbol": "NSE:BAJAJ_AUTO", "action": "SELL"})
    a = alerts(ctx)[0]
    assert (a.exchange, a.symbol) == ("NSE", "BAJAJ_AUTO")


def test_oversized_body_rejected(ctx):
    r = post(ctx, json.dumps({"secret": "x", "symbol": "SBIN", "action": "BUY", "pad": "x" * 5000}))
    assert r.status_code == 413


def test_only_post_webhook_exists(ctx):
    client = TestClient(create_webhook_app(ctx))
    assert client.get("/api/status").status_code == 404
    assert client.get("/docs").status_code == 404
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `.venv\Scripts\pytest tests/test_webhook.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.webhook'`

- [ ] **Step 3: Implement the schema**

`app/webhook/__init__.py`: empty file.

`app/webhook/schema.py`:
```python
"""TradingView alert contract (spec section 4)."""
import json
import re
from datetime import datetime, timezone
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

SYMBOL_RE = re.compile(r"^[A-Z0-9&_\-]{1,30}$")


class AlertParseError(Exception):
    def __init__(self, reason: str, payload: dict | None = None):
        super().__init__(reason)
        self.reason = reason
        self.payload = payload or {}


class AlertIn(BaseModel):
    model_config = ConfigDict(extra="ignore")

    secret: str = Field(min_length=1, max_length=128)
    symbol: str
    exchange: Literal["NSE", "BSE"] = "NSE"
    action: Literal["BUY", "SELL"]
    price: float | None = Field(default=None, gt=0)
    time: datetime | None = None

    @field_validator("action", "exchange", mode="before")
    @classmethod
    def _upper(cls, v):
        return str(v).strip().upper()

    @field_validator("time")
    @classmethod
    def _aware(cls, v):
        # {{timenow}} is UTC with "Z"; a naive time is treated as UTC so comparisons never crash.
        return v if v is None or v.tzinfo else v.replace(tzinfo=timezone.utc)

    @field_validator("symbol", mode="before")
    @classmethod
    def _symbol(cls, v):
        s = str(v).strip().upper()
        if ":" in s:  # "NSE:SBIN" pasted as {{exchange}}:{{ticker}}
            s = s.split(":", 1)[1]
        if not SYMBOL_RE.match(s):
            raise ValueError("symbol must be 1-30 of A-Z 0-9 & _ -")
        return s

    @classmethod
    def from_raw(cls, data: dict) -> "AlertIn":
        if isinstance(data.get("symbol"), str) and ":" in data["symbol"] and "exchange" not in data:
            data = {**data, "exchange": data["symbol"].split(":", 1)[0]}
        return cls(**data)


def parse_alert(body: bytes) -> AlertIn:
    try:
        data = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as err:
        raise AlertParseError("Alert is not valid JSON. Use the message from Settings.") from err
    if not isinstance(data, dict):
        raise AlertParseError("Alert JSON must be an object.")
    try:
        return AlertIn.from_raw(data)
    except ValidationError as err:
        first = err.errors()[0]
        where = ".".join(str(p) for p in first["loc"]) or "alert"
        raise AlertParseError(f"Invalid {where}: {first['msg']}", data) from err
```

- [ ] **Step 4: Implement intake and the app**

`app/webhook/intake.py`:
```python
"""Turn one HTTP body into a stored Alert. Must return in milliseconds (TradingView waits 3 s)."""
import hmac
from datetime import datetime

from app.clock import now_ist
from app.context import AppContext
from app.db import session_scope
from app.events import log_event
from app.models import Alert
from app.repo_broker import get_webhook_secret
from app.repo_settings import load_settings
from app.webhook.schema import AlertIn, AlertParseError, parse_alert


def _safe_payload(data: dict) -> dict:
    return {**data, "secret": "********"} if "secret" in data else dict(data)


def _store(s, **fields) -> Alert:
    alert = Alert(**fields)
    s.add(alert)
    s.flush()
    return alert


def _reject(ctx: AppContext, s, now, ip, payload: dict, reason: str, alert_in: AlertIn | None = None) -> Alert:
    alert = _store(s, received_at=now, source_ip=ip, raw_payload=_safe_payload(payload),
                   symbol=alert_in.symbol if alert_in else str(payload.get("symbol", ""))[:32],
                   exchange=alert_in.exchange if alert_in else "NSE",
                   action=alert_in.action if alert_in else str(payload.get("action", ""))[:4],
                   status="REJECTED", action_taken="No order", detail=reason,
                   checks=[{"name": "Secret and format", "ok": False, "detail": reason}])
    log_event(s, ctx.bus, "WARN", "webhook", f"Alert rejected: {reason}", {"alert_id": alert.id, "ip": ip})
    return alert


def receive_alert(ctx: AppContext, body: bytes, source_ip: str, now: datetime | None = None) -> tuple[int, dict]:
    now = now or now_ist()
    with session_scope(ctx.db) as s:
        try:
            alert_in = parse_alert(body)
        except AlertParseError as err:
            payload = err.payload or {"raw": body[:500].decode("utf-8", "replace")}
            _reject(ctx, s, now, source_ip, payload, err.reason)
            return 200, {"ok": False, "reason": err.reason}
        payload = alert_in.model_dump(mode="json")
        if not hmac.compare_digest(alert_in.secret, get_webhook_secret(s, ctx.box)):
            _reject(ctx, s, now, source_ip, payload, "Wrong webhook secret.", alert_in)
            return 401, {"ok": False, "reason": "unauthorised"}
        stale_after = load_settings(s).stale_alert_sec
        if alert_in.time and (now - alert_in.time).total_seconds() > stale_after:
            _reject(ctx, s, now, source_ip, payload, f"Alert is too old (more than {stale_after} s).", alert_in)
            return 200, {"ok": False, "reason": "stale"}
        alert = _store(s, received_at=now, source_ip=source_ip, raw_payload=_safe_payload(payload),
                       symbol=alert_in.symbol, exchange=alert_in.exchange, action=alert_in.action,
                       alert_price=alert_in.price, status="PENDING", action_taken="Processing",
                       checks=[{"name": "Secret and format", "ok": True, "detail": "Valid JSON, secret matched"}])
        log_event(s, ctx.bus, "INFO", "webhook", f"Alert received: {alert.action} {alert.symbol} ({alert.exchange})",
                  {"alert_id": alert.id})
        alert_id = alert.id
    ctx.alert_queue.put_nowait(alert_id)
    ctx.bus.publish("alert", {"id": alert_id})
    return 200, {"ok": True, "alert_id": alert_id}
```

`app/webhook/app.py`:
```python
"""Port 8001: the only thing the tunnel exposes. One route, no docs, small bodies, rate-limited."""
import time
from collections import deque

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from app.context import AppContext
from app.webhook.intake import receive_alert

MAX_BODY = 4096
RATE_LIMIT = 60  # alerts per minute


class SlidingWindow:
    def __init__(self, limit: int, seconds: float):
        self.limit, self.seconds, self.hits = limit, seconds, deque()

    def allow(self) -> bool:
        now = time.monotonic()
        while self.hits and now - self.hits[0] > self.seconds:
            self.hits.popleft()
        if len(self.hits) >= self.limit:
            return False
        self.hits.append(now)
        return True


def client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for", "")
    return forwarded.split(",")[0].strip() or (request.client.host if request.client else "")


def create_webhook_app(ctx: AppContext) -> FastAPI:
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    window = SlidingWindow(RATE_LIMIT, 60.0)

    @app.post("/webhook")
    async def webhook(request: Request) -> JSONResponse:
        body = await request.body()
        if len(body) > MAX_BODY:
            return JSONResponse({"ok": False, "reason": "too large"}, status_code=413)
        if not window.allow():
            return JSONResponse({"ok": False, "reason": "rate limited"}, status_code=429)
        status, payload = receive_alert(ctx, body, client_ip(request))
        return JSONResponse(payload, status_code=status)

    return app
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `.venv\Scripts\pytest tests/test_webhook.py -v`
Expected: 9 passed

- [ ] **Step 6: Commit**

```bash
git add app/webhook tests/test_webhook.py
git commit -m "feat: webhook receiver with secret, schema, staleness and size checks"
```

---

### Task 6: Broker DTOs and instrument master (TradingView ticker -> Angel token)

**Files:**
- Create: `app/brokers/__init__.py`, `app/brokers/base.py`, `app/brokers/instruments.py`
- Test: `tests/test_instruments.py`, `tests/fixtures/scripmaster_sample.json`

**Interfaces:**
- Produces (`app/brokers/base.py`):
  - `Instrument(symbol, exchange, token, trading_symbol, tick_size: float)` frozen dataclass.
  - `Quote(token, ltp: float, upper_circuit: float | None, lower_circuit: float | None)`.
  - `OrderRequest(instrument, side: "BUY"|"SELL", qty: int, limit_price: float, tag: str)`.
  - `OrderState(broker_order_id, status: "OPEN"|"COMPLETE"|"PARTIAL"|"CANCELLED"|"REJECTED", filled_qty: int, avg_price: float | None, message: str)`.
  - `Funds(available: float, used: float, net: float)`, `MarginInfo(per_share: float, source: "broker"|"paper estimate")`.
  - `BrokerError(message, code="")`, `RateLimited(BrokerError)`, `SessionExpired(BrokerError)`, `OrderOutcomeUnknown(BrokerError)`.
  - `Broker` Protocol: `name`, `connected() -> bool`, `quotes(insts) -> dict[str, Quote]`, `margin_per_share(inst, price) -> MarginInfo`, `funds() -> Funds | None`, `place_limit(req) -> str`, `modify_limit(broker_order_id, req) -> None`, `cancel(broker_order_id) -> None`, `order_state(broker_order_id) -> OrderState`, `find_by_tag(tag) -> OrderState | None`, `account_positions() -> list[dict]`, `account_orders() -> list[dict]`.
- Produces (`app/brokers/instruments.py`): `InstrumentMaster(rows)`, `InstrumentMaster.load(cache_path, url, now, fetch=...)`, `.resolve(ticker, exchange) -> Instrument` raising `UnknownSymbol(reason)`.

- [ ] **Step 1: Create the fixture**

`tests/fixtures/scripmaster_sample.json` (shape of Angel's `OpenAPIScripMaster.json`; tick_size is in paise):
```json
[
  {"token": "3045", "symbol": "SBIN-EQ", "name": "SBIN", "expiry": "", "strike": "-1.000000", "lotsize": "1", "instrumenttype": "", "exch_seg": "NSE", "tick_size": "5.000000"},
  {"token": "16669", "symbol": "BAJAJ-AUTO-EQ", "name": "BAJAJ-AUTO", "expiry": "", "strike": "-1.000000", "lotsize": "1", "instrumenttype": "", "exch_seg": "NSE", "tick_size": "10.000000"},
  {"token": "2031", "symbol": "M&M-EQ", "name": "M&M", "expiry": "", "strike": "-1.000000", "lotsize": "1", "instrumenttype": "", "exch_seg": "NSE", "tick_size": "5.000000"},
  {"token": "500112", "symbol": "SBIN", "name": "SBIN", "expiry": "", "strike": "-1.000000", "lotsize": "1", "instrumenttype": "", "exch_seg": "BSE", "tick_size": "5.000000"},
  {"token": "99926000", "symbol": "Nifty 50", "name": "NIFTY", "expiry": "", "strike": "-1.000000", "lotsize": "1", "instrumenttype": "AMXIDX", "exch_seg": "NSE", "tick_size": "5.000000"},
  {"token": "35001", "symbol": "SBIN26SEPFUT", "name": "SBIN", "expiry": "30SEP2026", "strike": "-1.000000", "lotsize": "750", "instrumenttype": "FUTSTK", "exch_seg": "NFO", "tick_size": "5.000000"}
]
```
Note: token `16669` for BAJAJ-AUTO is fixture data only; real tokens always come from the downloaded master.

- [ ] **Step 2: Write the failing tests**

`tests/test_instruments.py`:
```python
import json
from datetime import datetime
from pathlib import Path

import pytest

from app.brokers.instruments import InstrumentMaster, UnknownSymbol
from app.clock import IST

ROWS = json.loads((Path(__file__).parent / "fixtures" / "scripmaster_sample.json").read_text())


@pytest.fixture
def master():
    return InstrumentMaster(ROWS)


def test_nse_equity(master):
    i = master.resolve("SBIN", "NSE")
    assert (i.token, i.trading_symbol, i.tick_size) == ("3045", "SBIN-EQ", 0.05)


def test_tradingview_underscore_maps_to_hyphen(master):
    assert master.resolve("BAJAJ_AUTO", "NSE").trading_symbol == "BAJAJ-AUTO-EQ"


def test_ampersand_symbol(master):
    assert master.resolve("M&M", "NSE").token == "2031"


def test_bse_equity(master):
    assert master.resolve("SBIN", "BSE").token == "500112"


def test_index_rejected_with_reason(master):
    with pytest.raises(UnknownSymbol, match="index"):
        master.resolve("NIFTY", "NSE")


def test_unknown_symbol(master):
    with pytest.raises(UnknownSymbol, match="not found"):
        master.resolve("NOPE", "NSE")


def test_cache_used_when_fresh(tmp_path):
    cache = tmp_path / "sm.json"
    cache.write_text(json.dumps(ROWS))
    calls = []
    now = datetime(2026, 9, 18, 10, 0, tzinfo=IST)
    import os
    os.utime(cache, (now.timestamp(), now.timestamp()))
    InstrumentMaster.load(cache, "http://x", now, fetch=lambda url: calls.append(url) or ROWS)
    assert calls == []


def test_cache_refreshed_after_0830_when_old(tmp_path):
    cache = tmp_path / "sm.json"
    cache.write_text("[]")
    old = datetime(2026, 9, 17, 18, 0, tzinfo=IST).timestamp()
    import os
    os.utime(cache, (old, old))
    now = datetime(2026, 9, 18, 9, 0, tzinfo=IST)
    m = InstrumentMaster.load(cache, "http://x", now, fetch=lambda url: ROWS)
    assert m.resolve("SBIN", "NSE").token == "3045"
    assert json.loads(cache.read_text())[0]["token"] == "3045"
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `.venv\Scripts\pytest tests/test_instruments.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.brokers'`

- [ ] **Step 4: Implement the DTOs and protocol**

`app/brokers/__init__.py`: empty file.

`app/brokers/base.py`:
```python
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
```

- [ ] **Step 5: Implement the instrument master**

`app/brokers/instruments.py`:
```python
"""Angel scrip master: download once a day (after 08:30 IST), map TradingView tickers to tokens."""
import json
import logging
from collections.abc import Callable
from datetime import datetime, time
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
        for r in rows:
            exch = r.get("exch_seg")
            if exch not in ("NSE", "BSE") or r.get("instrumenttype"):
                continue
            sym = str(r.get("symbol", ""))
            if exch == "NSE" and not sym.endswith("-EQ"):
                continue
            key = sym.removesuffix("-EQ").upper() if exch == "NSE" else sym.upper()
            tick = float(r.get("tick_size") or 5) / 100
            self._index[(exch, key)] = Instrument(key, exch, str(r["token"]), sym, tick)

    @classmethod
    def load(cls, cache_path: Path, url: str, now: datetime,
             fetch: Callable[[str], list[dict]] = _download) -> "InstrumentMaster":
        today_cutoff = datetime.combine(now.astimezone(IST).date(), REFRESH_AFTER, IST)
        fresh = cache_path.exists() and (
            datetime.fromtimestamp(cache_path.stat().st_mtime, IST) >= today_cutoff or now < today_cutoff
        )
        if fresh:
            return cls(json.loads(cache_path.read_text(encoding="utf-8")))
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
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `.venv\Scripts\pytest tests/test_instruments.py -v`
Expected: 8 passed

- [ ] **Step 7: Commit**

```bash
git add app/brokers/__init__.py app/brokers/base.py app/brokers/instruments.py tests/test_instruments.py tests/fixtures/scripmaster_sample.json
git commit -m "feat: broker DTOs and Angel scrip-master ticker mapping"
```

---

### Task 7: PaperBroker and BrokerHub

**Files:**
- Create: `app/brokers/paper.py`, `app/brokers/hub.py`
- Test: `tests/test_paper_broker.py`

**Interfaces:**
- Consumes: everything in `app/brokers/base.py` (Task 6).
- Produces:
  - `PaperBroker(price_source: Callable[[Sequence[Instrument]], dict[str, Quote]], margin_source: Callable[[Instrument, float], MarginInfo | None], paper_margin_pct: Callable[[], float])` implementing `Broker`, plus `note_price(token: str, price: float) -> None` (fallback price when no live feed).
  - Fill rule: on `order_state`, BUY fills when `limit >= ltp`, SELL when `limit <= ltp`, at the LTP. No LTP known -> stays OPEN.
  - `BrokerHub(paper: PaperBroker, angel: Broker | None)` with `for_mode(mode: str) -> Broker`, `data() -> Broker | None` (Angel only when connected).

- [ ] **Step 1: Write the failing tests**

`tests/test_paper_broker.py`:
```python
import pytest

from app.brokers.base import BrokerError, Instrument, MarginInfo, OrderRequest, Quote
from app.brokers.hub import BrokerHub
from app.brokers.paper import PaperBroker

SBIN = Instrument("SBIN", "NSE", "3045", "SBIN-EQ", 0.05)


def make(ltp=None, broker_margin=None):
    prices = {} if ltp is None else {"3045": Quote("3045", ltp)}
    return PaperBroker(price_source=lambda insts: {t: q for t, q in prices.items()},
                       margin_source=lambda inst, px: broker_margin,
                       paper_margin_pct=lambda: 25.0), prices


def test_buy_fills_at_ltp_when_limit_is_marketable():
    b, _ = make(ltp=842.70)
    oid = b.place_limit(OrderRequest(SBIN, "BUY", 10, 845.25, "A1"))
    s = b.order_state(oid)
    assert (s.status, s.filled_qty, s.avg_price) == ("COMPLETE", 10, 842.70)


def test_buy_stays_open_below_market_then_cancel():
    b, _ = make(ltp=842.70)
    oid = b.place_limit(OrderRequest(SBIN, "BUY", 10, 840.00, "A2"))
    assert b.order_state(oid).status == "OPEN"
    b.cancel(oid)
    assert b.order_state(oid).status == "CANCELLED"


def test_sell_reprice_then_fill():
    b, prices = make(ltp=842.70)
    req = OrderRequest(SBIN, "SELL", 10, 845.00, "A3")
    oid = b.place_limit(req)
    assert b.order_state(oid).status == "OPEN"
    b.modify_limit(oid, OrderRequest(SBIN, "SELL", 10, 840.15, "A3"))
    assert b.order_state(oid).status == "COMPLETE"


def test_fallback_price_from_alert():
    b, _ = make(ltp=None)
    b.note_price("3045", 842.70)
    oid = b.place_limit(OrderRequest(SBIN, "BUY", 1, 845.25, "A4"))
    assert b.order_state(oid).status == "COMPLETE"


def test_margin_prefers_broker_then_paper_estimate():
    b, _ = make(ltp=800.0, broker_margin=MarginInfo(210.0, "broker"))
    assert b.margin_per_share(SBIN, 800.0) == MarginInfo(210.0, "broker")
    b2, _ = make(ltp=800.0, broker_margin=None)
    assert b2.margin_per_share(SBIN, 800.0) == MarginInfo(200.0, "paper estimate")


def test_find_by_tag_and_no_funds_in_paper():
    b, _ = make(ltp=842.70)
    b.place_limit(OrderRequest(SBIN, "BUY", 1, 845.0, "A5"))
    assert b.find_by_tag("A5") is not None and b.find_by_tag("nope") is None
    assert b.funds() is None


def test_unknown_order_id_is_a_broker_error_not_keyerror():
    b, _ = make(ltp=842.70)
    with pytest.raises(BrokerError, match="lost on restart"):
        b.order_state("PAPER-999999")


def test_hub_routes_by_mode():
    paper, _ = make(ltp=1.0)

    class FakeAngel:
        name = "Angel One"
        def connected(self): return False

    hub = BrokerHub(paper, FakeAngel())
    assert hub.for_mode("PAPER") is paper
    assert hub.for_mode("LIVE").name == "Angel One"
    assert hub.data() is None
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `.venv\Scripts\pytest tests/test_paper_broker.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.brokers.paper'`

- [ ] **Step 3: Implement**

`app/brokers/paper.py`:
```python
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
```

`app/brokers/hub.py`:
```python
"""Chooses the broker for the current mode and the live data source."""
from app.brokers.base import Broker
from app.brokers.paper import PaperBroker


class BrokerHub:
    def __init__(self, paper: PaperBroker, angel: Broker | None):
        self.paper = paper
        self.angel = angel

    def for_mode(self, mode: str) -> Broker:
        if mode == "LIVE":
            if self.angel is None:
                raise RuntimeError("LIVE mode needs Angel One configured")
            return self.angel
        return self.paper

    def data(self) -> Broker | None:
        return self.angel if self.angel is not None and self.angel.connected() else None
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv\Scripts\pytest tests/test_paper_broker.py -v`
Expected: 8 passed

- [ ] **Step 5: Commit**

```bash
git add app/brokers/paper.py app/brokers/hub.py tests/test_paper_broker.py
git commit -m "feat: paper broker with marketable-limit fills and broker hub"
```

---

### Task 8: Sizing (limit price, tick rounding, amount -> qty) and rupee formatting

**Files:**
- Create: `app/fmt.py`, `app/engine/__init__.py`, `app/engine/sizing.py`
- Test: `tests/test_sizing.py`

**Interfaces:**
- Produces:
  - `inr(value: float, decimals: int = 2) -> str` (Indian grouping: `inr(100000, 0) == "₹1,00,000"`).
  - `round_to_tick(price: float, tick: float, direction: "up"|"down") -> float`.
  - `limit_price(ltp, side, buffer_pct, tick, upper=None, lower=None) -> float` (BUY rounds up and is capped at the upper circuit; SELL rounds down and is floored at the lower circuit).
  - `SizeResult(qty: int, deployed: float, margin_per_share: float, note: str)`.
  - `size_order(mode: "margin"|"value", amount: float, limit: float, margin_per_share: float, available: float | None) -> SizeResult`.

- [ ] **Step 1: Write the failing tests**

`tests/test_sizing.py`:
```python
import pytest

from app.engine.sizing import limit_price, round_to_tick, size_order
from app.fmt import inr


@pytest.mark.parametrize("value,decimals,expected", [
    (100000, 0, "₹1,00,000"), (9886.8, 2, "₹9,886.80"), (-174.6, 2, "-₹174.60"),
    (12345678.9, 2, "₹1,23,45,678.90"), (999, 0, "₹999"),
])
def test_inr(value, decimals, expected):
    assert inr(value, decimals) == expected


def test_round_to_tick_handles_float_noise():
    assert round_to_tick(845.2500000001, 0.05, "up") == 845.25
    assert round_to_tick(845.2400001, 0.05, "up") == 845.25
    assert round_to_tick(845.2499, 0.05, "down") == 845.20


def test_buy_limit_is_ltp_plus_buffer_rounded_up():
    assert limit_price(842.70, "BUY", 0.3, 0.05) == 845.25  # 845.228 -> 845.25


def test_sell_limit_is_ltp_minus_buffer_rounded_down():
    assert limit_price(842.70, "SELL", 0.3, 0.05) == 840.15  # 840.172 -> 840.15


def test_buy_limit_capped_at_upper_circuit():
    assert limit_price(100.0, "BUY", 2.0, 0.05, upper=101.0) == 101.0


def test_sell_limit_floored_at_lower_circuit():
    assert limit_price(100.0, "SELL", 2.0, 0.05, lower=99.5) == 99.5


def test_margin_mode_uses_margin_per_share():
    r = size_order("margin", 10000, 1416.65, 354.16, available=None)
    assert r.qty == 28
    assert r.deployed == pytest.approx(28 * 354.16)
    assert "MTF margin per share = 28" in r.note


def test_value_mode_uses_limit_price():
    r = size_order("value", 10000, 842.70, 210.68, available=None)
    assert r.qty == 11
    assert r.deployed == pytest.approx(11 * 842.70)


def test_available_funds_reduce_qty_and_say_so():
    r = size_order("margin", 10000, 800.0, 200.0, available=3000.0)
    assert r.qty == 15
    assert "reduced to 15" in r.note


def test_amount_too_small_gives_zero_qty():
    assert size_order("value", 500, 3612.0, 900.0, available=None).qty == 0
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `.venv\Scripts\pytest tests/test_sizing.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.engine'`

- [ ] **Step 3: Implement**

`app/fmt.py`:
```python
"""Rupee formatting with Indian digit grouping (1,00,000)."""


def inr(value: float, decimals: int = 2) -> str:
    sign = "-" if value < 0 else ""
    whole, _, frac = f"{abs(value):.{decimals}f}".partition(".")
    head, tail = whole[:-3], whole[-3:]
    groups: list[str] = []
    while len(head) > 2:
        groups.insert(0, head[-2:])
        head = head[:-2]
    if head:
        groups.insert(0, head)
    body = ",".join([*groups, tail])
    return f"{sign}₹{body}" + (f".{frac}" if decimals else "")
```

`app/engine/__init__.py`: empty file.

`app/engine/sizing.py`:
```python
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv\Scripts\pytest tests/test_sizing.py -v`
Expected: 14 passed

- [ ] **Step 5: Commit**

```bash
git add app/fmt.py app/engine/__init__.py app/engine/sizing.py tests/test_sizing.py
git commit -m "feat: limit pricing, tick rounding and amount-to-qty sizing"
```

---

### Task 9: Guards (every quotation risk control, in spec order)

**Files:**
- Create: `app/engine/guards.py`
- Test: `tests/test_guards.py`

**Interfaces:**
- Consumes: `TradingSettings` (Task 2), `inr` (Task 8).
- Produces:
  - `Check(name: str, ok: bool, detail: str)` with `as_dict() -> dict`.
  - `OpenPos(symbol: str, status: "OPEN"|"EXITING", deployed: float)`.
  - `GuardContext(settings, now: datetime, market_open: bool, is_test: bool, recent: tuple[tuple[str, str, datetime], ...], positions: tuple[OpenPos, ...], working_buy_deployed: float)`. `recent` = (symbol, action, received_at) of **other** alerts in the last hour that were not REJECTED for format/secret.
  - `Verdict(status: str | None, reason: str, checks: tuple[Check, ...])` with `passed` property; `status` is one of `REJECTED`, `DUPLICATE`, `IGNORED` or `None`.
  - `evaluate(symbol: str, action: "BUY"|"SELL", ctx: GuardContext) -> Verdict`.

- [ ] **Step 1: Write the failing tests**

`tests/test_guards.py`:
```python
from datetime import datetime, timedelta

from app.clock import IST
from app.engine.guards import GuardContext, OpenPos, evaluate
from app.settings_model import TradingSettings

NOW = datetime(2026, 9, 18, 11, 0, tzinfo=IST)


def ctx(**over):
    base = dict(settings=TradingSettings(), now=NOW, market_open=True, is_test=False,
                recent=(), positions=(), working_buy_deployed=0.0)
    return GuardContext(**{**base, **over})


def test_clean_buy_passes_with_trace():
    v = evaluate("SBIN", "BUY", ctx())
    assert v.passed and [c.name for c in v.checks][:2] == ["Automation ON", "Market open"]


def test_kill_switch_first():
    v = evaluate("SBIN", "BUY", ctx(settings=TradingSettings(automation_on=False), market_open=False))
    assert v.status == "REJECTED" and "Automation is OFF" in v.reason


def test_market_closed_rejects_but_test_alert_skips():
    assert evaluate("SBIN", "BUY", ctx(market_open=False)).status == "REJECTED"
    v = evaluate("SBIN", "BUY", ctx(market_open=False, is_test=True))
    assert v.passed and any("Skipped" in c.detail for c in v.checks)


def test_duplicate_within_window():
    recent = (("SBIN", "BUY", NOW - timedelta(seconds=20)),)
    assert evaluate("SBIN", "BUY", ctx(recent=recent)).status == "DUPLICATE"


def test_duplicate_outside_window_or_protection_off_passes():
    old = (("SBIN", "BUY", NOW - timedelta(seconds=90)),)
    assert evaluate("SBIN", "BUY", ctx(recent=old)).passed
    recent = (("SBIN", "BUY", NOW - timedelta(seconds=5)),)
    assert evaluate("SBIN", "BUY", ctx(recent=recent, settings=TradingSettings(duplicate_protection=False))).passed


def test_buy_on_held_stock_ignored():
    v = evaluate("SBIN", "BUY", ctx(positions=(OpenPos("SBIN", "OPEN", 9000.0),)))
    assert v.status == "IGNORED" and "Already holding" in v.reason


def test_max_positions():
    held = tuple(OpenPos(s, "OPEN", 9000.0) for s in ["A", "B", "C", "D", "E"])
    v = evaluate("SBIN", "BUY", ctx(positions=held))
    assert v.status == "REJECTED" and "5 of 5" in v.reason


def test_capital_cap_counts_working_buys():
    held = (OpenPos("A", "OPEN", 45000.0), OpenPos("B", "OPEN", 45000.0))
    v = evaluate("SBIN", "BUY", ctx(positions=held, working_buy_deployed=1000.0))
    assert v.status == "REJECTED" and "Capital cap" in v.reason


def test_sell_without_position_ignored():
    assert evaluate("SBIN", "SELL", ctx()).status == "IGNORED"


def test_sell_while_exiting_ignored():
    v = evaluate("SBIN", "SELL", ctx(positions=(OpenPos("SBIN", "EXITING", 9000.0),)))
    assert v.status == "IGNORED" and "already in progress" in v.reason


def test_sell_with_open_position_passes():
    assert evaluate("SBIN", "SELL", ctx(positions=(OpenPos("SBIN", "OPEN", 9000.0),))).passed
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `.venv\Scripts\pytest tests/test_guards.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.engine.guards'`

- [ ] **Step 3: Implement**

`app/engine/guards.py`:
```python
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv\Scripts\pytest tests/test_guards.py -v`
Expected: 11 passed

- [ ] **Step 5: Commit**

```bash
git add app/engine/guards.py tests/test_guards.py
git commit -m "feat: guard chain for kill switch, hours, duplicates, positions and capital cap"
```

---

### Task 10: Engine worker (guards -> symbol -> price -> size -> LIMIT order)

**Files:**
- Create: `app/engine/ledger.py`, `app/engine/worker.py`
- Test: `tests/__init__.py`, `tests/factory.py`, `tests/test_engine.py`

**Interfaces:**
- Consumes: `AppContext` (Task 4; `hub` and `instruments` must be set), `evaluate/Check/GuardContext/OpenPos` (Task 9), `limit_price/size_order` (Task 8), `BrokerHub/PaperBroker` (Task 7), `InstrumentMaster/UnknownSymbol` (Task 6), `OrderOutcomeUnknown/BrokerError` (Task 6), models (Task 2), `log_event` (Task 4).
- Produces:
  - `ledger.open_positions(s, mode) -> list[Position]` (OPEN or EXITING), `ledger.position_for(s, mode, symbol) -> Position | None`, `ledger.recent_alerts(s, exclude_id, since) -> list[tuple[str, str, datetime]]`, `ledger.working_buy_deployed(s, mode) -> float`, `ledger.working_orders(s) -> list[Order]` (OPEN/PARTIAL with a broker id).
  - `order_tag(alert_id: int) -> str` (`"MTF<id>"`, within Angel's 20-char ordertag limit).
  - `Engine(ctx)` with `async run()` (forever) and `async process(alert_id)`. After `process`, a passing alert is `PENDING` with an `OPEN` order holding a `broker_order_id`; fills are Task 11's job.

- [ ] **Step 1: Write the shared test factory and the failing tests**

`tests/__init__.py`: empty file (makes `tests.factory` importable; reused by Tasks 11, 15, 16).

`tests/factory.py`:
```python
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


def seed_position(ctx, symbol="SBIN", qty=47, avg=842.70) -> int:
    with session_scope(ctx.db) as s:
        p = Position(mode="PAPER", symbol=symbol, exchange="NSE", token="3045", trading_symbol="SBIN-EQ",
                     qty=qty, avg_price=avg, deployed_amount=9931.57, margin_per_share=211.31,
                     status="OPEN", entry_order_id=0, opened_at=MARKET)
        s.add(p)
        s.flush()
        return p.id


def fetch(ctx, model, **where):
    with session_scope(ctx.db) as s:
        return list(s.scalars(select(model).filter_by(**where)))
```

`tests/test_engine.py`:
```python
import asyncio

import pytest

from app.brokers.base import OrderOutcomeUnknown
from app.engine.worker import Engine
from app.models import Alert, Order, Position
from tests.factory import SATURDAY, add_alert, fetch, make_world, seed_position


@pytest.fixture
def w(tmp_path):
    world = make_world(tmp_path)
    world.engine = Engine(world.ctx)
    return world


async def test_buy_places_mtf_limit_sized_from_amount(w):
    aid = add_alert(w.ctx)
    await w.engine.process(aid)
    [alert] = fetch(w.ctx, Alert, id=aid)
    [order] = fetch(w.ctx, Order)
    assert (alert.status, alert.action_taken) == ("PENDING", "LIMIT BUY sent")
    assert (order.side, order.product, order.order_type) == ("BUY", "MTF", "LIMIT")
    assert order.limit_price == 845.25                    # 842.70 * 1.003 rounded up to 0.05
    assert order.qty == 47                                # 10000 / (845.25 * 25%) = 47.32
    assert order.ordertag == f"MTF{aid}" and order.broker_order_id.startswith("PAPER-")
    assert any("paper estimate" in c["detail"] for c in alert.checks)


async def test_buy_on_held_stock_is_ignored_without_order(w):
    seed_position(w.ctx)
    aid = add_alert(w.ctx)
    await w.engine.process(aid)
    assert fetch(w.ctx, Alert, id=aid)[0].status == "IGNORED"
    assert fetch(w.ctx, Order) == []


async def test_market_closed_rejects_but_test_alert_trades(w):
    closed = add_alert(w.ctx, at=SATURDAY)
    # 5 minutes later: outside the 60 s duplicate window, so only the market-hours rule differs.
    test = add_alert(w.ctx, at=SATURDAY.replace(minute=5), is_test=True, symbol="SBIN")
    await w.engine.process(closed)
    await w.engine.process(test)
    assert fetch(w.ctx, Alert, id=closed)[0].status == "REJECTED"
    assert fetch(w.ctx, Alert, id=test)[0].status == "PENDING"


async def test_index_symbol_rejected(w):
    aid = add_alert(w.ctx, symbol="NIFTY")
    await w.engine.process(aid)
    a = fetch(w.ctx, Alert, id=aid)[0]
    assert a.status == "REJECTED" and "index" in a.detail


async def test_no_price_fails_with_reason(w):
    w.prices.clear()
    aid = add_alert(w.ctx)
    await w.engine.process(aid)
    a = fetch(w.ctx, Alert, id=aid)[0]
    assert a.status == "FAILED" and "No live price" in a.detail


async def test_sell_marks_exiting_and_sends_full_qty(w):
    seed_position(w.ctx, qty=47)
    aid = add_alert(w.ctx, action="SELL")
    await w.engine.process(aid)
    [pos] = fetch(w.ctx, Position)
    [order] = fetch(w.ctx, Order)
    assert pos.status == "EXITING"
    assert (order.side, order.qty, order.limit_price, order.position_id) == ("SELL", 47, 840.15, pos.id)


async def test_timeout_recovers_order_by_tag_without_duplicate(w):
    real = w.paper.place_limit

    def flaky(req):
        real(req)
        raise OrderOutcomeUnknown("read timeout")

    w.paper.place_limit = flaky
    aid = add_alert(w.ctx)
    await w.engine.process(aid)
    assert fetch(w.ctx, Alert, id=aid)[0].status == "PENDING"
    assert len(w.paper._orders) == 1  # noqa: SLF001 - proves no second placeOrder


async def test_timeout_not_found_fails_safely(w):
    def lost(req):
        raise OrderOutcomeUnknown("connection reset")

    w.paper.place_limit = lost
    aid = add_alert(w.ctx)
    await w.engine.process(aid)
    a = fetch(w.ctx, Alert, id=aid)[0]
    [o] = fetch(w.ctx, Order)
    assert a.status == "FAILED" and o.status == "REJECTED" and "unknown" in o.reason.lower()


async def test_worker_survives_a_crashing_alert(w, monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("scrip master corrupt")

    monkeypatch.setattr(w.ctx.instruments, "resolve", boom)
    task = asyncio.create_task(w.engine.run())
    aid = add_alert(w.ctx)
    w.ctx.alert_queue.put_nowait(aid)
    await asyncio.wait_for(w.ctx.alert_queue.join(), 2)
    task.cancel()
    a = fetch(w.ctx, Alert, id=aid)[0]
    assert a.status == "FAILED" and "scrip master corrupt" in a.detail
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `.venv\Scripts\pytest tests/test_engine.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.engine.worker'`

- [ ] **Step 3: Implement the ledger queries**

`app/engine/ledger.py`:
```python
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
    q = select(Position).where(Position.mode == mode, Position.symbol == symbol, Position.status.in_(LIVE_POSITION))
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
```

- [ ] **Step 4: Implement the worker**

`app/engine/worker.py`:
```python
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
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `.venv\Scripts\pytest tests/test_engine.py -v`
Expected: 9 passed

- [ ] **Step 6: Commit**

```bash
git add app/engine/ledger.py app/engine/worker.py tests/__init__.py tests/factory.py tests/test_engine.py
git commit -m "feat: sequential engine placing MTF LIMIT orders with tag-based timeout recovery"
```

---

### Task 11: Order tracker (fills, BUY timeout, SELL re-price, exit pending, kill switch)

**Files:**
- Modify: `app/fmt.py` (add `signed_inr`)
- Create: `app/engine/tracker.py`
- Test: `tests/test_tracker.py`

**Interfaces:**
- Consumes: `working_orders` (Task 10), `limit_price` (Task 8), `OrderState/OrderRequest/BrokerError` (Task 6), models (Task 2), `load_settings` (Task 2), `log_event` (Task 4).
- Produces:
  - `signed_inr(value, decimals=2) -> str` (`"+₹596.90"`, `"-₹174.60"`, `"₹0.00"`).
  - `OrderTracker(ctx, clock=now_ist)` with `async tick()` (one pass) and `async run(interval=2.0)`.
  - `async cancel_all_working(ctx) -> int` (kill switch; returns how many cancels were sent).
  - Outcomes: BUY COMPLETE -> Position OPEN + alert `EXECUTED`; SELL COMPLETE -> Position CLOSED + Trade + alert `SQUARED_OFF`; BUY unfilled past `buy_fill_timeout_sec` -> cancel -> alert `FAILED` (partial fill keeps the filled qty and is `EXECUTED`); SELL unfilled for `sell_reprice_interval_sec` -> modify to fresh LTP - buffer, up to `sell_reprice_attempts`, then `exit_pending_flagged` + ERROR event; SELL cancelled/rejected -> position back to OPEN.

- [ ] **Step 1: Add `signed_inr` to `app/fmt.py`**

Append:
```python
def signed_inr(value: float, decimals: int = 2) -> str:
    return ("+" if value > 0 else "") + inr(value, decimals)
```

- [ ] **Step 2: Write the failing tests**

`tests/test_tracker.py`:
```python
from datetime import timedelta

import pytest

from app.brokers.base import OrderState, Quote
from app.engine.tracker import OrderTracker, cancel_all_working
from app.engine.worker import Engine
from app.fmt import signed_inr
from app.models import Alert, EventRow, Order, Position, Trade
from tests.factory import MARKET, add_alert, fetch, make_world, seed_position


class Clock:
    def __init__(self, t):
        self.t = t

    def __call__(self):
        return self.t

    def advance(self, seconds):
        self.t = self.t + timedelta(seconds=seconds)


@pytest.fixture
def w(tmp_path, monkeypatch):
    world = make_world(tmp_path)
    world.clock = Clock(MARKET)
    monkeypatch.setattr("app.engine.worker.now_ist", world.clock)  # order created_at follows the test clock
    world.engine = Engine(world.ctx)
    world.tracker = OrderTracker(world.ctx, clock=world.clock)
    return world


def test_signed_inr():
    assert (signed_inr(596.9), signed_inr(-174.6), signed_inr(0)) == ("+₹596.90", "-₹174.60", "₹0.00")


async def test_buy_fill_opens_position_and_executes_alert(w):
    aid = add_alert(w.ctx)
    await w.engine.process(aid)
    await w.tracker.tick()
    [pos] = fetch(w.ctx, Position)
    [order] = fetch(w.ctx, Order)
    alert = fetch(w.ctx, Alert, id=aid)[0]
    assert (pos.qty, pos.avg_price, pos.status) == (47, 842.70, "OPEN")
    assert pos.deployed_amount == round(47 * 211.31, 2)
    assert order.status == "COMPLETE" and order.position_id == pos.id
    assert alert.status == "EXECUTED" and "Qty 47" in alert.detail


async def test_unfilled_buy_cancelled_after_timeout(w):
    aid = add_alert(w.ctx)
    await w.engine.process(aid)
    w.prices["3045"] = Quote("3045", 900.0)  # market ran above our limit
    await w.tracker.tick()
    assert fetch(w.ctx, Order)[0].status == "OPEN"
    w.clock.advance(31)
    await w.tracker.tick()
    order = fetch(w.ctx, Order)[0]
    assert order.status == "CANCELLED" and "Not filled in 30 s" in order.reason
    assert fetch(w.ctx, Alert, id=aid)[0].status == "FAILED"
    assert fetch(w.ctx, Position) == []


async def test_partial_buy_keeps_filled_qty(w, monkeypatch):
    aid = add_alert(w.ctx)
    await w.engine.process(aid)
    seq = iter(["OPEN", "CANCELLED"])
    monkeypatch.setattr(w.paper, "order_state", lambda oid: OrderState(oid, next(seq), 20, 842.70))
    monkeypatch.setattr(w.paper, "cancel", lambda oid: None)
    w.clock.advance(31)
    await w.tracker.tick()
    [pos] = fetch(w.ctx, Position)
    order = fetch(w.ctx, Order)[0]
    assert pos.qty == 20
    assert order.filled_qty == 20 and "Part filled 20 of 47" in order.reason
    assert fetch(w.ctx, Alert, id=aid)[0].status == "EXECUTED"


async def test_sell_fill_records_trade_with_realised_pnl(w):
    seed_position(w.ctx, qty=47, avg=830.00)
    aid = add_alert(w.ctx, action="SELL")
    await w.engine.process(aid)
    await w.tracker.tick()
    [trade] = fetch(w.ctx, Trade)
    assert fetch(w.ctx, Position)[0].status == "CLOSED"
    assert trade.realised_pnl == round(47 * (842.70 - 830.00), 2)
    alert = fetch(w.ctx, Alert, id=aid)[0]
    assert alert.status == "SQUARED_OFF" and "+₹596.90" in alert.detail


async def test_unfilled_sell_repriced_then_flagged_exit_pending(w, monkeypatch):
    seed_position(w.ctx, qty=47, avg=830.00)
    aid = add_alert(w.ctx, action="SELL")
    await w.engine.process(aid)
    monkeypatch.setattr(w.paper, "order_state", lambda oid: OrderState(oid, "OPEN", 0, None))
    w.prices["3045"] = Quote("3045", 800.0)
    for _ in range(3):
        w.clock.advance(16)
        await w.tracker.tick()
    order = fetch(w.ctx, Order)[0]
    assert order.reprice_count == 3 and order.limit_price == 797.6
    w.clock.advance(16)
    await w.tracker.tick()
    assert fetch(w.ctx, Order)[0].exit_pending_flagged is True
    assert any("Exit pending" in e.message for e in fetch(w.ctx, EventRow, level="ERROR"))
    assert fetch(w.ctx, Position)[0].status == "EXITING"


async def test_kill_switch_cancels_and_reopens_exiting_position(w):
    seed_position(w.ctx, qty=47, avg=830.00)
    aid = add_alert(w.ctx, action="SELL")
    await w.engine.process(aid)
    w.prices["3045"] = Quote("3045", 800.0)  # SELL limit 840.15 cannot fill
    assert await cancel_all_working(w.ctx) == 1
    await w.tracker.tick()
    assert fetch(w.ctx, Order)[0].status == "CANCELLED"
    assert fetch(w.ctx, Position)[0].status == "OPEN"
    assert fetch(w.ctx, Alert, id=aid)[0].status == "FAILED"
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `.venv\Scripts\pytest tests/test_tracker.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.engine.tracker'`

- [ ] **Step 4: Implement**

`app/engine/tracker.py`:
```python
"""Follows every working order to its end (spec 6.3-6.5)."""
import asyncio
import logging
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime

from app.brokers.base import Broker, BrokerError, OrderRequest, OrderState
from app.clock import now_ist
from app.context import AppContext
from app.db import session_scope
from app.engine.ledger import working_orders
from app.engine.sizing import limit_price
from app.events import log_event
from app.fmt import inr, signed_inr
from app.models import Alert, Order, Position, Trade
from app.repo_settings import load_settings
from app.settings_model import TradingSettings

log = logging.getLogger("mtf.tracker")


@dataclass(frozen=True)
class Working:
    id: int
    alert_id: int | None
    mode: str
    broker_order_id: str
    ordertag: str
    side: str
    qty: int
    symbol: str
    exchange: str
    sizing_mode: str
    margin_per_share: float
    position_id: int | None
    reprice_count: int
    created_at: datetime
    updated_at: datetime
    exit_pending_flagged: bool

    @classmethod
    def of(cls, o: Order) -> "Working":
        return cls(o.id, o.alert_id, o.mode, o.broker_order_id, o.ordertag, o.side, o.qty, o.symbol, o.exchange,
                   o.sizing_mode, o.margin_per_share, o.position_id, o.reprice_count, o.created_at,
                   o.updated_at, o.exit_pending_flagged)


def _snapshot(ctx: AppContext) -> tuple[TradingSettings, list[Working]]:
    with session_scope(ctx.db) as s:
        return load_settings(s), [Working.of(o) for o in working_orders(s)]


async def cancel_all_working(ctx: AppContext) -> int:
    _, orders = _snapshot(ctx)
    for o in orders:
        try:
            await asyncio.to_thread(ctx.hub.for_mode(o.mode).cancel, o.broker_order_id)
        except BrokerError as err:
            log.error("kill switch: cancel %s failed: %s", o.broker_order_id, err)
    return len(orders)


class OrderTracker:
    def __init__(self, ctx: AppContext, clock: Callable[[], datetime] = now_ist):
        self.ctx, self.clock = ctx, clock

    async def run(self, interval: float = 2.0) -> None:
        while True:
            try:
                await self.tick()
            except Exception:  # noqa: BLE001 - the tracker must keep following orders
                log.exception("tracker tick failed")
            await asyncio.sleep(interval)

    async def tick(self) -> None:
        settings, orders = _snapshot(self.ctx)
        for o in orders:
            broker = self.ctx.hub.for_mode(o.mode)
            try:
                state = await asyncio.to_thread(broker.order_state, o.broker_order_id)
                await self._advance(o, state, settings, broker)
            except BrokerError as err:
                log.warning("order %s: %s", o.broker_order_id, err)

    async def _advance(self, o: Working, state: OrderState, settings: TradingSettings, broker: Broker) -> None:
        if state.status == "COMPLETE":
            return self._filled(o, state)
        if state.status in ("CANCELLED", "REJECTED"):
            return self._ended(o, state)
        now = self.clock()
        if o.side == "BUY" and (now - o.created_at).total_seconds() >= settings.buy_fill_timeout_sec:
            return await self._timeout_buy(o, broker, settings.buy_fill_timeout_sec)
        if o.side == "SELL" and (now - o.updated_at).total_seconds() >= settings.sell_reprice_interval_sec:
            if o.reprice_count < settings.sell_reprice_attempts:
                return await self._reprice(o, settings, broker)
            if not o.exit_pending_flagged:
                return self._flag_exit_pending(o, settings.sell_reprice_attempts)
        return None

    async def _timeout_buy(self, o: Working, broker: Broker, timeout: int) -> None:
        await asyncio.to_thread(broker.cancel, o.broker_order_id)
        final = await asyncio.to_thread(broker.order_state, o.broker_order_id)
        if final.status == "COMPLETE":
            return self._filled(o, final)
        if final.status == "OPEN":
            return None  # cancel not effective yet; next tick sees the final state
        return self._ended(o, final, reason=f"Not filled in {timeout} s, cancelled.")

    async def _reprice(self, o: Working, settings: TradingSettings, broker: Broker) -> None:
        inst = self.ctx.instruments.resolve(o.symbol, o.exchange)
        quote = (await asyncio.to_thread(broker.quotes, [inst])).get(inst.token)
        if quote is None:
            return
        new_limit = limit_price(quote.ltp, "SELL", settings.limit_buffer_pct, inst.tick_size,
                                quote.upper_circuit, quote.lower_circuit)
        await asyncio.to_thread(broker.modify_limit, o.broker_order_id,
                                OrderRequest(inst, "SELL", o.qty, new_limit, o.ordertag))
        with session_scope(self.ctx.db) as s:
            order = s.get(Order, o.id)
            order.limit_price, order.reprice_count, order.updated_at = new_limit, o.reprice_count + 1, self.clock()
            order.reason = f"Re-priced {order.reprice_count}x"
            log_event(s, self.ctx.bus, "INFO", "broker", f"SELL {o.symbol} re-priced to {inr(new_limit)}",
                      {"order_id": o.id})
        self.ctx.bus.publish("order", {"id": o.id})

    def _filled(self, o: Working, state: OrderState) -> None:
        now = self.clock()
        with session_scope(self.ctx.db) as s:
            order = s.get(Order, o.id)
            complete = state.filled_qty >= o.qty
            order.status = "COMPLETE" if complete else "CANCELLED"
            order.filled_qty, order.avg_price, order.updated_at = state.filled_qty, state.avg_price, now
            if not complete:
                order.reason = f"Part filled {state.filled_qty} of {o.qty}; rest cancelled"
            result = self._open_position(s, o, state, order, now) if o.side == "BUY" else self._close_position(s, o, state, now)
            self._alert(s, o.alert_id, *result)
        for kind in ("order", "position", "trade", "status"):
            self.ctx.bus.publish(kind, {"order_id": o.id})

    def _open_position(self, s, o: Working, state: OrderState, order: Order, now) -> tuple[str, str, str]:
        per_share = o.margin_per_share if o.sizing_mode == "margin" else state.avg_price
        deployed = round(state.filled_qty * per_share, 2)
        pos = Position(mode=o.mode, symbol=o.symbol, exchange=o.exchange, token=order.token,
                       trading_symbol=order.trading_symbol, qty=state.filled_qty, avg_price=state.avg_price,
                       deployed_amount=deployed, margin_per_share=o.margin_per_share, status="OPEN",
                       entry_order_id=o.id, opened_at=now)
        s.add(pos)
        s.flush()
        order.position_id = pos.id
        return "EXECUTED", "MTF buy placed", f"{inr(deployed)} | Qty {state.filled_qty}"

    def _close_position(self, s, o: Working, state: OrderState, now) -> tuple[str, str, str]:
        pos = s.get(Position, o.position_id)
        held, sold, exit_px = pos.qty, min(state.filled_qty, pos.qty), state.avg_price
        pnl = round(sold * (exit_px - pos.avg_price), 2)
        share = sold / held
        s.add(Trade(mode=pos.mode, position_id=pos.id, symbol=pos.symbol, qty=sold, entry_price=pos.avg_price,
                    exit_price=exit_px, deployed_amount=round(pos.deployed_amount * share, 2), realised_pnl=pnl,
                    pnl_pct=round((exit_px - pos.avg_price) / pos.avg_price * 100, 2),
                    opened_at=pos.opened_at, closed_at=now, exit_order_id=o.id))
        if sold >= held:
            pos.status = "CLOSED"
            return "SQUARED_OFF", "Squared off", f"P&L {signed_inr(pnl)}"
        pos.qty, pos.status = held - sold, "OPEN"
        pos.deployed_amount = round(pos.deployed_amount * (1 - share), 2)
        return "FAILED", "Part squared off", f"Sold {sold} of {held}; {held - sold} still open. P&L {signed_inr(pnl)}"

    def _ended(self, o: Working, state: OrderState, reason: str | None = None) -> None:
        if state.filled_qty > 0:
            return self._filled(o, state)
        with session_scope(self.ctx.db) as s:
            order = s.get(Order, o.id)
            order.status = state.status
            order.reason = reason or state.message or state.status.title()
            order.updated_at = self.clock()
            if o.side == "SELL" and o.position_id:
                s.get(Position, o.position_id).status = "OPEN"
            taken = "Order cancelled" if state.status == "CANCELLED" else "Broker rejected"
            kept = " Position kept open." if o.side == "SELL" else ""
            self._alert(s, o.alert_id, "FAILED", taken, order.reason + kept)
        for kind in ("order", "position", "status"):
            self.ctx.bus.publish(kind, {"order_id": o.id})
        return None

    def _flag_exit_pending(self, o: Working, attempts: int) -> None:
        with session_scope(self.ctx.db) as s:
            s.get(Order, o.id).exit_pending_flagged = True
            log_event(s, self.ctx.bus, "ERROR", "engine",
                      f"Exit pending for {o.symbol}: SELL not filled after {attempts} re-prices. Check Angel One.",
                      {"order_id": o.id})
        self.ctx.bus.publish("status", {"exit_pending": o.symbol})

    def _alert(self, s, alert_id: int | None, status: str, taken: str, detail: str) -> None:
        if alert_id is None:
            return
        a = s.get(Alert, alert_id)
        a.status, a.action_taken, a.detail = status, taken, detail
        log_event(s, self.ctx.bus, "ERROR" if status == "FAILED" else "INFO", "engine",
                  f"{a.action} {a.symbol}: {taken}. {detail}", {"alert_id": a.id})
        self.ctx.bus.publish("alert", {"id": a.id, "status": status})
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `.venv\Scripts\pytest tests/test_tracker.py -v`
Expected: 7 passed

- [ ] **Step 6: Commit**

```bash
git add app/fmt.py app/engine/tracker.py tests/test_tracker.py
git commit -m "feat: order tracker for fills, BUY timeout, SELL re-price and exit-pending"
```

---

### Task 12: Angel transport helpers (rate gate, response classifier, escalating backoff)

**Files:**
- Create: `app/brokers/angel_http.py`
- Test: `tests/test_angel_http.py`

**Interfaces:**
- Consumes: `BrokerError, RateLimited, SessionExpired` (Task 6).
- Produces:
  - `RateGate(per_second: float, clock=time.monotonic, sleep=time.sleep)` with `acquire()` (thread-safe; blocks until the next slot).
  - `Backoff(steps: tuple[float, ...], clock=time.monotonic)` with `blocked() -> float` (seconds left, 0 if free), `fail()` (escalate one step), `reset()`.
  - `classify(status_code: int, body: str | dict) -> dict` returning the parsed JSON `data` on success, raising `RateLimited` for HTTP 403 text containing "exceeding access rate" **or** JSON `errorcode == "AB1021"`, `SessionExpired` for `AG8001/AG8002/AG8003`, `BrokerError(message, code)` for any other `status: false`.
  - Constants: `RATE_COOLDOWN = (45, 90, 180)`, `LOGIN_BACKOFF = (60, 300, 900, 1800)`.

- [ ] **Step 1: Write the failing tests**

`tests/test_angel_http.py`:
```python
import threading

import pytest

from app.brokers.angel_http import LOGIN_BACKOFF, RATE_COOLDOWN, Backoff, RateGate, classify
from app.brokers.base import BrokerError, RateLimited, SessionExpired


class FakeClock:
    def __init__(self):
        self.t = 0.0

    def __call__(self):
        return self.t

    def sleep(self, s):
        self.t += s


def test_rate_gate_spaces_calls():
    c = FakeClock()
    gate = RateGate(2.0, clock=c, sleep=c.sleep)
    for _ in range(3):
        gate.acquire()
    assert c.t == pytest.approx(1.0)  # 3 calls at 2/s -> 0, 0.5, 1.0


def test_rate_gate_is_thread_safe():
    gate = RateGate(1000.0)
    threads = [threading.Thread(target=gate.acquire) for _ in range(20)]
    [t.start() for t in threads]
    [t.join() for t in threads]


def test_backoff_escalates_and_caps_then_resets():
    c = FakeClock()
    b = Backoff(RATE_COOLDOWN, clock=c)
    assert b.blocked() == 0
    b.fail(); assert b.blocked() == 45
    c.t += 45; b.fail(); assert b.blocked() == 90
    c.t += 90; b.fail(); c.t += 180; b.fail()
    assert b.blocked() == 180  # capped at the last step
    b.reset(); assert b.blocked() == 0
    assert LOGIN_BACKOFF == (60, 300, 900, 1800)


def test_success_returns_data():
    assert classify(200, {"status": True, "message": "SUCCESS", "errorcode": "", "data": {"net": "1"}}) == {"net": "1"}


def test_plain_text_403_is_rate_limited():
    with pytest.raises(RateLimited):
        classify(403, "Access denied because of exceeding access rate")


def test_ab1021_in_http_200_is_rate_limited():
    # The shape that slipped through in an earlier Angel project: HTTP 200, JSON error body.
    with pytest.raises(RateLimited):
        classify(200, {"status": False, "errorcode": "AB1021", "message": "Too many requests"})


@pytest.mark.parametrize("code", ["AG8001", "AG8002", "AG8003"])
def test_session_errors(code):
    with pytest.raises(SessionExpired):
        classify(200, {"status": False, "errorcode": code, "message": "Invalid Token"})


def test_camelcase_errorcode_also_recognised():
    # Angel sends errorCode (camelCase) on some endpoints despite the docs.
    with pytest.raises(SessionExpired):
        classify(200, {"success": False, "errorCode": "AG8001", "message": "Invalid Token"})


def test_other_api_error_keeps_code_and_message():
    with pytest.raises(BrokerError) as e:
        classify(200, {"status": False, "errorcode": "AB1008", "message": "Invalid order variety"})
    assert e.value.code == "AB1008" and "Invalid order variety" in str(e.value)
    assert not isinstance(e.value, (RateLimited, SessionExpired))


def test_non_json_5xx_is_broker_error():
    with pytest.raises(BrokerError):
        classify(502, "<html>Bad gateway</html>")
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `.venv\Scripts\pytest tests/test_angel_http.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.brokers.angel_http'`

- [ ] **Step 3: Implement**

`app/brokers/angel_http.py`:
```python
"""Transport rules learnt the hard way on earlier Angel One projects:
- rate limiting arrives as HTTP 403 plain text OR as HTTP 200 JSON errorcode AB1021;
- errorcode can be spelt errorCode; session loss is AG8001/AG8002/AG8003;
- never hammer: every retry path escalates its wait."""
import threading
import time
from collections.abc import Callable

from app.brokers.base import BrokerError, RateLimited, SessionExpired

RATE_COOLDOWN = (45, 90, 180)
LOGIN_BACKOFF = (60, 300, 900, 1800)
SESSION_CODES = {"AG8001", "AG8002", "AG8003"}
RATE_CODES = {"AB1021"}


class RateGate:
    def __init__(self, per_second: float, clock: Callable[[], float] = time.monotonic,
                 sleep: Callable[[float], None] = time.sleep):
        self._gap = 1.0 / per_second
        self._clock, self._sleep = clock, sleep
        self._next = 0.0
        self._lock = threading.Lock()

    def acquire(self) -> None:
        with self._lock:
            now = self._clock()
            wait = max(0.0, self._next - now)
            self._next = max(now, self._next) + self._gap
        if wait:
            self._sleep(wait)


class Backoff:
    def __init__(self, steps: tuple[float, ...], clock: Callable[[], float] = time.monotonic):
        self._steps, self._clock = steps, clock
        self._level = -1
        self._until = 0.0
        self._lock = threading.Lock()

    def blocked(self) -> float:
        return max(0.0, self._until - self._clock())

    def fail(self) -> None:
        with self._lock:
            if self.blocked():  # one incident = one step, even if many threads report it
                return
            self._level = min(self._level + 1, len(self._steps) - 1)
            self._until = self._clock() + self._steps[self._level]

    def reset(self) -> None:
        with self._lock:
            self._level, self._until = -1, 0.0


def classify(status_code: int, body: str | dict) -> dict:
    if isinstance(body, str):
        if status_code == 403 and "exceeding access rate" in body.lower():
            raise RateLimited("Angel rate limit: exceeding access rate", "HTTP403")
        raise BrokerError(f"Angel returned HTTP {status_code}: {body[:200]}", f"HTTP{status_code}")
    ok = body.get("status", body.get("success"))
    if ok:
        return body.get("data") or {}
    code = str(body.get("errorcode") or body.get("errorCode") or "")
    message = str(body.get("message") or "Angel API error")
    if code in RATE_CODES:
        raise RateLimited(f"Angel rate limit ({code} {message})", code)
    if code in SESSION_CODES:
        raise SessionExpired(f"Angel session expired ({code})", code)
    raise BrokerError(f"{message} ({code})" if code else message, code)
```
Note `Backoff.fail` ignores reports while already blocked. That is deliberate: in an earlier project six threads each reported the same block and pushed the ladder to its ceiling on one incident.

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv\Scripts\pytest tests/test_angel_http.py -v`
Expected: 12 passed

- [ ] **Step 5: Commit**

```bash
git add app/brokers/angel_http.py tests/test_angel_http.py
git commit -m "feat: Angel rate gate, error classifier and escalating backoff"
```

---

### Task 13: AngelBroker (SmartAPI REST)

**Files:**
- Create: `app/brokers/angel.py`
- Test: `tests/test_angel.py`

**Interfaces:**
- Consumes: `RateGate, Backoff, classify, RATE_COOLDOWN, LOGIN_BACKOFF` (Task 12), DTOs (Task 6), `Credentials` (Task 3), `IST, now_ist` (Task 1).
- Produces:
  - `BASE`, `P` (endpoint paths dict), `PRODUCT = "MARGIN"`.
  - `ClientIdentity(local_ip: str, public_ip: str, mac: str)`.
  - `map_status(raw: str, filled: int, qty: int) -> str`.
  - `AngelBroker(credentials: Callable[[], Credentials | None], identity: ClientIdentity, client: httpx.Client | None = None, clock=time.monotonic, sleep=time.sleep, totp=...)` implementing `Broker` (Task 6), plus `login()`, `logout()`, attributes `last_login_at`, `last_error`.
  - `account_positions()` items: `{symbol, exchange, qty, avg_price, ltp, product, note}`; `account_orders()` items follow the `/api/orders` shape (spec section 8).

- [ ] **Step 1: Write the failing tests**

`tests/test_angel.py`:
```python
import json

import httpx
import pytest
import respx

from app.brokers.angel import BASE, P, AngelBroker, ClientIdentity, map_status
from app.brokers.base import BrokerError, Instrument, OrderOutcomeUnknown, OrderRequest, RateLimited
from app.repo_broker import Credentials

SBIN = Instrument("SBIN", "NSE", "3045", "SBIN-EQ", 0.05)
CREDS = Credentials("A123456", "apikey123", "1234", "JBSWY3DPEHPK3PXP")
IDENT = ClientIdentity("192.168.1.5", "49.36.1.2", "aa:bb:cc:dd:ee:ff")


def ok(data):
    return httpx.Response(200, json={"status": True, "message": "SUCCESS", "errorcode": "", "data": data})


class Clock:
    def __init__(self):
        self.t = 0.0

    def __call__(self):
        return self.t

    def sleep(self, s):
        self.t += s


@pytest.fixture
def clock():
    return Clock()


@pytest.fixture
def angel(clock):
    return AngelBroker(lambda: CREDS, IDENT, client=httpx.Client(), clock=clock, sleep=clock.sleep,
                       totp=lambda secret: "123456")


def login_route():
    return respx.post(BASE + P["login"]).mock(return_value=ok({"jwtToken": "jwt-1", "refreshToken": "r", "feedToken": "f"}))


@respx.mock
def test_login_sends_mpin_totp_and_identity_headers(angel):
    route = login_route()
    angel.login()
    req = route.calls.last.request
    assert json.loads(req.content) == {"clientcode": "A123456", "password": "1234", "totp": "123456"}
    assert req.headers["X-PrivateKey"] == "apikey123"
    assert req.headers["X-ClientPublicIP"] == "49.36.1.2"
    assert angel.connected()


@respx.mock
def test_place_order_is_limit_margin_with_tag(angel):
    login_route()
    route = respx.post(BASE + P["place"]).mock(return_value=ok({"orderid": "260918000123", "uniqueorderid": "u-1"}))
    oid = angel.place_limit(OrderRequest(SBIN, "BUY", 47, 845.25, "MTF12"))
    body = json.loads(route.calls.last.request.content)
    assert oid == "260918000123"
    assert body == {"variety": "NORMAL", "tradingsymbol": "SBIN-EQ", "symboltoken": "3045", "transactiontype": "BUY",
                    "exchange": "NSE", "ordertype": "LIMIT", "producttype": "MARGIN", "duration": "DAY",
                    "price": "845.25", "quantity": "47", "ordertag": "MTF12"}
    assert route.calls.last.request.headers["Authorization"] == "Bearer jwt-1"


@respx.mock
def test_place_order_timeout_is_outcome_unknown(angel):
    login_route()
    respx.post(BASE + P["place"]).mock(side_effect=httpx.ReadTimeout("slow"))
    with pytest.raises(OrderOutcomeUnknown):
        angel.place_limit(OrderRequest(SBIN, "BUY", 1, 845.25, "MTF13"))


@respx.mock
def test_ab1021_pauses_calls_without_hitting_angel(angel):
    login_route()
    rms = respx.get(BASE + P["rms"]).mock(
        return_value=httpx.Response(200, json={"status": False, "errorcode": "AB1021", "message": "Too many requests"}))
    with pytest.raises(RateLimited):
        angel.funds()
    with pytest.raises(RateLimited):
        angel.funds()
    assert rms.call_count == 1


@respx.mock
def test_session_expiry_relogins_once_and_retries(angel):
    login = login_route()
    rms = respx.get(BASE + P["rms"]).mock(side_effect=[
        httpx.Response(200, json={"success": False, "errorCode": "AG8001", "message": "Invalid Token"}),
        ok({"net": "223890.55", "availablecash": "184250.40", "utiliseddebits": "39640.15"}),
    ])
    f = angel.funds()
    assert (f.available, f.used, f.net) == (184250.40, 39640.15, 223890.55)
    assert login.call_count == 2 and rms.call_count == 2


@respx.mock
def test_failed_login_backs_off(angel, clock):
    route = respx.post(BASE + P["login"]).mock(
        return_value=httpx.Response(200, json={"status": False, "errorcode": "AB1050", "message": "Invalid totp"}))
    with pytest.raises(BrokerError):
        angel.login()
    with pytest.raises(BrokerError, match="paused"):
        angel.login()
    assert route.call_count == 1
    clock.t += 61
    with pytest.raises(BrokerError):
        angel.login()
    assert route.call_count == 2


@respx.mock
def test_quotes_parse_ltp_and_circuits(angel):
    login_route()
    route = respx.post(BASE + P["quote"]).mock(return_value=ok({"fetched": [
        {"exchange": "NSE", "tradingSymbol": "SBIN-EQ", "symbolToken": "3045", "ltp": 568.2,
         "upperCircuit": 624.1, "lowerCircuit": 510.7}], "unfetched": []}))
    q = angel.quotes([SBIN])["3045"]
    assert (q.ltp, q.upper_circuit, q.lower_circuit) == (568.2, 624.1, 510.7)
    assert json.loads(route.calls.last.request.content) == {"mode": "FULL", "exchangeTokens": {"NSE": ["3045"]}}


@respx.mock
def test_margin_per_share_from_batch_api(angel):
    login_route()
    route = respx.post(BASE + P["margin"]).mock(return_value=ok({"totalMarginRequired": 2544.0, "marginComponents": {}}))
    m = angel.margin_per_share(SBIN, 845.25)  # probe qty = 10000 // 845.25 = 11
    assert m.per_share == round(2544.0 / 11, 2) and m.source == "broker"
    sent = json.loads(route.calls.last.request.content)["positions"][0]
    assert (sent["productType"], sent["qty"], sent["orderType"]) == ("MARGIN", 11, "LIMIT")


@respx.mock
def test_zero_margin_means_not_mtf_approved(angel):
    login_route()
    respx.post(BASE + P["margin"]).mock(return_value=ok({"totalMarginRequired": 0}))
    with pytest.raises(BrokerError, match="MTF"):
        angel.margin_per_share(SBIN, 845.25)


@respx.mock
def test_order_state_and_find_by_tag_from_book(angel):
    login_route()
    respx.get(BASE + P["book"]).mock(return_value=ok([
        {"orderid": "1", "ordertag": "MTF7", "orderstatus": "complete", "quantity": "47", "filledshares": "47",
         "averageprice": 842.7, "text": ""},
        {"orderid": "2", "ordertag": "MTF8", "orderstatus": "open", "quantity": "47", "filledshares": "20",
         "averageprice": 842.7, "text": ""},
        {"orderid": "3", "ordertag": "MTF9", "orderstatus": "rejected", "quantity": "5", "filledshares": "0",
         "averageprice": 0, "text": "Example rejection text from the broker"},
    ]))
    assert angel.order_state("1").status == "COMPLETE"
    assert angel.order_state("2").status == "PARTIAL"
    s3 = angel.find_by_tag("MTF9")
    assert s3.status == "REJECTED" and "Example rejection" in s3.message
    assert angel.find_by_tag("MTF404") is None


@pytest.mark.parametrize("raw,filled,qty,expected", [
    ("complete", 5, 5, "COMPLETE"), ("rejected", 0, 5, "REJECTED"), ("cancelled", 2, 5, "CANCELLED"),
    ("open", 0, 5, "OPEN"), ("open", 2, 5, "PARTIAL"), ("trigger pending", 0, 5, "OPEN"), ("", 0, 5, "OPEN"),
])
def test_map_status(raw, filled, qty, expected):
    assert map_status(raw, filled, qty) == expected


def test_missing_credentials_is_clear(clock):
    a = AngelBroker(lambda: None, IDENT, client=httpx.Client(), clock=clock, sleep=clock.sleep)
    with pytest.raises(BrokerError, match="not saved"):
        a.login()
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `.venv\Scripts\pytest tests/test_angel.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.brokers.angel'`

- [ ] **Step 3: Implement**

`app/brokers/angel.py`:
```python
"""Angel One SmartAPI over plain REST (spec section 9)."""
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import datetime

import httpx
import pyotp

from app.brokers.angel_http import LOGIN_BACKOFF, RATE_COOLDOWN, Backoff, RateGate, classify
from app.brokers.base import (BrokerError, Funds, Instrument, MarginInfo, OrderOutcomeUnknown, OrderRequest,
                              OrderState, Quote, RateLimited, SessionExpired)
from app.clock import IST, now_ist
from app.repo_broker import Credentials

BASE = "https://apiconnect.angelone.in"
P = {
    "login": "/rest/auth/angelbroking/user/v1/loginByPassword",
    "place": "/rest/secure/angelbroking/order/v1/placeOrder",
    "modify": "/rest/secure/angelbroking/order/v1/modifyOrder",
    "cancel": "/rest/secure/angelbroking/order/v1/cancelOrder",
    "book": "/rest/secure/angelbroking/order/v1/getOrderBook",
    "positions": "/rest/secure/angelbroking/order/v1/getPosition",
    "holdings": "/rest/secure/angelbroking/portfolio/v1/getAllHolding",
    "rms": "/rest/secure/angelbroking/user/v1/getRMS",
    "quote": "/rest/secure/angelbroking/market/v1/quote/",
    "margin": "/rest/secure/angelbroking/margin/v1/batch",
}
PRODUCT = "MARGIN"  # SmartAPI producttype for MTF ("Margin Delivery"); confirmed by the first live test (Task 18)
PRODUCT_LABEL = {"MARGIN": "MTF", "DELIVERY": "CNC", "INTRADAY": "MIS", "CARRYFORWARD": "NRML"}
BOOK_TTL = 1.5


@dataclass(frozen=True)
class ClientIdentity:
    local_ip: str
    public_ip: str
    mac: str


def map_status(raw: str, filled: int, qty: int) -> str:
    s = (raw or "").strip().lower()
    if s in ("complete", "rejected", "cancelled"):
        return s.upper()
    return "PARTIAL" if 0 < filled < qty else "OPEN"


def _num(value, default: float | None = 0.0) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _base_symbol(tradingsymbol: str | None) -> str:
    return str(tradingsymbol or "").removesuffix("-EQ")


class AngelBroker:
    name = "Angel One"

    def __init__(self, credentials: Callable[[], Credentials | None], identity: ClientIdentity,
                 client: httpx.Client | None = None, clock: Callable[[], float] = time.monotonic,
                 sleep: Callable[[float], None] = time.sleep,
                 totp: Callable[[str], str] = lambda secret: pyotp.TOTP(secret).now()):
        self._credentials, self._identity, self._totp = credentials, identity, totp
        self._http = client or httpx.Client(timeout=10.0)
        self._clock = clock
        self._jwt: str | None = None
        self._api_key = ""
        self.last_login_at: datetime | None = None
        self.last_error: str | None = None
        self._login_backoff = Backoff(LOGIN_BACKOFF, clock)
        self._rate_backoff = Backoff(RATE_COOLDOWN, clock)
        self._order_gate = RateGate(8.0, clock, sleep)  # exchange threshold is 10 orders/s
        self._data_gate = RateGate(1.0, clock, sleep)
        self._book_cache: tuple[float, list[dict]] = (float("-inf"), [])

    # ---- session ---------------------------------------------------------------------
    def connected(self) -> bool:
        return self._jwt is not None

    def login(self) -> None:
        wait = self._login_backoff.blocked()
        if wait:
            raise BrokerError(f"Angel login paused for {int(wait)} s after a failed attempt.")
        creds = self._credentials()
        if creds is None:
            raise BrokerError("Angel One credentials are not saved.")
        self._api_key = creds.api_key
        body = {"clientcode": creds.client_code, "password": creds.mpin, "totp": self._totp(creds.totp_secret)}
        try:
            data = self._send("POST", P["login"], body, auth=False)
        except BrokerError as err:
            self._login_backoff.fail()
            self._jwt, self.last_error = None, str(err)
            raise
        self._jwt, self.last_error, self.last_login_at = data["jwtToken"], None, now_ist()
        self._login_backoff.reset()

    def logout(self) -> None:
        self._jwt = None

    # ---- transport -------------------------------------------------------------------
    def _headers(self, auth: bool) -> dict:
        h = {"Content-Type": "application/json", "Accept": "application/json", "X-UserType": "USER",
             "X-SourceID": "WEB", "X-ClientLocalIP": self._identity.local_ip,
             "X-ClientPublicIP": self._identity.public_ip, "X-MACAddress": self._identity.mac,
             "X-PrivateKey": self._api_key}
        if auth:
            h["Authorization"] = f"Bearer {self._jwt}"
        return h

    def _send(self, method: str, path: str, body: dict | None = None, auth: bool = True,
              gate: RateGate | None = None, unknown_on_timeout: bool = False):
        wait = self._rate_backoff.blocked()
        if wait:
            raise RateLimited(f"Angel rate limit: calls paused for {int(wait)} s")
        (gate or self._data_gate).acquire()
        try:
            resp = self._http.request(method, BASE + path, json=body, headers=self._headers(auth))
        except (httpx.TimeoutException, httpx.NetworkError) as err:
            if unknown_on_timeout:
                raise OrderOutcomeUnknown(f"No reply from Angel One: {err}") from err
            raise BrokerError(f"Cannot reach Angel One: {err}") from err
        try:
            payload = resp.json()
        except ValueError:
            payload = resp.text
        try:
            return classify(resp.status_code, payload)
        except RateLimited:
            self._rate_backoff.fail()
            raise
        except SessionExpired:
            self._jwt = None
            raise

    def _call(self, method: str, path: str, body: dict | None = None, gate: RateGate | None = None,
              unknown_on_timeout: bool = False):
        if self._jwt is None:
            self.login()
        try:
            return self._send(method, path, body, gate=gate, unknown_on_timeout=unknown_on_timeout)
        except SessionExpired:
            self.login()  # AG800x is refused at auth, so the request did not execute: one retry is safe
            return self._send(method, path, body, gate=gate, unknown_on_timeout=unknown_on_timeout)

    # ---- market data -----------------------------------------------------------------
    def quotes(self, instruments: Sequence[Instrument]) -> dict[str, Quote]:
        out: dict[str, Quote] = {}
        for start in range(0, len(instruments), 50):
            tokens: dict[str, list[str]] = {}
            for inst in instruments[start:start + 50]:
                tokens.setdefault(inst.exchange, []).append(inst.token)
            data = self._call("POST", P["quote"], {"mode": "FULL", "exchangeTokens": tokens})
            for row in data.get("fetched", []):
                token = str(row["symbolToken"])
                out[token] = Quote(token, _num(row.get("ltp")), _num(row.get("upperCircuit"), None) or None,
                                   _num(row.get("lowerCircuit"), None) or None)
        return out

    def margin_per_share(self, instrument: Instrument, price: float) -> MarginInfo:
        probe = max(1, int(10000 // price))  # a multi-share probe keeps rounding error per share small
        position = {"exchange": instrument.exchange, "qty": probe, "price": price, "productType": PRODUCT,
                    "token": instrument.token, "tradeType": "BUY", "orderType": "LIMIT"}
        data = self._call("POST", P["margin"], {"positions": [position]})
        total = _num(data.get("totalMarginRequired"))
        if not total or total <= 0:
            raise BrokerError(f"Angel returned no MTF margin for {instrument.symbol}; it may not be MTF-approved.")
        return MarginInfo(round(total / probe, 2), "broker")

    def funds(self) -> Funds:
        d = self._call("GET", P["rms"])
        return Funds(_num(d.get("availablecash")), _num(d.get("utiliseddebits")), _num(d.get("net")))

    # ---- orders ----------------------------------------------------------------------
    @staticmethod
    def _order_fields(req: OrderRequest) -> dict:
        i = req.instrument
        return {"tradingsymbol": i.trading_symbol, "symboltoken": i.token, "exchange": i.exchange,
                "ordertype": "LIMIT", "producttype": PRODUCT, "duration": "DAY",
                "price": f"{req.limit_price:.2f}", "quantity": str(req.qty)}

    def place_limit(self, req: OrderRequest) -> str:
        body = {"variety": "NORMAL", "transactiontype": req.side, **self._order_fields(req), "ordertag": req.tag}
        data = self._call("POST", P["place"], body, gate=self._order_gate, unknown_on_timeout=True)
        self._book_cache = (float("-inf"), [])
        oid = str(data.get("orderid") or "")
        if not oid:
            raise BrokerError("Angel accepted the request but returned no order id.")
        return oid

    def modify_limit(self, broker_order_id: str, req: OrderRequest) -> None:
        body = {"variety": "NORMAL", "orderid": broker_order_id, **self._order_fields(req)}
        self._call("POST", P["modify"], body, gate=self._order_gate)
        self._book_cache = (float("-inf"), [])

    def cancel(self, broker_order_id: str) -> None:
        self._call("POST", P["cancel"], {"variety": "NORMAL", "orderid": broker_order_id}, gate=self._order_gate)
        self._book_cache = (float("-inf"), [])

    def _book(self) -> list[dict]:
        at, rows = self._book_cache
        if self._clock() - at < BOOK_TTL:
            return rows
        data = self._call("GET", P["book"])
        rows = data if isinstance(data, list) else []
        self._book_cache = (self._clock(), rows)
        return rows

    @staticmethod
    def _state(row: dict) -> OrderState:
        qty, filled = int(_num(row.get("quantity"))), int(_num(row.get("filledshares")))
        return OrderState(str(row["orderid"]), map_status(row.get("orderstatus") or row.get("status"), filled, qty),
                          filled, _num(row.get("averageprice")) or None, str(row.get("text") or ""))

    def order_state(self, broker_order_id: str) -> OrderState:
        row = next((r for r in self._book() if str(r.get("orderid")) == broker_order_id), None)
        if row is None:
            raise BrokerError(f"Order {broker_order_id} is not in today's Angel order book.")
        return self._state(row)

    def find_by_tag(self, tag: str) -> OrderState | None:
        self._book_cache = (float("-inf"), [])  # this decides whether an order exists: never use a stale book
        row = next((r for r in self._book() if r.get("ordertag") == tag), None)
        return self._state(row) if row else None

    # ---- account views ---------------------------------------------------------------
    def account_positions(self) -> list[dict]:
        rows = self._call("GET", P["positions"])
        out = [{"symbol": _base_symbol(p.get("tradingsymbol")), "exchange": p.get("exchange"),
                "qty": int(_num(p.get("netqty"))),
                "avg_price": _num(p.get("avgnetprice") or p.get("netprice") or p.get("buyavgprice")),
                "ltp": _num(p.get("ltp")), "product": PRODUCT_LABEL.get(p.get("producttype"), p.get("producttype")),
                "note": "Open position (today)"}
               for p in (rows if isinstance(rows, list) else []) if int(_num(p.get("netqty"))) != 0]
        hold = self._call("GET", P["holdings"])
        for h in (hold.get("holdings") or []) if isinstance(hold, dict) else []:
            out.append({"symbol": _base_symbol(h.get("tradingsymbol")), "exchange": h.get("exchange"),
                        "qty": int(_num(h.get("quantity"))), "avg_price": _num(h.get("averageprice")),
                        "ltp": _num(h.get("ltp")), "product": PRODUCT_LABEL.get(h.get("product"), h.get("product")),
                        "note": "Holding"})
        return out

    def account_orders(self) -> list[dict]:
        out = []
        for r in self._book():
            state = self._state(r)
            stamp = r.get("updatetime") or ""
            try:
                created = datetime.strptime(stamp, "%d-%b-%Y %H:%M:%S").replace(tzinfo=IST).isoformat()
            except ValueError:
                created = None
            out.append({"id": state.broker_order_id, "created_at": created, "broker_order_id": state.broker_order_id,
                        "symbol": _base_symbol(r.get("tradingsymbol")), "side": r.get("transactiontype"),
                        "product": PRODUCT_LABEL.get(r.get("producttype"), r.get("producttype")),
                        "order_type": r.get("ordertype"), "qty": int(_num(r.get("quantity"))),
                        "limit_price": _num(r.get("price")), "filled_qty": state.filled_qty,
                        "avg_price": state.avg_price, "status": state.status, "reason": state.message,
                        "reprice_count": 0})
        return out
```
Note on unverified live shapes: `getPosition` field names (`netqty`, `avgnetprice`) and `getAllHolding.holdings[].product` come from the SmartAPI docs, not from a live account. Task 18's live checklist compares the Broker tab with the Angel app.

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv\Scripts\pytest tests/test_angel.py -v`
Expected: 18 passed

- [ ] **Step 5: Commit**

```bash
git add app/brokers/angel.py tests/test_angel.py
git commit -m "feat: Angel One REST broker with TOTP login, LIMIT MARGIN orders and safe retries"
```

---

### Task 14: Services (live prices, broker reconcile, Excel export)

**Files:**
- Create: `app/services/__init__.py`, `app/services/ltp.py`, `app/services/reconcile.py`, `app/services/export.py`
- Test: `tests/test_services.py`

**Interfaces:**
- Consumes: `open_positions` (Task 10), `AppContext` fields `prices/broker_positions/mismatch` (Task 4), `is_market_open` (Task 1), `BrokerError` (Task 6).
- Produces:
  - `LtpPoller(ctx, clock=now_ist)`: `async tick() -> dict[str, float]` (symbols whose LTP changed; also written to `ctx.prices` and published as SSE `tick`), `async run()` (3 s in market hours, 60 s otherwise).
  - `Reconciler(ctx)`: `async tick()` sets `ctx.broker_positions` (Angel account view), `ctx.funds` (RMS, cached), and, in LIVE mode, `ctx.mismatch` = tracked symbols where Angel holds fewer shares (any product) than MTF Trader bought; `async run()` every 60 s.
  - `build_xlsx(kind: "alerts"|"orders"|"trades", rows: list[dict]) -> bytes` (same columns as `web/assets/js/mock/csv.js`; formula guard; ISO times shown as `dd-mm-yyyy hh:mm:ss`).

- [ ] **Step 1: Write the failing tests**

`tests/test_services.py`:
```python
import io
from types import SimpleNamespace

from openpyxl import load_workbook

from app.brokers.base import Funds, Quote
from app.db import session_scope
from app.models import Position
from app.repo_settings import set_mode
from app.services.export import build_xlsx
from app.services.ltp import LtpPoller
from app.services.reconcile import Reconciler
from tests.factory import MARKET, make_world, seed_position


async def test_ltp_poller_publishes_only_changes(tmp_path):
    w = make_world(tmp_path)
    seed_position(w.ctx)
    q = w.ctx.bus.subscribe()
    poller = LtpPoller(w.ctx, clock=lambda: MARKET)
    assert await poller.tick() == {"SBIN": 842.70}
    assert w.ctx.prices["SBIN"] == 842.70 and q.get_nowait() == ("tick", {"SBIN": 842.70})
    assert await poller.tick() == {}
    w.prices["3045"] = Quote("3045", 845.10)
    assert await poller.tick() == {"SBIN": 845.10}


async def test_reconciler_flags_live_position_sold_outside(tmp_path):
    w = make_world(tmp_path)
    with session_scope(w.ctx.db) as s:
        set_mode(s, "LIVE")
    pid = seed_position(w.ctx, qty=47)
    with session_scope(w.ctx.db) as s:
        s.get(Position, pid).mode = "LIVE"
    rows = [{"symbol": "SBIN", "exchange": "NSE", "qty": 20, "avg_price": 842.7, "ltp": 845.0, "product": "MTF", "note": "Holding"}]
    funds = Funds(184250.40, 39640.15, 223890.55)
    w.ctx.hub.angel = SimpleNamespace(name="Angel One", connected=lambda: True, account_positions=lambda: rows,
                                      funds=lambda: funds)
    await Reconciler(w.ctx).tick()
    assert w.ctx.broker_positions == rows and w.ctx.mismatch == {"SBIN"} and w.ctx.funds == funds
    rows[0]["qty"] = 47
    await Reconciler(w.ctx).tick()
    assert w.ctx.mismatch == set()


async def test_reconciler_clears_when_angel_disconnected(tmp_path):
    w = make_world(tmp_path)
    w.ctx.mismatch = {"SBIN"}
    await Reconciler(w.ctx).tick()
    assert w.ctx.broker_positions == [] and w.ctx.mismatch == set()


def test_xlsx_guards_formulas_and_keeps_numbers():
    rows = [{"received_at": "2026-09-18T11:00:05+05:30", "symbol": "=HYPERLINK(\"http://x\")", "exchange": "NSE",
             "action": "BUY", "status": "REJECTED", "action_taken": "No order", "detail": "-5 lots", "order_id": 7}]
    ws = load_workbook(io.BytesIO(build_xlsx("alerts", rows))).active
    header = [c.value for c in ws[1]]
    assert header[:3] == ["Time", "Stock", "Exchange"]
    assert ws["B2"].value == "'=HYPERLINK(\"http://x\")" and ws["B2"].data_type == "s"
    assert ws["G2"].value == "'-5 lots"
    assert ws["A2"].value == "18-09-2026 11:00:05"
    assert ws["H2"].value == 7
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `.venv\Scripts\pytest tests/test_services.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.services'`

- [ ] **Step 3: Implement**

`app/services/__init__.py`: empty file.

`app/services/ltp.py`:
```python
"""Live prices for open positions -> ctx.prices + SSE 'tick' (the dashboard patches cells in place)."""
import asyncio
import logging
from collections.abc import Callable
from datetime import datetime

from app.brokers.base import BrokerError
from app.brokers.instruments import UnknownSymbol
from app.clock import is_market_open, now_ist
from app.context import AppContext
from app.db import session_scope
from app.engine.ledger import open_positions
from app.repo_settings import load_settings

log = logging.getLogger("mtf.ltp")


class LtpPoller:
    def __init__(self, ctx: AppContext, clock: Callable[[], datetime] = now_ist):
        self.ctx, self.clock = ctx, clock

    async def tick(self) -> dict[str, float]:
        with session_scope(self.ctx.db) as s:
            mode = load_settings(s).mode
            held = [(p.symbol, p.exchange) for p in open_positions(s, mode)]
        try:
            insts = [self.ctx.instruments.resolve(sym, exch) for sym, exch in held]
            quotes = await asyncio.to_thread(self.ctx.hub.for_mode(mode).quotes, insts) if insts else {}
        except (BrokerError, UnknownSymbol) as err:
            log.warning("price refresh skipped: %s", err)
            return {}
        moved = {i.symbol: quotes[i.token].ltp for i in insts
                 if i.token in quotes and self.ctx.prices.get(i.symbol) != quotes[i.token].ltp}
        self.ctx.prices.update(moved)
        if moved:
            self.ctx.bus.publish("tick", moved)
        return moved

    async def run(self) -> None:
        while True:
            try:
                await self.tick()
            except Exception:  # noqa: BLE001 - prices are display-only; never stop the loop
                log.exception("ltp tick failed")
            await asyncio.sleep(3 if is_market_open(self.clock()) else 60)
```

`app/services/reconcile.py`:
```python
"""Angel account view + LIVE mismatch flag (Angel holds fewer shares than MTF Trader bought)."""
import asyncio
import logging
from collections import defaultdict

from app.brokers.base import BrokerError
from app.context import AppContext
from app.db import session_scope
from app.engine.ledger import open_positions
from app.repo_settings import load_settings

log = logging.getLogger("mtf.reconcile")


class Reconciler:
    def __init__(self, ctx: AppContext):
        self.ctx = ctx

    async def tick(self) -> None:
        angel = self.ctx.hub.angel
        if angel is None or not angel.connected():
            self.ctx.broker_positions, self.ctx.mismatch, self.ctx.funds = [], set(), None
            return
        try:
            rows = await asyncio.to_thread(angel.account_positions)
            self.ctx.funds = await asyncio.to_thread(angel.funds)  # cached: the dashboard must not call RMS per reload
        except BrokerError as err:
            log.warning("reconcile skipped: %s", err)
            return
        self.ctx.broker_positions = rows
        with session_scope(self.ctx.db) as s:
            if load_settings(s).mode != "LIVE":
                self.ctx.mismatch = set()
                return
            tracked = {p.symbol: p.qty for p in open_positions(s, "LIVE")}
        held: dict[str, int] = defaultdict(int)
        for r in rows:  # any product: a next-day MTF holding may be labelled differently by Angel
            held[r["symbol"]] += r["qty"]
        self.ctx.mismatch = {sym for sym, qty in tracked.items() if held.get(sym, 0) < qty}

    async def run(self) -> None:
        while True:
            try:
                await self.tick()
            except Exception:  # noqa: BLE001 - a view refresh must never stop
                log.exception("reconcile tick failed")
            await asyncio.sleep(60)
```

`app/services/export.py`:
```python
"""Excel export. Webhook-supplied text can start with '=', so every such cell is neutralised."""
import io
import re
from datetime import datetime

from openpyxl import Workbook
from openpyxl.styles import Font

from app.clock import IST

COLUMNS = {
    "alerts": [("received_at", "Time"), ("symbol", "Stock"), ("exchange", "Exchange"), ("action", "Type"),
               ("status", "Status"), ("action_taken", "Action"), ("detail", "Details"), ("order_id", "Order")],
    "orders": [("created_at", "Time"), ("broker_order_id", "Order ID"), ("symbol", "Stock"), ("side", "Side"),
               ("product", "Product"), ("order_type", "Type"), ("qty", "Qty"), ("limit_price", "Limit price"),
               ("filled_qty", "Filled"), ("avg_price", "Avg fill"), ("status", "Status"), ("reason", "Reason")],
    "trades": [("opened_at", "Opened"), ("closed_at", "Closed"), ("symbol", "Stock"), ("qty", "Qty"),
               ("entry_price", "Buy price"), ("exit_price", "Sell price"), ("deployed", "Deployed"),
               ("pnl", "P&L"), ("pnl_pct", "P&L %")],
}
NUMBER = re.compile(r"^-?\d+(\.\d+)?$")


def _cell(key: str, value):
    if value is None:
        return ""
    if key.endswith("_at") and isinstance(value, str):
        try:
            return datetime.fromisoformat(value).astimezone(IST).strftime("%d-%m-%Y %H:%M:%S")
        except ValueError:
            pass
    if isinstance(value, str) and value[:1] in ("=", "+", "-", "@", "\t", "\r") and not NUMBER.match(value):
        return "'" + value
    return value


def build_xlsx(kind: str, rows: list[dict]) -> bytes:
    cols = COLUMNS[kind]
    wb = Workbook()
    ws = wb.active
    ws.title = kind.title()
    ws.append([label for _, label in cols])
    for cell in ws[1]:
        cell.font = Font(bold=True)
    for r in rows:
        ws.append([_cell(key, r.get(key)) for key, _ in cols])
    ws.freeze_panes = "A2"
    for i, (_, label) in enumerate(cols, start=1):
        ws.column_dimensions[ws.cell(1, i).column_letter].width = max(12, len(label) + 4)
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv\Scripts\pytest tests/test_services.py -v`
Expected: 4 passed

- [ ] **Step 5: Commit**

```bash
git add app/services tests/test_services.py
git commit -m "feat: live price poller, broker reconcile with mismatch flag, guarded Excel export"
```

---

### Task 15: Dashboard app and ledger API (read side, export, SSE)

**Files:**
- Create: `app/api/__init__.py`, `app/api/app.py`, `app/api/serialize.py`, `app/api/queries.py`, `app/api/sse.py`, `app/api/routes_ledger.py`
- Test: `tests/test_api_ledger.py`

**Interfaces:**
- Consumes: everything above; `build_xlsx` (Task 14); `broker_view` (Task 3).
- Produces:
  - `create_dashboard_app(ctx, web_dir=WEB_DIR) -> FastAPI` (envelope, error handlers, CSP headers, `GET /assets/js/config.js` with `mode: 'live'`, static `web/`). Task 16 adds `control_router`.
  - `ApiError(status, code, message, fields=None)`, `ok(data) -> JSONResponse`.
  - `build_status(ctx) -> dict` (shape = spec section 8 `/api/status`; reused by Task 16).
  - Routes: `GET /api/status`, `/api/dashboard`, `/api/positions`, `/api/alerts`, `/api/alerts/{id}`, `/api/orders`, `/api/trades`, `/api/logs`, `/api/export/{kind}.xlsx`, `/api/events`.
  - `sse_stream(bus, is_disconnected, heartbeat=15.0)` async generator of SSE text frames.

- [ ] **Step 1: Write the failing tests**

`tests/test_api_ledger.py`:
```python
import asyncio
import io
from datetime import timedelta

import pytest
from fastapi.testclient import TestClient
from openpyxl import load_workbook

from app.api.app import create_dashboard_app
from app.api.sse import sse_stream
from app.db import session_scope
from app.models import Trade
from tests.factory import MARKET, add_alert, make_world, seed_position


@pytest.fixture
def w(tmp_path):
    world = make_world(tmp_path)
    world.client = TestClient(create_dashboard_app(world.ctx))
    return world


def data(resp):
    body = resp.json()
    assert body["ok"] is True, body
    return body["data"]


def test_live_config_and_security_headers(w):
    r = w.client.get("/assets/js/config.js")
    assert "mode: 'live'" in r.text and r.headers["content-type"].startswith("text/javascript")
    assert "default-src 'self'" in r.headers["content-security-policy"]
    assert w.client.get("/").status_code == 200  # web/index.html


def test_status_shape(w):
    st = data(w.client.get("/api/status"))
    assert set(st) >= {"automation", "mode", "market", "broker", "webhook", "engine", "exit_pending", "version"}
    assert st["mode"] == "PAPER" and st["broker"]["connected"] is False and st["webhook"]["tunnel_up"] is False


def test_positions_use_live_price_and_mismatch(w):
    seed_position(w.ctx, qty=47, avg=842.70)
    w.ctx.prices["SBIN"] = 850.00
    w.ctx.mismatch = {"SBIN"}
    [p] = data(w.client.get("/api/positions", params={"source": "tracked"}))["items"]
    assert p["ltp"] == 850.00 and p["pnl"] == round(47 * 7.30, 2) and p["mismatch"] is True
    assert p["deployed"] == 9931.57


def test_broker_positions_view(w):
    w.ctx.broker_positions = [{"symbol": "ITC", "exchange": "NSE", "qty": 10, "avg_price": 400.0, "ltp": 410.0,
                               "product": "CNC", "note": "Holding"}]
    [p] = data(w.client.get("/api/positions", params={"source": "broker"}))["items"]
    assert (p["product"], p["deployed"], p["pnl"]) == ("CNC", None, 100.0)


def test_dashboard_kpis(w):
    seed_position(w.ctx)
    with session_scope(w.ctx.db) as s:
        s.add(Trade(mode="PAPER", position_id=9, symbol="INFY", qty=6, entry_price=1498.2, exit_price=1519.6,
                    deployed_amount=2247.3, realised_pnl=128.4, pnl_pct=1.43, opened_at=MARKET,
                    closed_at=MARKET + timedelta(hours=1), exit_order_id=1))
    k = data(w.client.get("/api/dashboard"))["kpis"]
    assert k["open_positions"] == 1 and k["capital_deployed"] == 9931.57
    assert k["capital_cap"] == 100000 and k["max_positions"] == 5


def test_alert_filters_counts_and_detail(w):
    add_alert(w.ctx, symbol="SBIN", action="BUY")
    sell = add_alert(w.ctx, symbol="SBIN", action="SELL")
    d = data(w.client.get("/api/alerts", params={"action": "SELL"}))
    assert [a["id"] for a in d["items"]] == [sell] and d["counts"] == {"all": 2, "BUY": 1, "SELL": 1}
    detail = data(w.client.get(f"/api/alerts/{sell}"))
    assert detail["checks"] and detail["order"] is None
    missing = w.client.get("/api/alerts/999")
    assert missing.status_code == 404 and missing.json()["error"]["code"] == "not_found"


def test_bad_date_is_422_envelope(w):
    r = w.client.get("/api/alerts", params={"date_from": "18/09/2026"})
    assert r.status_code == 422 and r.json()["ok"] is False


def test_export_xlsx(w):
    add_alert(w.ctx, symbol="SBIN")
    r = w.client.get("/api/export/alerts.xlsx")
    assert r.headers["content-type"].startswith("application/vnd.openxmlformats")
    assert load_workbook(io.BytesIO(r.content)).active["B2"].value == "SBIN"
    assert w.client.get("/api/export/secrets.xlsx").status_code == 404


async def test_sse_stream_frames(w):
    frames = sse_stream(w.ctx.bus, is_disconnected=lambda: asyncio.sleep(0, result=False), heartbeat=0.05)
    assert (await anext(frames)).startswith("retry:")
    w.ctx.bus.publish("tick", {"SBIN": 850.0})
    assert await anext(frames) == 'event: tick\ndata: {"SBIN": 850.0}\n\n'
    assert (await anext(frames)).startswith(": keep-alive")
    await frames.aclose()
    assert w.ctx.bus._subscribers == set()  # noqa: SLF001 - proves unsubscribe on close
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `.venv\Scripts\pytest tests/test_api_ledger.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.api'`

- [ ] **Step 3: Implement serializers, queries and SSE**

`app/api/__init__.py`: empty file.

`app/api/serialize.py`:
```python
"""ORM rows -> the JSON shapes of spec section 8 (the frontend reads exactly these keys)."""
from app.models import Alert, EventRow, Order, Position, Trade


def _r2(x: float) -> float:
    return round(x, 2)


def alert_dict(a: Alert) -> dict:
    return {"id": a.id, "received_at": a.received_at, "source_ip": a.source_ip, "symbol": a.symbol,
            "exchange": a.exchange, "action": a.action, "alert_price": a.alert_price, "status": a.status,
            "action_taken": a.action_taken, "detail": a.detail, "order_id": a.order_id, "checks": a.checks,
            "raw_payload": a.raw_payload, "is_test": a.is_test}


def order_dict(o: Order) -> dict:
    return {"id": o.id, "created_at": o.created_at, "broker_order_id": o.broker_order_id or "-", "symbol": o.symbol,
            "side": o.side, "product": o.product, "order_type": o.order_type, "qty": o.qty,
            "limit_price": o.limit_price, "filled_qty": o.filled_qty, "avg_price": o.avg_price, "status": o.status,
            "reason": o.reason, "reprice_count": o.reprice_count, "alert_id": o.alert_id}


def position_dict(p: Position, ltp: float | None, mismatch: bool) -> dict:
    px = ltp if ltp else p.avg_price
    return {"id": p.id, "symbol": p.symbol, "exchange": p.exchange, "qty": p.qty, "avg_price": p.avg_price,
            "ltp": px, "deployed": p.deployed_amount, "value": _r2(p.qty * px), "pnl": _r2(p.qty * (px - p.avg_price)),
            "pnl_pct": _r2((px - p.avg_price) / p.avg_price * 100), "opened_at": p.opened_at,
            "status": p.status, "mismatch": mismatch}


def broker_row_dict(i: int, r: dict) -> dict:
    ltp, avg, qty = r.get("ltp") or r["avg_price"], r["avg_price"], r["qty"]
    return {"id": f"B{i}", "symbol": r["symbol"], "exchange": r["exchange"], "qty": qty, "avg_price": avg,
            "ltp": ltp, "deployed": None, "value": _r2(qty * ltp), "pnl": _r2(qty * (ltp - avg)),
            "pnl_pct": _r2((ltp - avg) / avg * 100) if avg else 0.0, "opened_at": None, "status": "OPEN",
            "mismatch": False, "product": r.get("product"), "note": r.get("note")}


def trade_dict(t: Trade) -> dict:
    return {"id": t.id, "symbol": t.symbol, "qty": t.qty, "entry_price": t.entry_price, "exit_price": t.exit_price,
            "deployed": t.deployed_amount, "pnl": t.realised_pnl, "pnl_pct": t.pnl_pct,
            "opened_at": t.opened_at, "closed_at": t.closed_at}


def event_dict(e: EventRow) -> dict:
    return {"id": e.id, "ts": e.ts, "level": e.level, "category": e.category, "message": e.message, "data": e.data}
```

`app/api/queries.py`:
```python
"""Filtered list queries shared by the JSON routes and the Excel export."""
from datetime import date, datetime, time, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.clock import IST
from app.models import Alert, EventRow, Order, Trade

LIMIT = 500


def day_bounds(date_from: str, date_to: str) -> tuple[datetime | None, datetime | None]:
    start = datetime.combine(date.fromisoformat(date_from), time(0), IST) if date_from else None
    end = datetime.combine(date.fromisoformat(date_to), time(0), IST) + timedelta(days=1) if date_to else None
    return start, end


def _ranged(q, column, start, end):
    if start:
        q = q.where(column >= start)
    if end:
        q = q.where(column < end)
    return q


def list_alerts(s: Session, action="", status="", date_from="", date_to="", q="") -> tuple[list[Alert], dict]:
    start, end = day_bounds(date_from, date_to)
    base = list(s.scalars(_ranged(select(Alert), Alert.received_at, start, end).order_by(Alert.id.desc()).limit(LIMIT)))
    counts = {"all": len(base), "BUY": sum(a.action == "BUY" for a in base), "SELL": sum(a.action == "SELL" for a in base)}
    rows = [a for a in base if (not action or a.action == action) and (not status or a.status == status)
            and (not q or q.upper() in a.symbol)]
    return rows, counts


def list_orders(s: Session, mode: str, status="") -> list[Order]:
    query = select(Order).where(Order.mode == mode).order_by(Order.id.desc()).limit(LIMIT)
    if status:
        query = query.where(Order.status == status)
    return list(s.scalars(query))


def list_trades(s: Session, mode: str, date_from="", date_to="") -> list[Trade]:
    start, end = day_bounds(date_from, date_to)
    query = _ranged(select(Trade).where(Trade.mode == mode), Trade.closed_at, start, end)
    return list(s.scalars(query.order_by(Trade.closed_at.desc()).limit(LIMIT)))


def list_events(s: Session, level="", category="", q="") -> list[EventRow]:
    query = select(EventRow).order_by(EventRow.id.desc()).limit(LIMIT)
    if level:
        query = query.where(EventRow.level == level)
    if category:
        query = query.where(EventRow.category == category)
    rows = list(s.scalars(query))
    return [e for e in rows if not q or q.lower() in e.message.lower()]
```

`app/api/sse.py`:
```python
"""Server-Sent Events: one bus subscription per open dashboard tab."""
import asyncio
import json
from collections.abc import AsyncIterator, Awaitable, Callable

from fastapi.encoders import jsonable_encoder

from app.events import EventBus


async def sse_stream(bus: EventBus, is_disconnected: Callable[[], Awaitable[bool]],
                     heartbeat: float = 15.0) -> AsyncIterator[str]:
    q = bus.subscribe()
    try:
        yield "retry: 3000\n\n"
        while not await is_disconnected():
            try:
                kind, payload = await asyncio.wait_for(q.get(), timeout=heartbeat)
            except asyncio.TimeoutError:
                yield ": keep-alive\n\n"
                continue
            yield f"event: {kind}\ndata: {json.dumps(jsonable_encoder(payload))}\n\n"
    finally:
        bus.unsubscribe(q)
```

- [ ] **Step 4: Implement the app factory and ledger routes**

`app/api/app.py`:
```python
"""Port 8000, bound to 127.0.0.1 only: /api/*, SSE, live config.js and the static web/ frontend."""
import logging
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from app.context import AppContext
from app.repo_settings import SettingsError

WEB_DIR = Path(__file__).resolve().parents[2] / "web"
CSP = ("default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; "
       "frame-ancestors 'none'; base-uri 'self'; form-action 'self'")
log = logging.getLogger("mtf.api")


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str, fields: dict | None = None):
        super().__init__(message)
        self.status, self.code, self.message, self.fields = status, code, message, fields


def ok(data) -> JSONResponse:
    return JSONResponse({"ok": True, "data": jsonable_encoder(data), "error": None})


def error(status: int, code: str, message: str, fields: dict | None = None) -> JSONResponse:
    err = {"code": code, "message": message, **({"fields": fields} if fields else {})}
    return JSONResponse({"ok": False, "data": None, "error": err}, status_code=status)


def create_dashboard_app(ctx: AppContext, web_dir: Path = WEB_DIR) -> FastAPI:
    from app.api.routes_ledger import ledger_router  # local import: routes import this module

    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)

    @app.exception_handler(ApiError)
    async def _api_error(_: Request, exc: ApiError):
        return error(exc.status, exc.code, exc.message, exc.fields)

    @app.exception_handler(SettingsError)
    async def _settings_error(_: Request, exc: SettingsError):
        return error(422, "validation", str(exc), exc.fields)

    @app.exception_handler(RequestValidationError)
    async def _validation(_: Request, exc: RequestValidationError):
        first = exc.errors()[0] if exc.errors() else {"msg": "Invalid request"}
        return error(422, "validation", str(first.get("msg")))

    @app.exception_handler(ValueError)
    async def _value(_: Request, exc: ValueError):
        return error(422, "validation", str(exc))

    @app.exception_handler(Exception)
    async def _crash(_: Request, exc: Exception):
        log.exception("unhandled API error")
        return error(500, "internal", "Something went wrong. Details are in the Logs page and data/logs.")

    @app.middleware("http")
    async def _security_headers(request: Request, call_next):
        resp = await call_next(request)
        resp.headers["Content-Security-Policy"] = CSP
        resp.headers["X-Content-Type-Options"] = "nosniff"
        resp.headers["X-Frame-Options"] = "DENY"
        resp.headers["Referrer-Policy"] = "no-referrer"
        return resp

    @app.get("/assets/js/config.js")
    def live_config() -> Response:
        body = f"export const CONFIG = Object.freeze({{ mode: 'live', version: '{ctx.config.version}' }});\n"
        return Response(body, media_type="text/javascript", headers={"Cache-Control": "no-store"})

    app.include_router(ledger_router(ctx))
    app.mount("/", StaticFiles(directory=web_dir, html=True), name="web")
    return app
```

`app/api/routes_ledger.py`:
```python
"""Read side of the dashboard API + export + SSE (spec section 8)."""
import asyncio

from fastapi import APIRouter, Request
from fastapi.responses import Response, StreamingResponse
from sqlalchemy import select

from app.api.app import ApiError, ok
from app.api.queries import list_alerts, list_events, list_orders, list_trades
from app.api.serialize import (alert_dict, broker_row_dict, event_dict, order_dict, position_dict, trade_dict)
from app.api.sse import sse_stream
from app.clock import is_market_open, market_label, now_ist
from app.context import AppContext
from app.db import session_scope
from app.engine.ledger import open_positions, working_orders
from app.models import Alert, Order
from app.repo_broker import broker_view
from app.repo_settings import load_settings
from app.services.export import COLUMNS, build_xlsx

XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


def webhook_url(ctx: AppContext) -> str:
    return f"{ctx.tunnel_url}/webhook" if ctx.tunnel_url else "Tunnel not running (start.bat starts it)"


def angel_connected(ctx: AppContext) -> bool:
    return bool(ctx.hub and ctx.hub.angel and ctx.hub.angel.connected())


def build_status(ctx: AppContext) -> dict:
    now = now_ist()
    with session_scope(ctx.db) as s:
        st = load_settings(s)
        working = working_orders(s)
        last = s.scalars(select(Alert.received_at).order_by(Alert.id.desc()).limit(1)).first()
        view = broker_view(s)
    return {
        "automation": {"on": st.automation_on}, "mode": st.mode,
        "market": {"open": is_market_open(now), "label": market_label(now)},
        "broker": {"name": "Angel One", "connected": angel_connected(ctx),
                   "client_code_masked": view["client_code_masked"], "session_valid_till": view["session_valid_till"]},
        "webhook": {"public_url": webhook_url(ctx), "tunnel_up": ctx.tunnel_url is not None, "last_alert_at": last},
        "engine": {"queue_depth": ctx.alert_queue.qsize(), "working_orders": len(working)},
        "exit_pending": sorted({o.symbol for o in working if o.exit_pending_flagged}),
        "server_time": now, "version": ctx.config.version,
    }


def _positions(ctx: AppContext, s, mode: str) -> list[dict]:
    return [position_dict(p, ctx.prices.get(p.symbol), p.symbol in ctx.mismatch) for p in open_positions(s, mode)]


def _dashboard(ctx: AppContext) -> dict:
    today = now_ist().date().isoformat()
    with session_scope(ctx.db) as s:
        st = load_settings(s)
        positions = _positions(ctx, s, st.mode)
        closed = list_trades(s, st.mode, today, today)
        alerts, _ = list_alerts(s)
    funds = ctx.funds if angel_connected(ctx) else None
    return {
        "kpis": {"capital_deployed": round(sum(p["deployed"] for p in positions), 2), "capital_cap": st.capital_cap,
                 "open_positions": len(positions), "max_positions": st.max_open_positions,
                 "realised_pnl_today": round(sum(t.realised_pnl for t in closed), 2),
                 "unrealised_pnl": round(sum(p["pnl"] for p in positions), 2),
                 "available_margin": funds.available if funds else None, "margin_source": "Angel One RMS"},
        "positions": positions, "recent_alerts": [alert_dict(a) for a in alerts[:8]],
        "pipeline": {"last_alert_at": alerts[0].received_at if alerts else None, "webhook_up": ctx.tunnel_url is not None,
                     "amount_per_trade": st.amount_per_trade, "sizing_mode": st.sizing_mode, "broker": "Angel One",
                     "broker_connected": angel_connected(ctx), "mode": st.mode, "trades_today": len(closed)},
    }


def _export_rows(ctx: AppContext, kind: str, p: dict) -> list[dict]:
    with session_scope(ctx.db) as s:
        mode = load_settings(s).mode
        if kind == "alerts":
            return [alert_dict(a) for a in list_alerts(s, p.get("action", ""), p.get("status", ""),
                                                       p.get("date_from", ""), p.get("date_to", ""), p.get("q", ""))[0]]
        if kind == "orders":
            return [order_dict(o) for o in list_orders(s, mode, p.get("status", ""))]
        return [trade_dict(t) for t in list_trades(s, mode, p.get("date_from", ""), p.get("date_to", ""))]


def ledger_router(ctx: AppContext) -> APIRouter:
    r = APIRouter(prefix="/api")

    @r.get("/status")
    def status():
        return ok(build_status(ctx))

    @r.get("/dashboard")
    def dashboard():
        return ok(_dashboard(ctx))

    @r.get("/positions")
    def positions(source: str = "tracked"):
        if source == "broker":
            items = [broker_row_dict(i, row) for i, row in enumerate(ctx.broker_positions)]
            return ok({"items": items, "totals": {"deployed": None, "unrealised": round(sum(i["pnl"] for i in items), 2),
                                                  "realised_today": None}})
        today = now_ist().date().isoformat()
        with session_scope(ctx.db) as s:
            mode = load_settings(s).mode
            items = _positions(ctx, s, mode)
            realised = sum(t.realised_pnl for t in list_trades(s, mode, today, today))
        return ok({"items": items, "totals": {"deployed": round(sum(i["deployed"] for i in items), 2),
                                              "unrealised": round(sum(i["pnl"] for i in items), 2),
                                              "realised_today": round(realised, 2)}})

    @r.get("/alerts")
    def alerts(action: str = "", status: str = "", date_from: str = "", date_to: str = "", q: str = ""):
        with session_scope(ctx.db) as s:
            rows, counts = list_alerts(s, action, status, date_from, date_to, q)
            return ok({"items": [alert_dict(a) for a in rows], "counts": counts})

    @r.get("/alerts/{alert_id}")
    def alert(alert_id: int):
        with session_scope(ctx.db) as s:
            a = s.get(Alert, alert_id)
            if a is None:
                raise ApiError(404, "not_found", f"Alert {alert_id} not found")
            order = s.get(Order, a.order_id) if a.order_id else None
            return ok({**alert_dict(a), "order": order_dict(order) if order else None})

    @r.get("/orders")
    async def orders(source: str = "software", status: str = ""):
        if source == "broker":
            angel = ctx.hub.angel if angel_connected(ctx) else None
            rows = await asyncio.to_thread(angel.account_orders) if angel else []
            return ok({"items": [o for o in rows if not status or o["status"] == status]})
        with session_scope(ctx.db) as s:
            return ok({"items": [order_dict(o) for o in list_orders(s, load_settings(s).mode, status)]})

    @r.get("/trades")
    def trades(date_from: str = "", date_to: str = ""):
        with session_scope(ctx.db) as s:
            rows = list_trades(s, load_settings(s).mode, date_from, date_to)
            items = [trade_dict(t) for t in rows]
        return ok({"items": items, "totals": {"count": len(items), "net_pnl": round(sum(i["pnl"] for i in items), 2),
                                              "deployed": round(sum(i["deployed"] for i in items), 2)}})

    @r.get("/logs")
    def logs(level: str = "", category: str = "", q: str = ""):
        with session_scope(ctx.db) as s:
            return ok({"items": [event_dict(e) for e in list_events(s, level, category, q)]})

    @r.get("/export/{kind}.xlsx")
    def export(kind: str, request: Request):
        if kind not in COLUMNS:
            raise ApiError(404, "not_found", "Unknown export")
        body = build_xlsx(kind, _export_rows(ctx, kind, dict(request.query_params)))
        name = f"mtf-{kind}-{now_ist():%Y-%m-%d}.xlsx"
        return Response(body, media_type=XLSX, headers={"Content-Disposition": f'attachment; filename="{name}"'})

    @r.get("/events")
    async def events(request: Request):
        return StreamingResponse(sse_stream(ctx.bus, request.is_disconnected), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})

    return r
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `.venv\Scripts\pytest tests/test_api_ledger.py -v`
Expected: 9 passed

- [ ] **Step 6: Commit**

```bash
git add app/api tests/test_api_ledger.py
git commit -m "feat: dashboard app with ledger API, Excel export, SSE and security headers"
```

---

### Task 16: Control API (settings, kill switch, mode, broker, webhook, test alert) and network info

**Files:**
- Create: `app/api/routes_control.py`, `app/netinfo.py`
- Modify: `app/api/app.py` (include `control_router`)
- Test: `tests/test_api_control.py`, `tests/test_netinfo.py`

**Interfaces:**
- Consumes: `build_status, angel_connected, webhook_url` (Task 15), `cancel_all_working` (Task 11), `update_settings/set_mode/set_automation` (Task 2), `validate_credentials/save_credentials/broker_view/get_webhook_secret/rotate_webhook_secret` (Task 3), `SYMBOL_RE` (Task 5), `mask` (Task 3).
- Produces:
  - Routes: `GET/PUT /api/settings`, `POST /api/automation`, `POST /api/mode`, `GET /api/broker`, `PUT /api/broker/credentials`, `POST /api/broker/connect`, `POST /api/broker/disconnect`, `GET /api/webhook`, `POST /api/webhook/reveal`, `POST /api/webhook/rotate`, `POST /api/webhook/test`.
  - `live_blockers(ctx, s, ip_confirmed: bool) -> list[str]` (same wording as `web/assets/js/mock/rules.js`).
  - `TEST_WAIT_S = 3.0` (how long `/webhook/test` waits for the engine before returning).
  - `record_login(ctx, error: str | None) -> None` (persists last login/error + event; reused by the daily login in Task 17).
  - `public_ip(fetch=httpx.get) -> str`, `ngrok_public_url(api_url, port, fetch=httpx.get) -> str | None`, `NetWatcher(ctx)` with `async tick()` and `async run()` (updates `ctx.public_ip`, `ctx.tunnel_url`; publishes `status` on change).

- [ ] **Step 1: Write the failing tests**

`tests/test_api_control.py`:
```python
import pytest
from fastapi.testclient import TestClient

import app.api.routes_control as control
from app.api.app import create_dashboard_app
from app.db import session_scope
from app.engine.worker import Engine
from app.models import Alert, Order
from app.repo_settings import set_mode
from tests.factory import add_alert, fetch, make_world

GOOD = {"client_code": "A123456", "api_key": "abcDEF123", "mpin": "1234", "totp_secret": "JBSWY3DPEHPK3PXP"}


@pytest.fixture
def w(tmp_path, monkeypatch):
    monkeypatch.setattr(control, "TEST_WAIT_S", 0.0)
    world = make_world(tmp_path)
    world.client = TestClient(create_dashboard_app(world.ctx))
    return world


def test_settings_roundtrip_and_field_errors(w):
    r = w.client.put("/api/settings", json={"amount_per_trade": 25000, "capital_cap": 200000})
    assert r.json()["data"]["amount_per_trade"] == 25000
    bad = w.client.put("/api/settings", json={"amount_per_trade": 100})
    assert bad.status_code == 422 and "amount_per_trade" in bad.json()["error"]["fields"]


def test_live_mode_blocked_with_reasons(w):
    r = w.client.post("/api/mode", json={"mode": "LIVE", "ip_confirmed": False})
    body = r.json()
    assert r.status_code == 409 and body["error"]["code"] == "blocked"
    assert any("not connected" in b for b in body["error"]["fields"]["blockers"])
    assert w.client.post("/api/mode", json={"mode": "PAPER"}).json()["data"]["mode"] == "PAPER"


async def test_kill_switch_cancels_working_orders(w):
    await Engine(w.ctx).process(add_alert(w.ctx))  # leaves one OPEN paper order (no tracker tick yet)
    st = w.client.post("/api/automation", json={"on": False}).json()["data"]
    assert st["automation"]["on"] is False
    [order] = fetch(w.ctx, Order)
    assert w.paper.order_state(order.broker_order_id).status == "CANCELLED"


def test_credentials_are_write_only(w):
    bad = w.client.put("/api/broker/credentials", json={**GOOD, "mpin": "12"})
    assert bad.status_code == 422 and "mpin" in bad.json()["error"]["fields"]
    view = w.client.put("/api/broker/credentials", json=GOOD).json()["data"]
    assert view["configured"] is True and view["client_code_masked"] == "A1****56"
    text = w.client.get("/api/broker").text
    assert "1234" not in text and "JBSWY3DPEHPK3PXP" not in text and "abcDEF123" not in text


def test_webhook_templates_masked_reveal_and_rotate(w):
    wh = w.client.get("/api/webhook").json()["data"]
    secret = w.client.post("/api/webhook/reveal").json()["data"]["secret"]
    assert secret not in wh["template_buy"] and wh["secret_masked"] in wh["template_buy"]
    assert '"action": "SELL"' in wh["template_sell"] and '"price": {{close}}' in wh["template_buy"]
    new = w.client.post("/api/webhook/rotate").json()["data"]["secret"]
    assert new != secret


def test_test_alert_is_paper_only_and_validated(w):
    r = w.client.post("/api/webhook/test", json={"symbol": "sbin", "action": "BUY"})
    a = r.json()["data"]
    assert (a["symbol"], a["is_test"]) == ("SBIN", True)
    assert w.ctx.alert_queue.qsize() == 1
    assert w.client.post("/api/webhook/test", json={"symbol": "<b>", "action": "BUY"}).status_code == 422
    with session_scope(w.ctx.db) as s:
        set_mode(s, "LIVE")  # set directly: the /api/mode route would (correctly) block LIVE here
    assert w.client.post("/api/webhook/test", json={"symbol": "SBIN", "action": "BUY"}).status_code == 409
    assert len(fetch(w.ctx, Alert)) == 1
```

`tests/test_netinfo.py`:
```python
import httpx

from app.netinfo import ngrok_public_url, public_ip


class Resp:
    def __init__(self, payload=None, text=""):
        self._payload, self.text = payload, text

    def json(self):
        return self._payload

    def raise_for_status(self):
        return None


def test_ngrok_picks_https_tunnel_for_the_webhook_port():
    payload = {"tunnels": [
        {"public_url": "https://other.ngrok-free.dev", "config": {"addr": "http://localhost:3000"}},
        {"public_url": "https://mtf-desk.ngrok-free.dev", "config": {"addr": "http://127.0.0.1:8001"}},
    ]}
    assert ngrok_public_url("http://x", 8001, fetch=lambda url, timeout: Resp(payload)) == "https://mtf-desk.ngrok-free.dev"


def test_ngrok_not_running_is_none():
    def down(url, timeout):
        raise httpx.ConnectError("refused")
    assert ngrok_public_url("http://x", 8001, fetch=down) is None


def test_public_ip_failure_is_unknown():
    def down(url, timeout):
        raise httpx.ConnectTimeout("offline")
    assert public_ip(fetch=down) == "unknown"
    assert public_ip(fetch=lambda url, timeout: Resp(text="49.36.1.2\n")) == "49.36.1.2"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `.venv\Scripts\pytest tests/test_api_control.py tests/test_netinfo.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.api.routes_control'`

- [ ] **Step 3: Implement network info**

`app/netinfo.py`:
```python
"""This PC's public IP (for Angel static-IP registration) and the ngrok public URL."""
import asyncio
import logging
from collections.abc import Callable

import httpx

from app.context import AppContext

log = logging.getLogger("mtf.net")


def public_ip(fetch: Callable = httpx.get) -> str:
    try:
        resp = fetch("https://api.ipify.org", timeout=5)
        resp.raise_for_status()
        return resp.text.strip() or "unknown"
    except httpx.HTTPError:
        return "unknown"


def ngrok_public_url(api_url: str, port: int, fetch: Callable = httpx.get) -> str | None:
    try:
        tunnels = fetch(api_url, timeout=2).json().get("tunnels", [])
    except (httpx.HTTPError, ValueError):
        return None
    for t in tunnels:
        addr, url = str(t.get("config", {}).get("addr", "")), str(t.get("public_url", ""))
        if url.startswith("https://") and addr.endswith(f":{port}"):
            return url
    return None


class NetWatcher:
    def __init__(self, ctx: AppContext):
        self.ctx = ctx

    async def tick(self) -> None:
        ip = await asyncio.to_thread(public_ip)
        url = await asyncio.to_thread(ngrok_public_url, self.ctx.config.ngrok_api, self.ctx.config.webhook_port)
        changed = (ip, url) != (self.ctx.public_ip, self.ctx.tunnel_url)
        self.ctx.public_ip, self.ctx.tunnel_url = ip, url
        if changed:
            log.info("public ip %s, tunnel %s", ip, url)
            self.ctx.bus.publish("status", {"tunnel_up": url is not None})

    async def run(self) -> None:
        while True:
            try:
                await self.tick()
            except Exception:  # noqa: BLE001 - informational only
                log.exception("net watcher failed")
            await asyncio.sleep(30)
```

- [ ] **Step 4: Implement the control routes**

`app/api/routes_control.py`:
```python
"""Write side of the dashboard API (spec section 8)."""
import asyncio
import json
from typing import Literal

from fastapi import APIRouter
from pydantic import BaseModel

from app.api.app import ApiError, ok
from app.api.routes_ledger import angel_connected, build_status, webhook_url
from app.api.serialize import alert_dict
from app.brokers.base import BrokerError
from app.clock import now_ist
from app.context import AppContext
from app.crypto import mask
from app.db import session_scope
from app.engine.ledger import working_orders
from app.engine.tracker import cancel_all_working
from app.events import log_event
from app.models import Alert, BrokerAccount
from app.repo_broker import (Credentials, broker_view, get_webhook_secret, rotate_webhook_secret, save_credentials,
                             validate_credentials)
from app.repo_settings import load_settings, set_automation, set_mode, update_settings
from app.webhook.schema import SYMBOL_RE

TEST_WAIT_S = 3.0


class AutomationIn(BaseModel):
    on: bool


class ModeIn(BaseModel):
    mode: Literal["PAPER", "LIVE"]
    ip_confirmed: bool = False


class CredsIn(BaseModel):
    client_code: str = ""
    api_key: str = ""
    mpin: str = ""
    totp_secret: str = ""


class TestAlertIn(BaseModel):
    symbol: str
    action: Literal["BUY", "SELL"]


def live_blockers(ctx: AppContext, s, ip_confirmed: bool) -> list[str]:
    blockers = []
    if not broker_view(s)["configured"]:
        blockers.append("Angel One credentials are not saved.")
    if not angel_connected(ctx):
        blockers.append("Angel One is not connected. Connect it on the Broker page.")
    if not ip_confirmed:
        blockers.append("Confirm this PC's public IP is registered in your SmartAPI app.")
    working = len(working_orders(s))
    if working:
        blockers.append(f"{working} order(s) still working. Wait for them to finish.")
    return blockers


def _templates(masked: str) -> tuple[str, str]:
    def one(action: str) -> str:
        body = {"secret": masked, "symbol": "{{ticker}}", "exchange": "{{exchange}}", "action": action,
                "price": "{{close}}", "time": "{{timenow}}"}
        return json.dumps(body, indent=2).replace('"{{close}}"', "{{close}}")  # numeric placeholder, unquoted
    return one("BUY"), one("SELL")


def _broker(ctx: AppContext) -> dict:
    angel = ctx.hub.angel
    with session_scope(ctx.db) as s:
        view = broker_view(s)
    funds = ctx.funds if angel_connected(ctx) else None
    return {**view, "name": "Angel One", "connected": angel_connected(ctx),
            "funds": {"available": funds.available, "used": funds.used, "net": funds.net} if funds else None,
            "public_ip": ctx.public_ip, "last_error": (angel.last_error if angel else None) or view["last_error"]}


def record_login(ctx: AppContext, error: str | None) -> None:
    with session_scope(ctx.db) as s:
        acc = s.get(BrokerAccount, 1)
        if acc is None:
            return
        acc.last_error = error
        if error is None:
            acc.last_login_at = now_ist()
        log_event(s, ctx.bus, "ERROR" if error else "INFO", "broker",
                  f"Angel One login failed: {error}" if error else "Angel One login OK with TOTP.")


async def _wait_processed(ctx: AppContext, alert_id: int) -> dict:
    deadline = asyncio.get_running_loop().time() + TEST_WAIT_S
    while True:
        with session_scope(ctx.db) as s:
            a = alert_dict(s.get(Alert, alert_id))
        if a["action_taken"] != "Processing" or asyncio.get_running_loop().time() >= deadline:
            return a
        await asyncio.sleep(0.1)


def control_router(ctx: AppContext) -> APIRouter:
    r = APIRouter(prefix="/api")

    @r.get("/settings")
    def get_settings():
        with session_scope(ctx.db) as s:
            return ok(load_settings(s).model_dump())

    @r.put("/settings")
    def put_settings(patch: dict):
        with session_scope(ctx.db) as s:
            saved = update_settings(s, patch)
            log_event(s, ctx.bus, "INFO", "system", "Settings saved.")
        ctx.bus.publish("status", {})
        return ok(saved.model_dump())

    @r.post("/automation")
    async def automation(body: AutomationIn):
        with session_scope(ctx.db) as s:
            set_automation(s, body.on)
        cancelled = 0 if body.on else await cancel_all_working(ctx)
        with session_scope(ctx.db) as s:
            msg = ("Automation turned ON." if body.on else
                   f"Kill switch: automation OFF. {cancelled} working order(s) cancelled. Positions kept.")
            log_event(s, ctx.bus, "INFO" if body.on else "WARN", "engine", msg)
        ctx.bus.publish("status", {})
        return ok(build_status(ctx))

    @r.post("/mode")
    def mode(body: ModeIn):
        with session_scope(ctx.db) as s:
            if body.mode == "LIVE":
                blockers = live_blockers(ctx, s, body.ip_confirmed)
                if blockers:
                    raise ApiError(409, "blocked", "Live mode is not allowed yet.", {"blockers": blockers})
            set_mode(s, body.mode)
            log_event(s, ctx.bus, "WARN", "system", f"Trading mode set to {body.mode}.")
        ctx.bus.publish("status", {})
        return ok(build_status(ctx))

    @r.get("/broker")
    def broker():
        return ok(_broker(ctx))

    @r.put("/broker/credentials")
    def credentials(body: CredsIn):
        errors = validate_credentials(body.model_dump())
        if errors:
            raise ApiError(422, "validation", "Please fix the highlighted fields.", errors)
        with session_scope(ctx.db) as s:
            save_credentials(s, ctx.box, Credentials(**body.model_dump()))
            log_event(s, ctx.bus, "INFO", "broker", "Angel One credentials saved (encrypted).")
        if ctx.hub.angel:
            ctx.hub.angel.logout()  # next call logs in with the new credentials
        return ok(_broker(ctx))

    @r.post("/broker/connect")
    async def connect():
        if ctx.hub.angel is None:
            raise ApiError(409, "not_configured", "Save your Angel One credentials first.")
        try:
            await asyncio.to_thread(ctx.hub.angel.login)
        except BrokerError as err:
            record_login(ctx, str(err))
            raise ApiError(502, "broker", str(err)) from err
        record_login(ctx, None)
        ctx.bus.publish("status", {})
        return ok(_broker(ctx))

    @r.post("/broker/disconnect")
    def disconnect():
        if ctx.hub.angel:
            ctx.hub.angel.logout()
        with session_scope(ctx.db) as s:
            log_event(s, ctx.bus, "WARN", "broker", "Angel One disconnected by user.")
        ctx.bus.publish("status", {})
        return ok(_broker(ctx))

    @r.get("/webhook")
    def webhook():
        with session_scope(ctx.db) as s:
            masked = mask(get_webhook_secret(s, ctx.box))
            last = build_status(ctx)["webhook"]["last_alert_at"]
        buy, sell = _templates(masked)
        return ok({"public_url": webhook_url(ctx), "tunnel_up": ctx.tunnel_url is not None, "secret_masked": masked,
                   "template_buy": buy, "template_sell": sell, "last_alert_at": last})

    @r.post("/webhook/reveal")
    def reveal():
        with session_scope(ctx.db) as s:
            return ok({"secret": get_webhook_secret(s, ctx.box)})

    @r.post("/webhook/rotate")
    def rotate():
        with session_scope(ctx.db) as s:
            secret = rotate_webhook_secret(s, ctx.box)
            log_event(s, ctx.bus, "WARN", "webhook", "Webhook secret rotated. Update the alert message in TradingView.")
        return ok({"secret": secret})

    @r.post("/webhook/test")
    async def test_alert(body: TestAlertIn):
        symbol = body.symbol.strip().upper()
        if not SYMBOL_RE.match(symbol):
            raise ApiError(422, "validation", "Enter a valid NSE symbol, e.g. SBIN.")
        with session_scope(ctx.db) as s:
            if load_settings(s).mode != "PAPER":
                raise ApiError(409, "paper_only", "Test alerts are only allowed in Paper mode.")
            a = Alert(received_at=now_ist(), source_ip="test (dashboard)", symbol=symbol, exchange="NSE",
                      action=body.action, is_test=True, status="PENDING", action_taken="Processing",
                      raw_payload={"secret": "********", "symbol": symbol, "exchange": "NSE", "action": body.action, "test": True},
                      checks=[{"name": "Secret and format", "ok": True, "detail": "Test alert from dashboard (Paper mode)"}])
            s.add(a)
            s.flush()
            alert_id = a.id
            log_event(s, ctx.bus, "INFO", "webhook", f"Test alert: {body.action} {symbol}", {"alert_id": alert_id})
        ctx.alert_queue.put_nowait(alert_id)
        return ok(await _wait_processed(ctx, alert_id))

    return r
```

- [ ] **Step 5: Register the router in `app/api/app.py`**

Two edits inside `create_dashboard_app` (keep the function's indentation):

1. Replace the line
```python
from app.api.routes_ledger import ledger_router  # local import: routes import this module
```
with
```python
from app.api.routes_control import control_router
from app.api.routes_ledger import ledger_router  # local imports: routes import this module
```
2. Directly after `app.include_router(ledger_router(ctx))` and before `app.mount(...)`, add
```python
app.include_router(control_router(ctx))
```
The static mount must stay last: a mount at `/` placed earlier would swallow the `/api` routes.

- [ ] **Step 6: Run tests to verify they pass**

Run: `.venv\Scripts\pytest tests/test_api_control.py tests/test_netinfo.py -v`
Expected: 9 passed

- [ ] **Step 7: Commit**

```bash
git add app/api/routes_control.py app/api/app.py app/netinfo.py tests/test_api_control.py tests/test_netinfo.py
git commit -m "feat: control API for settings, kill switch, mode, broker, webhook and test alerts"
```

---

### Task 17: Process entry, restart recovery, Windows scripts and client handover

**Files:**
- Create: `app/main.py`, `scripts/install.bat`, `scripts/start.bat`, `scripts/ngrok-domain.txt.example`, `scripts/send_test_alert.ps1`, `docs/HANDOVER.md`
- Test: `tests/test_main.py`

**Interfaces:**
- Consumes: every earlier task.
- Produces: `next_login_at(now) -> datetime` (next weekday 08:45 IST), `mac_address() -> str`, `local_ip() -> str`, `build_context(cfg, ip_lookup=public_ip, master_loader=load_master) -> AppContext`, `recover_after_restart(ctx) -> None`, `async serve(ctx)`, `main()`. Run with `python -m app.main`.

- [ ] **Step 1: Write the failing tests**

`tests/test_main.py`:
```python
import re
from datetime import datetime

from app.brokers.angel import AngelBroker
from app.brokers.instruments import InstrumentMaster
from app.brokers.paper import PaperBroker
from app.clock import IST
from app.config import AppConfig
from app.db import session_scope
from app.main import build_context, mac_address, next_login_at, recover_after_restart
from app.models import Alert, Order, Position
from tests.factory import MARKET, ROWS, add_alert, fetch, make_world, seed_position


def test_next_login_is_next_weekday_0845():
    assert next_login_at(datetime(2026, 9, 18, 9, 0, tzinfo=IST)) == datetime(2026, 9, 21, 8, 45, tzinfo=IST)  # Fri -> Mon
    assert next_login_at(datetime(2026, 9, 21, 7, 0, tzinfo=IST)) == datetime(2026, 9, 21, 8, 45, tzinfo=IST)


def test_mac_format():
    assert re.fullmatch(r"([0-9a-f]{2}:){5}[0-9a-f]{2}", mac_address())


def test_build_context_without_network(tmp_path):
    ctx = build_context(AppConfig(data_dir=tmp_path), ip_lookup=lambda: "49.36.1.2",
                        master_loader=lambda cfg: InstrumentMaster(ROWS))
    assert isinstance(ctx.hub.for_mode("PAPER"), PaperBroker) and isinstance(ctx.hub.angel, AngelBroker)
    assert ctx.public_ip == "49.36.1.2" and len(ctx.instruments) > 0
    assert ctx.hub.data() is None  # no Angel session yet -> paper uses alert prices


def test_recover_after_restart(tmp_path):
    w = make_world(tmp_path)
    stuck = add_alert(w.ctx)                               # never processed
    pid = seed_position(w.ctx)
    with session_scope(w.ctx.db) as s:
        s.get(Position, pid).status = "EXITING"            # its SELL order was lost
        common = dict(mode="PAPER", ordertag="MTF1", symbol="SBIN", exchange="NSE", token="3045",
                      trading_symbol="SBIN-EQ", side="BUY", qty=1, limit_price=845.25, created_at=MARKET, updated_at=MARKET)
        s.add(Order(broker_order_id=None, status="OPEN", **common))              # crashed mid-send
        s.add(Order(broker_order_id="PAPER-000009", status="OPEN", **common))    # paper order lost with memory
    recover_after_restart(w.ctx)
    assert fetch(w.ctx, Alert, id=stuck)[0].status == "FAILED"
    statuses = sorted(o.status for o in fetch(w.ctx, Order))
    assert statuses == ["CANCELLED", "REJECTED"]
    assert fetch(w.ctx, Position)[0].status == "OPEN"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `.venv\Scripts\pytest tests/test_main.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.main'`

- [ ] **Step 3: Implement `app/main.py`**

```python
"""Process entry (spec section 3): two local servers plus the background tasks."""
import asyncio
import logging
import socket
import uuid
from datetime import datetime, time, timedelta
from logging.handlers import RotatingFileHandler
from pathlib import Path

import httpx
import uvicorn
from sqlalchemy import select

from app.api.app import create_dashboard_app
from app.api.routes_control import record_login
from app.brokers.angel import AngelBroker, ClientIdentity
from app.brokers.base import BrokerError
from app.brokers.hub import BrokerHub
from app.brokers.instruments import InstrumentMaster
from app.brokers.paper import PaperBroker
from app.clock import IST, now_ist
from app.config import AppConfig, get_config
from app.context import AppContext
from app.crypto import SecretBox
from app.db import init_db, make_engine, session_scope
from app.engine.tracker import OrderTracker
from app.engine.worker import Engine
from app.events import EventBus, log_event
from app.models import Alert, Order, Position
from app.netinfo import NetWatcher, public_ip
from app.repo_broker import load_credentials
from app.repo_settings import load_settings
from app.services.ltp import LtpPoller
from app.services.reconcile import Reconciler
from app.webhook.app import create_webhook_app

log = logging.getLogger("mtf")
LOGIN_AT = time(8, 45)
MASTER_AT = time(8, 35)


def setup_logging(log_dir: Path) -> None:
    fmt = logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s")
    file = RotatingFileHandler(log_dir / "mtf.log", maxBytes=5_000_000, backupCount=5, encoding="utf-8")
    file.setFormatter(fmt)
    console = logging.StreamHandler()
    console.setFormatter(fmt)
    logging.basicConfig(level=logging.INFO, handlers=[file, console])


def local_ip() -> str:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("8.8.8.8", 80))  # UDP connect sends nothing; it only picks the outbound interface
            return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"


def mac_address() -> str:
    node = uuid.getnode()
    return ":".join(f"{(node >> shift) & 0xFF:02x}" for shift in range(40, -1, -8))


def _next_weekday_at(now: datetime, at: time) -> datetime:
    t = now.astimezone(IST)
    candidate = datetime.combine(t.date(), at, IST)
    if candidate <= t:
        candidate += timedelta(days=1)
    while candidate.weekday() >= 5:
        candidate += timedelta(days=1)
    return candidate


def next_login_at(now: datetime) -> datetime:
    return _next_weekday_at(now, LOGIN_AT)


def load_master(cfg: AppConfig) -> InstrumentMaster:
    try:
        return InstrumentMaster.load(cfg.data_dir / "scripmaster.json", cfg.scrip_master_url, now_ist())
    except (httpx.HTTPError, OSError, ValueError) as err:
        log.error("scrip master unavailable, will retry: %s", err)
        return InstrumentMaster([])


def _creds(ctx: AppContext):
    with session_scope(ctx.db) as s:
        return load_credentials(s, ctx.box)


def _live_quotes(ctx: AppContext, insts):
    data = ctx.hub.data()
    try:
        return data.quotes(insts) if data else {}
    except BrokerError:
        return {}  # paper then falls back to the alert price


def _live_margin(ctx: AppContext, inst, price):
    data = ctx.hub.data()
    try:
        return data.margin_per_share(inst, price) if data else None
    except BrokerError:
        return None  # paper then uses its labelled estimate


def _paper_pct(ctx: AppContext) -> float:
    with session_scope(ctx.db) as s:
        return load_settings(s).paper_margin_pct


def build_context(cfg: AppConfig, ip_lookup=public_ip, master_loader=load_master) -> AppContext:
    db = make_engine(cfg.db_path)
    init_db(db)
    ctx = AppContext(config=cfg, db=db, box=SecretBox(cfg.key_path), bus=EventBus())
    ctx.public_ip = ip_lookup()
    ctx.instruments = master_loader(cfg)
    angel = AngelBroker(lambda: _creds(ctx), ClientIdentity(local_ip(), ctx.public_ip, mac_address()))
    paper = PaperBroker(lambda insts: _live_quotes(ctx, insts), lambda i, p: _live_margin(ctx, i, p),
                        lambda: _paper_pct(ctx))
    ctx.hub = BrokerHub(paper, angel)
    return ctx


def recover_after_restart(ctx: AppContext) -> None:
    with session_scope(ctx.db) as s:
        for a in s.scalars(select(Alert).where(Alert.action_taken == "Processing")):
            a.status, a.action_taken = "FAILED", "Not processed"
            a.detail = "App restarted before this alert was processed. Not traded."
        for o in s.scalars(select(Order).where(Order.status.in_(("OPEN", "PARTIAL")))):
            if o.broker_order_id is None:
                o.status, o.reason = "REJECTED", "App restarted while sending. Check the Angel One order book."
            elif o.mode == "PAPER":
                o.status, o.reason = "CANCELLED", "Paper order lost on restart."
            else:
                continue  # LIVE orders with an id keep being tracked against Angel
            if o.side == "SELL" and o.position_id:
                s.get(Position, o.position_id).status = "OPEN"
        s.flush()
        for p in s.scalars(select(Position).where(Position.status == "EXITING")):
            working = s.scalars(select(Order).where(Order.position_id == p.id, Order.side == "SELL",
                                                    Order.status.in_(("OPEN", "PARTIAL")))).first()
            if working is None:
                p.status = "OPEN"
        cfg = ctx.config
        log_event(s, ctx.bus, "INFO", "system",
                  f"MTF Trader started. Dashboard on 127.0.0.1:{cfg.dashboard_port}, webhook on 127.0.0.1:{cfg.webhook_port}.")


async def _login_once(ctx: AppContext) -> None:
    try:
        await asyncio.to_thread(ctx.hub.angel.login)
        record_login(ctx, None)
    except BrokerError as err:
        record_login(ctx, str(err))
    ctx.bus.publish("status", {})


async def daily_login(ctx: AppContext) -> None:
    if _creds(ctx) is not None:
        await _login_once(ctx)
    while True:
        now = now_ist()
        await asyncio.sleep(max(1.0, (next_login_at(now) - now).total_seconds()))
        await _login_once(ctx)


async def refresh_instruments(ctx: AppContext) -> None:
    while True:
        now = now_ist()
        wait = 600 if len(ctx.instruments) == 0 else (_next_weekday_at(now, MASTER_AT) - now).total_seconds()
        await asyncio.sleep(max(1.0, wait))
        ctx.instruments = await asyncio.to_thread(load_master, ctx.config)


async def serve(ctx: AppContext) -> None:
    cfg = ctx.config
    apps = ((create_dashboard_app(ctx), cfg.dashboard_port), (create_webhook_app(ctx), cfg.webhook_port))
    servers = [uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning", access_log=False))
               for app, port in apps]
    background = [Engine(ctx).run(), OrderTracker(ctx).run(), LtpPoller(ctx).run(), Reconciler(ctx).run(),
                  NetWatcher(ctx).run(), daily_login(ctx), refresh_instruments(ctx)]
    await asyncio.gather(*(srv.serve() for srv in servers), *background)


def main() -> None:
    cfg = get_config()
    setup_logging(cfg.log_dir)
    ctx = build_context(cfg)
    recover_after_restart(ctx)
    asyncio.run(serve(ctx))


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv\Scripts\pytest tests/test_main.py -v`
Expected: 4 passed

- [ ] **Step 5: Write the Windows scripts**

`scripts/install.bat`:
```bat
@echo off
setlocal
cd /d "%~dp0\.."
where py >nul 2>nul || (echo Python 3.12 is not installed. Install it from python.org and tick "Add python.exe to PATH". & pause & exit /b 1)
py -3.12 -m venv .venv || (echo Could not create the Python environment. & pause & exit /b 1)
.venv\Scripts\python -m pip install --upgrade pip
.venv\Scripts\pip install -r requirements.txt || (echo Package install failed. Check the internet connection and run again. & pause & exit /b 1)
if not exist scripts\ngrok-domain.txt copy scripts\ngrok-domain.txt.example scripts\ngrok-domain.txt >nul
where ngrok >nul 2>nul || echo NOTE: ngrok is not installed. Run: winget install ngrok.ngrok   then: ngrok config add-authtoken YOUR_TOKEN
echo.
echo Installed. Put your ngrok domain in scripts\ngrok-domain.txt, then double-click scripts\start.bat
pause
```

`scripts/ngrok-domain.txt.example`:
```
your-name.ngrok-free.dev
```

`scripts/start.bat`:
```bat
@echo off
setlocal
cd /d "%~dp0\.."
if not exist .venv\Scripts\python.exe (echo Run scripts\install.bat first. & pause & exit /b 1)
set /p NGROK_DOMAIN=<scripts\ngrok-domain.txt
if "%NGROK_DOMAIN%"=="your-name.ngrok-free.dev" (echo Put YOUR ngrok domain in scripts\ngrok-domain.txt first. & pause & exit /b 1)
start "MTF Trader tunnel" /min ngrok http --url=%NGROK_DOMAIN% 8001
start "MTF Trader" /min .venv\Scripts\python -m app.main
timeout /t 5 >nul
start "" http://127.0.0.1:8000
```
(Older ngrok agents use `--domain=` instead of `--url=`; HANDOVER troubleshooting covers it.)

`scripts/send_test_alert.ps1`:
```powershell
# Sends a TradingView-shaped alert. Default target is the local webhook port; pass -Url with your
# ngrok address to test the tunnel end to end. Outside market hours real alerts are rejected
# ("Market closed"); use Settings > Send test alert for after-hours Paper tests.
param(
    [Parameter(Mandatory = $true)][string]$Secret,
    [string]$Url = "http://127.0.0.1:8001/webhook",
    [string]$Symbol = "SBIN",
    [ValidateSet("BUY", "SELL")][string]$Action = "BUY"
)
$body = @{ secret = $Secret; symbol = $Symbol; exchange = "NSE"; action = $Action;
           time = (Get-Date).ToUniversalTime().ToString("o") } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri $Url -Body $body -ContentType "application/json"
```

- [ ] **Step 6: Write `docs/HANDOVER.md` (client guide)**

```markdown
# MTF Trader: setup and daily use

MTF Trader buys a stock in Angel One's **MTF (Margin Trading Facility)** product when your
TradingView indicator sends a BUY alert, and sells the whole position when it sends a SELL alert
for that stock. It runs on this PC. Keep the PC on, with internet, during market hours.

## 1. What you need first
1. Angel One account with **MTF activated** (Angel One app > MTF).
2. A **static IP** for this PC from your internet provider.
3. A SmartAPI app (smartapi.angelone.in > My Apps): note the **API key**, and set this PC's static IP
   as the **Primary Static IP** (the Broker page shows this PC's public IP). The IP can be changed at most once a week.
4. **TOTP enabled** for SmartAPI; keep the TOTP secret (the code shown while enabling it).
5. A free **ngrok** account: authtoken and your free domain (like `something.ngrok-free.dev`).
6. TradingView with **2-factor login on** and a plan that allows **webhook** alerts.

## 2. Install (once)
1. Install Python 3.12 from python.org (tick "Add python.exe to PATH").
2. Run `winget install ngrok.ngrok`, then `ngrok config add-authtoken YOUR_TOKEN`.
3. Double-click `scripts\install.bat`.
4. Open `scripts\ngrok-domain.txt` and replace the text with your ngrok domain.

## 3. Every day
Double-click `scripts\start.bat`. The dashboard opens at http://127.0.0.1:8000.
Angel One logs in by itself at startup and at 08:45 IST every weekday.

## 4. Connect Angel One
Broker page: enter Client ID, API key, MPIN, TOTP secret, then **Save and connect**.
They are stored encrypted on this PC and never shown again.

## 5. Set up the TradingView alerts
Settings page, "TradingView webhook":
1. Copy the **Webhook URL**.
2. On your indicator create a **BUY** alert: Notifications > Webhook URL = the URL; Message = **Copy** from "BUY alert message".
3. Create a **SELL** alert the same way with the "SELL alert message".
Do not edit the message. Without the secret inside it, alerts are rejected.

## 6. Test in Paper mode (no real orders)
1. Settings > "How the amount is used", "Amount per trade", "Max open positions", "Total capital cap". Save.
2. Settings > **Send test alert**: BUY SBIN. Watch Dashboard, Alerts and Positions. Then send SELL SBIN.
3. Let a real indicator alert arrive during market hours and check the Alerts page.

## 7. Go live
Settings > Trading mode > **Live**. Confirm the static IP and the paper test.
First live trade: keep **Amount per trade** small and watch the Orders page and the Angel One app together.

## 8. Emergency stop
Turn **Automation** off in the sidebar (or Settings > Stop automation). New alerts are rejected and working
orders are cancelled. **Open positions are kept**; exit them yourself in Angel One if needed.

## 9. When something looks wrong
| You see | Do this |
|---|---|
| Alert "Rejected: Market closed" | Normal outside 09:15-15:30 IST, Monday to Friday. |
| Alert "Wrong webhook secret" | Copy the alert message again from Settings into TradingView. |
| Order "Rejected" mentioning IP | Register this PC's public IP in your SmartAPI app (Broker page shows it). |
| "Angel One is not connected" | Broker page > Test connection. Check MPIN / TOTP secret. |
| "Webhook tunnel is down" | Close both MTF Trader windows and run start.bat again. If ngrok says `--url` is unknown, update ngrok (`winget upgrade ngrok.ngrok`) or change `--url=` to `--domain=` in start.bat. |
| "Exit pending" banner | The SELL did not fill after re-pricing. Check the order in the Angel One app. |
| Stock bought outside MTF Trader | It shows only in Positions > Angel One account. MTF Trader never sells it. |

## 10. Support
Urban Cairn Tech Solutions: urbancairn1@gmail.com, +91 93135 60694. 1 month free AMC from delivery
(bug fixes, amount-logic adjustments, broker API upkeep). Share the alert time and a screenshot of the Logs page.
```

- [ ] **Step 7: Smoke-run the app in Paper mode**

Run: `.venv\Scripts\python -m app.main` (in a separate terminal), then:
`curl -s http://127.0.0.1:8000/api/status` -> JSON with `"ok": true, ... "mode": "PAPER"`
`curl -s http://127.0.0.1:8000/assets/js/config.js` -> `mode: 'live'`
Stop with Ctrl+C.

- [ ] **Step 8: Commit**

```bash
git add app/main.py scripts docs/HANDOVER.md tests/test_main.py
git commit -m "feat: process entry with restart recovery, Windows scripts and client handover"
```

---

### Task 18: End-to-end browser tests and the live verification checklist

**Files:**
- Create: `tests/e2e/__init__.py`, `tests/e2e/test_ui.py`, `docs/LIVE-TEST.md`

**Interfaces:**
- Consumes: `create_dashboard_app` (Tasks 15-16), `Engine` (Task 10), `OrderTracker` (Task 11), `LtpPoller` (Task 14), `tests.factory.make_world` (Task 10).
- Produces: `pytest -m e2e` suite that drives the real frontend against the real backend in Paper mode; a signed-off live checklist.

- [ ] **Step 1: Install the browser once**

Run: `.venv\Scripts\python -m playwright install chromium`
Expected: Chromium downloaded (headless only; no window opens during tests).

- [ ] **Step 2: Write the E2E tests**

`tests/e2e/__init__.py`: empty file.

`tests/e2e/test_ui.py`:
```python
"""Real frontend + real backend (Paper mode, fixture scrip master), headless Chromium."""
import asyncio
import socket
import threading
import time

import httpx
import pytest
import uvicorn
from playwright.sync_api import sync_playwright

from app.api.app import create_dashboard_app
from app.engine.tracker import OrderTracker
from app.engine.worker import Engine
from app.services.ltp import LtpPoller
from tests.factory import make_world

pytestmark = pytest.mark.e2e
ROUTES = ["dashboard", "positions", "alerts", "orders", "trades", "settings", "broker", "logs", "help"]


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture(scope="module")
def base_url(tmp_path_factory):
    w = make_world(tmp_path_factory.mktemp("e2e"))
    port = _free_port()
    server = uvicorn.Server(uvicorn.Config(create_dashboard_app(w.ctx), host="127.0.0.1", port=port, log_level="warning"))

    async def run():
        await asyncio.gather(server.serve(), Engine(w.ctx).run(), OrderTracker(w.ctx).run(interval=0.5),
                             LtpPoller(w.ctx).run(), return_exceptions=True)

    threading.Thread(target=lambda: asyncio.run(run()), daemon=True).start()
    url = f"http://127.0.0.1:{port}"
    for _ in range(50):
        try:
            if httpx.get(f"{url}/api/status", timeout=0.5).status_code == 200:
                break
        except httpx.HTTPError:
            time.sleep(0.1)
    yield url
    server.should_exit = True


@pytest.fixture
def page(base_url):
    errors: list[str] = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        pg = browser.new_page(viewport={"width": 1440, "height": 900}, accept_downloads=True)
        pg.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.errors = errors
        yield pg
        browser.close()


def test_every_screen_renders_without_errors(page, base_url):
    for route in ROUTES:
        page.goto(f"{base_url}/#/{route}")
        page.wait_for_timeout(600)
        assert page.locator("#view .skel").count() == 0, route
    assert page.locator(".pill.demo").count() == 0  # live mode: no "Demo data" badge
    assert page.errors == []


def test_test_alert_opens_position_live(page, base_url):
    page.goto(f"{base_url}/#/settings")
    page.fill("#t-symbol", "SBIN")
    page.click('[data-action="send-test"]')
    page.goto(f"{base_url}/#/positions")
    page.wait_for_selector("[data-positions] tbody tr:has-text('SBIN')", timeout=8000)
    page.goto(f"{base_url}/#/alerts")
    page.locator("tbody tr.click").first.click()
    page.wait_for_selector(".drawer .checks li")
    assert "Qty from amount" in page.text_content(".drawer")
    assert page.errors == []


def test_settings_error_shows_under_the_field(page, base_url):
    page.goto(f"{base_url}/#/settings")
    page.fill("#s-amount_per_trade", "100")
    page.click('button[type="submit"]')
    page.wait_for_selector("#amount_per_trade-error")
    assert "500" in page.text_content("#amount_per_trade-error")


def test_excel_export_downloads(page, base_url):
    page.goto(f"{base_url}/#/alerts")
    with page.expect_download() as info:
        page.click('[data-action="export"]')
    assert info.value.suggested_filename.endswith(".xlsx")


def test_kill_switch_banner(page, base_url):
    page.goto(f"{base_url}/#/dashboard")
    page.click("#auto-card .switch")
    page.click('.modal [data-act="ok"]')
    page.wait_for_selector(".banner.err:has-text('Automation is OFF')")
```
Note: the frontend's demo mode keeps its own regression audit (`web/` served statically); this suite covers the live wiring. Test order matters only for the last test (kill switch), which is why it runs last in the file.

- [ ] **Step 3: Run the E2E suite**

Run: `.venv\Scripts\pytest -m e2e -v`
Expected: 5 passed

- [ ] **Step 4: Run the full suite with coverage**

Run: `.venv\Scripts\pytest --cov=app --cov-report=term-missing -m "not e2e"`
Expected: all passed, total coverage >= 80%. If below, add tests for the uncovered branches the report lists (do not lower the bar).

- [ ] **Step 5: Write the live checklist**

`docs/LIVE-TEST.md`:
```markdown
# Live verification (client account, market hours only, never on a weekend)

Rate-limit and order behaviour of Angel One only shows up while the market is open. A weekend "pass" is not a pass.
Use the smallest amount per trade the client agrees to, on an MTF-approved stock the client picks.

| # | Step | Expected | Result / evidence |
|---|---|---|---|
| 1 | Broker page: Save and connect | Connected; funds match the Angel One app | |
| 2 | Broker page public IP vs SmartAPI app | Same IP as the registered Primary Static IP | |
| 3 | Paper: Settings > Send test alert BUY then SELL | Position opens, then trade with P&L | |
| 4 | Paper: real indicator alert in market hours | Alerts row EXECUTED; source IP is a TradingView IP | |
| 5 | Switch to Live (small amount) | Mode LIVE, red pill in top bar | |
| 6 | Live BUY alert | Orders: LIMIT BUY MTF, filled; Angel app shows the order with product **MTF** (confirms `producttype MARGIN` = MTF) | |
| 7 | Live SELL alert same day | Position squared off in full; Trade row P&L = qty x (sell - buy), before charges | |
| 8 | Next trading day: SELL on a carried MTF position | Squared off from the MTF holding (confirms `MARGIN` SELL on holdings) | |
| 9 | Kill switch with a working order | Order cancelled in the Angel app; positions untouched | |
| 10 | Close and restart start.bat mid-session | Positions intact; working LIVE orders still tracked | |

Signed off by: ____________ (client)   ____________ (Urban Cairn)   Date: ________
```
If step 6 or 8 fails (Angel uses a different product code for MTF), change only `PRODUCT` in `app/brokers/angel.py`, re-run `tests/test_angel.py`, and repeat steps 6-8.

- [ ] **Step 6: Commit**

```bash
git add tests/e2e docs/LIVE-TEST.md
git commit -m "test: end-to-end UI suite against the paper backend and live verification checklist"
```

---

## Spec coverage (self-review)

| Quotation / spec requirement | Task(s) |
|---|---|
| Alert receiver, validate every alert | 5 (schema, secret, size, stale, rate), 9 (guards), 10 (symbol) |
| Automatic MTF buying via official API | 10, 13 (`producttype MARGIN`, LIMIT only) |
| Amount per trade and overall; qty from live price + MTF margin; editable | 2 (settings), 8 (sizing), 13 (margin API, RMS), 16 (PUT settings) |
| Exit on SELL, full square-off, realised P&L | 10 (SELL), 11 (fills, trade), 13 |
| Multi-stock, own position each | 2 (positions), 9 (one per stock) |
| Capital cap, max positions, duplicate, one per stock, kill switch | 9, 11 (`cancel_all_working`), 16 (`/api/automation`) |
| Live dashboard, logs, Excel export | 14 (LTP, export), 15 (read API, SSE), frontend (done) |
| Paper-trade mode | 7, 16 (test alert), 17 |
| Broker API integration (Angel One) | 12, 13, 16, 17 (daily login) |
| Installation, API keys, training | 17 (scripts, HANDOVER), 18 (LIVE-TEST) |
| Static IP rule, LIMIT-only rule, rate limits | 12, 13, 16 (`live_blockers`), HANDOVER |
| Restart safety | 17 (`recover_after_restart`) |

<!-- END OF PLAN -->
