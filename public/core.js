// Shared state + helpers for the UI.

export const S = {
  world: null, roster: null, month: null, tab: 'dashboard',
  rosterView: { kind: 'company', id: null },
  setupTab: 'brands', activity: [],
};

export const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const STATUS = { W: 'Working', WO: 'Weekly day off', H: 'Public holiday', L: 'On leave', CO: 'Comp-off (day off in return for extra work)' };

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export async function api(method, url, body) {
  const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}

// ── dates ──────────────────────────────────────────────────────────────────────
export const dowOf = (d) => new Date(d + 'T00:00:00Z').getUTCDay();
export const fmtDate = (d) => { const [, m, day] = d.split('-').map(Number); return `${DOW[dowOf(d)]} ${day} ${MONTHS[m - 1]}`; };
export const monthDates = (month) => { const [y, m] = month.split('-').map(Number); const n = new Date(Date.UTC(y, m, 0)).getUTCDate(); return Array.from({ length: n }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`); };
export const shiftMonth = (month, n) => { const [y, m] = month.split('-').map(Number); const t = new Date(Date.UTC(y, m - 1 + n, 1)); return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}`; };
export const monthLabel = (month) => { const [y, m] = month.split('-').map(Number); return `${MONTHS[m - 1]} ${y}`; };

// ── lookups (rebuilt whenever the world object changes) ────────────────────────
let cache = { world: null };
export function ix() {
  const w = S.world;
  if (cache.world === w) return cache;
  const c = { world: w };
  c.emp = new Map(w.employees.map((e) => [e.id, e]));
  c.proc = new Map(w.processes.map((p) => [p.id, p]));
  c.brand = new Map(w.brands.map((b) => [b.id, b]));
  c.pod = new Map(w.pods.map((p) => [p.id, p]));
  c.holidays = new Map(w.holidays.map((h) => [h.date, h.name]));
  c.asgByEmp = new Map(); c.asgByProc = new Map();
  for (const a of w.assignments) {
    if (!c.asgByEmp.has(a.employee_id)) c.asgByEmp.set(a.employee_id, []);
    if (!c.asgByProc.has(a.process_id)) c.asgByProc.set(a.process_id, []);
    c.asgByEmp.get(a.employee_id).push(a); c.asgByProc.get(a.process_id).push(a);
  }
  c.procsByBrand = new Map();
  for (const p of w.processes) { if (!c.procsByBrand.has(p.brand_id)) c.procsByBrand.set(p.brand_id, []); c.procsByBrand.get(p.brand_id).push(p); }
  cache = c;
  return c;
}
export const procLabel = (p) => { const c = ix(); return `${c.brand.get(p.brand_id)?.name ?? '?'} › ${p.name}`; };
export const empName = (id) => ix().emp.get(id)?.name ?? `#${id}`;

export function calendarLabel(p) {
  const days = p.operating_days;
  const all = days.length === 7;
  if (all && p.open_on_holidays) return '365 days';
  if (all) return 'Daily, holidays off';
  if (days.length === 6 && !days.includes(0)) return p.open_on_holidays ? 'Mon-Sat' : 'Sun & holidays off';
  return days.map((d) => DOW[d]).join('/') + (p.open_on_holidays ? '' : ' (holidays off)');
}

/** brand structure used for risk badges */
export function brandInfo(brandId) {
  const c = ix();
  const procs = c.procsByBrand.get(brandId) || [];
  const prim = new Set(); let sevenDayNoBackup = [];
  for (const p of procs) {
    const as = c.asgByProc.get(p.id) || [];
    as.filter((a) => a.role === 'primary').forEach((a) => prim.add(a.employee_id));
    const primaries = as.filter((a) => a.role === 'primary').length;
    const backups = as.filter((a) => a.role === 'backup').length;
    if (p.active && p.operating_days.length === 7 && primaries <= 1 && backups === 0) sevenDayNoBackup.push(p);
  }
  return { people: prim.size, type: prim.size <= 1 ? 'One person' : `${prim.size} people`, risk: sevenDayNoBackup };
}

// ── roster-derived data ────────────────────────────────────────────────────────
let rcache = { roster: null };
export function rdata() {
  const r = S.roster;
  if (rcache.roster === r) return rcache;
  const c = { roster: r, cells: new Map(), gapCause: new Set(), gapsByProcDate: new Map() };
  for (const [e, d, s, manual, comp, note] of r?.cells || []) c.cells.set(`${e}|${d}`, { s, manual, comp, note });
  for (const cf of r?.conflicts || []) {
    if (cf.type === 'COVERAGE_GAP' || cf.type === 'UNDERSTAFFED') {
      for (const id of cf.employee_ids || []) c.gapCause.add(`${id}|${cf.date}`);
      c.gapsByProcDate.set(`${cf.process_id}|${cf.date}`, cf);
    }
  }
  rcache = c;
  return c;
}

// ── UI plumbing ────────────────────────────────────────────────────────────────
let renderHook = () => {};
export const setRender = (fn) => { renderHook = fn; };
export const render = () => renderHook();

export function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`; el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), kind === 'err' ? 7000 : 4500);
}

export function openModal({ title, body, footer = '', wide = false }) {
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal ${wide ? 'wide' : ''}" role="dialog"><header><h3>${esc(title)}</h3><button class="icon" data-close>&times;</button></header><div class="body">${body}</div>${footer ? `<footer>${footer}</footer>` : ''}</div>`;
  const close = () => bg.remove();
  bg.addEventListener('mousedown', (e) => { if (e.target === bg) close(); });
  bg.querySelector('[data-close]').onclick = close;
  document.addEventListener('keydown', function esc_(e) { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc_); } });
  $('#modalRoot').appendChild(bg);
  return { el: bg, close, $: (s) => bg.querySelector(s), $$: (s) => [...bg.querySelectorAll(s)] };
}

export async function loadWorld() { S.world = await api('GET', '/api/world'); }
export async function loadRoster() { S.roster = await api('GET', `/api/roster?month=${S.month}`); }
export async function loadActivity() { S.activity = await api('GET', `/api/activity?month=${S.month}`); }
export async function reloadAll() { await Promise.all([loadWorld(), loadRoster(), loadActivity()]); render(); }
export function setRoster(p) { S.roster = p; render(); loadActivity().then(render); }

/** run an async action with button feedback + error toast */
export async function run(btn, fn) {
  if (btn) btn.disabled = true;
  try { return await fn(); } catch (e) { toast(e.message, 'err'); } finally { if (btn) btn.disabled = false; }
}

export function summarizeDiff(diff) {
  if (!diff) return '';
  const a = diff.introduced.length; const b = diff.resolved.length;
  return `${b} conflict(s) resolved, ${a} new`;
}
