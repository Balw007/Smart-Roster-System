import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TABLES, list, get, insert, update, remove, loadWorld, loadCells, saveCells, getMeta, touchMeta,
  logActivity, listActivity, persistOps, setSetting, listApprovals, setApproval,
} from './db.js';
import { generateRoster, diffCells, STRATEGIES } from './engine/generate.js';
import { validateRoster, diffConflicts } from './engine/validate.js';
import { suggestFixes } from './engine/suggest.js';
import { applyOps } from './engine/ops.js';
import { monthDates, fmt, eachDate, monthOf, dowName } from './engine/dates.js';
import { cellKey } from './engine/rules.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (msg) => new HttpError(400, msg);

// ── input validation for master data (kept deliberately small & explicit) ────────
const ENUMS = {
  employees: { role: ['agent', 'pod_lead', 'manager'], shift: ['DAY', 'EVENING', 'NIGHT', 'FLEX'] },
  processes: { shift: ['DAY', 'EVENING', 'NIGHT', 'FLEX'] },
  assignments: { role: ['primary', 'backup'] },
  leaves: { type: ['PL', 'SL', 'CL', 'LWP', 'COMPOFF'], status: ['pending', 'approved', 'rejected'] },
};
const REQUIRED = {
  pods: ['name'], employees: ['name'], brands: ['name'], processes: ['brand_id', 'name'], assignments: ['employee_id', 'process_id'],
  holidays: ['date', 'name'], leaves: ['employee_id', 'start_date', 'end_date'], covers: ['process_id', 'employee_id', 'date'],
};
function validateRow(table, row, partial) {
  if (!partial) for (const f of REQUIRED[table]) if (row[f] === undefined || row[f] === null || row[f] === '') throw bad(`${f} is required`);
  for (const [f, allowed] of Object.entries(ENUMS[table] || {})) if (row[f] !== undefined && !allowed.includes(row[f])) throw bad(`${f} must be one of ${allowed.join(', ')}`);
  for (const f of ['date', 'start_date', 'end_date']) if (row[f] !== undefined && !DATE_RE.test(row[f])) throw bad(`${f} must be YYYY-MM-DD`);
  if (row.start_date && row.end_date && row.start_date > row.end_date) throw bad('start_date must be on or before end_date');
  if (table === 'processes') {
    if (row.operating_days !== undefined && (!Array.isArray(row.operating_days) || row.operating_days.some((n) => !Number.isInteger(n) || n < 0 || n > 6))) throw bad('operating_days must be a list of 0-6 (0 = Sunday)');
    if (row.min_staff !== undefined && (!Number.isInteger(row.min_staff) || row.min_staff < 0)) throw bad('min_staff must be a whole number >= 0');
    for (const f of ['min_staff_by_dow', 'min_staff_by_date']) if (row[f] !== undefined && (typeof row[f] !== 'object' || Array.isArray(row[f]))) throw bad(`${f} must be an object`);
  }
  if (table === 'employees') for (const f of ['preferred_off_days', 'unavailable_dows']) if (row[f] !== undefined && (!Array.isArray(row[f]) || row[f].some((n) => !Number.isInteger(n) || n < 0 || n > 6))) throw bad(`${f} must be a list of 0-6`);
}

