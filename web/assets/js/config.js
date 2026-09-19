// 'demo' = in-browser mock backend with sample data (clearly badged in the UI).
// 'live' = real FastAPI backend on the same origin. The Python app serves its own
// config.js with mode 'live'; there is no automatic fallback between the two.
export const CONFIG = Object.freeze({
  mode: 'demo',
  version: '1.0.0',
});
