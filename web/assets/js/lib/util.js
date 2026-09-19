// Small shared helpers.

// Collapse a burst of calls (e.g. several SSE events) into one call after `ms` of quiet.
export function debounce(fn, ms = 300) {
  let timer = null;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
  wrapped.cancel = () => clearTimeout(timer);
  return wrapped;
}

// Guard against out-of-order responses: only the most recent request may render.
//   const seq = sequencer(); const t = seq.next(); await ...; if (!seq.isLatest(t)) return;
export function sequencer() {
  let latest = 0;
  return { next: () => ++latest, isLatest: (token) => token === latest };
}

// Read a form into a plain object: numbers for type=number, booleans for checkboxes.
export function formValues(form) {
  const out = {};
  form.querySelectorAll('input[name], select[name]').forEach((el) => {
    if (el.type === 'checkbox') out[el.name] = el.checked;
    else if (el.type === 'number') out[el.name] = el.value === '' ? '' : Number(el.value);
    else out[el.name] = el.value.trim();
  });
  return out;
}

// Show server-side field errors next to the matching inputs; clears old ones first.
export function showFieldErrors(form, fields = {}) {
  form.querySelectorAll('.field .error').forEach((el) => el.remove());
  form.querySelectorAll('[aria-invalid]').forEach((el) => el.removeAttribute('aria-invalid'));
  Object.entries(fields || {}).forEach(([name, message]) => {
    const input = form.querySelector(`[name="${CSS.escape(name)}"]`);
    const field = input?.closest('.field');
    if (!field) return;
    input.setAttribute('aria-invalid', 'true');
    const err = document.createElement('div');
    err.className = 'error';
    err.id = `${name}-error`;
    err.textContent = message;
    input.setAttribute('aria-describedby', err.id);
    field.append(err);
  });
  form.querySelector('[aria-invalid="true"]')?.focus();
}
