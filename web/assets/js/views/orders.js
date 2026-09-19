// Orders: every LIMIT order the software sent (fills, re-prices, reasons) + Angel One order book.
import { api } from '../lib/api.js';
import { on } from '../lib/bus.js';
import { html, mount } from '../lib/html.js';
import { icon } from '../lib/icons.js';
import { time, date, price, qty } from '../lib/format.js';
import { debounce, sequencer } from '../lib/util.js';
import { card, orderStatusBadge, errorBox, skeletonRows, symbolCell } from '../components/ui.js';
import { table } from '../components/table.js';

const TABS = [{ id: 'software', label: 'Sent by MTF Trader' }, { id: 'broker', label: 'Angel One order book' }];
const STATUSES = [['', 'All statuses'], ['OPEN', 'Open'], ['COMPLETE', 'Filled'], ['PARTIAL', 'Part filled'], ['CANCELLED', 'Cancelled'], ['REJECTED', 'Rejected']];

function rows(items, tab) {
  return table({
    rows: items,
    columns: [
      { label: 'Time', render: (o) => html`<span class="num">${time(o.created_at)}</span><div class="sym-sub">${date(o.created_at)}</div>` },
      { label: 'Order ID', render: (o) => html`<span class="mono">${o.broker_order_id}</span>` },
      { label: 'Stock', render: (o) => symbolCell(o.symbol) },
      { label: 'Side', render: (o) => html`<span class="badge ${o.side === 'BUY' ? 'b-buy' : 'b-sell'}">${o.side}</span>` },
      { label: 'Product', render: (o) => html`<span class="badge b-neutral">${o.product}</span>` },
      { label: 'Type', render: (o) => o.order_type },
      { label: 'Qty', align: 'right', render: (o) => html`<span class="num">${qty(o.qty)}</span>` },
      { label: 'Limit price', align: 'right', render: (o) => html`<span class="num">${price(o.limit_price)}</span>` },
      { label: 'Filled', align: 'right', render: (o) => html`<span class="num">${qty(o.filled_qty)}</span>` },
      { label: 'Avg fill', align: 'right', render: (o) => html`<span class="num">${o.avg_price ? price(o.avg_price) : '-'}</span>` },
      { label: 'Status', render: (o) => orderStatusBadge(o.status) },
      { label: 'Note', render: (o) => html`<span class="subtle">${o.reason || (o.reprice_count ? `Re-priced ${o.reprice_count}x` : '')}</span>` },
    ],
    emptyState: tab === 'broker'
      ? { iconName: 'list-details', title: 'No orders in Angel One today', text: 'Orders placed from the Angel One app or by MTF Trader in Live mode show here.' }
      : { iconName: 'list-details', title: 'No orders yet', text: 'A BUY or SELL alert that passes all checks sends a LIMIT order in the MTF product.' },
  });
}

export default {
  id: 'orders',
  title: 'Orders',
  subtitle: 'LIMIT orders in the MTF product, with fills and reasons',
  icon: 'list-details',
  async render(root) {
    const f = { source: 'software', status: '' };
    mount(root, card({
      title: 'Order book', desc: 'Angel One accepts only LIMIT orders from algos, so every order is a LIMIT order', iconName: 'list-details', flush: true,
      actions: html`<button type="button" class="btn sm outline-accent" data-action="export">${icon('download', 15)}Export to Excel</button>`,
      body: html`<div class="tabs" role="tablist">${TABS.map((t) => html`<button type="button" role="tab" data-tab="${t.id}" aria-selected="${t.id === f.source}">${t.label}</button>`)}</div>
        <div class="toolbar" style="padding-top:14px"><label class="sr-only" for="o-status">Status</label>
          <select class="select" id="o-status" name="status">${STATUSES.map(([v, l]) => html`<option value="${v}" ${v === f.status ? 'selected' : ''}>${l}</option>`)}</select></div>
        <div data-rows>${skeletonRows(6, 8)}</div>`,
    }));
    const rowsEl = root.querySelector('[data-rows]');
    const seq = sequencer();
    const load = async () => {
      const t = seq.next();
      const q = { ...f };
      try {
        const d = await api.get('/api/orders', q);
        if (seq.isLatest(t)) mount(rowsEl, rows(d.items, q.source));
      } catch (err) {
        if (seq.isLatest(t)) mount(rowsEl, errorBox(err.message, 'retry'));
      }
    };
    const reload = debounce(load, 250);
    root.querySelector('#o-status').addEventListener('change', (e) => { f.status = e.target.value; load(); });
    root.addEventListener('click', (e) => {
      const t = e.target.closest('[data-tab]');
      if (t && t.dataset.tab !== f.source) {
        f.source = t.dataset.tab;
        root.querySelectorAll('[data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b === t)));
        mount(rowsEl, skeletonRows(6, 8));
        load();
      }
      if (e.target.closest('[data-action="export"]')) api.download('/api/export/orders.xlsx', f);
      if (e.target.closest('[data-action="retry"]')) load();
    });
    await load();
    const off = on('order', reload);
    return () => { reload.cancel(); off(); };
  },
};
