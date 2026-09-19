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
