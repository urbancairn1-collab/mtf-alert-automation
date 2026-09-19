// Settings: trading rules (amount, qty mode, caps), order execution, risk & safety,
// trading mode (Paper/Live) and the TradingView webhook.
import { api, ApiError } from '../lib/api.js';
import { emit, on } from '../lib/bus.js';
import { html, mount } from '../lib/html.js';
import { icon } from '../lib/icons.js';
import { getStatus } from '../lib/store.js';
import { formValues, showFieldErrors } from '../lib/util.js';
import { card, seg, switchInput, errorBox, skeletonRows } from '../components/ui.js';
import { toast, wireCopy } from '../components/overlay.js';
import { webhookCard, wireWebhook } from './settings-webhook.js';
import { switchMode } from './settings-mode.js';

const HINTS = {
  margin: 'Amount is your own money (margin). Qty = amount / MTF margin per share from Angel One. At 25% margin, ₹10,000 buys about ₹40,000 of stock.',
  value: 'Amount is the full order value. Qty = amount / share price. ₹10,000 buys about ₹10,000 of stock; your margin used is only a part of it.',
};

function num({ name, label, value, help, prefix, suffix, step = 1 }) {
  return html`<div class="field"><label for="s-${name}">${label}</label>
    <div class="input-group">${prefix ? html`<span class="prefix">${prefix}</span>` : ''}
      <input class="input num" type="number" id="s-${name}" name="${name}" value="${value}" step="${step}" inputmode="decimal">
      ${suffix ? html`<span class="suffix">${suffix}</span>` : ''}</div>
    ${help ? html`<div class="help">${help}</div>` : ''}</div>`;
}

function toggleRow({ name, checked, title, text, iconName, extra = '' }) {
  return html`<div class="toggle-row"><span class="ic">${icon(iconName, 18)}</span>
    <div><div class="t">${title}</div><div class="d">${text}</div></div>
    <div class="ctl">${extra}${switchInput({ name, checked, label: title })}</div></div>`;
}

function rulesCard(s) {
  return card({
    title: 'Trading rules', iconName: 'adjustments-horizontal', desc: 'Uses your existing indicator. BUY buys in MTF, SELL squares off in full.',
    body: html`<div class="form-grid">
      <div class="field"><label for="s-product">MTF product type</label>
        <select class="select" id="s-product" disabled><option>Margin Trading Facility (MTF)</option></select>
        <div class="help">Sent to Angel One as product MARGIN.</div></div>
      ${num({ name: 'amount_per_trade', label: 'Amount per trade', value: s.amount_per_trade, prefix: '₹', step: 500, help: 'Qty is calculated from this on every BUY alert.' })}
      <div class="field full"><label>How the amount is used</label>
        ${seg('sizing_mode', [{ value: 'margin', label: 'Amount = my margin' }, { value: 'value', label: 'Amount = order value' }], s.sizing_mode, { block: true, label: 'How the amount is used' })}
        <input type="hidden" name="sizing_mode" value="${s.sizing_mode}">
        <div class="help" data-hint>${HINTS[s.sizing_mode]}</div></div>
      ${num({ name: 'max_open_positions', label: 'Max open positions', value: s.max_open_positions, help: 'BUY alerts are rejected once this many stocks are held.' })}
      ${num({ name: 'capital_cap', label: 'Total capital cap (overall)', value: s.capital_cap, prefix: '₹', step: 1000, help: 'All open MTF positions together may not use more than this.' })}
    </div>`,
  });
}

function executionCard(s) {
  return card({
    title: 'Order execution', iconName: 'send', desc: 'How LIMIT orders are priced and followed up',
    body: html`<div class="banner info" style="margin-bottom:14px">${icon('info-circle', 18)}Angel One does not allow market or IOC orders from algos. Orders go out as LIMIT at live price plus or minus the buffer.</div>
      <div class="form-grid">
        ${num({ name: 'limit_buffer_pct', label: 'Limit price buffer', value: s.limit_buffer_pct, suffix: '%', step: 0.05, help: 'BUY at LTP + buffer, SELL at LTP - buffer.' })}
        ${num({ name: 'buy_fill_timeout_sec', label: 'Cancel unfilled BUY after', value: s.buy_fill_timeout_sec, suffix: 'sec' })}
        ${num({ name: 'sell_reprice_attempts', label: 'SELL re-price attempts', value: s.sell_reprice_attempts, help: 'If a SELL is not filled it is re-priced to the new LTP.' })}
        ${num({ name: 'sell_reprice_interval_sec', label: 'Re-price SELL every', value: s.sell_reprice_interval_sec, suffix: 'sec' })}
      </div>`,
  });
}

