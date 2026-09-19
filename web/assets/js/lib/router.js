// Hash router. Each view exports { id, title, subtitle, icon, render(root) -> dispose? }.

export function createRouter({ views, fallback, onChange }) {
  let dispose = null;
  let token = 0;

  async function go() {
    const id = (location.hash.replace(/^#\/?/, '').split('?')[0]) || fallback;
    const view = views.find((v) => v.id === id) || views.find((v) => v.id === fallback);
    const myToken = ++token;
    if (typeof dispose === 'function') dispose();
    dispose = null;
    onChange(view);
    // Fresh element per render: listeners a view attaches to its root die with it,
    // so revisiting a screen never stacks duplicate handlers (e.g. double test alerts).
    const root = document.createElement('div');
    root.className = 'stack';
    root.style.gap = '20px';
    document.getElementById('view').replaceChildren(root);
    window.scrollTo(0, 0);
    const result = await view.render(root);
    if (myToken !== token) {
      if (typeof result === 'function') result();
      return;
    }
    dispose = result;
  }

  window.addEventListener('hashchange', go);
  return { start: go, refresh: go };
}
