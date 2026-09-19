// Mini paper engine for the demo "Send test alert" button. It follows spec section 6
// (guard order, sizing, LIMIT orders, full square-off) so the demo behaves like the real app.
import { STOCKS, tick, sizeFor } from './data.js';
import { money, money0, signedMoney } from '../lib/format.js';

const FILL_DELAY_MS = 1400;
let seq = 9000;
const id = (p) => `${p}${++seq}`;
const round2 = (n) => Math.round(n * 100) / 100;
const deployedTotal = (s) => s.positions.reduce((sum, p) => sum + p.deployed, 0);

function guardBuy(state, symbol) {
  const s = state.settings;
  if (!STOCKS[symbol]) return `${symbol} not found in the NSE equity (-EQ) master.`;
  if (s.one_position_per_stock && state.positions.some((p) => p.symbol === symbol)) {
    return { ignored: true, reason: `Already holding ${symbol} (one open position per stock).` };
  }
  if (state.positions.length >= s.max_open_positions) {
    return `Max open positions reached (${state.positions.length} of ${s.max_open_positions}).`;
  }
  if (deployedTotal(state) + s.amount_per_trade > s.capital_cap) {
    return `Capital cap reached: ${money(deployedTotal(state))} deployed of ${money0(s.capital_cap)}.`;
  }
  return null;
}

function isDuplicate(state, symbol, action, now) {
  const s = state.settings;
  if (!s.duplicate_protection) return false;
  const windowMs = s.duplicate_window_sec * 1000;
  return state.alerts.some((a) => a.symbol === symbol && a.action === action && now - new Date(a.received_at) < windowMs);
}

function quantity(state, symbol, limit) {
  const s = state.settings;
  if (s.sizing_mode === 'value') {
    const qty = Math.floor(s.amount_per_trade / limit);
    return { qty, deployed: round2(qty * limit), note: `${money0(s.amount_per_trade)} / ${money(limit)} order value = ${qty}` };
  }
  const { qty, deployed, marginPerShare } = sizeFor(symbol, limit, s.amount_per_trade);
  return { qty, deployed, note: `${money0(s.amount_per_trade)} / ${money(marginPerShare)} MTF margin per share = ${qty}` };
}

function newAlert(state, symbol, action, nowIso) {
  const alert = {
    id: id('A'), received_at: nowIso, source_ip: 'test (dashboard)', symbol, exchange: 'NSE', action,
    alert_price: state.ltp[symbol] ?? null, status: 'PENDING', action_taken: 'Processing', detail: '', order_id: null,
    raw_payload: { secret: '********', symbol, exchange: 'NSE', action, price: state.ltp[symbol] ?? null, time: nowIso, test: true },
    checks: [
      { name: 'Secret and format', ok: true, detail: 'Test alert from dashboard (Paper mode)' },
      { name: 'Automation ON', ok: state.settings.automation_on, detail: state.settings.automation_on ? 'Kill switch is off' : 'Automation is OFF' },
      { name: 'Market hours', ok: true, detail: 'Skipped for test alerts so setup can be checked after hours' },
    ],
  };
  state.alerts.push(alert);
  return alert;
}

function finish(alert, status, taken, detail, check) {
  if (check) alert.checks.push(check);
  Object.assign(alert, { status, action_taken: taken, detail });
  return alert;
}

function placeOrder(state, alert, side, qty, limit) {
  const order = {
    id: id('O'), created_at: alert.received_at, broker_order_id: `PAPER-${seq}`, symbol: alert.symbol,
    token: STOCKS[alert.symbol].token, side, product: 'MTF', order_type: 'LIMIT', qty, limit_price: limit,
    filled_qty: 0, avg_price: null, status: 'OPEN', reason: '', reprice_count: 0, alert_id: alert.id, mode: 'PAPER',
  };
  state.orders.push(order);
  alert.order_id = order.id;
  return order;
}

