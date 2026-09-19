// Dashboard: KPIs, open MTF positions (live P&L), recent alerts, live pipeline status.
import { api } from '../lib/api.js';
import { on } from '../lib/bus.js';
import { html, mount } from '../lib/html.js';
import { icon } from '../lib/icons.js';
import { money, signedMoney, tone, time, ago, istParts } from '../lib/format.js';
import { card, kpi, actionBadge, alertStatusBadge, empty, errorBox, skeletonRows } from '../components/ui.js';
import { positionsTable, patchTicks, totalPnl } from '../components/positions.js';
import { debounce } from '../lib/util.js';

function greeting() {
  const m = istParts().minutes;
  return m < 720 ? 'Good morning' : m < 1020 ? 'Good afternoon' : 'Good evening';
}

function kpis(k, pipeline) {
  const used = k.capital_cap ? k.capital_deployed / k.capital_cap : 0;
  return html`<div class="grid-kpi">
    ${kpi({ iconName: 'wallet', label: 'Total capital deployed', value: money(k.capital_deployed), sub: `of ${money(k.capital_cap)} cap (${(used * 100).toFixed(1)}%)`, meter: used })}
    ${kpi({ iconName: 'stack-2', label: 'Running positions', value: `${k.open_positions} / ${k.max_positions}`, sub: html`Unrealised <span class="num ${tone(k.unrealised_pnl)}" data-kpi-unreal>${signedMoney(k.unrealised_pnl)}</span>`, meter: k.max_positions ? k.open_positions / k.max_positions : 0 })}
    ${kpi({ iconName: 'receipt', label: 'Realised P&L (today)', value: html`<span class="${tone(k.realised_pnl_today)}">${signedMoney(k.realised_pnl_today)}</span>`, sub: `${pipeline.trades_today} trade${pipeline.trades_today === 1 ? '' : 's'} squared off today` })}
    ${kpi({ iconName: 'building-bank', label: 'Available margin (broker)', value: k.available_margin === null ? 'Not connected' : money(k.available_margin), sub: html`<span class="badge b-accent">MTF</span>${k.margin_source}` })}
  </div>`;
}

function alertFeed(alerts) {
  if (!alerts.length) return empty({ iconName: 'bell-ringing', title: 'No alerts yet', text: 'Alerts from your TradingView indicator will appear here the moment they arrive.' });
  return html`<ul class="feed">${alerts.map((a) => html`<li data-href="#/alerts">
    ${actionBadge(a.action)}
    <div style="min-width:0"><div class="t">${a.symbol}</div><div class="d">${a.action_taken}. ${a.detail}</div></div>
    <div class="time"><div class="num">${time(a.received_at)}</div>${alertStatusBadge(a.status)}</div>
  </li>`)}</ul>`;
}

function pipelineStep(iconName, title, detail, state = 'ok') {
  return html`<div class="pipe-step" data-state="${state}"><div class="ic">${icon(iconName, 18)}</div>
    <div><div class="t">${title}</div><div class="d">${detail}</div></div></div>`;
}

function pipeline(p) {
  return html`<div class="pipeline">
    ${pipelineStep('bell-ringing', 'Indicator alert', p.last_alert_at ? `Last alert ${ago(p.last_alert_at)}` : 'Waiting for first alert', p.last_alert_at ? 'ok' : 'warn')}
    ${pipelineStep('webhook', 'Receive alert', p.webhook_up ? 'Webhook tunnel is up' : 'Tunnel down, alerts cannot arrive', p.webhook_up ? 'ok' : 'err')}
    ${pipelineStep('calculator', 'Calculate qty', `${money(p.amount_per_trade)} per trade, ${p.sizing_mode === 'margin' ? 'amount = margin' : 'amount = order value'}`)}
    ${pipelineStep('bolt', 'Auto buy in MTF', p.broker_connected ? `${p.broker}, ${p.mode === 'LIVE' ? 'LIVE orders' : 'Paper mode'}` : `${p.broker} not connected`, p.broker_connected ? 'ok' : 'warn')}
    ${pipelineStep('arrows-exchange', 'Square off on SELL', `${p.trades_today} closed today`)}
  </div>`;
}

function draw(root, d) {
  const autoText = d.pipeline.mode === 'LIVE' ? 'Live orders are being placed in your Angel One account.' : 'Paper mode: the full flow runs, no real orders are sent.';
  mount(root, html`
    <div><h2 class="greet">${greeting()}</h2><p class="muted">${autoText}</p></div>
    ${kpis(d.kpis, d.pipeline)}
    <div class="grid-main">
      ${card({ title: `Open MTF positions (${d.positions.length})`, iconName: 'stack-2', flush: true,
        actions: html`<a class="btn sm ghost" href="#/positions">View all ${icon('arrow-right', 15)}</a>`,
        body: html`<div data-positions>${positionsTable(d.positions, { compact: true })}</div>`,
        footer: html`<span class="subtle">Unrealised P&L</span><span class="spacer"></span><strong class="num ${tone(totalPnl(d.positions))}" data-total-pnl>${signedMoney(totalPnl(d.positions))}</strong>` })}
      ${card({ title: 'Recent alerts', iconName: 'bell-ringing', flush: true,
        actions: html`<a class="btn sm ghost" href="#/alerts">View all ${icon('arrow-right', 15)}</a>`,
        body: alertFeed(d.recent_alerts) })}
    </div>
    ${card({ title: 'Automation status', desc: 'Every step from your indicator to the square-off, live', iconName: 'route', flush: true, body: pipeline(d.pipeline) })}
  `);
}

export default {
  id: 'dashboard',
  title: 'Dashboard',
  subtitle: 'Your MTF trading automation at a glance',
  icon: 'layout-dashboard',
  async render(root) {
    let data = null;
    const load = async () => {
      try {
        data = await api.get('/api/dashboard');
        draw(root, data);
      } catch (err) {
        mount(root, card({ body: errorBox(err.message, 'retry') }));
      }
    };
    const reload = debounce(load, 300);
    mount(root, card({ title: 'Loading dashboard', body: skeletonRows(4, 5) }));
    root.addEventListener('click', (e) => {
      if (e.target.closest('[data-action="retry"]')) load();
      const li = e.target.closest('li[data-href]');
      if (li) location.hash = li.dataset.href;
    });
    await load();
    const offs = [
      on('tick', (ticks) => {
        if (!data) return;
        patchTicks(root.querySelector('[data-positions]'), data.positions, ticks);
        const total = totalPnl(data.positions);
        root.querySelectorAll('[data-total-pnl], [data-kpi-unreal]').forEach((el) => { el.textContent = signedMoney(total); el.className = `num ${tone(total)}`; });
      }),
      ...['alert', 'position', 'trade', 'status'].map((t) => on(t, reload)),
    ];
    return () => { reload.cancel(); offs.forEach((off) => off()); };
  },
};
