// Sidebar order. Every screen maps to a quotation line (spec section 7.1).
import dashboard from './dashboard.js';
import positions from './positions.js';
import alerts from './alerts.js';
import orders from './orders.js';
import trades from './trades.js';
import settings from './settings.js';
import broker from './broker.js';
import logs from './logs.js';
import help from './help.js';

export const VIEWS = [dashboard, positions, alerts, orders, trades, settings, broker, logs, help];
