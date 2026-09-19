// Auto-escaping tagged template. Every interpolated value is HTML-escaped unless it
// is itself the result of html`` or raw(). Webhook-supplied strings (symbols, reasons,
// raw payloads) therefore can never inject markup.

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

class SafeHtml {
  constructor(value) { this.value = value; }
  toString() { return this.value; }
}

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ESCAPES[ch]);
}

export function raw(value) {
  return new SafeHtml(String(value));
}

function render(part) {
  if (part instanceof SafeHtml) return part.value;
  if (Array.isArray(part)) return part.map(render).join('');
  if (part === false || part === null || part === undefined) return '';
  return esc(part);
}

export function html(strings, ...values) {
  let out = strings[0];
  values.forEach((value, i) => { out += render(value) + strings[i + 1]; });
  return new SafeHtml(out);
}

export function mount(el, content) {
  el.innerHTML = render(content);
  return el;
}

export function fragment(content) {
  const tpl = document.createElement('template');
  tpl.innerHTML = render(content);
  return tpl.content;
}
