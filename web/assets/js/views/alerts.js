// Alert log: every alert received, why it did or did not trade, raw payload. Excel export.
import { api } from '../lib/api.js';
import { on } from '../lib/bus.js';
import { html, mount } from '../lib/html.js';
import { icon } from '../lib/icons.js';
import { time, dateTime, date, price, qty } from '../lib/format.js';
import { debounce, sequencer } from '../lib/util.js';
import { card, chips, actionBadge, alertStatusBadge, orderStatusBadge, errorBox, skeletonRows, symbolCell } from '../components/ui.js';
import { table, onRowActivate } from '../components/table.js';
import { openDrawer } from '../components/overlay.js';

const STATUSES = [['', 'All statuses'], ['EXECUTED', 'Executed'], ['SQUARED_OFF', 'Squared off'], ['PENDING', 'Working'], ['DUPLICATE', 'Duplicate'], ['IGNORED', 'Ignored'], ['REJECTED', 'Rejected'], ['FAILED', 'Failed']];

function toolbar(f, counts) {
  return html`<div class="toolbar">
    ${chips('action', [{ value: '', label: 'All', count: counts.all }, { value: 'BUY', label: 'BUY', count: counts.BUY }, { value: 'SELL', label: 'SELL', count: counts.SELL }], f.action)}
    <label class="sr-only" for="f-status">Status</label>
    <select class="select" id="f-status" name="status">${STATUSES.map(([v, l]) => html`<option value="${v}" ${v === f.status ? 'selected' : ''}>${l}</option>`)}</select>
    <label class="sr-only" for="f-from">From date</label><input class="input" type="date" id="f-from" name="date_from" value="${f.date_from}">
    <label class="sr-only" for="f-to">To date</label><input class="input" type="date" id="f-to" name="date_to" value="${f.date_to}">
    <div class="search">${icon('search', 16)}<label class="sr-only" for="f-q">Search stock</label><input class="input" id="f-q" name="q" placeholder="Search stock" value="${f.q}"></div>
  </div>`;
}

function rowsTable(items) {
  return table({
    clickable: true,
    rows: items,
    columns: [
      { label: 'Time', render: (a) => html`<span class="num">${time(a.received_at)}</span><div class="sym-sub">${date(a.received_at)}</div>` },
      { label: 'Stock', render: (a) => symbolCell(a.symbol, a.exchange) },
      { label: 'Type', render: (a) => actionBadge(a.action) },
      { label: 'Action taken', render: (a) => a.action_taken },
      { label: 'Status', render: (a) => alertStatusBadge(a.status) },
      { label: 'Details', render: (a) => html`<span class="muted">${a.detail}</span>` },
    ],
    emptyState: { iconName: 'bell-ringing', title: 'No alerts match', text: 'Change the filters, or wait for your indicator to fire. Every alert is logged here, even rejected ones.' },
  });
}

function detail(a) {
  const o = a.order;
  return html`
    <div class="row">${actionBadge(a.action)}<strong style="font-size:16px">${a.symbol}</strong>${alertStatusBadge(a.status)}</div>
    <dl class="kv">
      <dt>Received</dt><dd>${dateTime(a.received_at)}</dd>
      <dt>Exchange</dt><dd>${a.exchange}</dd>
      <dt>Alert price</dt><dd class="num">${a.alert_price ? price(a.alert_price) : '-'}</dd>
      <dt>Source</dt><dd>${a.source_ip}</dd>
      <dt>Result</dt><dd>${a.action_taken}. ${a.detail}</dd>
    </dl>
    <div><h3>Checks before acting</h3><ul class="checks">${a.checks.map((c) => html`<li data-ok="${c.ok}">
      ${icon(c.ok ? 'circle-check' : 'circle-x', 18)}<div><div class="n">${c.name}</div><div class="dd">${c.detail}</div></div></li>`)}</ul></div>
    ${o ? html`<div><h3>Order</h3><dl class="kv">
      <dt>Order ID</dt><dd class="mono">${o.broker_order_id}</dd>
      <dt>Order</dt><dd>${o.order_type} ${o.side} ${qty(o.qty)} @ ${price(o.limit_price)} (${o.product})</dd>
      <dt>Filled</dt><dd>${qty(o.filled_qty)}${o.avg_price ? html` @ ${price(o.avg_price)}` : ''}</dd>
      <dt>Status</dt><dd>${orderStatusBadge(o.status)} ${o.reason}</dd></dl></div>` : ''}
    <div><h3>Raw alert</h3><pre class="code">${JSON.stringify(a.raw_payload, null, 2)}</pre></div>`;
}

export default {
  id: 'alerts',
  title: 'Alerts',
  subtitle: 'Every alert received from your indicator, and what was done with it',
  icon: 'bell-ringing',
  async render(root) {
    const f = { action: '', status: '', date_from: '', date_to: '', q: '' };
    mount(root, card({
      title: 'Alert log', desc: 'Click any row to see the checks and the raw alert', iconName: 'bell-ringing', flush: true,
      actions: html`<button type="button" class="btn sm outline-accent" data-action="export">${icon('download', 15)}Export to Excel</button>`,
      body: html`<div data-toolbar></div><div data-rows>${skeletonRows(6, 6)}</div>`,
    }));
    const rowsEl = root.querySelector('[data-rows]');
    const toolbarEl = root.querySelector('[data-toolbar]');
    let items = [];
    const seq = sequencer();
    const load = async () => {
      const t = seq.next();
      try {
        const d = await api.get('/api/alerts', { ...f });
        if (!seq.isLatest(t)) return;
        items = d.items;
        if (!toolbarEl.childElementCount) mount(toolbarEl, toolbar(f, d.counts));
        toolbarEl.querySelectorAll('.chip .n').forEach((n, i) => { n.textContent = [d.counts.all, d.counts.BUY, d.counts.SELL][i]; });
        mount(rowsEl, rowsTable(items));
      } catch (err) {
        if (seq.isLatest(t)) mount(rowsEl, errorBox(err.message, 'retry'));
      }
    };
    const reload = debounce(load, 250);
    toolbarEl.addEventListener('input', (e) => { if (e.target.name) { f[e.target.name] = e.target.value; reload(); } });
    root.addEventListener('click', async (e) => {
      const chip = e.target.closest('[data-chips="action"] .chip');
      if (chip) {
        f.action = chip.dataset.value;
        toolbarEl.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-pressed', String(c === chip)));
        load();
      }
      if (e.target.closest('[data-action="export"]')) api.download('/api/export/alerts.xlsx', f);
      if (e.target.closest('[data-action="retry"]')) load();
    });
    onRowActivate(rowsEl, async (id) => {
      try {
        const a = await api.get(`/api/alerts/${encodeURIComponent(id)}`);
        openDrawer({ title: 'Alert details', body: detail(a) });
      } catch (err) {
        openDrawer({ title: 'Alert details', body: errorBox(err.message) });
      }
    });
    await load();
    const off = on('alert', reload);
    return () => { reload.cancel(); off(); };
  },
};
