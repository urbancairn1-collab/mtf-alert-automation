// In-browser mock backend implementing the spec section 8 contract.
import { createState, STOCKS, tick } from './data.js';
import { buildLogs, logEntry } from './logs.js';
import { processTestAlert } from './engine.js';
import { validateSettings, validateCredentials, blockersForLive } from './rules.js';
import { toCsv } from './csv.js';
import { ApiError } from '../lib/api.js';
import { istParts, dayKey } from '../lib/format.js';

const state = createState();
state.logs = buildLogs(state);
const subscribers = new Set();
const publish = (type, payload) => subscribers.forEach((fn) => fn(type, payload));
const delay = () => new Promise((r) => setTimeout(r, 120 + Math.random() * 180));
const round2 = (n) => Math.round(n * 100) / 100;

function marketStatus(d = new Date()) {
  const { weekday, minutes } = istParts(d);
  const weekend = weekday === 'Sat' || weekday === 'Sun';
  const open = !weekend && minutes >= 555 && minutes < 930;
  return { open, label: open ? 'Market open' : weekend ? 'Market closed (weekend)' : 'Market closed' };
}

function enrich(p) {
  const ltp = state.ltp[p.symbol];
  const pnl = round2(p.qty * (ltp - p.avg_price));
  return { ...p, ltp, value: round2(p.qty * ltp), pnl, pnl_pct: round2(((ltp - p.avg_price) / p.avg_price) * 100), mismatch: false };
}

const todayTrades = () => state.trades.filter((t) => t.closed_at.slice(0, 10) === state.sessionDay);
const sum = (rows, key) => round2(rows.reduce((s, r) => s + r[key], 0));
const mask = (s) => `${'*'.repeat(Math.max(0, s.length - 4))}${s.slice(-4)}`;

function status() {
  return {
    automation: { on: state.settings.automation_on }, mode: state.settings.mode, market: marketStatus(),
    broker: { name: state.broker.name, connected: state.broker.connected, client_code_masked: state.broker.client_code_masked, session_valid_till: state.broker.session_valid_till },
    webhook: { public_url: state.webhook.public_url, tunnel_up: state.webhook.tunnel_up, last_alert_at: state.alerts.at(-1)?.received_at },
    engine: { queue_depth: 0, working_orders: state.orders.filter((o) => o.status === 'OPEN').length },
    exit_pending: state.positions.filter((p) => p.status === 'EXITING').map((p) => p.symbol),
    server_time: new Date().toISOString(), version: '1.0.0',
  };
}

function dashboard() {
  const positions = state.positions.map(enrich);
  return {
    kpis: {
      capital_deployed: sum(positions, 'deployed'), capital_cap: state.settings.capital_cap,
      open_positions: positions.length, max_positions: state.settings.max_open_positions,
      realised_pnl_today: sum(todayTrades(), 'pnl'), unrealised_pnl: sum(positions, 'pnl'),
      available_margin: state.broker.connected ? state.broker.funds.available : null, margin_source: 'Angel One RMS',
    },
    positions, recent_alerts: [...state.alerts].reverse().slice(0, 8),
    pipeline: { last_alert_at: state.alerts.at(-1)?.received_at, webhook_up: state.webhook.tunnel_up, amount_per_trade: state.settings.amount_per_trade, sizing_mode: state.settings.sizing_mode, broker: state.broker.name, broker_connected: state.broker.connected, mode: state.settings.mode, trades_today: todayTrades().length },
  };
}

const BROKER_HOLDINGS = [
  { id: 'BH1', symbol: 'ITC', exchange: 'NSE', qty: 120, avg_price: 401.2, product: 'CNC', note: 'Delivery holding (not managed by MTF Trader)' },
  { id: 'BH2', symbol: 'SBIN', exchange: 'NSE', qty: 35, avg_price: 818.4, product: 'MTF', note: 'MTF holding bought outside the software' },
];
const BROKER_ORDERS = [
  { id: 'BO1', created_at: `${state.sessionDay}T10:31:12+05:30`, broker_order_id: `${state.sessionDay.slice(2).replaceAll('-', '')}000418820`, symbol: 'ITC', side: 'BUY', product: 'CNC', order_type: 'LIMIT', qty: 20, limit_price: 409.5, filled_qty: 20, avg_price: 409.45, status: 'COMPLETE', reason: 'Placed from Angel One app', reprice_count: 0 },
];

