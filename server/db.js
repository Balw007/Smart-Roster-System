// SQLite persistence (node:sqlite - built into Node >= 22.13, nothing to install or host separately).

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_SETTINGS, cellKey } from './engine/rules.js';
import { horizonDates, monthDates } from './engine/dates.js';

export const TABLES = {
  pods: { cols: ['name', 'lead_id'], json: [], bool: [] },
  employees: { cols: ['code', 'name', 'email', 'pod_id', 'role', 'shift', 'preferred_off_days', 'unavailable_dows', 'weekly_offs_per_week', 'max_daily_load', 'active'], json: ['preferred_off_days', 'unavailable_dows'], bool: ['active'] },
  brands: { cols: ['name', 'pod_id', 'notes', 'active'], json: [], bool: ['active'] },
  processes: { cols: ['brand_id', 'name', 'operating_days', 'open_on_holidays', 'min_staff', 'min_staff_by_dow', 'min_staff_by_date', 'shift', 'load', 'active'], json: ['operating_days', 'min_staff_by_dow', 'min_staff_by_date'], bool: ['open_on_holidays', 'active'] },
  assignments: { cols: ['employee_id', 'process_id', 'role'], json: [], bool: [] },
  holidays: { cols: ['date', 'name'], json: [], bool: [] },
  leaves: { cols: ['employee_id', 'start_date', 'end_date', 'type', 'status', 'note'], json: [], bool: [] },
  covers: { cols: ['process_id', 'employee_id', 'date', 'note'], json: [], bool: [] },
};

