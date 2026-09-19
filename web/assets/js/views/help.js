// Help & support: setup checklist (live state), alert format, why an alert did not trade, support/AMC.
import { api } from '../lib/api.js';
import { html, mount } from '../lib/html.js';
import { icon } from '../lib/icons.js';
import { getStatus } from '../lib/store.js';
import { card, templateBlock, errorBox, skeletonRows } from '../components/ui.js';
import { wireTemplateCopy } from '../components/webhook-copy.js';

const REASONS = [
  ['Market closed', 'Orders are placed only Monday to Friday, 09:15 to 15:30 IST. Exchange holidays are rejected by the broker.'],
  ['Duplicate', 'The same stock and action arrived again inside the duplicate window (default 60 s).'],
  ['Already holding', 'One open position per stock. A second BUY for a held stock is ignored.'],
  ['Max open positions', 'The number of open MTF positions reached your limit in Settings.'],
  ['Capital cap reached', 'This trade would take total deployed money above your overall cap.'],
  ['Not an MTF stock', 'Angel One allows MTF only on its approved list. Other stocks are rejected by the broker.'],
  ['Order not filled', 'A LIMIT BUY not filled in the timeout is cancelled. Nothing is bought.'],
  ['Automation OFF', 'The kill switch is on. Turn automation back on from the sidebar.'],
  ['IP not registered', 'Angel One blocks orders that do not come from the static IP in your SmartAPI app.'],
  ['Wrong secret', 'The alert message does not contain the current webhook secret. Copy it again from Settings.'],
];

function checklist(st, b) {
  const items = [
    [true, 'Angel One account with MTF activated', 'Confirm in the Angel One app under MTF.', null],
    [b.configured, 'SmartAPI app, API key and TOTP saved', 'Broker page: Client ID, API key, MPIN, TOTP secret.', '#/broker'],
    [b.connected, 'Angel One connected', 'Daily auto-login with TOTP at 08:45 IST.', '#/broker'],
    [st.webhook.tunnel_up, 'Webhook tunnel running', 'start.bat starts the app and the ngrok tunnel together.', '#/settings'],
    [Boolean(st.webhook.last_alert_at), 'TradingView alert created', 'One alert for BUY, one for SELL, with the messages below.', '#/settings'],
    [st.mode === 'LIVE', 'Tested in Paper, then switched to Live', 'Use "Send test alert" in Settings first.', '#/settings'],
  ];
  return html`<ul class="checklist">${items.map(([done, t, d, href], i) => html`<li data-done="${i === 0 ? 'manual' : done}">
    <span class="state">${icon(i === 0 ? 'info-circle' : done ? 'circle-check' : 'clock', 20)}</span>
    <div><div class="t">${t}</div><div class="d">${d}</div>${href ? html`<a href="${href}" style="font-size:12.5px">Open ${icon('arrow-right', 13)}</a>` : ''}</div></li>`)}</ul>`;
}

function page(st, b, w) {
  return html`
    ${card({ title: 'Setup checklist', iconName: 'checklist', desc: 'Updates by itself as each step is completed', body: checklist(st, b) })}
    <div class="grid-2">
      ${card({ title: 'Alert message format', iconName: 'webhook', desc: 'Paste into the Message box of your indicator alert. Webhook URL is in Settings.',
        body: html`<div class="stack" style="gap:12px"><div class="field"><label>BUY alert</label>${templateBlock(w.template_buy, w.secret_masked)}</div>
          <div class="field"><label>SELL alert</label>${templateBlock(w.template_sell, w.secret_masked)}</div></div>` })}
      ${card({ title: 'Support', iconName: 'lifebuoy', body: html`<div class="stack" style="gap:12px">
        <p><strong>Urban Cairn Tech Solutions</strong></p>
        <div class="row">${icon('mail', 16)}<a href="mailto:urbancairn1@gmail.com">urbancairn1@gmail.com</a></div>
        <div class="row">${icon('phone', 16)}<a href="tel:+919313560694">+91 93135 60694</a></div>
        <div class="row">${icon('external-link', 16)}<a href="https://urbancairn.in" target="_blank" rel="noopener noreferrer">urbancairn.in</a></div>
        <div class="banner info">${icon('info-circle', 18)}1 month free AMC from delivery: bug fixes, amount-logic adjustments and broker API upkeep.</div>
        <p class="subtle">When you report a problem, share the time of the alert and a screenshot of the Logs page.</p></div>` })}
    </div>
    ${card({ title: 'Why did an alert not trade?', iconName: 'help-circle', desc: 'The exact reason is on every alert in the Alerts page. The common ones:',
      body: html`<div class="faq">${REASONS.map(([q, a]) => html`<div><div class="q">${q}</div><div class="a">${a}</div></div>`)}</div>` })}`;
}

export default {
  id: 'help',
  title: 'Help & Support',
  subtitle: 'Setup steps, alert format and support',
  icon: 'help-circle',
  async render(root) {
    mount(root, card({ title: 'Loading', body: skeletonRows(4, 2) }));
    wireTemplateCopy(root);
    try {
      const [b, w] = await Promise.all([api.get('/api/broker'), api.get('/api/webhook')]);
      mount(root, page(getStatus(), b, w));
    } catch (err) {
      mount(root, card({ body: errorBox(err.message) }));
    }
  },
};
