// Copy an alert-message template with the real webhook secret. The page only ever
// shows the masked secret; the real one is fetched at click time and goes straight
// to the clipboard.
import { api } from '../lib/api.js';
import { toast } from './overlay.js';

export function wireTemplateCopy(root) {
  root.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-copy-template]');
    if (!btn) return;
    let secret;
    try {
      ({ secret } = await api.post('/api/webhook/reveal'));
    } catch (err) {
      toast(err.message, 'err');
      return;
    }
    try {
      await navigator.clipboard.writeText(btn.dataset.copyTemplate.replace(btn.dataset.masked, secret));
      toast('Alert message copied, with your secret. Paste it into TradingView.');
    } catch {
      toast('Copy blocked by the browser. Use Reveal, then copy by hand.', 'warn');
    }
  });
}
