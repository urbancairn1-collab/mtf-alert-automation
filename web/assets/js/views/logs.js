// System logs: webhook, engine, broker and system events with level/category filters.
import { api } from '../lib/api.js';
import { on } from '../lib/bus.js';
import { html, mount } from '../lib/html.js';
import { icon } from '../lib/icons.js';
import { timeSec, date } from '../lib/format.js';
import { debounce, sequencer } from '../lib/util.js';
import { card, chips, levelBadge, errorBox, skeletonRows } from '../components/ui.js';
import { table } from '../components/table.js';

const LEVELS = [{ value: '', label: 'All' }, { value: 'INFO', label: 'Info' }, { value: 'WARN', label: 'Warning' }, { value: 'ERROR', label: 'Error' }];
const CATEGORIES = [['', 'All sources'], ['webhook', 'Webhook'], ['engine', 'Engine'], ['broker', 'Broker'], ['system', 'System']];

function rows(items) {
  return table({
    rows: items,
    columns: [
      { label: 'Time', render: (l) => html`<span class="num">${timeSec(l.ts)}</span><div class="sym-sub">${date(l.ts)}</div>` },
      { label: 'Level', render: (l) => levelBadge(l.level) },
      { label: 'Source', render: (l) => html`<span class="badge b-neutral">${l.category}</span>` },
      { label: 'Message', render: (l) => l.message },
    ],
    emptyState: { iconName: 'file-text', title: 'No log entries match', text: 'Try another level or source.' },
  });
}

export default {
  id: 'logs',
  title: 'Logs',
  subtitle: 'What the software did, and when',
  icon: 'file-text',
  async render(root) {
    const f = { level: '', category: '', q: '' };
    mount(root, card({
      title: 'System log', iconName: 'file-text', flush: true, desc: 'Newest first. Also written to data/logs on this PC.',
      body: html`<div class="toolbar">${chips('level', LEVELS, '')}
        <label class="sr-only" for="l-cat">Source</label>
        <select class="select" id="l-cat" name="category">${CATEGORIES.map(([v, l]) => html`<option value="${v}">${l}</option>`)}</select>
        <div class="search">${icon('search', 16)}<label class="sr-only" for="l-q">Search</label><input class="input" id="l-q" name="q" placeholder="Search messages"></div></div>
        <div data-rows>${skeletonRows(8, 4)}</div>`,
    }));
    const rowsEl = root.querySelector('[data-rows]');
    const seq = sequencer();
    const load = async () => {
      const t = seq.next();
      try {
        const d = await api.get('/api/logs', { ...f });
        if (seq.isLatest(t)) mount(rowsEl, rows(d.items));
      } catch (err) {
        if (seq.isLatest(t)) mount(rowsEl, errorBox(err.message, 'retry'));
      }
    };
    const reload = debounce(load, 250);
    root.addEventListener('input', (e) => { if (e.target.name) { f[e.target.name] = e.target.value; reload(); } });
    root.addEventListener('click', (e) => {
      const chip = e.target.closest('[data-chips="level"] .chip');
      if (chip) {
        f.level = chip.dataset.value;
        root.querySelectorAll('[data-chips="level"] .chip').forEach((c) => c.setAttribute('aria-pressed', String(c === chip)));
        load();
      }
      if (e.target.closest('[data-action="retry"]')) load();
    });
    await load();
    const offs = ['log', 'alert', 'order', 'status'].map((t) => on(t, reload));
    return () => { reload.cancel(); offs.forEach((off) => off()); };
  },
};