function positions({ source = 'tracked' }) {
  if (source === 'broker') {
    const items = BROKER_HOLDINGS.map((h) => enrich({ ...h, deployed: null, ltp: STOCKS[h.symbol].ltp }));
    return { items, totals: { deployed: null, unrealised: sum(items, 'pnl'), realised_today: null } };
  }
  const items = state.positions.map(enrich);
  return { items, totals: { deployed: sum(items, 'deployed'), unrealised: sum(items, 'pnl'), realised_today: sum(todayTrades(), 'pnl') } };
}

function inRange(iso, from, to) {
  const d = dayKey(new Date(iso));
  return (!from || d >= from) && (!to || d <= to);
}

function alerts(q) {
  const base = [...state.alerts].reverse().filter((a) => inRange(a.received_at, q.date_from, q.date_to));
  const items = base.filter((a) => (!q.action || a.action === q.action) && (!q.status || a.status === q.status) && (!q.q || a.symbol.includes(q.q.toUpperCase())));
  const counts = { all: base.length, BUY: base.filter((a) => a.action === 'BUY').length, SELL: base.filter((a) => a.action === 'SELL').length };
  return { items, counts };
}

function alertById(id) {
  const a = state.alerts.find((x) => x.id === id);
  if (!a) throw new ApiError('not_found', `Alert ${id} not found`);
  return { ...a, order: state.orders.find((o) => o.id === a.order_id) || null };
}

function orders({ source = 'software', status: st }) {
  const rows = source === 'broker' ? BROKER_ORDERS : [...state.orders].reverse();
  return { items: rows.filter((o) => !st || o.status === st) };
}

function trades(q) {
  const items = [...state.trades].reverse().filter((t) => inRange(t.closed_at, q.date_from, q.date_to));
  return { items, totals: { count: items.length, net_pnl: sum(items, 'pnl'), deployed: sum(items, 'deployed') } };
}

function putSettings(body) {
  const { errors, value } = validateSettings({ ...state.settings, ...body });
  if (errors) throw new ApiError('validation', 'Please fix the highlighted fields.', errors);
  Object.assign(state.settings, value);
  logEntry(state, 'INFO', 'system', 'Settings saved.');
  publish('status', {});
  return state.settings;
}

function setAutomation({ on }) {
  state.settings.automation_on = Boolean(on);
  if (!on) state.orders.filter((o) => o.status === 'OPEN').forEach((o) => { o.status = 'CANCELLED'; o.reason = 'Cancelled by kill switch'; });
  logEntry(state, on ? 'INFO' : 'WARN', 'engine', on ? 'Automation turned ON.' : 'Kill switch: automation OFF. Working orders cancelled. Positions kept.');
  publish('status', {});
  return status();
}

function setMode({ mode, ip_confirmed }) {
  if (mode === 'LIVE') {
    const blockers = blockersForLive({ broker: state.broker, ipConfirmed: ip_confirmed, workingOrders: status().engine.working_orders });
    if (blockers.length) throw new ApiError('blocked', 'Live mode is not allowed yet.', { blockers });
  }
  state.settings.mode = mode === 'LIVE' ? 'LIVE' : 'PAPER';
  logEntry(state, 'WARN', 'system', `Trading mode set to ${state.settings.mode}.`);
  publish('status', {});
  return status();
}

function broker() {
  const { funds, ...rest } = state.broker;
  return { ...rest, funds: rest.connected ? funds : null };
}

function putCredentials(body) {
  const errors = validateCredentials(body);
  if (errors) throw new ApiError('validation', 'Please fix the highlighted fields.', errors);
  Object.assign(state.broker, { configured: true, client_code_masked: `${body.client_code.slice(0, 2)}****${body.client_code.slice(-2)}`, api_key_masked: mask(body.api_key) });
  logEntry(state, 'INFO', 'broker', 'Angel One credentials saved (encrypted).');
  return broker();
}

function connectBroker(on) {
  if (on && !state.broker.configured) throw new ApiError('not_configured', 'Save your Angel One credentials first.');
  Object.assign(state.broker, { connected: on, last_login_at: on ? new Date().toISOString() : state.broker.last_login_at, last_error: null });
  logEntry(state, on ? 'INFO' : 'WARN', 'broker', on ? 'Angel One login OK with TOTP.' : 'Angel One disconnected by user.');
  publish('status', {});
  return broker();
}

function template(action) {
  return JSON.stringify({ secret: mask(state.webhook.secret), symbol: '{{ticker}}', exchange: '{{exchange}}', action, price: '{{close}}', time: '{{timenow}}' }, null, 2).replace('"{{close}}"', '{{close}}');
}

