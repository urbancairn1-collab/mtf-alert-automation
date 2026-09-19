# MTF Alert Automation (Angel One) - Design Spec

- **Date:** 2026-09-19
- **Status:** Approved for frontend build; backend plan in `docs/superpowers/plans/2026-09-19-mtf-alert-automation.md`
- **Scope source (binding):** Quotation `UC/QTN/26-27/09/050` (MTF Alert-Based Automated Stock Buying Software, Python). Every line of that quotation is in scope; nothing outside it is.
- **UI reference:** "MTF Trader" multi-screen mock (light, emerald) for layout; the two dark Urban Cairn mocks for the dark theme. Charts are excluded by instruction.

## 1. Decisions log

| # | Decision | Source |
|---|---|---|
| D1 | "MTF" = Margin Trading Facility (broker product), not multi-timeframe | Rahul, 2026-09-19 |
| D2 | Broker = Angel One SmartAPI; Paper mode always available | Rahul, 2026-09-19 |
| D3 | Feature scope = quotation, all of it, nothing extra | Rahul, 2026-09-19 |
| D4 | No chart, no Reports/Analytics screen, no manual trade panel, no multi-timeframe settings | Rahul + quotation |
| D5 | Orders are LIMIT only (Angel 1-Apr-2026: market and IOC orders prohibited for algo orders) | Angel notice |
| D6 | Runs on the client's own Windows PC; webhook reaches it through an ngrok permanent domain | Quotation "runs on client's own system" + TradingView ports 80/443 only |
| D7 | Qty sizing has two modes, chosen in Settings; default = "Amount is my margin" (quotation wording) | Client-decides rule |
| D8 | Dashboard binds to 127.0.0.1 only; only the webhook port is tunnelled; therefore no login screen | Security design |

## 2. Goals and non-goals

**Goals (quotation lines, verbatim intent)**
1. Alert Receiver: secure webhook listener, reads symbol and action, validates every alert before acting.
2. Automatic MTF buying on BUY alert via the official broker API.
3. Customised money: rupee amount per trade and overall; qty auto-calculated from live price and available MTF margin; editable any time in Settings.
4. Automatic exit on SELL alert: squares off that MTF position in full; completed trade recorded with realised P&L.
5. Multi-stock handling: each stock tracked as its own MTF position.
6. Capital and risk controls: total deployed-capital cap, max open positions, duplicate/repeat alert protection, one open position per stock, emergency kill switch.
7. Live dashboard and logs: running status, every alert received, open MTF positions with deployed amount and live P&L, complete alert and order history exportable to Excel.
8. Paper-trade (test) mode running the full alert-to-order flow without real orders.
9. Broker API integration with the client's MTF-enabled Angel One account.
10. Installation on the client's machine, API key setup, end-to-end test with his indicator, training walkthrough.

**Non-goals:** indicator development, charts, strategy logic, stop-loss/target, other brokers, multi-user, remote (internet) dashboard access, mobile app.

## 3. Architecture

```
TradingView alert (JSON)
   -> https://<name>.ngrok-free.dev/webhook      (ngrok agent on client PC)
   -> 127.0.0.1:8001  Webhook app (FastAPI, only POST /webhook)
         validate -> persist alert -> enqueue -> 200 OK (<100 ms, TradingView timeout is 3 s)
   -> Engine worker (single asyncio consumer, sequential)
         guards -> sizing -> Broker.place_limit() -> OrderTracker
   -> Broker: PaperBroker | AngelBroker (SmartAPI REST)
   -> SQLite (WAL) ledger: alerts, orders, positions, trades, events, settings
   -> 127.0.0.1:8000  Dashboard app (FastAPI: /api/*, /api/events SSE, static web/)
         <- LtpPoller (open symbols, 1 quote call / 3 s in market hours)
         <- Reconciler (LIVE: broker positions/holdings every 60 s)
```

One Python process runs both uvicorn servers, the engine worker, the order tracker, the LTP poller and the reconciler as asyncio tasks. The single engine consumer is deliberate: capital-cap and one-position-per-stock checks can never race.

### 3.1 Repository layout