function riskCard(s, st) {
  const autoOn = st?.automation.on;
  return card({
    title: 'Risk & safety', iconName: 'shield-check',
    body: html`
      ${toggleRow({ name: 'one_position_per_stock', checked: s.one_position_per_stock, iconName: 'lock', title: 'One position per stock', text: 'A BUY alert for a stock already held is ignored.' })}
      ${toggleRow({ name: 'duplicate_protection', checked: s.duplicate_protection, iconName: 'copy', title: 'Duplicate alert protection', text: 'Same stock and action repeated within the window is blocked.',
        extra: html`<div class="input-group" style="width:120px"><input class="input num" type="number" name="duplicate_window_sec" value="${s.duplicate_window_sec}" aria-label="Duplicate window in seconds"><span class="suffix">sec</span></div>` })}
      <div class="toggle-row"><span class="ic">${icon('hand-stop', 18)}</span>
        <div><div class="t">Emergency kill switch</div><div class="d">Stops all automation instantly. Open positions are kept.</div></div>
        <div class="ctl"><button type="button" class="btn ${autoOn ? 'danger' : 'primary'}" data-action="kill">${icon(autoOn ? 'hand-stop' : 'player-play', 16)}${autoOn ? 'Stop automation' : 'Start automation'}</button></div></div>`,
  });
}

function modeCard(s) {
  return card({
    title: 'Trading mode', iconName: 'arrows-exchange',
    body: html`<div class="stack" style="gap:14px">
      ${seg('mode', [{ value: 'PAPER', label: 'Paper (test)' }, { value: 'LIVE', label: 'Live (real orders)' }], s.mode, { block: true, label: 'Trading mode' })}
      <p class="muted" style="font-size:13px">${s.mode === 'LIVE' ? 'Live: BUY and SELL alerts place real MTF orders in your Angel One account.' : 'Paper: the full alert-to-order flow runs, but no order is sent to Angel One.'}</p>
      ${num({ name: 'paper_margin_pct', label: 'Paper margin estimate', value: s.paper_margin_pct, suffix: '%', help: 'Used only in Paper mode when Angel One is not connected, to estimate MTF margin per share.' })}
    </div>`,
  });
}

function page(s, w, st) {
  return html`<form data-settings novalidate class="stack">
      <div class="grid-2">
        <div class="stack">${rulesCard(s)}${executionCard(s)}</div>
        <div class="stack">${riskCard(s, st)}${modeCard(s)}</div>
      </div>
      <div class="savebar" data-savebar hidden>
        ${icon('info-circle', 18)}<span>You have unsaved changes.</span><span class="spacer"></span>
        <button type="button" class="btn" data-action="discard">Discard</button>
        <button type="submit" class="btn primary">${icon('check', 16)}Save settings</button>
      </div>
    </form>
    ${webhookCard(w, s.mode)}`;
}

async function save(form, reload) {
  try {
    await api.put('/api/settings', formValues(form));
    toast('Settings saved. New alerts use them immediately.');
    emit('status:refresh');
    reload();
  } catch (err) {
    if (err instanceof ApiError && err.fields) showFieldErrors(form, err.fields);
    toast(err.message, 'err');
  }
}

function wire(root, reload) {
  root.addEventListener('input', (e) => { if (e.target.closest('[data-settings]')) root.querySelector('[data-savebar]').hidden = false; });
  root.addEventListener('submit', (e) => { e.preventDefault(); save(e.target, reload); });
  root.addEventListener('click', (e) => {
    const sizing = e.target.closest('[data-seg="sizing_mode"] button');
    if (sizing) {
      const form = root.querySelector('[data-settings]');
      form.querySelector('input[name="sizing_mode"]').value = sizing.dataset.value;
      sizing.parentElement.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === sizing)));
      form.querySelector('[data-hint]').textContent = HINTS[sizing.dataset.value];
      root.querySelector('[data-savebar]').hidden = false;
    }
    const mode = e.target.closest('[data-seg="mode"] button');
    if (mode && mode.getAttribute('aria-pressed') !== 'true') switchMode(mode.dataset.value, reload);
    if (e.target.closest('[data-action="discard"]')) reload();
    if (e.target.closest('[data-action="kill"]')) emit('automation:toggle', !getStatus()?.automation.on);
  });
  wireCopy(root);
  wireWebhook(root, reload);
}

export default {
  id: 'settings',
  title: 'Settings',
  subtitle: 'Amount, risk limits, trading mode and webhook',
  icon: 'settings',
  async render(root) {
    const load = async () => {
      try {
        const [s, w] = await Promise.all([api.get('/api/settings'), api.get('/api/webhook')]);
        mount(root, page(s, w, getStatus()));
      } catch (err) {
        mount(root, card({ body: errorBox(err.message, 'retry') }));
      }
    };
    mount(root, card({ title: 'Loading settings', body: skeletonRows(5, 3) }));
    wire(root, load);
    root.addEventListener('click', (e) => { if (e.target.closest('[data-action="retry"]')) load(); });
    await load();
    const off = on('status:changed', (st) => {
      const btn = root.querySelector('[data-action="kill"]');
      if (!btn) return;
      btn.className = `btn ${st.automation.on ? 'danger' : 'primary'}`;
      mount(btn, html`${icon(st.automation.on ? 'hand-stop' : 'player-play', 16)}${st.automation.on ? 'Stop automation' : 'Start automation'}`);
    });
    return off;
  },
};
