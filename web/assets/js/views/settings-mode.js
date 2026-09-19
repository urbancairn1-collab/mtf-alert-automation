// Paper <-> Live switch with the safety confirmation. The backend re-checks every blocker.
import { api, ApiError } from '../lib/api.js';
import { emit } from '../lib/bus.js';
import { html } from '../lib/html.js';
import { confirmModal, toast } from '../components/overlay.js';

async function confirmLive(publicIp) {
  return confirmModal({
    title: 'Switch to LIVE trading?', danger: true, iconName: 'alert-triangle', confirmLabel: 'Go live',
    body: html`<p>From now on every BUY alert places a <strong>real MTF order</strong> in your Angel One account, using your amount and risk settings.</p>
      <label class="row" style="align-items:flex-start;gap:10px;color:var(--text)"><input type="checkbox" name="ip_confirmed" style="margin-top:3px">
        <span>This PC's public IP <strong class="mono">${publicIp}</strong> is registered as the primary static IP in my SmartAPI app. Angel One blocks orders from any other IP.</span></label>
      <label class="row" style="align-items:flex-start;gap:10px;color:var(--text)"><input type="checkbox" name="paper_tested" style="margin-top:3px">
        <span>I have tested my indicator alerts in Paper mode.</span></label>`,
    validate: (wrap) => wrap.querySelector('[name="ip_confirmed"]').checked && wrap.querySelector('[name="paper_tested"]').checked,
  });
}

async function showBlockers(blockers) {
  const go = await confirmModal({
    title: 'Live mode is blocked', iconName: 'lock', confirmLabel: 'Open Broker page',
    body: html`<p>Fix these first:</p><ul style="margin:0;padding-left:18px">${blockers.map((b) => html`<li>${b}</li>`)}</ul>`,
  });
  if (go) location.hash = '#/broker';
}

export async function switchMode(target, reload) {
  try {
    if (target === 'LIVE') {
      const broker = await api.get('/api/broker');
      if (!(await confirmLive(broker.public_ip))) return;
      await api.post('/api/mode', { mode: 'LIVE', ip_confirmed: true });
      toast('LIVE mode on. Real orders will be placed.', 'warn', 5000);
    } else {
      const ok = await confirmModal({ title: 'Switch to Paper mode?', iconName: 'flask', confirmLabel: 'Switch to Paper', body: html`<p>New alerts will be simulated. Existing live positions stay in your Angel One account.</p>` });
      if (!ok) return;
      await api.post('/api/mode', { mode: 'PAPER' });
      toast('Paper mode on. No real orders will be sent.');
    }
    emit('status:refresh');
    reload();
  } catch (err) {
    if (err instanceof ApiError && err.fields?.blockers) showBlockers(err.fields.blockers);
    else toast(err.message, 'err');
  }
}
