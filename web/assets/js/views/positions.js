// Positions: MTF positions tracked by the software, plus a read-only Angel One account view.
import { api } from '../lib/api.js';
import { on } from '../lib/bus.js';
import { html, mount } from '../lib/html.js';
import { icon } from '../lib/icons.js';
import { money, signedMoney, tone } from '../lib/format.js';
import { debounce, sequencer } from '../lib/util.js';
import { card, errorBox, skeletonRows } from '../components/ui.js';
import { positionsTable, patchTicks, totalPnl } from '../components/positions.js';

const TABS = [
  { id: 'tracked', label: 'Tracked by MTF Trader' },
  { id: 'broker', label: 'Angel One account' },
];

function summary(t, items) {
  const unreal = totalPnl(items);
  return html`<div class="summary">
    <div><div class="l">Total deployed</div><div class="v num">${t.deployed === null ? '-' : money(t.deployed)}</div></div>
    <div><div class="l">Unrealised P&L</div><div class="v num ${tone(unreal)}" data-sum-unreal>${signedMoney(unreal)}</div></div>
    <div><div class="l">Realised P&L (today)</div><div class="v num ${tone(t.realised_today)}">${t.realised_today === null ? '-' : signedMoney(t.realised_today)}</div></div>
  </div>`;
}

function body(tab, d) {
  const note = tab === 'broker'
    ? html`<div class="banner info" style="margin:0 18px 14px">${icon('info-circle', 18)}Everything in your Angel One account, including stocks bought outside MTF Trader. Read-only.</div>`
    : '';
  const emptyText = tab === 'broker' ? 'No positions or holdings in the connected Angel One account.' : undefined;
  return html`${note}<div data-positions>${positionsTable(d.items, { emptyText })}</div>${d.items.length ? summary(d.totals, d.items) : ''}`;
}

export default {
  id: 'positions',
  title: 'Positions',
  subtitle: 'Open MTF positions with live P&L',
  icon: 'stack-2',
  async render(root) {
    let tab = 'tracked';
    let data = null;
    const draw = (content) => mount(root, card({
      title: 'Open MTF positions', desc: 'Live prices update every few seconds during market hours', iconName: 'stack-2', flush: true,
      actions: html`<span class="subtle hide-sm">${data ? `${data.items.length} open` : ''}</span>`,
      body: html`<div class="tabs" role="tablist">${TABS.map((t) => html`<button type="button" role="tab" data-tab="${t.id}" aria-selected="${t.id === tab}">${t.label}</button>`)}</div>
        <div style="padding-top:14px">${content}</div>`,
    }));
    const seq = sequencer();
    const load = async () => {
      const t = seq.next();
      const source = tab;
      try {
        const d = await api.get('/api/positions', { source });
        if (!seq.isLatest(t)) return; // a newer tab/request superseded this one
        data = d;
        draw(body(source, d));
      } catch (err) {
        if (seq.isLatest(t)) draw(errorBox(err.message, 'retry'));
      }
    };
    const reload = debounce(load, 300);
    root.addEventListener('click', (e) => {
      const t = e.target.closest('[data-tab]');
      if (t && t.dataset.tab !== tab) { tab = t.dataset.tab; draw(skeletonRows(4, 8)); load(); }
      if (e.target.closest('[data-action="retry"]')) load();
    });
    draw(skeletonRows(4, 8));
    await load();
    const offs = [
      on('tick', (ticks) => {
        if (!data) return;
        patchTicks(root, data.items, ticks);
        const el = root.querySelector('[data-sum-unreal]');
        if (el) { const t = totalPnl(data.items); el.textContent = signedMoney(t); el.className = `v num ${tone(t)}`; }
      }),
      ...['position', 'trade'].map((t) => on(t, reload)),
    ];
    return () => { reload.cancel(); offs.forEach((off) => off()); };
  },
};
