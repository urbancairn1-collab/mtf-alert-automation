// Builds the demo system log from the scripted session so Logs matches Alerts/Orders.
import { ist } from './data.js';
import { money } from '../lib/format.js';

const LEVEL_FOR = { EXECUTED: 'INFO', SQUARED_OFF: 'INFO', DUPLICATE: 'WARN', IGNORED: 'INFO', REJECTED: 'WARN', FAILED: 'ERROR', PENDING: 'INFO' };

function systemBoot(day) {
  return [
    ['08:44:51', 'INFO', 'system', 'MTF Trader started (Paper mode). Dashboard on 127.0.0.1:8000, webhook on 127.0.0.1:8001.'],
    ['08:44:53', 'INFO', 'system', 'Webhook tunnel is up: https://your-name.ngrok-free.dev/webhook'],
    ['08:45:03', 'INFO', 'broker', 'Angel One login OK with TOTP. Session valid till 23:59 IST.'],
    ['08:45:06', 'INFO', 'broker', 'Scrip master refreshed from Angel One (NSE/BSE equity symbols cached).'],
    ['11:02:14', 'WARN', 'broker', 'Angel rate limit (AB1021 "Too many requests"). Quotes paused 45 s, then resumed.'],
  ].map(([t, level, category, message]) => ({ ts: ist(day, t), level, category, message, data: null }));
}

export function buildLogs(state) {
  const logs = systemBoot(state.sessionDay);
  state.alerts.forEach((a) => {
    logs.push({ ts: a.received_at, level: 'INFO', category: 'webhook', message: `Alert received: ${a.action} ${a.symbol} (${a.exchange})`, data: { alert_id: a.id } });
    logs.push({ ts: a.received_at, level: LEVEL_FOR[a.status] || 'INFO', category: 'engine', message: `${a.action} ${a.symbol}: ${a.action_taken}. ${a.detail}`, data: { alert_id: a.id, status: a.status } });
  });
  state.orders.forEach((o) => {
    const level = o.status === 'CANCELLED' ? 'WARN' : 'INFO';
    const what = o.status === 'COMPLETE' ? `filled ${o.filled_qty} @ ${money(o.avg_price)}` : `${o.status.toLowerCase()}${o.reason ? ` (${o.reason})` : ''}`;
    logs.push({ ts: o.created_at, level, category: 'broker', message: `LIMIT ${o.side} ${o.qty} ${o.symbol} MTF @ ${money(o.limit_price)}: ${what}`, data: { order_id: o.id } });
  });
  return logs.sort((x, y) => new Date(y.ts) - new Date(x.ts)).map((l, i) => ({ id: `L${i + 1}`, ...l }));
}

export function logEntry(state, level, category, message, data = null) {
  const entry = { id: `L${Date.now()}${Math.floor(Math.random() * 1000)}`, ts: new Date().toISOString(), level, category, message, data };
  state.logs.unshift(entry);
  return entry;
}
