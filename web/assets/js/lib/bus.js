// Tiny in-page event bus. One SSE subscription fans out to whichever view is mounted.
const listeners = new Map();

export function on(type, fn) {
  if (!listeners.has(type)) listeners.set(type, new Set());
  listeners.get(type).add(fn);
  return () => listeners.get(type)?.delete(fn);
}

export function emit(type, payload) {
  listeners.get(type)?.forEach((fn) => {
    try {
      fn(payload);
    } catch (err) {
      console.error(`[bus] listener for "${type}" failed`, err);
    }
  });
}