function webhook() {
  return { public_url: state.webhook.public_url, tunnel_up: state.webhook.tunnel_up, secret_masked: mask(state.webhook.secret), template_buy: template('BUY'), template_sell: template('SELL'), last_alert_at: state.alerts.at(-1)?.received_at };
}

function rotateSecret() {
  state.webhook.secret = `mtf_${Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('')}`;
  logEntry(state, 'WARN', 'webhook', 'Webhook secret rotated. Update the alert message in TradingView.');
  return { secret: state.webhook.secret };
}

function testAlert({ symbol, action }) {
  if (state.settings.mode !== 'PAPER') throw new ApiError('paper_only', 'Test alerts are only allowed in Paper mode.');
  if (!['BUY', 'SELL'].includes(action)) throw new ApiError('validation', 'Action must be BUY or SELL.');
  const alert = processTestAlert(state, { symbol: String(symbol || '').toUpperCase(), action }, publish);
  logEntry(state, 'INFO', 'webhook', `Test alert: ${action} ${alert.symbol} -> ${alert.status}`);
  publish('alert', alert); publish('status', {});
  return alert;
}

function logs(q) {
  const items = state.logs.filter((l) => (!q.level || l.level === q.level) && (!q.category || l.category === q.category) && (!q.q || l.message.toLowerCase().includes(q.q.toLowerCase())));
  return { items };
}

const ROUTES = [
  ['GET', /^\/api\/status$/, () => status()],
  ['GET', /^\/api\/dashboard$/, () => dashboard()],
  ['GET', /^\/api\/positions$/, (q) => positions(q)],
  ['GET', /^\/api\/alerts$/, (q) => alerts(q)],
  ['GET', /^\/api\/alerts\/([\w-]+)$/, (q, b, m) => alertById(m[1])],
  ['GET', /^\/api\/orders$/, (q) => orders(q)],
  ['GET', /^\/api\/trades$/, (q) => trades(q)],
  ['GET', /^\/api\/settings$/, () => ({ ...state.settings })],
  ['PUT', /^\/api\/settings$/, (q, b) => putSettings(b)],
  ['POST', /^\/api\/automation$/, (q, b) => setAutomation(b)],
  ['POST', /^\/api\/mode$/, (q, b) => setMode(b)],
  ['GET', /^\/api\/broker$/, () => broker()],
  ['PUT', /^\/api\/broker\/credentials$/, (q, b) => putCredentials(b)],
  ['POST', /^\/api\/broker\/connect$/, () => connectBroker(true)],
  ['POST', /^\/api\/broker\/disconnect$/, () => connectBroker(false)],
  ['GET', /^\/api\/webhook$/, () => webhook()],
  ['POST', /^\/api\/webhook\/reveal$/, () => ({ secret: state.webhook.secret })],
  ['POST', /^\/api\/webhook\/rotate$/, () => rotateSecret()],
  ['POST', /^\/api\/webhook\/test$/, (q, b) => testAlert(b)],
  ['GET', /^\/api\/logs$/, (q) => logs(q)],
];

function startTicker() {
  return setInterval(() => {
    if (document.hidden) return;
    const moved = {};
    new Set(state.positions.map((p) => p.symbol)).forEach((s) => {
      state.ltp[s] = tick(state.ltp[s] * (1 + (Math.random() - 0.485) * 0.0018));
      moved[s] = state.ltp[s];
    });
    if (Object.keys(moved).length) publish('tick', moved);
  }, 2000);
}

let ticker = null;
export const mockBackend = {
  async request(method, pathWithQuery, body) {
    await delay();
    const [path, qs = ''] = pathWithQuery.split('?');
    const params = Object.fromEntries(new URLSearchParams(qs));
    const route = ROUTES.find(([m, re]) => m === method && re.test(path));
    if (!route) throw new ApiError('not_found', `No mock route for ${method} ${path}`);
    return structuredClone(route[2](params, body || {}, path.match(route[1])));
  },
  subscribe(onEvent) {
    subscribers.add(onEvent);
    if (!ticker) ticker = startTicker();
    return () => subscribers.delete(onEvent);
  },
  download(pathWithQuery) {
    const [path, qs = ''] = pathWithQuery.split('?');
    const kind = path.match(/export\/(alerts|orders|trades)/)?.[1];
    const q = Object.fromEntries(new URLSearchParams(qs));
    const rows = { alerts: () => alerts(q).items, orders: () => orders(q).items, trades: () => trades(q).items }[kind]();
    const blob = new Blob([toCsv(kind, rows)], { type: 'text/csv;charset=utf-8' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `mtf-${kind}-${dayKey()}.csv` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  },
};