```
app/
  main.py                 process entry: two uvicorn servers + background tasks
  config.py               paths, ports, env (pydantic-settings)
  db.py                   SQLAlchemy 2.0 engine (SQLite WAL), session factory, schema create
  models.py               ORM tables (section 5)
  crypto.py               Fernet encrypt/decrypt for broker secrets (key in data/secret.key)
  clock.py                IST now(), market-hours check (zoneinfo + tzdata)
  events.py               in-process pub/sub -> SSE and event log
  webhook/app.py          FastAPI app for port 8001
  webhook/schema.py       pydantic alert model + validation
  engine/worker.py        queue consumer, orchestrates one alert
  engine/guards.py        pure functions: each guard returns Pass | Reject(reason)
  engine/sizing.py        amount -> qty (two modes), tick rounding, limit price
  engine/exits.py         SELL path: full square-off, re-pricing policy
  engine/tracker.py       polls open orders, fills -> positions/trades, timeouts
  brokers/base.py         Broker protocol + DTOs
  brokers/paper.py        PaperBroker
  brokers/angel.py        AngelBroker (smartapi-python + own rate limiter)
  brokers/instruments.py  scrip-master download + TradingView ticker -> Angel token
  services/ltp.py         LtpPoller
  services/reconcile.py   Reconciler (LIVE)
  services/export.py      Excel export (openpyxl)
  api/app.py              FastAPI app for port 8000 (+ static mount)
  api/routes_*.py         status, dashboard, positions, alerts, orders, trades, settings, broker, webhook, logs, export, events
web/                      frontend (section 7), no build step
scripts/install.bat, scripts/start.bat, scripts/send_test_alert.ps1
tests/                    pytest (unit + integration), tests/e2e (Playwright)
docs/HANDOVER.md          client setup + training guide
data/                     runtime: app.db, secret.key, scripmaster cache, logs (git-ignored)
```

## 4. Alert contract

TradingView cannot set headers, so the secret travels in the body.

```json
{"secret": "<from Settings>", "symbol": "{{ticker}}", "exchange": "{{exchange}}",
 "action": "BUY", "price": {{close}}, "time": "{{timenow}}"}
```

A separate alert (or `alertcondition`) is created for SELL with `"action": "SELL"`.

**Validation (in order, each failure is stored with its reason; the HTTP reply is still 200 so TradingView does not disable the alert):**
1. Body <= 4 KB, valid JSON, fields per schema (`action` in BUY/SELL, `symbol` 1-30 chars `[A-Z0-9&_-]`, `exchange` in NSE/BSE, `price` > 0 optional).
2. `secret` matches (constant-time compare). Wrong secret -> HTTP 401, stored as REJECTED with `source_ip`.
3. `time` (if present) not older than `stale_alert_sec` (default 120).
4. Rate limit 60 alerts/min on the webhook port.

**Ticker mapping:** TradingView `BAJAJ_AUTO` -> Angel `BAJAJ-AUTO-EQ` (underscore to hyphen, `-EQ` suffix), `M&M` -> `M&M-EQ`. Lookup in the Angel scrip master (`OpenAPIScripMaster.json`, refreshed daily after 08:30 IST, cached in `data/`). Index tickers (NIFTY, BANKNIFTY, etc.) and non-EQ series are rejected with a readable reason.

## 5. Data model (SQLite, WAL)

| Table | Key columns |
|---|---|
| `settings` | single row JSON: amount_per_trade, sizing_mode (`margin`/`value`), capital_cap, max_open_positions, one_position_per_stock, duplicate_protection, duplicate_window_sec, limit_buffer_pct, buy_fill_timeout_sec, sell_reprice_attempts, sell_reprice_interval_sec, stale_alert_sec, paper_margin_pct, mode (`PAPER`/`LIVE`), automation_on, webhook_secret_enc |
| `broker_accounts` | broker, client_code, api_key_enc, mpin_enc, totp_secret_enc, connected, last_login_at, session_valid_till, last_error |
| `alerts` | id, received_at, source_ip, raw_payload, symbol, exchange, action, alert_price, status, action_taken, reason, checks (JSON list of {name, ok, detail}), order_id |
| `orders` | id, alert_id, mode, broker_order_id, ordertag, symbol, token, side, product (`MARGIN`), order_type (`LIMIT`), qty, limit_price, filled_qty, avg_fill_price, status, reject_reason, reprice_count, created_at, updated_at |
| `positions` | id, mode, symbol, exchange, token, qty, avg_price, deployed_amount, margin_per_share, status (`OPEN`/`EXITING`/`CLOSED`), entry_order_id, opened_at |
| `trades` | id, mode, position_id, symbol, qty, entry_price, exit_price, deployed_amount, realised_pnl, pnl_pct, opened_at, closed_at, exit_order_id |
| `events` | id, ts, level (INFO/WARN/ERROR), category (webhook/engine/broker/system), message, data JSON |

Alert `status` values: `EXECUTED` (BUY order filled), `SQUARED_OFF` (SELL filled), `PENDING` (order working), `DUPLICATE`, `IGNORED` (e.g. SELL with no position, BUY on held stock), `REJECTED` (guard failed), `FAILED` (broker error or unfilled).

