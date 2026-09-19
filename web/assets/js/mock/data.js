// Demo dataset for the in-browser mock backend. Every number is derived, not typed:
// qty = floor(amount / margin_per_share), deployed = qty * price * margin%, P&L = qty * (exit - entry).
// Prices, tokens and margin percentages are sample values for demonstration only.
import { money, money0, signedMoney } from '../lib/format.js';

export const STOCKS = {
  RELIANCE: { token: '2885', ltp: 1418.6, m: 0.25 },
  TCS: { token: '11536', ltp: 3126.4, m: 0.25 },
  INFY: { token: '1594', ltp: 1512.3, m: 0.25 },
  HDFCBANK: { token: '1333', ltp: 986.5, m: 0.25 },
  ICICIBANK: { token: '4963', ltp: 1402.1, m: 0.25 },
  SBIN: { token: '3045', ltp: 842.7, m: 0.3 },
  LT: { token: '11483', ltp: 3612.0, m: 0.3 },
  BHARTIARTL: { token: '10604', ltp: 1905.4, m: 0.3 },
  ITC: { token: '1660', ltp: 412.35, m: 0.3 },
  SUNPHARMA: { token: '3351', ltp: 1634.8, m: 0.35 },
  AXISBANK: { token: '5900', ltp: 1168.25, m: 0.3 },
};

export const DEFAULT_SETTINGS = {
  amount_per_trade: 10000,
  sizing_mode: 'margin',
  capital_cap: 100000,
  max_open_positions: 5,
  one_position_per_stock: true,
  duplicate_protection: true,
  duplicate_window_sec: 60,
  limit_buffer_pct: 0.3,
  buy_fill_timeout_sec: 30,
  sell_reprice_attempts: 3,
  sell_reprice_interval_sec: 15,
  stale_alert_sec: 120,
  paper_margin_pct: 25,
  mode: 'PAPER',
  automation_on: true,
};

const round2 = (n) => Math.round(n * 100) / 100;
export const tick = (n) => Math.round(n * 20) / 20;

// Most recent weekday (IST) as YYYY-MM-DD, plus `back` earlier weekdays.
export function tradingDays(count, from = new Date()) {
  const days = [];
  const d = new Date(from.getTime() + 5.5 * 3600e3);
  while (days.length < count) {
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) days.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return days;
}
export const ist = (day, hms) => `${day}T${hms}+05:30`;

export function sizeFor(symbol, price, amount) {
  const marginPerShare = price * STOCKS[symbol].m;
  const qty = Math.floor(amount / marginPerShare);
  return { qty, deployed: round2(qty * marginPerShare), marginPerShare: round2(marginPerShare) };
}

let seq = 0;
const nextId = (prefix) => `${prefix}${String(++seq).padStart(4, '0')}`;

// One scripted session. Each step becomes an alert, and fills become orders/positions/trades.
const SESSION = [
  { t: '09:02:15', a: 'BUY', s: 'AXISBANK', outcome: 'REJECTED', reason: 'Market closed. NSE opens at 09:15 IST.' },
  { t: '09:21:07', a: 'BUY', s: 'RELIANCE', fill: 1412.4 },
  { t: '09:34:52', a: 'BUY', s: 'TCS', fill: 3108.9 },
  { t: '09:35:18', a: 'BUY', s: 'TCS', outcome: 'DUPLICATE', reason: 'Same BUY for TCS 26 s ago (window 60 s).' },
  { t: '09:48:30', a: 'BUY', s: 'NIFTY', outcome: 'REJECTED', reason: 'NIFTY is an index. Only NSE/BSE equity (-EQ) stocks can be bought in MTF.' },
  { t: '10:05:12', a: 'BUY', s: 'INFY', fill: 1498.2 },
  { t: '10:42:44', a: 'BUY', s: 'ICICIBANK', fill: 1389.5 },
  { t: '11:15:03', a: 'SELL', s: 'INFY', fill: 1519.6 },
  { t: '11:40:26', a: 'SELL', s: 'SBIN', outcome: 'IGNORED', reason: 'No open MTF position in SBIN. Nothing to square off.' },
  { t: '12:12:40', a: 'BUY', s: 'HDFCBANK', unfilled: 981.35 },
  { t: '12:30:09', a: 'BUY', s: 'HDFCBANK', fill: 979.85 },
  { t: '13:05:55', a: 'BUY', s: 'LT', fill: 3590.4 },
  { t: '13:52:10', a: 'SELL', s: 'LT', fill: 3571.0, reprice: 1 },
  { t: '14:02:31', a: 'BUY', s: 'RELIANCE', outcome: 'IGNORED', reason: 'Already holding RELIANCE (one open position per stock).' },
  { t: '14:20:18', a: 'BUY', s: 'BHARTIARTL', fill: 1897.7 },
  { t: '14:46:02', a: 'BUY', s: 'ITC', outcome: 'REJECTED', reason: 'Max open positions reached (5 of 5).' },
  { t: '15:02:37', a: 'SELL', s: 'ICICIBANK', fill: 1408.3 },
];

