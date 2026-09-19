// Sidebar, top bar and status-driven chrome (pills, banners, automation switch).
import { html, mount } from '../lib/html.js';
import { icon } from '../lib/icons.js';
import { ago } from '../lib/format.js';
import { switchInput } from './ui.js';

export function shellMarkup(views, { demo, version }) {
  return html`<div class="shell" data-nav="closed">
    <aside class="sidebar" aria-label="Main navigation">
      <div class="brand">
        <div class="brand-mark">${icon('trending-up', 20)}</div>
        <div><div class="brand-name">MTF Trader</div><div class="brand-tag">Alert to MTF order, automatically</div></div>
      </div>
      <nav class="nav">${views.map((v) => html`<a href="#/${v.id}" data-nav="${v.id}">${icon(v.icon, 19)}<span>${v.title}</span></a>`)}</nav>
      <div class="sidebar-foot">
        <div class="auto-card" data-on="true" id="auto-card">
          <div style="flex:1;min-width:0"><div class="t" data-slot="t">Automation is ON</div><div class="s" data-slot="s">Alerts are being traded</div></div>
          ${switchInput({ name: 'automation', checked: true, label: 'Automation on or off (kill switch)' })}
        </div>
        <div class="sidebar-credit">v${version} by Urban Cairn Tech Solutions</div>
      </div>
    </aside>
    <div class="main">
      <header class="topbar">
        <button type="button" class="btn ghost icon menu-btn" data-act="menu" aria-label="Open menu">${icon('menu-2', 20)}</button>
        <div class="page-head"><h1 id="page-title">Dashboard</h1><p id="page-sub"></p></div>
        <div class="right">
          ${demo ? html`<span class="pill demo" title="Sample data. Nothing is sent to a broker.">${icon('flask', 15)}<span class="lbl">Demo data</span></span>` : ''}
          <span class="pill hide-sm" id="pill-market" data-tone=""><span class="dot"></span><span data-slot="t">Market</span></span>
          <span class="pill" id="pill-mode">-</span>
          <span class="pill hide-md" id="pill-broker" data-tone=""><span class="dot"></span><span data-slot="t">Broker</span></span>
          <span class="clock num" id="clock" aria-label="Indian Standard Time"></span>
          <button type="button" class="btn ghost icon" data-act="theme" aria-label="Switch light or dark theme">${icon('moon', 18)}</button>
        </div>
      </header>
      <div class="content">
        <div id="banners" class="stack" style="gap:8px"></div>
        <div id="view" class="stack" style="gap:20px"></div>
      </div>
    </div>
  </div>`;
}

export function setActiveNav(viewId) {
  document.querySelectorAll('.nav a').forEach((a) => {
    if (a.dataset.nav === viewId) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
}

function setPill(id, text, tone) {
  const el = document.getElementById(id);
  el.dataset.tone = tone;
  el.querySelector('[data-slot="t"]').textContent = text;
}

export function applyStatus(st) {
  setPill('pill-market', st.market.label, st.market.open ? 'ok' : '');
  setPill('pill-broker', `${st.broker.name}: ${st.broker.connected ? 'Connected' : 'Not connected'}`, st.broker.connected ? 'ok' : 'err');
  const mode = document.getElementById('pill-mode');
  mode.className = `pill ${st.mode === 'LIVE' ? 'mode-live' : 'mode-paper'}`;
  mode.textContent = st.mode === 'LIVE' ? 'LIVE' : 'PAPER';
  mode.title = st.mode === 'LIVE' ? 'Real orders are sent to Angel One' : 'Paper mode: no real orders';

  const card = document.getElementById('auto-card');
  const on = st.automation.on;
  card.dataset.on = String(on);
  card.querySelector('[data-slot="t"]').textContent = on ? 'Automation is ON' : 'Automation is OFF';
  card.querySelector('[data-slot="s"]').textContent = on ? `Last alert ${ago(st.webhook.last_alert_at)}` : 'Kill switch active. Alerts rejected.';
  card.querySelector('input').checked = on;
  renderBanners(st);
}

function renderBanners(st) {
  const items = [];
  if (!st.automation.on) items.push(html`<div class="banner err" role="alert">${icon('hand-stop', 18)}Automation is OFF. New alerts are rejected and no orders are placed. Open positions are kept.</div>`);
  st.exit_pending.forEach((s) => items.push(html`<div class="banner warn" role="alert">${icon('alert-triangle', 18)}Exit pending for ${s}. The SELL order is still working after re-pricing. Check the Orders page.</div>`));
  if (!st.webhook.tunnel_up) items.push(html`<div class="banner err" role="alert">${icon('wifi-off', 18)}Webhook tunnel is down. TradingView alerts cannot reach this PC. Restart the app with start.bat.</div>`);
  if (!st.broker.connected) items.push(html`<div class="banner warn">${icon('plug-connected', 18)}Angel One is not connected. Live prices and orders need a broker session.</div>`);
  mount(document.getElementById('banners'), items);
}

export function showOffline(message) {
  mount(document.getElementById('banners'), html`<div class="banner err" role="alert">${icon('server', 18)}${message}</div>`);
}
