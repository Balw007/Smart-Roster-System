// Date helpers. All dates are 'YYYY-MM-DD' strings and all arithmetic is done in UTC,
// so results never depend on the server's timezone.

export const pad = (n) => String(n).padStart(2, '0');
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const toTime = (d) => Date.parse(d + 'T00:00:00Z');
export const dow = (d) => new Date(toTime(d)).getUTCDay(); // 0 = Sunday
export const dowName = (n) => DOW[n];

export function addDays(d, n) {
  const t = new Date(toTime(d));
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

export const diffDays = (a, b) => Math.round((toTime(b) - toTime(a)) / 86400000);

export function monthDates(month) {
  const [y, m] = month.split('-').map(Number);
  const n = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Array.from({ length: n }, (_, i) => `${y}-${pad(m)}-${pad(i + 1)}`);
}

export function eachDate(a, b) {
  const out = [];
  for (let d = a; d <= b; d = addDays(d, 1)) out.push(d);
  return out;
}

/** Monday of the ISO week containing d */
export function weekStart(d) {
  return addDays(d, -((dow(d) + 6) % 7));
}

export function monthOf(d) {
  return d.slice(0, 7);
}

export function shiftMonth(month, delta) {
  const [y, m] = month.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}`;
}

/** 'Wed 9 Dec' */
export function fmt(d) {
  const [, m, day] = d.split('-').map(Number);
  return `${DOW[dow(d)]} ${day} ${MON[m - 1]}`;
}

/** Group a month's dates into Monday-based weeks (partial weeks at the edges). */
export function monthWeeks(month) {
  const weeks = new Map();
  for (const d of monthDates(month)) {
    const w = weekStart(d);
    if (!weeks.has(w)) weeks.set(w, []);
    weeks.get(w).push(d);
  }
  return [...weeks.values()];
}

/** Whole Monday-Sunday weeks that overlap the month (plans never stop at a month boundary). */
export function horizonDates(month) {
  const ds = monthDates(month);
  return eachDate(weekStart(ds[0]), addDays(weekStart(ds[ds.length - 1]), 6));
}

export function horizonWeeks(month) {
  const h = horizonDates(month);
  const out = [];
  for (let i = 0; i < h.length; i += 7) out.push(h.slice(i, i + 7));
  return out;
}
