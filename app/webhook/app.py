"""Port 8001: the only thing the tunnel exposes. One route, no docs, small bodies, rate-limited."""
import time
from collections import deque

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from app.context import AppContext
from app.webhook.intake import receive_alert

MAX_BODY = 4096
RATE_LIMIT = 60  # alerts per minute per IP


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


class PerIpLimiter:
    """One SlidingWindow per client IP, so junk from one IP can't 429 another's real alerts."""

    def __init__(self, limit: int, seconds: float):
        self.limit, self.seconds = limit, seconds
        self._windows: dict[str, SlidingWindow] = {}

    def allow(self, ip: str) -> bool:
        now = time.monotonic()
        for other_ip, window in list(self._windows.items()):
            while window.hits and now - window.hits[0] > window.seconds:
                window.hits.popleft()
            if not window.hits and other_ip != ip:
                del self._windows[other_ip]  # prune stale IPs so the dict cannot grow without bound
        window = self._windows.setdefault(ip, SlidingWindow(self.limit, self.seconds))
        return window.allow()


async def read_capped(request: Request, limit: int) -> bytes | None:
    """Read the body without ever buffering more than `limit` bytes."""
    content_length = request.headers.get("content-length")
    if content_length is not None:
        try:
            if int(content_length) > limit:
                return None
        except ValueError:
            pass  # non-integer content-length: treat as absent, fall back to the streaming cap
    total = 0
    chunks = []
    async for chunk in request.stream():
        total += len(chunk)
        if total > limit:
            return None
        chunks.append(chunk)
    return b"".join(chunks)


def client_ip(request: Request) -> str:
    peer = request.client.host if request.client else ""
    is_loopback = peer in ("127.0.0.1", "::1") or peer.startswith("127.")
    forwarded = request.headers.get("x-forwarded-for", "")
    if is_loopback and forwarded:
        # ngrok is the single trusted proxy hop and appends the real client IP last.
        parts = [p.strip() for p in forwarded.split(",") if p.strip()]
        if parts:
            return parts[-1]
    return peer


def create_webhook_app(ctx: AppContext) -> FastAPI:
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    limiter = PerIpLimiter(RATE_LIMIT, 60.0)

    @app.post("/webhook")
    async def webhook(request: Request) -> JSONResponse:
        ip = client_ip(request)
        body = await read_capped(request, MAX_BODY)
        if body is None:
            return JSONResponse({"ok": False, "reason": "too large"}, status_code=413)
        if not limiter.allow(ip):
            return JSONResponse({"ok": False, "reason": "rate limited"}, status_code=429)
        status, payload = receive_alert(ctx, body, ip)
        return JSONResponse(payload, status_code=status)

    return app