export function createApp(db) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  const h = (fn) => (req, res, next) => { try { Promise.resolve(fn(req, res)).catch(next); } catch (e) { next(e); } };
  const monthParam = (v) => { if (!MONTH_RE.test(v || '')) throw bad('month must be YYYY-MM'); return v; };

  // ── roster payload ──────────────────────────────────────────────────────────
  function payload(month, extra = {}) {
    const world = loadWorld(db);
    const cells = loadCells(db, month);
    const v = validateRoster(world, month, cells);
    const dates = new Set(monthDates(month));
    return {
      month, meta: getMeta(db, month), generated: v.generated, approvals: approvalState(month),
      cells: v.generated ? [...cells.values()].filter((c) => dates.has(c.date)).map((c) => [c.employee_id, c.date, c.status, c.source === 'manual' ? 1 : 0, c.compoff_due ? 1 : 0, c.note || '']) : [],
      coverage: v.coverage, conflicts: v.conflicts, stats: v.stats, employeeStats: v.employeeStats, ...extra,
    };
  }
  /** Which pods must sign off, and whether each sign-off still matches the current roster version. */
  function approvalState(month) {
    const world = loadWorld(db);
    const done = new Map(listApprovals(db, month).map((a) => [a.pod_id, a]));
    return world.pods.filter((p) => world.employees.some((e) => e.pod_id === p.id && e.active)).map((p) => {
      const a = done.get(p.id);
      return { pod_id: p.id, pod: p.name, lead: world.employees.find((e) => e.id === p.lead_id)?.name || null, approved: !!a?.valid, stale: !!a && !a.valid, by: a?.approved_by || null, note: a?.note || '', ts: a?.ts || null };
    });
  }
  const snapshot = (month) => { const world = loadWorld(db); const cells = loadCells(db, month); return { world, cells, v: validateRoster(world, month, cells) }; };
  const flagIfPublished = (month, what) => {
    if (getMeta(db, month).status === 'published') logActivity(db, month, 'PUBLISHED_ROSTER_CHANGED', `Published roster ${month} changed: ${what}. Notify affected employees and pod leads.`);
  };

  /** (Re)generate and persist a month. mode: full | keep-manual | repair */
  function runGeneration(month, mode, strategy = 'balanced') {
    const world = loadWorld(db);
    const existing = loadCells(db, month);
    const before = validateRoster(world, month, existing);
    const { cells, moves } = generateRoster(world, month, { existing, keepManual: mode !== 'full', previous: mode === 'repair' ? existing : null, strategy });
    saveCells(db, month, cells);
    const meta = getMeta(db, month);
    touchMeta(db, month, { generated_at: new Date().toISOString(), status: mode === 'repair' ? meta.status : 'draft' });
    const after = validateRoster(world, month, loadCells(db, month));
    const changed = before.generated ? diffCells(existing, cells).filter((c) => c.date.startsWith(month)) : [];
    return { before, after, moves, changed, diff: before.generated ? diffConflicts(before.conflicts, after.conflicts) : null };
  }

  // ── world / settings ────────────────────────────────────────────────────────
  app.get('/api/health', (req, res) => res.json({ ok: true }));
  app.get('/api/world', h((req, res) => {
    res.json({ ...loadWorld(db), rosters: db.prepare('SELECT * FROM roster_meta ORDER BY month').all() });
  }));
  app.put('/api/settings', h((req, res) => {
    for (const k of ['weekly_offs_per_week', 'max_consecutive_work', 'default_max_daily_load', 'leave_waiver_days']) {
      if (req.body[k] !== undefined) { if (!Number.isInteger(req.body[k]) || req.body[k] < 0) throw bad(`${k} must be a whole number`); setSetting(db, k, req.body[k]); }
    }
    res.json(loadWorld(db).settings);
  }));

  // ── roster ──────────────────────────────────────────────────────────────────
  app.get('/api/roster', h((req, res) => res.json(payload(monthParam(req.query.month)))));

  app.post('/api/roster/generate', h((req, res) => {
    const month = monthParam(req.body.month);
    const mode = ['full', 'keep-manual', 'repair'].includes(req.body.mode) ? req.body.mode : 'full';
    const strategy = STRATEGIES[req.body.strategy] ? req.body.strategy : 'balanced';
    const r = runGeneration(month, mode, strategy);
    logActivity(db, month, 'GENERATED', `Roster ${month} ${mode === 'repair' ? 'repaired (minimal changes)' : mode === 'keep-manual' ? 'regenerated, manual edits kept' : 'generated'} (${STRATEGIES[strategy].label} plan) - ${r.after.stats.errors} open conflict(s), ${r.after.stats.coverage_pct}% coverage.`);
    if (mode !== 'full') flagIfPublished(month, `regeneration (${r.changed.length} cells)`);
    res.json(payload(month, { changed: r.changed, diff: r.diff, moves: r.moves }));
  }));

  app.post('/api/roster/cell', h((req, res) => {
    const month = monthParam(req.body.month);
    const { employee_id, date, status } = req.body;
    if (!['W', 'WO', 'H', 'L', 'CO'].includes(status)) throw bad('status must be W, WO, H, L or CO');
    if (!DATE_RE.test(date || '') || monthOf(date) !== month) throw bad('date must be inside the month');
    if (!list(db, 'employees').some((e) => e.id === employee_id)) throw bad('unknown employee');
    const { world, cells, v: before } = snapshot(month);
    if (!before.generated) throw bad('Generate the roster first');
    const op = { type: 'SET_CELL', employee_id, date, status, note: req.body.note || '', compoff_due: req.body.compoff_due ? 1 : 0 };
    persistOps(db, [op], month);
    const after = validateRoster(world, month, loadCells(db, month));
    const diff = diffConflicts(before.conflicts, after.conflicts);
    const e = world.employees.find((x) => x.id === employee_id);
    logActivity(db, month, 'MANUAL_EDIT', `${e.name}: ${fmt(date)} set to ${status} manually (${diff.introduced.length} new / ${diff.resolved.length} resolved conflicts).`);
    touchMeta(db, month);
    flagIfPublished(month, `${e.name} on ${fmt(date)}`);
    res.json(payload(month, { diff }));
  }));

  app.post('/api/roster/suggest', h((req, res) => {
    const month = monthParam(req.body.month);
    const { world, cells } = snapshot(month);
    res.json(suggestFixes(world, month, cells, { process_id: req.body.process_id, date: req.body.date }));
  }));

  app.post('/api/roster/apply', h((req, res) => {
    const month = monthParam(req.body.month);
    const ops = req.body.ops;
    if (!Array.isArray(ops) || !ops.length) throw bad('ops required');
    const { before } = { before: snapshot(month).v };
    persistOps(db, ops, month);
    const after = validateRoster(loadWorld(db), month, loadCells(db, month));
    const diff = diffConflicts(before.conflicts, after.conflicts);
    logActivity(db, month, 'FIX_APPLIED', `${req.body.label || 'Fix applied'} (${diff.resolved.length} resolved, ${diff.introduced.length} new conflicts).`);
    touchMeta(db, month);
    flagIfPublished(month, req.body.label || 'fix applied');
    res.json(payload(month, { diff }));
  }));

  // What-if: preview a change WITHOUT saving it. Shows (1) the raw impact, (2) what an automatic minimal repair achieves,
  // (3) simulated resolution options for whatever is still open.
  function resolveChange(change) {
    if (change.kind === 'leave') {
      let l = change;
      if (change.leave_id) { l = get(db, 'leaves', change.leave_id); if (!l) throw bad('leave not found'); }
      if (!l.employee_id || !DATE_RE.test(l.start_date || '') || !DATE_RE.test(l.end_date || '')) throw bad('employee_id, start_date and end_date required');
      const leave = { employee_id: l.employee_id, start_date: l.start_date, end_date: l.end_date, type: l.type || 'PL', status: 'approved', note: l.note || '' };
      return { op: { type: 'ADD_LEAVE', leave }, label: `${leave.type} leave ${fmt(leave.start_date)} - ${fmt(leave.end_date)}`, months: [...new Set(eachDate(leave.start_date, leave.end_date).map(monthOf))] };
    }
    if (change.kind === 'process') {
      const p = get(db, 'processes', change.process_id);
      if (!p) throw bad('process not found');
      validateRow('processes', change.patch || {}, true);
      return { op: { type: 'PATCH_PROCESS', process_id: p.id, patch: change.patch }, label: `requirement change on process #${p.id}`, months: change.months };
    }
    throw bad('kind must be "leave" or "process"');
  }

  function simulate(world, cells, month, op) {
    const base = validateRoster(world, month, cells);
    const imm = applyOps(world, cells, [op], month);
    const immV = validateRoster(imm.world, month, imm.cells);
    const { cells: repaired, moves } = generateRoster(imm.world, month, { existing: imm.cells, previous: cells, keepManual: true });
    for (const [k, c] of imm.cells) if (!repaired.has(k) && !c.date.startsWith(month)) repaired.set(k, c); // neighbour-month cells stay as they are
    const repV = validateRoster(imm.world, month, repaired);
    return { base, imm, immV, repaired, repV, moves };
  }

  app.post('/api/roster/whatif', h((req, res) => {
    const month = monthParam(req.body.month);
    const { op, label } = resolveChange(req.body.change || {});
    const { world, cells } = snapshot(month);
    if (!validateRoster(world, month, cells).generated) throw bad('Generate the roster first');
    const s = simulate(world, cells, month, op);
    const immediate = diffConflicts(s.base.conflicts, s.immV.conflicts);
    const afterRepair = diffConflicts(s.base.conflicts, s.repV.conflicts);
    const ixw = new Map(world.employees.map((e) => [e.id, e.name]));
    const changed = diffCells(cells, s.repaired).filter((c) => c.date.startsWith(month)).map((c) => ({ ...c, employee: ixw.get(c.employee_id) }));
    // suggestions for the gaps that remain after the automatic repair
    const seen = new Set(); const suggestions = [];
    for (const c of afterRepair.introduced.filter((x) => ['COVERAGE_GAP', 'UNDERSTAFFED'].includes(x.type))) {
      const key = `${c.process_id}|${c.date}`;
      if (seen.has(key) || suggestions.length >= 6) continue;
      seen.add(key);
      const sug = suggestFixes(s.imm.world, month, s.repaired, { process_id: c.process_id, date: c.date }, { limit: 4 });
      suggestions.push({ conflict: c, options: sug.options });
    }
    res.json({
      label, month,
      base: s.base.stats, immediate: { stats: s.immV.stats, introduced: immediate.introduced },
      afterRepair: { stats: s.repV.stats, introduced: afterRepair.introduced, resolved: afterRepair.resolved, changed },
      suggestions,
    });
  }));

  // Commit a change (approve leave / change requirement) and repair every affected, already-generated month
  app.post('/api/roster/commit', h((req, res) => {
    const month = monthParam(req.body.month);
    const change = req.body.change || {};
    const { op, label, months } = resolveChange(change);
    if (op.type === 'ADD_LEAVE') {
      if (change.leave_id) update(db, 'leaves', change.leave_id, { status: 'approved' });
      else persistOps(db, [op], month);
    } else persistOps(db, [op], month);
    const targets = new Set([month, ...(months || []).filter((m) => getMeta(db, m).status !== 'none')]);
    const results = [];
    for (const m of targets) {
      if (!validateRoster(loadWorld(db), m, loadCells(db, m)).generated) continue;
      const r = runGeneration(m, 'repair');
      logActivity(db, m, 'CHANGE_APPLIED', `${label} applied; roster auto-repaired (${r.changed.length} cells changed, ${r.after.stats.errors} conflict(s) open).`);
      flagIfPublished(m, label);
      results.push({ month: m, changed: r.changed.length, errors: r.after.stats.errors });
    }
    res.json(payload(month, { repairs: results }));
  }));

  app.post('/api/roster/publish', h((req, res) => {
    const month = monthParam(req.body.month);
    const { v } = snapshot(month);
    if (!v.generated) throw bad('Generate the roster first');
    if (v.stats.errors > 0 && !req.body.force) throw new HttpError(409, `${v.stats.errors} mandatory conflict(s) are still open. Resolve them or publish with an explicit override.`);
    const waiting = approvalState(month).filter((a) => !a.approved);
    if (waiting.length && !req.body.force) throw new HttpError(409, `Waiting for pod lead approval: ${waiting.map((a) => a.pod).join(', ')}. Pod leads sign off first, or publish with an explicit override.`);
    touchMeta(db, month, { status: 'published', published_at: new Date().toISOString() });
    logActivity(db, month, 'PUBLISHED', v.stats.errors ? `Roster ${month} published with ${v.stats.errors} acknowledged open conflict(s).` : `Roster ${month} published - no open conflicts.`);
    res.json(payload(month));
  }));
  /** Pod lead sign-off. Bound to the current roster version, so any later edit makes it stale. */
  app.post('/api/roster/approve-pod', h((req, res) => {
    const month = monthParam(req.body.month);
    const { v, world } = snapshot(month);
    if (!v.generated) throw bad('Generate the roster first');
    const pod = world.pods.find((p) => p.id === Number(req.body.pod_id));
    if (!pod) throw bad('pod not found');
    const open = v.conflicts.filter((c) => c.category === 'mandatory' && c.severity === 'error' && c.pod_id === pod.id);
    if (open.length && !req.body.acknowledge) throw new HttpError(409, `${pod.name} still has ${open.length} open mandatory conflict(s). Approve with acknowledgement to sign off anyway.`);
    const by = world.employees.find((e) => e.id === pod.lead_id)?.name || 'Pod lead';
    setApproval(db, month, pod.id, by, req.body.note);
    logActivity(db, month, 'POD_APPROVED', `${pod.name} roster for ${month} approved by ${by}${open.length ? ` (acknowledging ${open.length} open conflict(s))` : ''}.`);
    res.json(payload(month));
  }));
  app.post('/api/roster/request-changes', h((req, res) => {
    const month = monthParam(req.body.month);
    const pod = loadWorld(db).pods.find((p) => p.id === Number(req.body.pod_id));
    if (!pod) throw bad('pod not found');
    touchMeta(db, month, { status: 'draft', published_at: null });
    logActivity(db, month, 'CHANGES_REQUESTED', `${pod.name} lead requested changes to ${month}: ${String(req.body.note || 'no note').slice(0, 300)}`);
    res.json(payload(month));
  }));

  /** Build alternative plans with different soft priorities and compare them without saving anything. */
  app.post('/api/roster/compare', h((req, res) => {
    const month = monthParam(req.body.month);
    const { world, cells } = snapshot(month);
    const plans = Object.entries(STRATEGIES).map(([key, st]) => {
      const { cells: planCells } = generateRoster(world, month, { existing: cells, keepManual: false, strategy: key });
      for (const [k, c] of cells) if (!planCells.has(k) && !c.date.startsWith(month)) planCells.set(k, c); // neighbour-month cells stay as they are
      const v = validateRoster(world, month, planCells);
      // fairness = how evenly the planner-chosen weekend offs are shared (closed-day offs are nobody's choice)
      const wkCount = new Map(world.employees.map((e) => [e.id, 0]));
      for (const c of planCells.values()) if (c.date.startsWith(month) && c.status === 'WO' && /^Weekly off/.test(c.note || '') && [0, 6].includes(new Date(c.date + 'T00:00:00Z').getUTCDay())) wkCount.set(c.employee_id, (wkCount.get(c.employee_id) || 0) + 1);
      const wk = [...wkCount.values()];
      const mean = wk.reduce((a, b) => a + b, 0) / Math.max(1, wk.length);
      const sd = Math.sqrt(wk.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, wk.length));
      return {
        key, label: st.label, blurb: st.blurb,
        coverage_pct: v.stats.coverage_pct, mandatory: v.stats.errors, preferences_missed: v.stats.preferences,
        max_weekend_offs: Math.max(0, ...wk), weekend_spread: Math.round(sd * 100) / 100,
        changed_cells: diffCells(cells, planCells).filter((c) => c.date.startsWith(month)).length,
      };
    });
    res.json({ month, plans });
  }));

  app.post('/api/roster/unpublish', h((req, res) => {
    const month = monthParam(req.body.month);
    touchMeta(db, month, { status: 'draft', published_at: null });
    logActivity(db, month, 'UNPUBLISHED', `Roster ${month} moved back to draft.`);
    res.json(payload(month));
  }));

  app.get('/api/activity', h((req, res) => res.json(listActivity(db, monthParam(req.query.month)))));

  app.get('/api/roster/export.csv', h((req, res) => {
    const month = monthParam(req.query.month);
    const { world, cells } = snapshot(month);
    const dates = monthDates(month);
    const podName = new Map(world.pods.map((p) => [p.id, p.name]));
    const procName = new Map(world.processes.map((p) => [p.id, p]));
    const brandName = new Map(world.brands.map((b) => [b.id, b.name]));
    const q = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
    const rows = [['Employee', 'Pod', 'Assignments', ...dates.map((d) => `${d.slice(8)} ${dowName(new Date(d + 'T00:00:00Z').getUTCDay())}`)].map(q).join(',')];
    for (const e of world.employees.filter((x) => x.active)) {
      const asg = world.assignments.filter((a) => a.employee_id === e.id).map((a) => { const p = procName.get(a.process_id); return `${brandName.get(p.brand_id)}:${p.name}${a.role === 'backup' ? '(backup)' : ''}`; }).join('; ');
      rows.push([e.name, podName.get(e.pod_id) || '', asg, ...dates.map((d) => cells.get(cellKey(e.id, d))?.status || '')].map(q).join(','));
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="roster-${month}.csv"`);
    res.send(rows.join('\n'));
  }));

  // ── master-data CRUD ────────────────────────────────────────────────────────
  for (const table of Object.keys(TABLES)) {
    app.get(`/api/${table}`, h((req, res) => res.json(list(db, table))));
    app.post(`/api/${table}`, h((req, res) => {
      validateRow(table, req.body, false);
      let row;
      try { row = insert(db, table, req.body); } catch (e) { throw bad(/UNIQUE/.test(e.message) ? 'That record already exists' : e.message); }
      if (table === 'leaves' && req.body.auto_repair && row.status === 'approved') {
        const months = [...new Set(eachDate(row.start_date, row.end_date).map(monthOf))].filter((m) => getMeta(db, m).status !== 'none');
        for (const m of months) { runGeneration(m, 'repair'); logActivity(db, m, 'LEAVE_APPROVED', `Leave added for employee #${row.employee_id} - roster auto-repaired.`); flagIfPublished(m, 'approved leave'); }
      }
      res.status(201).json(row);
    }));
    app.put(`/api/${table}/:id`, h((req, res) => {
      const id = Number(req.params.id);
      if (!get(db, table, id)) throw new HttpError(404, 'Not found');
      validateRow(table, req.body, true);
      let row;
      try { row = update(db, table, id, req.body); } catch (e) { throw bad(/UNIQUE/.test(e.message) ? 'That record already exists' : e.message); }
      res.json(row);
    }));
    app.delete(`/api/${table}/:id`, h((req, res) => {
      const n = remove(db, table, Number(req.params.id));
      if (!n) throw new HttpError(404, 'Not found');
      res.json({ ok: true });
    }));
  }

  app.use(express.static(path.join(__dirname, '../public')));
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Internal error: ' + err.message });
  });
  return app;
}
