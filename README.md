# MTF Trader

TradingView indicator alert -> webhook -> Python engine -> Angel One **MTF** (Margin Trading Facility) order,
with a local dashboard for positions, alerts, orders, trade history, risk controls and settings.

Scope is fixed by quotation `UC/QTN/26-27/09/050`. Design: `docs/superpowers/specs/2026-09-19-mtf-alert-automation-design.md`.

## Status

| Part | State |
|---|---|
| Frontend (`web/`) | Built. Runs in **demo mode** with sample data (in-browser mock backend, clearly badged). |
| Backend (Python) | Planned: `docs/superpowers/plans/2026-09-19-mtf-alert-automation.md` |

## Preview the frontend (demo data)

ES modules need a web server (opening `index.html` as a file will not work):

```
python -m http.server 8000 --bind 127.0.0.1 --directory web
```

Then open http://127.0.0.1:8000. Try **Settings > Send test alert** to run the full paper flow.

`web/assets/js/config.js` has `mode: 'demo'`. The Python app will serve its own `config.js` with `mode: 'live'`;
there is no automatic fallback between the two.

## Third-party assets (vendored, no CDN at runtime)

- Tabler Icons 3.47.0 (MIT) -> `web/assets/js/lib/icons.js`
- Geist and Geist Mono variable fonts (SIL OFL 1.1) -> `web/assets/fonts/`
