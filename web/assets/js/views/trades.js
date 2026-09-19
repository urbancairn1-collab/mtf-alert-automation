// Trade history: every squared-off MTF position with realised P&L. Excel export.
import { api } from '../lib/api.js';
import { on } from '../lib/bus.js';
import { html, mount } from '../lib/html.js';
import { icon } from '../lib/icons.js';
import { dateTime, price, qty, money, signedMoney, pct, tone, dayKey } from '../lib/format.js';
import { debounce, sequencer } from '../lib/util.js';
import { card, chips, errorBox, skeletonRows, symbolCell } from '../components/ui.js';
import { table } from '../components/table.js';

const RANGES = [{ value: 'today', label: 'Today' }, { value: '7', label: '7 days' }, { value: '30', label: '30 days' }, { value: 'all', label: 'All' }];

function rangeDates(range) {
  if (range === 'all') return { date_from: '', date_to: '' };
  const to = dayKey();
  const days = range === 'today' ? 0 : Number(range) - 1;
  return { date_from: dayKey(new Date(Date.now() - days * 86400e3)), date_to: to };
}

function view(d) {
  const body = table({
    rows: d.items,
    columns: [
      { label: 'Bought', render: (t) => html`<span class="num">${dateTime(t.opened_at)}</span>` },
      { label: 'Squared off', render: (t) => html`<span class="num">${dateTime(t.closed_at)}</span>` },
      { label: 'Stock', render: (t) => symbolCell(t.symbol) },
      { label: 'Qty', align: 'right', render: (t) => html`<span class="num">${qty(t.qty)}</span>` },
      { label: 'Buy price', align: 'right', render: (t) => html`<span class="num">${price(t.entry_price)}</span>` },
      { label: 'Sell price', align: 'right', render: (t) => html`<span class="num">${price(t.exit_price)}</span>` },
      { label: 'Deployed', align: 'right', render: (t) => html`<span class="num">${money(t.deployed)}</span>` },
      { label: 'P&L', align: 'right', render: (t) => html`<span class="num ${tone(t.pnl)}">${signedMoney(t.pnl)}</span>` },
      { label: 'P&L %', align: 'right', render: (t) => html`<span class="num ${tone(t.pnl)}">${pct(t.pnl_pct)}</span>` },
    ],
    emptyState: { iconName: 'history', title: 'No completed trades in this period', text: 'A trade is recorded here when a SELL alert squares off an MTF position.' },
  });
  const s = d.totals;
  return html`${body}${d.items.length ? html`<div class="summary">
    <div><div class="l">Completed trades</div><div class="v num">${s.count}</div></div>
    <div><div class="l">Capital used</div><div class="v num">${money(s.deployed)}</div></div>
    <div><div class="l">Net realised P&L</div><div class="v num ${tone(s.net_pnl)}">${signedMoney(s.net_pnl)}</div></div>
  </div>` : ''}`;
}

export default {
  id: 'trades',
  title: 'Trade History',
  subtitle: 'Completed MTF trades with realised P&L',
  icon: 'history',
  async render(root) {
    let range = 'all';
    let f = rangeDates(range);
    mount(root, card({
      title: 'Complete trade history', desc: 'Each row is one position: bought on a BUY alert, squared off on a SELL alert', iconName: 'history', flush: true,
      actions: html`<button type="button" class="btn sm outline-accent" data-action="export">${icon('download', 15)}Export to Excel</button>`,
      body: html`<div class="toolbar">${chips('range', RANGES, range)}</div><div data-rows>${skeletonRows(6, 8)}</div>`,
    }));
    const rowsEl = root.querySelector('[data-rows]');
    const seq = sequencer();
    const load = async () => {
      const t = seq.next();
      try {
        const d = await api.get('/api/trades', f);
        if (seq.isLatest(t)) mount(rowsEl, view(d));
      } catch (err) {
        if (seq.isLatest(t)) mount(rowsEl, errorBox(err.message, 'retry'));
      }
    };
    const reload = debounce(load, 250);
    root.addEventListener('click', (e) => {
      const chip = e.target.closest('[data-chips="range"] .chip');
      if (chip) {
        range = chip.dataset.value;
        f = rangeDates(range);
        root.querySelectorAll('[data-chips="range"] .chip').forEach((c) => c.setAttribute('aria-pressed', String(c === chip)));
        load();
      }
      if (e.target.closest('[data-action="export"]')) api.download('/api/export/trades.xlsx', f);
      if (e.target.closest('[data-action="retry"]')) load();
    });
    await load();
    const off = on('trade', reload);
    return () => { reload.cancel(); off(); };
  },
};