const SCHEMA = `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS pods (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, lead_id INTEGER);
CREATE TABLE IF NOT EXISTS employees (
  id INTEGER PRIMARY KEY, code TEXT, name TEXT NOT NULL, email TEXT,
  pod_id INTEGER REFERENCES pods(id) ON DELETE SET NULL,
  role TEXT NOT NULL DEFAULT 'agent', shift TEXT NOT NULL DEFAULT 'DAY',
  preferred_off_days TEXT NOT NULL DEFAULT '[]', unavailable_dows TEXT NOT NULL DEFAULT '[]',
  weekly_offs_per_week INTEGER, max_daily_load INTEGER, active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS brands (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, pod_id INTEGER REFERENCES pods(id) ON DELETE SET NULL, notes TEXT, active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS processes (
  id INTEGER PRIMARY KEY, brand_id INTEGER NOT NULL REFERENCES brands(id) ON DELETE CASCADE, name TEXT NOT NULL,
  operating_days TEXT NOT NULL DEFAULT '[0,1,2,3,4,5,6]', open_on_holidays INTEGER NOT NULL DEFAULT 1,
  min_staff INTEGER NOT NULL DEFAULT 1, min_staff_by_dow TEXT NOT NULL DEFAULT '{}', min_staff_by_date TEXT NOT NULL DEFAULT '{}',
  shift TEXT NOT NULL DEFAULT 'DAY', load INTEGER NOT NULL DEFAULT 1, active INTEGER NOT NULL DEFAULT 1,
  UNIQUE(brand_id, name));
CREATE TABLE IF NOT EXISTS assignments (
  id INTEGER PRIMARY KEY, employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  process_id INTEGER NOT NULL REFERENCES processes(id) ON DELETE CASCADE, role TEXT NOT NULL DEFAULT 'primary',
  UNIQUE(employee_id, process_id));
CREATE TABLE IF NOT EXISTS holidays (id INTEGER PRIMARY KEY, date TEXT NOT NULL UNIQUE, name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS leaves (
  id INTEGER PRIMARY KEY, employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  start_date TEXT NOT NULL, end_date TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'PL', status TEXT NOT NULL DEFAULT 'approved', note TEXT);
CREATE TABLE IF NOT EXISTS covers (
  id INTEGER PRIMARY KEY, process_id INTEGER NOT NULL REFERENCES processes(id) ON DELETE CASCADE,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE, date TEXT NOT NULL, note TEXT,
  UNIQUE(process_id, employee_id, date));
CREATE TABLE IF NOT EXISTS roster_cells (
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE, date TEXT NOT NULL,
  status TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'auto', note TEXT, compoff_due INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (employee_id, date));
CREATE TABLE IF NOT EXISTS roster_meta (month TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'draft', generated_at TEXT, published_at TEXT, version INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS pod_approvals (month TEXT NOT NULL, pod_id INTEGER NOT NULL, approved_by TEXT, note TEXT, version INTEGER NOT NULL, ts TEXT NOT NULL, PRIMARY KEY (month, pod_id));
CREATE TABLE IF NOT EXISTS activity (id INTEGER PRIMARY KEY, ts TEXT NOT NULL, month TEXT, kind TEXT NOT NULL, message TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

export function openDb(file = process.env.DB_PATH || './data/roster.db') {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  return db;
}

const toDb = (table, row) => {
  const t = TABLES[table];
  const out = {};
  for (const c of t.cols) {
    let v = row[c];
    if (v === undefined) continue;
    if (t.json.includes(c)) v = JSON.stringify(v ?? (c.startsWith('min_staff_by') ? {} : []));
    else if (t.bool.includes(c)) v = v ? 1 : 0;
    else if (v === '') v = null;
    out[c] = v;
  }
  return out;
};

const fromDb = (table, row) => {
  if (!row) return row;
  const t = TABLES[table];
  const out = { ...row };
  for (const c of t.json) out[c] = JSON.parse(out[c]);
  for (const c of t.bool) out[c] = !!out[c];
  return out;
};

export function list(db, table) {
  return db.prepare(`SELECT * FROM ${table} ORDER BY id`).all().map((r) => fromDb(table, r));
}
export function get(db, table, id) {
  return fromDb(table, db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id));
}
export function insert(db, table, row) {
  const data = toDb(table, row);
  const cols = Object.keys(data);
  const r = db.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map((c) => data[c]));
  return get(db, table, Number(r.lastInsertRowid));
}
export function update(db, table, id, row) {
  const data = toDb(table, row);
  const cols = Object.keys(data);
  if (!cols.length) return get(db, table, id);
  db.prepare(`UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(',')} WHERE id = ?`).run(...cols.map((c) => data[c]), id);
  return get(db, table, id);
}
export function remove(db, table, id) {
  return db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id).changes;
}

export function getSettings(db) {
  const out = { ...DEFAULT_SETTINGS };
  for (const r of db.prepare('SELECT * FROM settings').all()) out[r.key] = JSON.parse(r.value);
  return out;
}
export function setSetting(db, key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));
}

export function loadWorld(db) {
  return {
    pods: list(db, 'pods'), employees: list(db, 'employees'), brands: list(db, 'brands'), processes: list(db, 'processes'),
    assignments: list(db, 'assignments'), holidays: list(db, 'holidays'), leaves: list(db, 'leaves'), covers: list(db, 'covers'),
    settings: getSettings(db),
  };
}

/** Cells for the month plus the rest of its boundary weeks (Mon-Sun), so weeks are never cut in half. */
export function loadCells(db, month) {
  const h = horizonDates(month);
  const m = new Map();
  for (const r of db.prepare('SELECT * FROM roster_cells WHERE date >= ? AND date <= ?').all(h[0], h[h.length - 1])) m.set(cellKey(r.employee_id, r.date), r);
  return m;
}

/**
 * Replace the month's cells. Cells outside the month (source 'spill') are decisions made on behalf of the
 * neighbouring month for the shared boundary week; they never overwrite a real cell of that month.
 */
export function saveCells(db, month, cells) {
  const h = horizonDates(month);
  const inMonth = new Set(monthDates(month));
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM roster_cells WHERE date LIKE ?').run(`${month}-%`);
    db.prepare("DELETE FROM roster_cells WHERE source = 'spill' AND date >= ? AND date <= ?").run(h[0], h[h.length - 1]);
    const ins = db.prepare('INSERT OR IGNORE INTO roster_cells (employee_id, date, status, source, note, compoff_due) VALUES (?,?,?,?,?,?)');
    for (const c of cells.values()) {
      if (!inMonth.has(c.date) && c.source !== 'spill') continue;
      ins.run(c.employee_id, c.date, c.status, c.source || 'auto', c.note || '', c.compoff_due ? 1 : 0);
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

export function getMeta(db, month) {
  return db.prepare('SELECT * FROM roster_meta WHERE month = ?').get(month) || { month, status: 'none', generated_at: null, published_at: null, version: 0 };
}
export function touchMeta(db, month, patch = {}) {
  const cur = getMeta(db, month);
  const next = { ...cur, ...patch, status: patch.status || (cur.status === 'none' ? 'draft' : cur.status), version: cur.version + 1 };
  db.prepare('INSERT INTO roster_meta (month, status, generated_at, published_at, version) VALUES (?,?,?,?,?) ON CONFLICT(month) DO UPDATE SET status=excluded.status, generated_at=excluded.generated_at, published_at=excluded.published_at, version=excluded.version')
    .run(month, next.status, next.generated_at, next.published_at, next.version);
  return next;
}

export function logActivity(db, month, kind, message) {
  db.prepare('INSERT INTO activity (ts, month, kind, message) VALUES (?,?,?,?)').run(new Date().toISOString(), month, kind, message);
}
export function listActivity(db, month, limit = 60) {
  return db.prepare('SELECT * FROM activity WHERE month = ? OR month IS NULL ORDER BY id DESC LIMIT ?').all(month, limit);
}

/** Persist the ops produced by the suggestion engine / what-if once a human approves them. */
export function persistOps(db, ops, month) {
  for (const op of ops) {
    switch (op.type) {
      case 'SET_CELL':
        db.prepare(`INSERT INTO roster_cells (employee_id, date, status, source, note, compoff_due) VALUES (?,?,?, 'manual', ?, ?)
          ON CONFLICT(employee_id, date) DO UPDATE SET status=excluded.status, source='manual', note=excluded.note, compoff_due=excluded.compoff_due`)
          .run(op.employee_id, op.date, op.status, op.note || '', op.compoff_due ? 1 : 0);
        break;
      case 'ADD_COVER':
        db.prepare('INSERT OR IGNORE INTO covers (process_id, employee_id, date, note) VALUES (?,?,?,?)').run(op.process_id, op.employee_id, op.date, op.note || 'Added via suggestion');
        break;
      case 'ADD_BACKUP':
        db.prepare("INSERT OR IGNORE INTO assignments (employee_id, process_id, role) VALUES (?,?, 'backup')").run(op.employee_id, op.process_id);
        break;
      case 'SET_REQUIREMENT': {
        const p = get(db, 'processes', op.process_id);
        update(db, 'processes', p.id, { min_staff_by_date: { ...p.min_staff_by_date, [op.date]: op.min_staff } });
        break;
      }
      case 'PATCH_PROCESS':
        update(db, 'processes', op.process_id, op.patch);
        break;
      case 'ADD_LEAVE':
        insert(db, 'leaves', { status: 'approved', ...op.leave });
        break;
      default: throw new Error(`Unknown op ${op.type}`);
    }
  }
}

/** Pod sign-offs are bound to the roster version they approved: any later change invalidates them. */
export function listApprovals(db, month) {
  const v = getMeta(db, month).version;
  return db.prepare('SELECT * FROM pod_approvals WHERE month = ?').all(month).map((a) => ({ ...a, valid: a.version === v }));
}
export function setApproval(db, month, pod_id, approved_by, note) {
  db.prepare('INSERT INTO pod_approvals (month, pod_id, approved_by, note, version, ts) VALUES (?,?,?,?,?,?) ON CONFLICT(month, pod_id) DO UPDATE SET approved_by=excluded.approved_by, note=excluded.note, version=excluded.version, ts=excluded.ts')
    .run(month, pod_id, approved_by, note || '', getMeta(db, month).version, new Date().toISOString());
}
export function clearApprovals(db, month) { db.prepare('DELETE FROM pod_approvals WHERE month = ?').run(month); }
