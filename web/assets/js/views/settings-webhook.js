// Settings > TradingView webhook card: URL, secret (reveal/copy/rotate), alert templates, paper test alert.
import { api } from '../lib/api.js';
import { html, mount } from '../lib/html.js';
import { icon } from '../lib/icons.js';
import { ago } from '../lib/format.js';
import { card, templateBlock, seg } from '../components/ui.js';
import { confirmModal, toast } from '../components/overlay.js';
import { wireTemplateCopy } from '../components/webhook-copy.js';

function testRow(mode) {
  if (mode !== 'PAPER') {
    return html`<div class="banner info">${icon('info-circle', 18)}Test alerts are available in Paper mode only, so a test can never place a real order.</div>`;
  }
  return html`<div class="field full"><label for="t-symbol">Send a test alert (Paper mode)</label>
    <div class="row">
      <input class="input" id="t-symbol" style="max-width:180px" value="SBIN" autocomplete="off" aria-describedby="t-help">
      ${seg('test_action', [{ value: 'BUY', label: 'BUY' }, { value: 'SELL', label: 'SELL' }], 'BUY', { label: 'Test alert type' })}
      <button type="button" class="btn primary" data-action="send-test">${icon('send', 16)}Send test alert</button>
    </div>
    <div class="help" id="t-help">Runs the full flow (checks, qty, LIMIT order, fill) without TradingView. Market-hours check is skipped for tests.</div></div>`;
}

export function webhookCard(w, mode) {
  return card({
    title: 'TradingView webhook', iconName: 'webhook',
    desc: 'Paste the URL and message below into your indicator alert in TradingView',
    actions: html`<span class="pill" data-tone="${w.tunnel_up ? 'ok' : 'err'}"><span class="dot"></span>${w.tunnel_up ? 'Tunnel up' : 'Tunnel down'}</span>`,
    body: html`<div class="form-grid">
      <div class="field full"><label for="w-url">Webhook URL</label>
        <div class="row"><input class="input" id="w-url" value="${w.public_url}" readonly style="flex:1;min-width:220px">
        <button type="button" class="btn" data-copy="${w.public_url}">${icon('copy', 16)}Copy</button></div>
        <div class="help">Last alert received ${ago(w.last_alert_at)}. TradingView sends only to ports 80/443, which is why the app uses an ngrok address.</div></div>
      <div class="field full"><label for="w-secret">Webhook secret</label>
        <div class="row"><input class="input mono" id="w-secret" value="${w.secret_masked}" readonly style="flex:1;min-width:220px">
        <button type="button" class="btn" data-action="reveal">${icon('eye', 16)}Reveal</button>
        <button type="button" class="btn" data-action="rotate">${icon('rotate', 16)}Rotate</button></div>
        <div class="help">Alerts without this secret are rejected. If you rotate it, update both alert messages in TradingView.</div></div>
      <div class="field"><label>BUY alert message</label>${templateBlock(w.template_buy, w.secret_masked)}</div>
      <div class="field"><label>SELL alert message</label>${templateBlock(w.template_sell, w.secret_masked)}</div>
      ${testRow(mode)}
    </div>`,
  });
}

async function sendTest(root) {
  const symbol = root.querySelector('#t-symbol').value.trim().toUpperCase();
  const action = root.querySelector('[data-seg="test_action"] [aria-pressed="true"]').dataset.value;
  if (!/^[A-Z0-9&_-]{1,30}$/.test(symbol)) { toast('Enter a valid NSE symbol, e.g. SBIN', 'warn'); return; }
  try {
    const a = await api.post('/api/webhook/test', { symbol, action });
    toast(`Test ${action} ${a.symbol}: ${a.action_taken}. ${a.detail}`, a.status === 'REJECTED' || a.status === 'FAILED' ? 'warn' : 'ok', 5000);
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function rotate(reload) {
  const ok = await confirmModal({
    title: 'Rotate webhook secret?', danger: true, iconName: 'rotate', confirmLabel: 'Rotate secret',
    body: html`<p>The old secret stops working immediately. Alerts from TradingView will be rejected until you paste the new message into both alerts.</p>`,
  });
  if (!ok) return;
  try {
    await api.post('/api/webhook/rotate');
    toast('New secret created. Update your TradingView alerts.', 'warn', 5000);
    reload();
  } catch (err) {
    toast(err.message, 'err');
  }
}

export function wireWebhook(root, reload) {
  wireTemplateCopy(root);
  root.addEventListener('click', async (e) => {
    if (e.target.closest('[data-action="send-test"]')) sendTest(root);
    if (e.target.closest('[data-action="rotate"]')) rotate(reload);
    const segBtn = e.target.closest('[data-seg="test_action"] button');
    if (segBtn) segBtn.parentElement.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === segBtn)));
    const reveal = e.target.closest('[data-action="reveal"]');
    if (reveal) {
      try {
        const { secret } = await api.post('/api/webhook/reveal');
        const input = root.querySelector('#w-secret');
        input.value = secret;
        mount(reveal, html`${icon('copy', 16)}Copy`);
        reveal.dataset.action = '';
        reveal.dataset.copy = secret;
      } catch (err) {
        toast(err.message, 'err');
      }
    }
  });
}