## 6. Engine rules

### 6.1 Guards (evaluated in this order; first failure stops)
1. Automation ON (kill switch off).
2. Market open: Mon-Fri 09:15-15:30 IST (exchange holidays are rejected by the broker and logged).
3. Duplicate: same symbol + action within `duplicate_window_sec` (default 60) -> DUPLICATE.
4. BUY only: not already holding the symbol (one position per stock) -> IGNORED; open positions < `max_open_positions`; deployed + working + this trade <= `capital_cap`; symbol resolves to NSE/BSE `-EQ`.
5. SELL only: an OPEN position exists for the symbol in the current mode -> else IGNORED. A position already EXITING -> IGNORED "Exit already in progress" (never a second SELL order; prevents overselling).

Test alerts (`POST /api/webhook/test`, Paper only) run the same guards except market hours, so setup and training can be done after 15:30.

Every evaluated guard is appended to `alerts.checks`, so the Alerts screen shows exactly why an alert did or did not trade.

### 6.2 Sizing (`engine/sizing.py`)
- `limit_price = round_to_tick(ltp * (1 + buffer))` for BUY, `(1 - buffer)` for SELL; clamped inside the day's circuit band when the quote provides it. Default buffer 0.3 %.
- **Mode `margin` (default):** margin_per_share from Angel margin API (`productType: MARGIN`, qty probe), `qty = floor(amount / margin_per_share)`; re-verify total margin for `qty` <= amount and <= available funds (`rmsLimit`), step down if not. Deployed amount = margin for the filled qty.
- **Mode `value`:** `qty = floor(amount / limit_price)`; deployed amount = qty x fill price.
- PAPER without a broker session: `margin_per_share = price * paper_margin_pct` (default 25 %), shown as "paper estimate" in the order row.
- qty < 1 -> REJECTED "Amount too small for one share".

### 6.3 BUY flow
LIMIT BUY, product `MARGIN`, `ordertag` = alert id. Tracker polls every 2 s. Filled -> position OPEN. Not filled in `buy_fill_timeout_sec` (default 30) -> cancel; partial fill keeps the filled qty as the position; zero fill -> alert FAILED "Not filled in 30 s, cancelled".

### 6.4 SELL flow (quotation: "squares off that MTF position in full")
Position -> EXITING, LIMIT SELL full qty, product `MARGIN`. Not filled in `sell_reprice_interval_sec` (default 15) -> modify to fresh LTP - buffer, up to `sell_reprice_attempts` (default 3). Still open -> keeps tracking, ERROR event, dashboard banner "Exit pending: <symbol>". On fill: position CLOSED, trade row with realised P&L = qty x (exit - entry).

### 6.5 Kill switch
Automation OFF: new alerts are stored as REJECTED "Automation OFF"; all working orders are cancelled; open positions are **not** sold (quotation: "stop all automation").

### 6.6 Mode switch
PAPER -> LIVE requires: broker connected with a valid session, the operator ticks "this PC's public IP is registered in my SmartAPI app", and no working orders. Positions/trades carry their `mode`; each mode's views show only its own rows.

## 7. Frontend

Plain HTML/CSS/ES modules in `web/`, served as static files by the dashboard app. No framework, no build, no CDN at runtime (fonts and icons vendored).

- `web/assets/js/config.js` sets `mode: 'demo' | 'live'`. `demo` uses `mock/server.js`, which implements the same API contract with realistic in-memory data and a price random walk; a permanent "Demo data" badge is shown. There is **no automatic fallback** from live to demo.
- All markup goes through the auto-escaping `html` tagged template (`lib/html.js`); webhook-supplied strings can never inject HTML.
- Live updates: `EventSource('/api/events')`; LTP ticks patch existing table cells in place (same DOM nodes), not full re-renders.
- Themes: light (reference) default, dark toggle, stored in `localStorage`; tokens in `tokens.css`. Radius rule: cards 12 px, inputs and buttons 8 px, pills full.

### 7.1 Screens (quotation mapping)

