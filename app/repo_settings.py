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
