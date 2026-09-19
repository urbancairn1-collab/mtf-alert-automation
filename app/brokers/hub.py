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
