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