// Closed trades from earlier sessions: [daysBack, symbol, entry, exit, openT, closeT]
const HISTORY = [
  [1, 'SUNPHARMA', 1612.4, 1641.9, '10:14:22', '14:31:05'],
  [1, 'SBIN', 836.15, 829.4, '09:47:10', '13:12:44'],
  [2, 'AXISBANK', 1149.8, 1171.35, '11:03:39', '15:05:16'],
  [2, 'ITC', 409.9, 414.55, '09:28:51', '12:40:02'],
  [3, 'TCS', 3068.2, 3097.75, '10:22:18', '14:58:40'],
  [4, 'RELIANCE', 1396.3, 1388.1, '09:39:06', '11:57:31'],
  [4, 'BHARTIARTL', 1871.5, 1893.2, '12:08:47', '15:11:09'],
];

function makeOrder(state, { day, t, a, s, price, qty, status, filledQty, reason, alertId, reprice = 0 }) {
  const order = {
    id: nextId('O'), created_at: ist(day, t), broker_order_id: `PAPER-${String(seq).padStart(6, '0')}`,
    symbol: s, token: STOCKS[s].token, side: a, product: 'MTF', order_type: 'LIMIT', qty,
    limit_price: price, filled_qty: filledQty, avg_price: filledQty ? price : null,
    status, reason: reason || '', reprice_count: reprice, alert_id: alertId, mode: 'PAPER',
  };
  state.orders.push(order);
  return order;
}

function checksFor(step, extra = []) {
  const base = [
    { name: 'Secret and format', ok: true, detail: 'Valid JSON, secret matched' },
    { name: 'Automation ON', ok: true, detail: 'Kill switch is off' },
  ];
  return [...base, ...extra];
}

function applyStep(state, day, step, settings) {
  const alert = {
    id: nextId('A'), received_at: ist(day, step.t), source_ip: '52.89.214.238', symbol: step.s, exchange: 'NSE',
    action: step.a, alert_price: step.fill ?? step.unfilled ?? null, status: '', action_taken: '', detail: '', order_id: null,
    raw_payload: { secret: '********', symbol: step.s, exchange: 'NSE', action: step.a, price: step.fill ?? step.unfilled ?? null, time: ist(day, step.t) },
    checks: [],
  };
  state.alerts.push(alert);
  if (step.outcome) return rejectStep(alert, step);
  return step.a === 'BUY' ? buyStep(state, day, step, alert, settings) : sellStep(state, day, step, alert);
}

function rejectStep(alert, step) {
  const label = { REJECTED: 'Rejected', DUPLICATE: 'Duplicate', IGNORED: 'Ignored' }[step.outcome];
  Object.assign(alert, { status: step.outcome, action_taken: 'No order', detail: step.reason });
  alert.checks = checksFor(step, [{ name: label, ok: false, detail: step.reason }]);
}

