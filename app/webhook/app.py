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
