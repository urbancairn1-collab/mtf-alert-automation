// CSV export for demo mode (live mode downloads .xlsx from the backend).
// Cells starting with = + - @ are prefixed with ' so Excel never runs them as formulas.

const COLUMNS = {
  alerts: [['received_at', 'Time'], ['symbol', 'Stock'], ['exchange', 'Exchange'], ['action', 'Type'], ['status', 'Status'], ['action_taken', 'Action'], ['detail', 'Details'], ['order_id', 'Order']],
  orders: [['created_at', 'Time'], ['broker_order_id', 'Order ID'], ['symbol', 'Stock'], ['side', 'Side'], ['product', 'Product'], ['order_type', 'Type'], ['qty', 'Qty'], ['limit_price', 'Limit price'], ['filled_qty', 'Filled'], ['avg_price', 'Avg fill'], ['status', 'Status'], ['reason', 'Reason']],
  trades: [['opened_at', 'Opened'], ['closed_at', 'Closed'], ['symbol', 'Stock'], ['qty', 'Qty'], ['entry_price', 'Buy price'], ['exit_price', 'Sell price'], ['deployed', 'Deployed'], ['pnl', 'P&L'], ['pnl_pct', 'P&L %']],
};

function cell(value) {
  let s = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(kind, rows) {
  const cols = COLUMNS[kind];
  const lines = [cols.map(([, label]) => cell(label)).join(',')];
  rows.forEach((r) => lines.push(cols.map(([key]) => cell(r[key])).join(',')));
  return `﻿${lines.join('\r\n')}`;
}
