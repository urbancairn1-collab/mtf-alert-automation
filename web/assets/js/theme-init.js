// Classic (non-module) script loaded in <head>: apply the saved theme before first
// paint so dark mode does not flash light. Kept external for a strict CSP.
try {
  document.documentElement.dataset.theme = localStorage.getItem('mtf-theme') || 'light';
} catch (e) {
  document.documentElement.dataset.theme = 'light';
}
