// Number, money and IST time formatting. All times are shown in Asia/Kolkata.

const TZ = 'Asia/Kolkata';
const inr2 = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const inr0 = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const timeFmt = new Intl.DateTimeFormat('en-IN', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: true });
const timeSecFmt = new Intl.DateTimeFormat('en-IN', { timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
const dateFmt = new Intl.DateTimeFormat('en-IN', { timeZone: TZ, day: '2-digit', month: 'short', year: 'numeric' });
const dayKeyFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });

export const money = (n) => `₹${inr2.format(Number(n) || 0)}`;
export const money0 = (n) => `₹${inr0.format(Number(n) || 0)}`;
export const price = (n) => inr2.format(Number(n) || 0);
export const qty = (n) => inr0.format(Number(n) || 0);

export function signedMoney(n) {
  const v = Number(n) || 0;
  const sign = v > 0 ? '+' : v < 0 ? '-' : '';
  return `${sign}₹${inr2.format(Math.abs(v))}`;
}

export function pct(n, digits = 2) {
  const v = Number(n) || 0;
  const sign = v > 0 ? '+' : v < 0 ? '-' : '';
  return `${sign}${Math.abs(v).toFixed(digits)}%`;
}

export const tone = (n) => (Number(n) > 0 ? 'up' : Number(n) < 0 ? 'down' : '');

export const time = (iso) => (iso ? timeFmt.format(new Date(iso)) : '-');
export const timeSec = (iso) => (iso ? timeSecFmt.format(new Date(iso)) : '-');
export const date = (iso) => (iso ? dateFmt.format(new Date(iso)) : '-');
export const dateTime = (iso) => (iso ? `${date(iso)}, ${time(iso)}` : '-');
export const dayKey = (d = new Date()) => dayKeyFmt.format(d);

export function ago(iso, now = Date.now()) {
  if (!iso) return 'never';
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function istParts(d = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    // h23 (not hour12:false): some ICU builds return "24" at midnight with hour12:false.
    timeZone: TZ, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(d);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return { weekday: get('weekday'), minutes: Number(get('hour')) * 60 + Number(get('minute')) };
}
