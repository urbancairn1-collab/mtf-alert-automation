// Bootstrap: shell, theme, IST clock, status refresh, live events, router.
import { CONFIG } from './config.js';
import { api } from './lib/api.js';
import { emit, on } from './lib/bus.js';
import { html, mount } from './lib/html.js';
import { icon } from './lib/icons.js';
import { timeSec } from './lib/format.js';
import { setStatus } from './lib/store.js';
import { createRouter } from './lib/router.js';
import { shellMarkup, setActiveNav, applyStatus, showOffline } from './components/shell.js';
import { confirmModal, toast } from './components/overlay.js';
import { VIEWS } from './views/index.js';

const THEME_KEY = 'mtf-theme';
const STATUS_POLL_MS = 15000;

function readTheme() {
  try { return localStorage.getItem(THEME_KEY) || 'light'; } catch { return 'light'; }
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const btn = document.querySelector('[data-act="theme"]');
  if (btn) mount(btn, icon(theme === 'dark' ? 'sun' : 'moon', 18));
  try { localStorage.setItem(THEME_KEY, theme); } catch { /* private mode: theme just won't persist */ }
}

let refreshTimer = null;
async function refreshStatus() {
  try {
    const st = await api.get('/api/status');
    setStatus(st);
    applyStatus(st);
  } catch (err) {
    showOffline(err.message);
  }
}
function refreshSoon() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refreshStatus, 250);
}

// Single entry point for the kill switch (sidebar switch and Settings button both call this).
async function requestAutomation(turnOn) {
  const ok = await confirmModal(turnOn
    ? { title: 'Start automation?', body: html`<p>New BUY and SELL alerts will be traded again using your current settings.</p>`, confirmLabel: 'Start automation', iconName: 'player-play' }
    : { title: 'Stop all automation?', body: html`<p>This is the emergency kill switch.</p><p>New alerts will be rejected and working orders cancelled. <strong>Open positions are not sold.</strong></p>`, confirmLabel: 'Stop automation', danger: true, iconName: 'hand-stop' });
  if (!ok) return;
  try {
    await api.post('/api/automation', { on: turnOn });
    toast(turnOn ? 'Automation started' : 'Automation stopped. Kill switch is active.', turnOn ? 'ok' : 'warn');
    refreshStatus();
  } catch (err) {
    toast(err.message, 'err');
  }
}

function wireShell() {
  const shell = document.querySelector('.shell');
  document.querySelector('[data-act="theme"]').addEventListener('click', () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
  document.querySelector('[data-act="menu"]').addEventListener('click', () => { shell.dataset.nav = shell.dataset.nav === 'open' ? 'closed' : 'open'; });
  document.querySelector('.nav').addEventListener('click', () => { shell.dataset.nav = 'closed'; });
  document.querySelector('#auto-card input').addEventListener('change', (e) => {
    const wanted = e.target.checked;
    e.target.checked = !wanted;
    requestAutomation(wanted);
  });
  on('automation:toggle', requestAutomation);
  const clock = document.getElementById('clock');
  const tickClock = () => { clock.textContent = `${timeSec(new Date().toISOString())} IST`; };
  tickClock();
  setInterval(tickClock, 1000);
}

async function start() {
  mount(document.getElementById('app'), shellMarkup(VIEWS, { demo: api.isDemo, version: CONFIG.version }));
  applyTheme(readTheme());
  wireShell();
  const router = createRouter({
    views: VIEWS,
    fallback: 'dashboard',
    onChange(view) {
      setActiveNav(view.id);
      document.getElementById('page-title').textContent = view.title;
      document.getElementById('page-sub').textContent = view.subtitle;
      document.title = `${view.title} | MTF Trader`;
    },
  });
  await refreshStatus();
  api.subscribe((type, payload) => {
    emit(type, payload);
    if (type !== 'tick') refreshSoon();
  });
  on('status:refresh', refreshSoon);
  setInterval(refreshStatus, STATUS_POLL_MS);
  router.start();
}

start().catch((err) => {
  console.error(err);
  document.getElementById('app').textContent = `MTF Trader failed to start: ${err.message}`;
});
