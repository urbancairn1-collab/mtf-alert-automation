// Toasts, confirm modal (Promise-based, never window.confirm) and side drawer.
import { html, mount, fragment } from '../lib/html.js';
import { icon } from '../lib/icons.js';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea, [tabindex]:not([tabindex="-1"])';

// Keep Tab / Shift+Tab inside an open dialog (WCAG 2.1 dialog pattern).
function trapFocus(container) {
  container.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const items = [...container.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
}

function toastHost() {
  let host = document.querySelector('.toasts');
  if (!host) {
    host = document.createElement('div');
    host.className = 'toasts';
    host.setAttribute('role', 'status');
    host.setAttribute('aria-live', 'polite');
    document.body.append(host);
  }
  return host;
}

export function toast(message, tone = 'ok', ms = 3200) {
  const iconName = tone === 'err' ? 'circle-x' : tone === 'warn' ? 'alert-triangle' : 'circle-check';
  const el = document.createElement('div');
  el.className = 'toast';
  el.dataset.tone = tone;
  mount(el, html`${icon(iconName, 18)}<span>${message}</span>`);
  toastHost().append(el);
  setTimeout(() => el.remove(), ms);
}

// Resolves true on confirm, false on cancel/escape. `body` is SafeHtml.
export function confirmModal({ title, body, confirmLabel = 'Confirm', danger = false, iconName = 'info-circle', validate }) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'modal-wrap';
    mount(wrap, html`<div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
      <div class="modal-h"><div class="ic ${danger ? 'danger' : ''}">${icon(iconName, 20)}</div>
        <div><h2 id="modal-title">${title}</h2></div></div>
      <div class="modal-b">${body}</div>
      <div class="modal-f">
        <button type="button" class="btn" data-act="cancel">Cancel</button>
        <button type="button" class="btn ${danger ? 'danger' : 'primary'}" data-act="ok">${confirmLabel}</button>
      </div></div>`);
    const opener = document.activeElement;
    const okBtn = wrap.querySelector('[data-act="ok"]');
    const sync = () => { if (validate) okBtn.disabled = !validate(wrap); };
    const close = (value) => {
      document.removeEventListener('keydown', onKey);
      wrap.remove();
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
      resolve(value);
    };
    trapFocus(wrap.querySelector('.modal'));
    const onKey = (e) => { if (e.key === 'Escape') close(false); };
    wrap.addEventListener('click', (e) => {
      if (e.target === wrap || e.target.closest('[data-act="cancel"]')) close(false);
      if (e.target.closest('[data-act="ok"]') && !okBtn.disabled) close(true);
    });
    wrap.addEventListener('change', sync);
    document.addEventListener('keydown', onKey);
    document.body.append(wrap);
    sync();
    okBtn.focus();
  });
}

export function openDrawer({ title, body }) {
  const scrim = document.createElement('div');
  scrim.className = 'scrim';
  const drawer = document.createElement('aside');
  drawer.className = 'drawer';
  drawer.setAttribute('role', 'dialog');
  drawer.setAttribute('aria-modal', 'true');
  drawer.setAttribute('aria-label', title);
  mount(drawer, html`<div class="drawer-h"><h2>${title}</h2>
    <button type="button" class="btn ghost icon" style="margin-left:auto" data-act="close" aria-label="Close">${icon('x', 18)}</button></div>
    <div class="drawer-b"></div>`);
  drawer.querySelector('.drawer-b').append(fragment(body));
  const opener = document.activeElement;
  const close = () => {
    document.removeEventListener('keydown', onKey);
    scrim.remove();
    drawer.remove();
    if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
  };
  trapFocus(drawer);
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  scrim.addEventListener('click', close);
  drawer.querySelector('[data-act="close"]').addEventListener('click', close);
  document.addEventListener('keydown', onKey);
  document.body.append(scrim, drawer);
  drawer.querySelector('[data-act="close"]').focus();
  return close;
}

// Copy buttons anywhere in `root`: <button data-copy="text">
export function wireCopy(root) {
  root.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-copy]');
    if (!btn) return;
    try {
      await navigator.clipboard.writeText(btn.dataset.copy);
      toast('Copied to clipboard');
    } catch {
      toast('Copy blocked by the browser. Select the text and press Ctrl+C.', 'warn');
    }
  });
}
