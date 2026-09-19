// Generic data table. columns: [{ key, label, align, render(row) -> SafeHtml|string, cellAttr(row) }]
import { html } from '../lib/html.js';
import { empty } from './ui.js';

export function table({ columns, rows, rowId = (r) => r.id, clickable = false, emptyState, footer }) {
  if (!rows.length) return empty(emptyState);
  return html`<div class="table-wrap"><table class="t">
    <thead><tr>${columns.map((c) => html`<th class="${c.align === 'right' ? 'r' : ''}" scope="col">${c.label}</th>`)}</tr></thead>
    <tbody>${rows.map((row) => html`<tr data-id="${rowId(row)}" class="${clickable ? 'click' : ''}" ${clickable ? html`tabindex="0"` : ''}>
      ${columns.map((c) => html`<td class="${c.align === 'right' ? 'r' : ''}" ${c.cellAttr ? c.cellAttr(row) : ''}>${c.render ? c.render(row) : row[c.key]}</td>`)}
    </tr>`)}</tbody>
    ${footer ? html`<tfoot><tr>${footer}</tr></tfoot>` : ''}
  </table></div>`;
}

// Row activation (click or Enter) for clickable tables.
export function onRowActivate(root, handler) {
  root.addEventListener('click', (e) => {
    const tr = e.target.closest('tbody tr.click');
    if (tr && !e.target.closest('button, a, input')) handler(tr.dataset.id);
  });
  root.addEventListener('keydown', (e) => {
    const tr = e.target.closest('tbody tr.click');
    if (!tr || e.target !== tr || (e.key !== 'Enter' && e.key !== ' ')) return;
    e.preventDefault(); // Space must not scroll the page
    handler(tr.dataset.id);
  });
}