| Screen | Content | Quotation |
|---|---|---|
| Dashboard | 4 KPIs (capital deployed vs cap, running positions vs max, realised P&L today, available margin), open MTF positions with live P&L, recent alerts, live pipeline status (indicator alert, webhook, qty calc, MTF order, square-off) | 6, 7 |
| Positions | Tracked MTF positions (qty, avg, LTP, deployed, value, P&L, P&L %); broker view tab (LIVE) with mismatch flag; totals | 5, 7 |
| Alerts | Every alert, filters (action, status, date, search), detail drawer with raw payload and guard trace, Excel export | 1, 6, 7 |
| Orders | Software orders (LIMIT, MTF, fills, re-prices, reasons) and broker order book tab, Excel export | 2, 7 |
| Trade History | Closed trades with realised P&L, date filter, totals, Excel export | 4, 7 |
| Settings | Trading rules (amount per trade, qty mode, max positions, capital cap), execution (buffer, timeouts, re-price), risk and safety toggles, trading mode, webhook URL/secret/alert templates, paper test alert | 3, 6, 8 |
| Broker | Angel One credentials (client ID, API key, MPIN, TOTP secret), connect/test/disconnect, session info, funds, public IP for static-IP registration | 9 |
| Logs | System events with level/category filters | 7 |
| Help & Support | Setup checklist, alert format, rejection reasons, support contact and AMC note | 10, AMC |

Global: sidebar with automation (kill switch) switch, top bar with market status, PAPER/LIVE, broker status, IST clock, theme toggle.

## 8. API contract (dashboard port 8000)

Product label: every API `product` value for software orders is the display label `"MTF"`; only the Angel adapter translates it to SmartAPI `producttype: "MARGIN"`.

Envelope: `{"ok": true, "data": ..., "error": null}` / `{"ok": false, "data": null, "error": {"code": "...", "message": "..."}}`. Money in rupees as numbers, times ISO-8601 with +05:30.

| Method | Path | Data |
|---|---|---|
| GET | `/api/status` | automation{on}, mode, market{open, label}, broker{name, connected, client_code_masked, session_valid_till}, webhook{public_url, tunnel_up, last_alert_at}, engine{queue_depth, working_orders}, exit_pending[], server_time, version |
| GET | `/api/dashboard` | kpis{capital_deployed, capital_cap, open_positions, max_positions, realised_pnl_today, unrealised_pnl, available_margin, margin_source}, positions[], recent_alerts[], pipeline{...} |
| GET | `/api/positions?source=tracked\|broker` | items[{id, symbol, exchange, qty, avg_price, ltp, deployed, value, pnl, pnl_pct, opened_at, status, mismatch}], totals{deployed, unrealised, realised_today}. Broker-source items add `product` ("MTF"/"CNC"/...) and `note`, and use `deployed: null`, `opened_at: null` |
| GET | `/api/alerts?action=&status=&date_from=&date_to=&q=` | items[{id, received_at, symbol, exchange, action, status, action_taken, detail, order_id}], counts{} |
| GET | `/api/alerts/{id}` | alert + raw_payload + checks[{name, ok, detail}] + order |
| GET | `/api/orders?source=software\|broker&status=` | items[{id, created_at, broker_order_id, symbol, side, product, order_type, qty, limit_price, filled_qty, avg_price, status, reason, reprice_count, alert_id}] |
| GET | `/api/trades?date_from=&date_to=` | items[{id, symbol, qty, entry_price, exit_price, deployed, pnl, pnl_pct, opened_at, closed_at}], totals{count, net_pnl, deployed} |
| GET/PUT | `/api/settings` | settings object (section 5); PUT validates and returns field errors `{field: message}` |
| POST | `/api/automation` | `{on: bool}` |
| POST | `/api/mode` | `{mode, ip_confirmed}`; 409 with blocker list when not allowed |
| GET | `/api/broker` | configured, connected, client_code_masked, api_key_masked, last_login_at, session_valid_till, funds{available, used, net}, public_ip, last_error |
| PUT | `/api/broker/credentials` | `{client_code, api_key, mpin, totp_secret}` (write-only; never returned) |
| POST | `/api/broker/connect`, `/api/broker/disconnect` | status |
| GET | `/api/webhook` | public_url, tunnel_up, secret_masked, template_buy, template_sell (templates carry the **masked** secret; the Copy button calls `/reveal` and substitutes the real one) |
| POST | `/api/webhook/reveal`, `/api/webhook/rotate` | `{secret}` |
| POST | `/api/webhook/test` | `{symbol, action}`; PAPER only; injects into the same pipeline |
| GET | `/api/logs?level=&category=&q=` | items[{id, ts, level, category, message, data}] |
| GET | `/api/export/{alerts\|orders\|trades}.xlsx?date_from=&date_to=` | file |
| GET | `/api/events` | SSE: `status`, `alert`, `order`, `position`, `trade`, `tick` ({symbol: ltp}), `log` |

## 9. Angel One integration