function buy(state, alert, publish) {
  const g = guardBuy(state, alert.symbol);
  if (g) {
    const ignored = typeof g === 'object';
    return finish(alert, ignored ? 'IGNORED' : 'REJECTED', 'No order', ignored ? g.reason : g, { name: ignored ? 'Ignored' : 'Rejected', ok: false, detail: ignored ? g.reason : g });
  }
  const ltp = state.ltp[alert.symbol];
  const limit = tick(ltp * (1 + state.settings.limit_buffer_pct / 100));
  const { qty, deployed, note } = quantity(state, alert.symbol, limit);
  if (qty < 1) return finish(alert, 'REJECTED', 'No order', 'Amount too small for one share.', { name: 'Qty from amount', ok: false, detail: note });
  alert.checks.push({ name: 'Risk checks', ok: true, detail: 'Positions, capital cap and duplicate window OK' }, { name: 'Qty from amount', ok: true, detail: note });
  const order = placeOrder(state, alert, 'BUY', qty, limit);
  finish(alert, 'PENDING', 'LIMIT BUY sent', `Qty ${qty} @ ${money(limit)}`);
  setTimeout(() => {
    Object.assign(order, { status: 'COMPLETE', filled_qty: qty, avg_price: ltp });
    state.positions.push({ id: id('P'), symbol: alert.symbol, exchange: 'NSE', token: order.token, qty, avg_price: ltp, deployed, opened_at: new Date().toISOString(), status: 'OPEN', mode: 'PAPER' });
    finish(alert, 'EXECUTED', 'MTF buy placed', `${money(deployed)} | Qty ${qty}`);
    publish('order', order); publish('position', {}); publish('alert', alert); publish('status', {});
  }, FILL_DELAY_MS);
  return alert;
}

function sell(state, alert, publish) {
  const pos = state.positions.find((p) => p.symbol === alert.symbol);
  if (!pos) return finish(alert, 'IGNORED', 'No order', `No open MTF position in ${alert.symbol}. Nothing to square off.`, { name: 'Open position exists', ok: false, detail: 'Nothing held' });
  // A second SELL while the first exit order is still working must never place another order.
  if (pos.status === 'EXITING') return finish(alert, 'IGNORED', 'No order', `Exit for ${alert.symbol} already in progress.`, { name: 'Exit not already working', ok: false, detail: 'One square-off order at a time' });
  alert.checks.push({ name: 'Open position exists', ok: true, detail: `${pos.qty} ${pos.symbol} held` });
  const ltp = state.ltp[alert.symbol];
  const limit = tick(ltp * (1 - state.settings.limit_buffer_pct / 100));
  const order = placeOrder(state, alert, 'SELL', pos.qty, limit);
  pos.status = 'EXITING';
  finish(alert, 'PENDING', 'LIMIT SELL sent', `Qty ${pos.qty} @ ${money(limit)}`);
  setTimeout(() => {
    const exit = state.ltp[alert.symbol];
    const pnl = round2(pos.qty * (exit - pos.avg_price));
    Object.assign(order, { status: 'COMPLETE', filled_qty: pos.qty, avg_price: exit });
    state.positions = state.positions.filter((p) => p !== pos);
    state.trades.push({ id: id('T'), symbol: pos.symbol, qty: pos.qty, entry_price: pos.avg_price, exit_price: exit, deployed: pos.deployed, pnl, pnl_pct: round2(((exit - pos.avg_price) / pos.avg_price) * 100), opened_at: pos.opened_at, closed_at: new Date().toISOString(), mode: 'PAPER' });
    finish(alert, 'SQUARED_OFF', 'Squared off', `P&L ${signedMoney(pnl)}`);
    publish('order', order); publish('trade', {}); publish('position', {}); publish('alert', alert); publish('status', {});
  }, FILL_DELAY_MS);
  return alert;
}

export function processTestAlert(state, { symbol, action }, publish) {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const duplicate = isDuplicate(state, symbol, action, now);
  const alert = newAlert(state, symbol, action, nowIso);
  if (!state.settings.automation_on) return finish(alert, 'REJECTED', 'No order', 'Automation is OFF (kill switch).');
  if (duplicate) {
    return finish(alert, 'DUPLICATE', 'No order', `Same ${action} for ${symbol} within ${state.settings.duplicate_window_sec} s.`, { name: 'Not a duplicate', ok: false, detail: 'Repeat alert blocked' });
  }
  alert.checks.push({ name: 'Not a duplicate', ok: true, detail: 'No same alert in window' });
  return action === 'BUY' ? buy(state, alert, publish) : sell(state, alert, publish);
}
