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
    # TestClient's peer is "testclient" (not loopback), so per the trusted-proxy rule in
    # client_ip() the X-Forwarded-For header sent by post() is correctly ignored here;
    # the stored source_ip is the peer TestClient reports, not the spoofable header.
    assert (a.symbol, a.action, a.status, a.source_ip) == ("SBIN", "BUY", "PENDING", "testclient")
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


def test_rate_limit_is_per_ip(ctx, monkeypatch):
    import app.webhook.app as webhook_app_module

    monkeypatch.setattr(webhook_app_module, "RATE_LIMIT", 3)
    app_obj = webhook_app_module.create_webhook_app(ctx)
    # TestClient's `client=` sets the ASGI scope peer, so this is a real (non-spoofable)
    # per-IP distinction rather than an X-Forwarded-For header, which non-loopback peers ignore.
    client_a = TestClient(app_obj, client=("3.3.3.3", 12345))
    client_b = TestClient(app_obj, client=("4.4.4.4", 12345))
    body = json.dumps({"secret": secret(ctx), "symbol": "SBIN", "action": "BUY"})

    for _ in range(3):
        r = client_a.post("/webhook", content=body)
        assert r.status_code != 429

    r4 = client_a.post("/webhook", content=body)
    assert r4.status_code == 429

    rb = client_b.post("/webhook", content=body)
    assert rb.status_code != 429


def test_oversize_rejected_by_content_length(ctx):
    client = TestClient(create_webhook_app(ctx))
    r = client.post("/webhook", content=b"{}", headers={"content-length": "999999"})
    assert r.status_code == 413


def test_client_ip_uses_last_xff_entry_only_from_loopback():
    from app.webhook.app import client_ip

    class FakeClient:
        def __init__(self, host):
            self.host = host

    class FakeRequest:
        def __init__(self, host, headers):
            self.client = FakeClient(host)
            self.headers = headers

    loopback = FakeRequest("127.0.0.1", {"x-forwarded-for": "6.6.6.6, 52.89.214.238"})
    assert client_ip(loopback) == "52.89.214.238"

    non_loopback = FakeRequest("9.9.9.9", {"x-forwarded-for": "6.6.6.6, 52.89.214.238"})
    assert client_ip(non_loopback) == "9.9.9.9"
