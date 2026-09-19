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
