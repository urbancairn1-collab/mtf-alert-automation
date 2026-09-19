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