function buyStep(state, day, step, alert, settings) {
  const px = step.fill ?? step.unfilled;
  const { qty, deployed, marginPerShare } = sizeFor(step.s, px, settings.amount_per_trade);
  const checks = [
    { name: 'Market open', ok: true, detail: 'NSE session 09:15-15:30 IST' },
    { name: 'Not a duplicate', ok: true, detail: 'No same alert in last 60 s' },
    { name: 'One position per stock', ok: true, detail: `No open ${step.s} position` },
    { name: 'Capital cap', ok: true, detail: `Within ${money0(settings.capital_cap)} cap` },
    { name: 'Qty from amount', ok: true, detail: `${money0(settings.amount_per_trade)} / ${money(marginPerShare)} MTF margin per share = ${qty}` },
  ];
  alert.checks = checksFor(step, checks);
  if (step.unfilled) {
    const o = makeOrder(state, { day, t: step.t, a: 'BUY', s: step.s, price: px, qty, status: 'CANCELLED', filledQty: 0, reason: 'Not filled in 30 s, cancelled', alertId: alert.id });
    Object.assign(alert, { status: 'FAILED', action_taken: 'Order cancelled', detail: 'Limit order not filled in 30 s. Cancelled.', order_id: o.id });
    return;
  }
  const o = makeOrder(state, { day, t: step.t, a: 'BUY', s: step.s, price: px, qty, status: 'COMPLETE', filledQty: qty, alertId: alert.id });
  Object.assign(alert, { status: 'EXECUTED', action_taken: 'MTF buy placed', detail: `${money(deployed)} | Qty ${qty}`, order_id: o.id });
  state.positions.push({ id: nextId('P'), symbol: step.s, exchange: 'NSE', token: STOCKS[step.s].token, qty, avg_price: px, deployed, margin_per_share: marginPerShare, opened_at: ist(day, step.t), status: 'OPEN', mode: 'PAPER' });
}

function sellStep(state, day, step, alert) {
  const pos = state.positions.find((p) => p.symbol === step.s && p.status === 'OPEN');
  const o = makeOrder(state, { day, t: step.t, a: 'SELL', s: step.s, price: step.fill, qty: pos.qty, status: 'COMPLETE', filledQty: pos.qty, alertId: alert.id, reprice: step.reprice || 0, reason: step.reprice ? `Re-priced ${step.reprice}x before fill` : '' });
  const pnl = round2(pos.qty * (step.fill - pos.avg_price));
  alert.checks = checksFor(step, [{ name: 'Open position exists', ok: true, detail: `${pos.qty} ${step.s} held` }]);
  Object.assign(alert, { status: 'SQUARED_OFF', action_taken: 'Squared off', detail: `P&L ${signedMoney(pnl)}`, order_id: o.id });
  state.positions = state.positions.filter((p) => p !== pos);
  state.trades.push(tradeRow(pos, step.fill, ist(day, step.t), pos.opened_at));
}

function tradeRow(pos, exit, closedAt, openedAt) {
  const pnl = round2(pos.qty * (exit - pos.avg_price));
  return {
    id: nextId('T'), symbol: pos.symbol, qty: pos.qty, entry_price: pos.avg_price, exit_price: exit,
    deployed: pos.deployed, pnl, pnl_pct: round2(((exit - pos.avg_price) / pos.avg_price) * 100),
    opened_at: openedAt, closed_at: closedAt, mode: 'PAPER',
  };
}

function historyTrades(days, settings) {
  return HISTORY.map(([back, s, entry, exit, t1, t2]) => {
    const { qty, deployed } = sizeFor(s, entry, settings.amount_per_trade);
    return tradeRow({ symbol: s, qty, avg_price: entry, deployed }, exit, ist(days[back], t2), ist(days[back], t1));
  });
}

export function createState() {
  seq = 0;
  const settings = { ...DEFAULT_SETTINGS };
  const days = tradingDays(6);
  const state = { settings, alerts: [], orders: [], positions: [], trades: [], logs: [], ltp: {} };
  Object.entries(STOCKS).forEach(([s, v]) => { state.ltp[s] = v.ltp; });
  SESSION.forEach((step) => applyStep(state, days[0], step, settings));
  state.trades = [...historyTrades(days, settings), ...state.trades];
  state.sessionDay = days[0];
  state.broker = {
    configured: true, connected: true, name: 'Angel One', client_code_masked: 'A1****89', api_key_masked: '********Xk2P',
    last_login_at: ist(days[0], '08:45:03'), session_valid_till: ist(days[0], '23:59:00'),
    funds: { available: 184250.4, used: 39640.15, net: 223890.55 }, public_ip: '49.36.xx.xx (demo)', last_error: null,
  };
  state.webhook = { public_url: 'https://your-name.ngrok-free.dev/webhook', tunnel_up: true, secret: 'mtf_4f9a2c7e81d3b6', last_alert_at: state.alerts.at(-1).received_at };
  return state;
}
