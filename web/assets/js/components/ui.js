// Presentational building blocks. All return SafeHtml from the html`` template.
import { html } from '../lib/html.js';
import { icon } from '../lib/icons.js';

const ALERT_STATUS = {
  EXECUTED: ['b-ok', 'Executed'],
  SQUARED_OFF: ['b-ok', 'Squared off'],
  PENDING: ['b-info', 'Working'],
  DUPLICATE: ['b-neutral', 'Duplicate'],
  IGNORED: ['b-neutral', 'Ignored'],
  REJECTED: ['b-warn', 'Rejected'],
  FAILED: ['b-err', 'Failed'],
};
const ORDER_STATUS = {
  COMPLETE: ['b-ok', 'Filled'],
  OPEN: ['b-info', 'Open'],
  PARTIAL: ['b-info', 'Part filled'],
  CANCELLED: ['b-neutral', 'Cancelled'],
  REJECTED: ['b-err', 'Rejected'],
};
const POSITION_STATUS = { OPEN: ['b-ok', 'Open'], EXITING: ['b-warn', 'Exiting'], CLOSED: ['b-neutral', 'Closed'] };
const LOG_LEVEL = { INFO: ['b-info', 'Info'], WARN: ['b-warn', 'Warning'], ERROR: ['b-err', 'Error'] };

const pick = (map, key) => map[key] || ['b-neutral', key || '-'];

export const badge = (cls, text) => html`<span class="badge ${cls}">${text}</span>`;
export const actionBadge = (a) => badge(a === 'BUY' ? 'b-buy' : 'b-sell', a);
export const alertStatusBadge = (s) => badge(...pick(ALERT_STATUS, s));
export const orderStatusBadge = (s) => badge(...pick(ORDER_STATUS, s));
export const positionStatusBadge = (s) => badge(...pick(POSITION_STATUS, s));
export const levelBadge = (l) => badge(...pick(LOG_LEVEL, l));

export function card({ title, desc, iconName, actions, body, footer, flush = false, attrs = '' }) {
  return html`<section class="card" ${attrs}>
    ${title ? html`<header class="card-h">
      <div>
        <h2>${iconName ? icon(iconName, 18) : ''}${title}</h2>
        ${desc ? html`<p class="desc">${desc}</p>` : ''}
      </div>
      ${actions ? html`<div class="actions">${actions}</div>` : ''}
    </header>` : ''}
    <div class="card-b ${flush ? 'flush' : ''}">${body}</div>
    ${footer ? html`<footer class="card-f">${footer}</footer>` : ''}
  </section>`;
}

export function kpi({ iconName, label, value, sub, meter, id }) {
  const level = meter === undefined ? '' : meter >= 1 ? 'full' : meter >= 0.8 ? 'high' : 'ok';
  return html`<section class="card kpi" ${id ? html`data-kpi="${id}"` : ''}>
    <div class="ic">${icon(iconName, 20)}</div>
    <div style="min-width:0;flex:1">
      <div class="label">${label}</div>
      <div class="value num" data-slot="value">${value}</div>
      <div class="sub" data-slot="sub">${sub}</div>
      ${meter === undefined ? '' : html`<div class="meter" data-level="${level}" role="meter"
        aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(meter * 100)}">
        <i style="width:${Math.min(100, Math.round(meter * 100))}%"></i></div>`}
    </div>
  </section>`;
}

export function empty({ iconName = 'info-circle', title, text, action }) {
  return html`<div class="empty">
    <div class="ic">${icon(iconName, 22)}</div>
    <div class="t">${title}</div>
    ${text ? html`<div class="d">${text}</div>` : ''}
    ${action || ''}
  </div>`;
}

export function errorBox(message, retryId) {
  return html`<div class="error-box" role="alert">
    ${icon('alert-triangle', 18)}
    <div><strong>Could not load this data.</strong><div class="subtle">${message}</div>
    ${retryId ? html`<button class="btn sm" style="margin-top:8px" data-action="${retryId}">${icon('refresh', 15)}Try again</button>` : ''}</div>
  </div>`;
}

export function skeletonRows(rows = 5, cols = 6) {
  const cells = Array.from({ length: cols }, () => html`<td><div class="skel" style="height:12px;width:70%"></div></td>`);
  return html`<table class="t" aria-busy="true"><tbody>${Array.from({ length: rows }, () => html`<tr>${cells}</tr>`)}</tbody></table>`;
}

export function switchInput({ name, checked, label, disabled = false }) {
  return html`<label class="switch">
    <input type="checkbox" role="switch" name="${name}" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''} aria-label="${label}">
    <span class="track"></span>
  </label>`;
}

export function seg(name, options, value, { block = false, label = '' } = {}) {
  return html`<div class="seg ${block ? 'block' : ''}" role="group" aria-label="${label}" data-seg="${name}">
    ${options.map((o) => html`<button type="button" data-value="${o.value}" aria-pressed="${o.value === value}">${o.label}</button>`)}
  </div>`;
}

export function chips(name, options, value) {
  return html`<div class="chips" data-chips="${name}">
    ${options.map((o) => html`<button type="button" class="chip" data-value="${o.value}" aria-pressed="${o.value === value}">
      ${o.label}${o.count === undefined ? '' : html`<span class="n">${o.count}</span>`}</button>`)}
  </div>`;
}

// Alert-message template shown with a masked secret; Copy fetches the real secret (see webhook-copy.js).
export function templateBlock(text, masked) {
  return html`<pre class="code"><button type="button" class="btn sm copy" data-copy-template="${text}" data-masked="${masked}">${icon('copy', 14)}Copy</button>${text}</pre>`;
}

export function symbolCell(symbol, sub) {
  return html`<div class="sym">${symbol}</div>${sub ? html`<div class="sym-sub">${sub}</div>` : ''}`;
}
