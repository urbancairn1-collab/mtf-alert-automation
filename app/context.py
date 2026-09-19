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
