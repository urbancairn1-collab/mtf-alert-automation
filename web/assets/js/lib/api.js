// API client. Same contract for both backends (spec section 8):
//   demo -> mock/server.js (in-browser), live -> FastAPI on this origin.
import { CONFIG } from '../config.js';

const TIMEOUT_MS = 10000;

export class ApiError extends Error {
  constructor(code, message, fields = null) {
    super(message);
    this.code = code;
    this.fields = fields;
  }
}

function query(params = {}) {
  const q = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') q.set(k, v);
  });
  const s = q.toString();
  return s ? `?${s}` : '';
}

async function unwrap(res) {
  let body;
  try {
    body = await res.json();
  } catch {
    throw new ApiError('bad_response', `Server returned HTTP ${res.status} without JSON`);
  }
  if (!body.ok) {
    const err = body.error || {};
    throw new ApiError(err.code || 'error', err.message || 'Request failed', err.fields || null);
  }
  return body.data;
}

const httpBackend = {
  async request(method, path, body) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(path, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
      return await unwrap(res);
    } catch (err) {
      if (err instanceof ApiError) throw err;
      throw new ApiError('network', 'Cannot reach the MTF Trader service. Is it running?');
    } finally {
      clearTimeout(timer);
    }
  },
  subscribe(onEvent) {
    const source = new EventSource('/api/events');
    const types = ['status', 'alert', 'order', 'position', 'trade', 'tick', 'log'];
    types.forEach((type) => source.addEventListener(type, (e) => onEvent(type, JSON.parse(e.data))));
    return () => source.close();
  },
  download(path) {
    window.location.href = path;
  },
};

let backendPromise = null;
function backend() {
  if (!backendPromise) {
    backendPromise = CONFIG.mode === 'demo'
      ? import('../mock/server.js').then((m) => m.mockBackend)
      : Promise.resolve(httpBackend);
  }
  return backendPromise;
}

export const api = {
  get: async (path, params) => (await backend()).request('GET', path + query(params)),
  put: async (path, body) => (await backend()).request('PUT', path, body),
  post: async (path, body = {}) => (await backend()).request('POST', path, body),
  subscribe: async (onEvent) => (await backend()).subscribe(onEvent),
  download: async (path, params) => (await backend()).download(path + query(params)),
  isDemo: CONFIG.mode === 'demo',
};
