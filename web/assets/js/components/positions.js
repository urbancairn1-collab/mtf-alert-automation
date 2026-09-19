// Open MTF positions table + in-place live price patching (same DOM nodes on every tick).
import { html } from '../lib/html.js';
import { price, qty, money, signedMoney, pct, tone, time } from '../lib/format.js';
import { table } from './table.js';
import { positionStatusBadge, symbolCell } from './ui.js';

const round2 = (n) => Math.round(n * 100) / 100;

const pnlCell = (p) => html`<span class="num ${tone(p.pnl)}" data-cell="pnl">${signedMoney(p.pnl)}</span>`;
const pnlPctCell = (p) => html`<span class="num ${tone(p.pnl)}" data-cell="pnlpct">${pct(p.pnl_pct)}</span>`;
const ltpCell = (p) => html`<span class="num" data-cell="ltp">${price(p.ltp)}</span>`;

// Broker-source rows carry `product` (MTF/CNC); tracked rows carry `status`. `mismatch` (LIVE)
// means Angel One holds a different qty than MTF Trader bought for this stock.
function statusCell(p) {
  const main = p.product ? html`<span class="badge b-neutral">${p.product}</span>` : positionStatusBadge(p.status);
  if (!p.mismatch) return main;
  return html`${main} <span class="badge b-warn" title="Angel One shows a different quantity than MTF Trader bought. Check the Angel One account tab.">Check broker</span>`;
}

export function positionsTable(items, { compact = false, emptyText } = {}) {
  const full = [
    { label: 'Stock', render: (p) => symbolCell(p.symbol, p.exchange) },
    { label: 'Qty', align: 'right', render: (p) => html`<span class="num">${qty(p.qty)}</span>` },
    { label: 'Avg price', align: 'right', render: (p) => html`<span class="num">${price(p.avg_price)}</span>` },
    { label: 'LTP', align: 'right', render: ltpCell },
    { label: 'Deployed', align: 'right', render: (p) => html`<span class="num">${p.deployed === null ? '-' : money(p.deployed)}</span>` },
    { label: 'Value', align: 'right', render: (p) => html`<span class="num" data-cell="value">${money(p.value)}</span>` },
    { label: 'P&L', align: 'right', render: pnlCell },
    { label: 'P&L %', align: 'right', render: pnlPctCell },
    { label: 'Status', render: statusCell },
    { label: 'Opened', render: (p) => (p.opened_at ? html`<span class="subtle">${time(p.opened_at)}</span>` : html`<span class="subtle">${p.note || '-'}</span>`) },
  ];
  const short = [
    { label: 'Stock', render: (p) => symbolCell(p.symbol, `${qty(p.qty)} qty`) },
    { label: 'Avg price', align: 'right', render: (p) => html`<span class="num">${price(p.avg_price)}</span>` },
    { label: 'LTP', align: 'right', render: ltpCell },
    { label: 'Deployed', align: 'right', render: (p) => html`<span class="num">${money(p.deployed)}</span>` },
    { label: 'P&L', align: 'right', render: (p) => html`${pnlCell(p)}<div class="sym-sub r">${pnlPctCell(p)}</div>` },
  ];
  return table({
    columns: compact ? short : full,
    rows: items,
    emptyState: { iconName: 'stack-2', title: 'No open MTF positions', text: emptyText || 'A BUY alert from your indicator will open a position here automatically.' },
  });
}

function flash(el, dir) {
  el.classList.remove('flash-up', 'flash-down');
  void el.offsetWidth;
  el.classList.add(dir > 0 ? 'flash-up' : 'flash-down');
}

function setNum(row, cell, text, cls) {
  const el = row.querySelector(`[data-cell="${cell}"]`);
  if (!el) return;
  el.textContent = text;
  if (cls !== undefined) el.className = `num ${cls}`;
}

// Mutates the in-memory rows (they belong to the view) and patches the matching cells.
export function patchTicks(root, items, ticks) {
  items.forEach((p) => {
    const next = ticks[p.symbol];
    if (next === undefined || next === p.ltp) return;
    const dir = next - p.ltp;
    Object.assign(p, {
      ltp: next,
      value: round2(p.qty * next),
      pnl: round2(p.qty * (next - p.avg_price)),
      pnl_pct: round2(((next - p.avg_price) / p.avg_price) * 100),
    });
    const row = root.querySelector(`tr[data-id="${CSS.escape(p.id)}"]`);
    if (!row) return;
    setNum(row, 'ltp', price(p.ltp));
    setNum(row, 'value', money(p.value));
    setNum(row, 'pnl', signedMoney(p.pnl), tone(p.pnl));
    setNum(row, 'pnlpct', pct(p.pnl_pct), tone(p.pnl));
    flash(row.querySelector('[data-cell="ltp"]').closest('td'), dir);
  });
}

export const totalPnl = (items) => round2(items.reduce((s, p) => s + p.pnl, 0));