- Documented SmartAPI REST endpoints called directly with `httpx` + `pyotp` (the `smartapi-python` SDK hides HTTP status and raw bodies, which the rate-limit and timeout rules below depend on). Login `loginByPassword(clientcode, MPIN, TOTP)` at startup, daily 08:45 IST, and on session errors.
- Endpoints: `order/v1/placeOrder`, `order/v1/modifyOrder`, `order/v1/cancelOrder`, `order/v1/getOrderBook` (one call per tracker tick serves every working order and `ordertag` lookups), `order/v1/getPosition`, `portfolio/v1/getAllHolding`, `user/v1/getRMS`, `market/v1/quote` (FULL, up to 50 tokens), `margin/v1/batch`.
- Order params: `variety NORMAL`, `ordertype LIMIT`, `producttype MARGIN`, `duration DAY`, `ordertag` = alert id.
- Rate limits enforced client-side per endpoint (orders <= 10/s exchange cap, order book and quote 1/s). Rate-limit signals come in two shapes and both trigger an escalating cooldown (45 -> 90 -> 180 s): HTTP 403 plain text "exceeding access rate" and HTTP 200 JSON `errorcode: AB1021`. Session errors `AG8001/AG8002/AG8003` trigger relogin with escalating backoff (60 s -> 5 m -> 15 m -> 30 m), never a tight loop.
- `placeOrder` is never blindly retried. On timeout the order book is searched by `ordertag` before any retry decision.
- Static IP: orders only execute from the primary static IP registered in the SmartAPI app (Angel, from 1-Apr-2026; at most one change per week). Data APIs are not covered by that rule.
- **Unverified until the first live test on the client account:** that `producttype MARGIN` with LIMIT places an MTF buy, and that a next-day MTF holding squares off with `MARGIN` SELL. First live test = 1 share BUY then SELL, in market hours.

## 10. Security

- Dashboard on 127.0.0.1 only; the tunnel forwards only port 8001, which serves only `POST /webhook`.
- Broker secrets and webhook secret encrypted at rest (Fernet); key file `data/secret.key` (git-ignored, created on first run). Credentials are write-only through the API and masked on read.
- Webhook: constant-time secret compare, 4 KB body cap, 60/min rate limit, schema validation, no reflection of input in responses.
- Frontend: auto-escaping templates, no `innerHTML` with raw strings, no inline scripts or event handlers. CSP from the dashboard app: `default-src 'self'; style-src 'self' 'unsafe-inline'` (inline `style` attributes are used for widths/meters; scripts stay strictly `'self'`).
- Excel/CSV export: any cell starting with `= + - @` (and not a plain number) is prefixed with `'` so spreadsheet software never evaluates it as a formula (symbols and reasons can come from webhook input).

## 11. Error handling

- Every broker error is stored on the order/alert with the broker's message and written to `events`.
- No silent fallbacks: missing LTP, margin API failure or session loss produce a visible reason on the alert and a WARN/ERROR event, never a guessed value (paper estimate is labelled as such).
- Engine exceptions never kill the worker: the alert is marked FAILED with the exception summary and the loop continues.

## 12. Testing

- **Unit (pytest):** schema/validation, ticker mapping, each guard, sizing both modes (tick rounding, circuit clamp, step-down), exit re-pricing, kill switch, mode-switch blockers, crypto round-trip.
- **Integration:** FastAPI TestClient: webhook -> worker -> PaperBroker -> position -> SELL -> trade with P&L; duplicate and cap scenarios; AngelBroker against mocked HTTP with real error shapes (AB1021 200-JSON, 403 plain text, AG8001).
- **E2E:** Playwright headless over the demo frontend and over the paper backend: each screen renders at 1440 and 768 px in both themes, no console errors, LTP ticks update the same DOM nodes.
- **Live (client account, market hours, never on weekends):** 1-share MTF BUY and SELL; real TradingView alert through ngrok.
- Coverage target 80 %.

## 13. Installation and client prerequisites

`scripts/install.bat` (Python 3.12 venv, requirements incl. `tzdata`), `scripts/start.bat` (starts app + ngrok with the permanent domain, opens the dashboard). Client provides: Angel account with MTF activated; SmartAPI app with the PC's static IP registered; TOTP enabled; free ngrok account (authtoken + domain); TradingView 2FA on and a plan with webhook alerts; indicator alerts set to the JSON above.

## 14. Open items

- Static IP source for the client PC: ISP static IP (recommended, no code) or a static-IP proxy (needs a proxy URL setting). Client/Rahul to decide.
- Whether the client's indicator allows a custom alert message (alertcondition/alert). If not, the parser must adapt to its fixed text (quotation: format finalised before development).
