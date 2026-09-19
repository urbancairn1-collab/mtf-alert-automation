// Validation and business rules shared by the demo backend. The Python backend
// implements the same rules (spec sections 5, 6.6); keep them in sync.

const RANGES = {
  amount_per_trade: [500, 10000000, 'Amount per trade must be between ₹500 and ₹1,00,00,000'],
  capital_cap: [500, 100000000, 'Capital cap must be between ₹500 and ₹10,00,00,000'],
  max_open_positions: [1, 50, 'Max open positions must be 1 to 50'],
  duplicate_window_sec: [5, 3600, 'Duplicate window must be 5 to 3600 seconds'],
  limit_buffer_pct: [0.05, 2, 'Limit buffer must be 0.05% to 2%'],
  buy_fill_timeout_sec: [5, 300, 'Buy fill timeout must be 5 to 300 seconds'],
  sell_reprice_attempts: [0, 10, 'Re-price attempts must be 0 to 10'],
  sell_reprice_interval_sec: [5, 120, 'Re-price interval must be 5 to 120 seconds'],
  paper_margin_pct: [10, 100, 'Paper margin must be 10% to 100%'],
};
const INTEGER_FIELDS = new Set(['amount_per_trade', 'capital_cap', 'max_open_positions', 'duplicate_window_sec', 'buy_fill_timeout_sec', 'sell_reprice_attempts', 'sell_reprice_interval_sec']);

export function validateSettings(input) {
  const errors = {};
  const value = { ...input };
  Object.entries(RANGES).forEach(([key, [min, max, message]]) => {
    const n = Number(input[key]);
    if (!Number.isFinite(n) || n < min || n > max || (INTEGER_FIELDS.has(key) && !Number.isInteger(n))) {
      errors[key] = message;
    } else {
      value[key] = n;
    }
  });
  if (!errors.capital_cap && !errors.amount_per_trade && value.capital_cap < value.amount_per_trade) {
    errors.capital_cap = 'Capital cap cannot be lower than the amount per trade';
  }
  if (!['margin', 'value'].includes(input.sizing_mode)) errors.sizing_mode = 'Choose how the amount is used';
  ['one_position_per_stock', 'duplicate_protection'].forEach((k) => { value[k] = Boolean(input[k]); });
  return Object.keys(errors).length ? { errors, value: null } : { errors: null, value };
}

export function validateCredentials(c) {
  const errors = {};
  if (!/^[A-Za-z0-9]{4,12}$/.test(c.client_code || '')) errors.client_code = 'Client ID is 4-12 letters or digits (e.g. your Angel login ID)';
  if (!/^[A-Za-z0-9]{6,64}$/.test(c.api_key || '')) errors.api_key = 'Paste the API key from your SmartAPI app';
  if (!/^\d{4}$/.test(c.mpin || '')) errors.mpin = 'MPIN is 4 digits';
  if (!/^[A-Z2-7]{16,64}$/.test((c.totp_secret || '').replace(/\s/g, '').toUpperCase())) {
    errors.totp_secret = 'TOTP secret is the 16+ character code shown when you enabled TOTP';
  }
  return Object.keys(errors).length ? errors : null;
}

// What must be true before real orders can be sent. Each entry is shown to the user as a
// reason the switch is blocked. Strict on purpose: LIVE places real MTF orders.
export function blockersForLive({ broker, ipConfirmed, workingOrders }) {
  const blockers = [];
  if (!broker.configured) blockers.push('Angel One credentials are not saved.');
  if (!broker.connected) blockers.push('Angel One is not connected. Connect it on the Broker page.');
  if (broker.connected && broker.session_valid_till && new Date(broker.session_valid_till) < new Date()) {
    blockers.push('Angel One session has expired. Reconnect first.');
  }
  if (!ipConfirmed) blockers.push("Confirm this PC's public IP is registered in your SmartAPI app.");
  if (workingOrders > 0) blockers.push(`${workingOrders} paper order(s) still working. Wait for them to finish.`);
  return blockers;
}
