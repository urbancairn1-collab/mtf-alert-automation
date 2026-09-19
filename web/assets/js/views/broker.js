// Broker / API setup: Angel One credentials (write-only), connect/test/disconnect, funds, static IP.
import { api, ApiError } from '../lib/api.js';
import { emit } from '../lib/bus.js';
import { html, mount } from '../lib/html.js';
import { icon } from '../lib/icons.js';
import { money, dateTime } from '../lib/format.js';
import { formValues, showFieldErrors } from '../lib/util.js';
import { card, errorBox, skeletonRows } from '../components/ui.js';
import { confirmModal, toast, wireCopy } from '../components/overlay.js';

function field({ name, label, type = 'text', help, placeholder, autocomplete = 'off' }) {
  return html`<div class="field"><label for="b-${name}">${label}</label>
    <input class="input" id="b-${name}" name="${name}" type="${type}" placeholder="${placeholder}" autocomplete="${autocomplete}" spellcheck="false">
    <div class="help">${help}</div></div>`;
}

function connectionCard(b) {
  const saved = b.configured ? 'Saved. Type again only to change.' : '';
  return card({
    title: 'Angel One', iconName: 'building-bank', desc: 'SmartAPI connection used for live prices, MTF margin and orders',
    actions: html`<span class="pill" data-tone="${b.connected ? 'ok' : 'err'}"><span class="dot"></span>${b.connected ? 'Connected' : 'Not connected'}</span>`,
    body: html`<dl class="kv" style="margin-bottom:18px">
        <dt>Client ID</dt><dd class="mono">${b.client_code_masked || 'Not saved'}</dd>
        <dt>API key</dt><dd class="mono">${b.api_key_masked || 'Not saved'}</dd>
        <dt>Last login</dt><dd>${dateTime(b.last_login_at)}</dd>
        <dt>Session valid till</dt><dd>${dateTime(b.session_valid_till)}</dd>
        ${b.last_error ? html`<dt>Last error</dt><dd class="down">${b.last_error}</dd>` : ''}
      </dl>
      <form data-creds class="form-grid" novalidate>
        ${field({ name: 'client_code', label: 'Client ID', placeholder: saved || 'Your Angel One login ID', help: 'The ID you use to log in to Angel One.' })}
        ${field({ name: 'api_key', label: 'API key', placeholder: saved || 'From your SmartAPI app', help: 'SmartAPI website > My Apps > your app.' })}
        ${field({ name: 'mpin', label: 'MPIN', type: 'password', placeholder: saved || '4 digits', help: 'Your 4-digit Angel One MPIN.', autocomplete: 'new-password' })}
        ${field({ name: 'totp_secret', label: 'TOTP secret', type: 'password', placeholder: saved || '16+ characters', help: 'Shown once when you enable TOTP for SmartAPI. Used for daily auto-login.', autocomplete: 'new-password' })}
        <div class="row full">
          <button type="submit" class="btn primary">${icon('lock', 16)}Save and connect</button>
          <button type="button" class="btn" data-action="connect">${icon('refresh', 16)}Test connection</button>
          <span class="spacer"></span>
          <button type="button" class="btn ghost" data-action="disconnect" ${b.connected ? '' : 'disabled'}>${icon('plug-connected', 16)}Disconnect</button>
        </div>
        <p class="subtle full">Credentials are stored encrypted on this PC only and are never shown again.</p>
      </form>`,
  });
}

function fundsCard(b) {
  const f = b.funds;
  return card({
    title: 'Funds (Angel One RMS)', iconName: 'wallet',
    body: f ? html`<dl class="kv"><dt>Available margin</dt><dd class="num">${money(f.available)}</dd>
      <dt>Used margin</dt><dd class="num">${money(f.used)}</dd><dt>Net</dt><dd class="num">${money(f.net)}</dd></dl>`
      : html`<p class="muted">Connect Angel One to see funds. Qty in "Amount = my margin" mode uses this.</p>`,
  });
}

function ipCard(b) {
  return card({
    title: 'Static IP (required for orders)', iconName: 'server',
    body: html`<div class="stack" style="gap:12px">
      <div class="row"><span class="muted">This PC's public IP</span><strong class="mono">${b.public_ip}</strong>
        <button type="button" class="btn sm" data-copy="${b.public_ip}">${icon('copy', 14)}Copy</button></div>
      <p class="muted" style="font-size:13px">Since 1 April 2026 Angel One executes API orders only from the primary static IP registered in your SmartAPI app. The IP can be changed at most once a week.</p>
      <ol style="margin:0;padding-left:18px;font-size:13px;display:flex;flex-direction:column;gap:4px">
        <li>Get a static IP for this PC from your internet provider.</li>
        <li>Open the SmartAPI website, go to My Apps and edit your app.</li>
        <li>Enter the IP above as the Primary Static IP and save.</li>
      </ol></div>`,
  });
}

async function onSave(form, reload) {
  try {
    await api.put('/api/broker/credentials', formValues(form));
    await api.post('/api/broker/connect');
    toast('Angel One connected.');
    emit('status:refresh');
    reload();
  } catch (err) {
    if (err instanceof ApiError && err.fields) showFieldErrors(form, err.fields);
    toast(err.message, 'err');
  }
}

async function onAction(action, reload) {
  if (action === 'disconnect') {
    const ok = await confirmModal({ title: 'Disconnect Angel One?', danger: true, iconName: 'plug-connected', confirmLabel: 'Disconnect', body: html`<p>Live prices stop and no orders can be placed until you connect again. Automation keeps receiving alerts but they will fail.</p>` });
    if (!ok) return;
  }
  try {
    await api.post(`/api/broker/${action}`);
    toast(action === 'connect' ? 'Angel One login OK.' : 'Angel One disconnected.', action === 'connect' ? 'ok' : 'warn');
    emit('status:refresh');
    reload();
  } catch (err) {
    toast(err.message, 'err');
  }
}

export default {
  id: 'broker',
  title: 'Broker',
  subtitle: 'Connect your MTF-enabled Angel One account',
  icon: 'plug-connected',
  async render(root) {
    const load = async () => {
      try {
        const b = await api.get('/api/broker');
        mount(root, html`<div class="grid-2">${connectionCard(b)}<div class="stack">${fundsCard(b)}${ipCard(b)}</div></div>`);
      } catch (err) {
        mount(root, card({ body: errorBox(err.message, 'retry') }));
      }
    };
    mount(root, card({ title: 'Loading broker', body: skeletonRows(4, 2) }));
    root.addEventListener('submit', (e) => { e.preventDefault(); onSave(e.target, load); });
    root.addEventListener('click', (e) => {
      const a = e.target.closest('[data-action]');
      if (!a) return;
      if (a.dataset.action === 'retry') load();
      else onAction(a.dataset.action, load);
    });
    wireCopy(root);
    await load();
  },
};
