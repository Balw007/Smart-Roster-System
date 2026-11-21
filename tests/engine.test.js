import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, loadWorld, loadCells, saveCells } from '../server/db.js';
import { seedDatabase } from '../server/seed.js';
import { generateRoster, diffCells } from '../server/engine/generate.js';
import { validateRoster, diffConflicts } from '../server/engine/validate.js';
import { suggestFixes } from '../server/engine/suggest.js';
import { applyOps } from '../server/engine/ops.js';
import { buildIndex, requiredStaff, cellKey } from '../server/engine/rules.js';
import { monthDates, dow, horizonDates } from '../server/engine/dates.js';

const MONTH = '2026-12';

function fresh() {
  const db = openDb(':memory:');
  seedDatabase(db, { month: MONTH });
  return db;
}
const byName = (world, n) => world.employees.find((e) => e.name === n);
const procOf = (world, brand, proc) => {
  const b = world.brands.find((x) => x.name === brand);
  return world.processes.find((p) => p.brand_id === b.id && p.name === proc);
};
const errors = (v) => v.conflicts.filter((c) => c.severity === 'error');

test('sample data reflects the brief: >=30 employees, ~80% single-resource brands, 2-3 people on the rest', () => {
  const world = loadWorld(fresh());
  assert.ok(world.employees.length >= 30);
  const primaries = new Map();
  for (const a of world.assignments.filter((x) => x.role === 'primary')) {
    const p = world.processes.find((x) => x.id === a.process_id);
    if (!primaries.has(p.brand_id)) primaries.set(p.brand_id, new Set());
    primaries.get(p.brand_id).add(a.employee_id);
  }
  const sizes = [...primaries.values()].map((s) => s.size);
  const single = sizes.filter((n) => n === 1).length;
  assert.equal(world.brands.length, 25);
  assert.equal(single, 20);
  assert.equal(single / sizes.length, 0.8);
  for (const n of sizes.filter((n) => n > 1)) assert.ok(n === 2 || n === 3);
  assert.equal(world.pods.length, 4);
  assert.ok(world.pods.every((p) => p.lead_id));
  // at least one employee handles several brands
  const brandsPerEmp = new Map();
  for (const a of world.assignments.filter((x) => x.role === 'primary')) {
    const p = world.processes.find((x) => x.id === a.process_id);
    if (!brandsPerEmp.has(a.employee_id)) brandsPerEmp.set(a.employee_id, new Set());
    brandsPerEmp.get(a.employee_id).add(p.brand_id);
  }
  assert.ok([...brandsPerEmp.values()].some((s) => s.size > 1));
});

test('operating calendars are per process and independent of employee schedules', () => {
  const world = loadWorld(fresh());
  const ix = buildIndex(world);
  const sun = '2026-12-06'; const xmas = '2026-12-25'; const mon = '2026-12-07';
  const cs365 = procOf(world, 'UrbanStyle', 'CS');
  const acc = procOf(world, 'UrbanStyle', 'ACC'); // every day except holidays
  const ndr = procOf(world, 'UrbanStyle', 'NDR'); // Sundays + holidays off
  assert.equal(dow(sun), 0);
  assert.deepEqual([cs365, acc, ndr].map((p) => requiredStaff(p, sun, ix.holidaySet)), [1, 1, 0]);
  assert.deepEqual([cs365, acc, ndr].map((p) => requiredStaff(p, xmas, ix.holidaySet)), [1, 0, 0]);
  assert.deepEqual([cs365, acc, ndr].map((p) => requiredStaff(p, mon, ix.holidaySet)), [1, 1, 1]);
  // minimum staffing on specific days: ModernKart CS needs 2 on Saturdays
  const mk = procOf(world, 'ModernKart', 'CS');
  assert.equal(requiredStaff(mk, '2026-12-05', ix.holidaySet), 2);
  assert.equal(requiredStaff(mk, '2026-12-04', ix.holidaySet), 1);
});

test('generated roster is valid: the only mandatory gaps are the two brands deliberately left without a backup', () => {
  const db = fresh();
  const world = loadWorld(db);
  const v = validateRoster(world, MONTH, loadCells(db, MONTH));
  assert.ok(v.generated);
  const errs = errors(v);
  assert.ok(errs.length > 0, 'unavoidable gaps must be surfaced, not hidden');
  const brandName = (id) => world.brands.find((b) => b.id === id)?.name;
  for (const c of errs) {
    assert.equal(c.type, 'COVERAGE_GAP', c.message);
    assert.ok(['StyleHub', 'PixelCam'].includes(brandName(c.brand_id)), c.message);
    assert.equal(c.cause, 'WEEKLY_OFF');
    assert.equal(c.sole_resource, true);
  }
  assert.ok(v.stats.coverage_pct > 99);
});

test('every employee gets their weekly off, never works >6 days in a row, and no one works while on leave', () => {
  const db = fresh();
  const world = loadWorld(db);
  for (const m of ['2026-11', MONTH]) {
    const v = validateRoster(world, m, loadCells(db, m));
    for (const t of ['WEEKLY_OFF_SHORT', 'CONSECUTIVE_WORK', 'LEAVE_VIOLATION', 'OVERLOAD', 'SHIFT_CONFLICT']) {
      assert.equal(v.conflicts.filter((c) => c.type === t).length, 0, `${m} ${t}`);
    }
  }
});

test('boundary weeks are planned as whole weeks and stay consistent when the next month is generated', () => {
  const db = fresh();
  let world = loadWorld(db);
  // generate January after December already exists
  const { cells } = generateRoster(world, '2027-01', { existing: loadCells(db, '2027-01') });
  saveCells(db, '2027-01', cells);
  world = loadWorld(db);
  for (const m of [MONTH, '2027-01']) {
    const v = validateRoster(world, m, loadCells(db, m));
    assert.equal(v.conflicts.filter((c) => c.type === 'WEEKLY_OFF_SHORT' || c.type === 'CONSECUTIVE_WORK').length, 0, m);
  }
  // December's cells are untouched by January's generation
  const dec = loadCells(db, MONTH);
  assert.ok(monthDates(MONTH).every((d) => [...dec.values()].some((c) => c.date === d)));
  assert.ok(horizonDates('2027-01')[0] <= '2026-12-28');
});

test('single-resource brand with a standby backup stays covered when the primary is on leave', () => {
  const db = fresh();
  const world = loadWorld(db);
  const v = validateRoster(world, MONTH, loadCells(db, MONTH));
  const priya = byName(world, 'Priya Mehta'); const pooja = byName(world, 'Pooja Gupta');
  const cs = procOf(world, 'UrbanStyle', 'CS');
  // Priya is on approved leave Dec 8-10 (seeded)
  const rec = v.coverage[cs.id]['2026-12-09'];
  assert.deepEqual(rec[1], [], 'primary not working');
  assert.deepEqual(rec[2], [pooja.id], 'backup activated');
  assert.equal(rec[3], 0);
  assert.ok(!v.conflicts.some((c) => c.employee_ids?.includes(priya.id)));
});

test('multi-employee brand: one absence is absorbed unless the day needs two people', () => {
  const db = fresh();
  const world = loadWorld(db);
  const cells = loadCells(db, MONTH);
  const aditya = byName(world, 'Aditya Rao');
  const cs = procOf(world, 'SmartGadgets', 'CS');
  // Wednesday: Kavya alone is enough (min 1)
  const wed = applyOps(world, cells, [{ type: 'ADD_LEAVE', leave: { employee_id: aditya.id, start_date: '2026-12-16', end_date: '2026-12-16', type: 'PL' } }], MONTH);
  let v = validateRoster(wed.world, MONTH, wed.cells);
  assert.ok(!v.conflicts.some((c) => c.process_id === cs.id && c.date === '2026-12-16'));
  // Saturday needs 2 -> understaffed, flagged as UNDERSTAFFED (not "no coverage")
  const sat = applyOps(world, cells, [{ type: 'ADD_LEAVE', leave: { employee_id: aditya.id, start_date: '2026-12-19', end_date: '2026-12-19', type: 'PL' } }], MONTH);
  v = validateRoster(sat.world, MONTH, sat.cells);
  const c = v.conflicts.find((x) => x.process_id === cs.id && x.date === '2026-12-19');
  assert.equal(c?.type, 'UNDERSTAFFED');
  assert.match(c.message, /1 of 2/);
});

test('sole resource unavailable on a required day -> gap flagged with explanation, simulated suggestions, and a fix that works', () => {
  const db = fresh();
  const world = loadWorld(db);
  const cells = loadCells(db, MONTH);
  const base = validateRoster(world, MONTH, cells);
  const rohit = byName(world, 'Rohit Verma');
  const denim = procOf(world, 'DenimCo', 'CS');
  const change = applyOps(world, cells, [{ type: 'ADD_LEAVE', leave: { employee_id: rohit.id, start_date: '2026-12-14', end_date: '2026-12-15', type: 'PL' } }], MONTH);
  const after = validateRoster(change.world, MONTH, change.cells);
  const { introduced } = diffConflicts(base.conflicts, after.conflicts);
  assert.ok(introduced.some((c) => c.process_id === denim.id && c.date === '2026-12-14' && c.type === 'COVERAGE_GAP'));
  const gap = introduced.find((c) => c.process_id === denim.id && c.date === '2026-12-14');
  assert.equal(gap.cause, 'LEAVE');
  assert.match(gap.message, /Rohit Verma \(on pl leave\)/);

  const sug = suggestFixes(change.world, MONTH, change.cells, { process_id: denim.id, date: '2026-12-14' });
  assert.ok(sug.options.length > 0);
  const fix = sug.options.find((o) => o.type === 'CROSS_COVER');
  assert.ok(fix, 'cross-cover from a working colleague should be proposed');
  assert.equal(fix.introduces, 0);
  const fixed = applyOps(change.world, change.cells, fix.ops, MONTH);
  const v2 = validateRoster(fixed.world, MONTH, fixed.cells);
  assert.ok(!v2.conflicts.some((c) => c.process_id === denim.id && c.date === '2026-12-14'));
  // Every option claims to resolve the gap: verify by simulation, and info options never carry ops
  for (const o of sug.options.filter((x) => x.ops)) {
    const s = applyOps(change.world, change.cells, o.ops, MONTH);
    assert.ok(!validateRoster(s.world, MONTH, s.cells).conflicts.some((c) => sug.target.conflict_ids.includes(c.id)), o.title);
  }
});

test('a recurring weekly-off gap on a brand without backup gets a structural fix (add a standby) that clears the whole month', () => {
  const db = fresh();
  const world = loadWorld(db);
  const cells = loadCells(db, MONTH);
  const base = validateRoster(world, MONTH, cells);
  const cs = procOf(world, 'PixelCam', 'CS');
  const gap = base.conflicts.find((c) => c.process_id === cs.id && c.type === 'COVERAGE_GAP');
  const sug = suggestFixes(world, MONTH, cells, { process_id: cs.id, date: gap.date });
  const add = sug.options.find((o) => o.type === 'ADD_BACKUP');
  assert.ok(add);
  const s = applyOps(world, cells, add.ops, MONTH);
  const v = validateRoster(s.world, MONTH, s.cells);
  assert.equal(v.conflicts.filter((c) => c.process_id === cs.id && c.severity === 'error').length, 0);
});

test('manual edits are validated: working on leave and removing a weekly off are both rejected as mandatory errors', () => {
  const db = fresh();
  const world = loadWorld(db);
  const cells = loadCells(db, MONTH);
  const priya = byName(world, 'Priya Mehta');
  const base = validateRoster(world, MONTH, cells);
  let r = applyOps(world, cells, [{ type: 'SET_CELL', employee_id: priya.id, date: '2026-12-09', status: 'W' }], MONTH);
  let v = validateRoster(r.world, MONTH, r.cells);
  assert.ok(v.conflicts.some((c) => c.type === 'LEAVE_VIOLATION' && c.employee_id === priya.id));
  // remove one employee's only weekly off in a week
  const rahul = byName(world, 'Rahul Bose');
  const off = [...cells.values()].find((c) => c.employee_id === rahul.id && c.status === 'WO' && c.date >= '2026-12-07' && c.date <= '2026-12-13');
  r = applyOps(world, cells, [{ type: 'SET_CELL', employee_id: rahul.id, date: off.date, status: 'W' }], MONTH);
  v = validateRoster(r.world, MONTH, r.cells);
  assert.ok(diffConflicts(base.conflicts, v.conflicts).introduced.some((c) => c.type === 'WEEKLY_OFF_SHORT' && c.employee_id === rahul.id));
});

test('preferences never override mandatory coverage and are reported separately (info, not error)', () => {
  const db = fresh();
  const world = loadWorld(db);
  const v = validateRoster(world, MONTH, loadCells(db, MONTH));
  const prefs = v.conflicts.filter((c) => c.type === 'PREFERENCE');
  assert.ok(prefs.length > 0);
  assert.ok(prefs.every((c) => c.severity === 'info' && c.category === 'preference'));
  assert.equal(v.stats.errors, errors(v).length);
});

test('repair after a leave change touches only a handful of cells (does not rebuild the roster)', () => {
  const db = fresh();
  const world = loadWorld(db);
  const cells = loadCells(db, MONTH);
  const nikhil = byName(world, 'Nikhil Desai');
  const leave = { employee_id: nikhil.id, start_date: '2026-12-02', end_date: '2026-12-04', type: 'PL', status: 'approved' };
  const w2 = { ...world, leaves: [...world.leaves, { id: 999, ...leave }] };
  const { cells: repaired } = generateRoster(w2, MONTH, { existing: cells, previous: cells, keepManual: true });
  const changes = diffCells(cells, repaired).filter((c) => c.date.startsWith(MONTH));
  assert.ok(changes.length >= 3 && changes.length <= 12, `expected a small diff, got ${changes.length}`);
  const { cells: full } = generateRoster(w2, MONTH, { existing: null });
  assert.ok(changes.length < diffCells(cells, full).length, 'repair must be less disruptive than regenerating from scratch');
  const v = validateRoster(w2, MONTH, new Map([...cells, ...repaired]));
  assert.equal(v.conflicts.filter((c) => c.type === 'LEAVE_VIOLATION').length, 0);
});

test('configuration problems are caught: understaffed definitions and incompatible shifts', () => {
  const db = fresh();
  const world = loadWorld(db);
  const cells = loadCells(db, MONTH);
  const sw = procOf(world, 'DenimCo', 'CS');
  const r = applyOps(world, cells, [{ type: 'PATCH_PROCESS', process_id: sw.id, patch: { min_staff: 2 } }], MONTH);
  let v = validateRoster(r.world, MONTH, r.cells);
  assert.ok(v.conflicts.some((c) => c.type === 'INSUFFICIENT_HEADCOUNT' && c.process_id === sw.id));
  assert.ok(v.conflicts.some((c) => c.type === 'UNDERSTAFFED' && c.process_id === sw.id), 'min_staff=2 with one person is flagged as understaffed');
  // put Rohit (DAY) as primary on a NIGHT process as well -> incompatible shifts
  const rohit = byName(world, 'Rohit Verma');
  const night = procOf(world, 'GlowSkin', 'CS');
  const w2 = { ...world, assignments: [...world.assignments, { id: 9999, employee_id: rohit.id, process_id: night.id, role: 'primary' }] };
  v = validateRoster(w2, MONTH, cells);
  assert.ok(v.conflicts.some((c) => c.type === 'SHIFT_CONFLICT' && c.employee_id === rohit.id));
});

test('generation is deterministic', () => {
  const world = loadWorld(fresh());
  const a = generateRoster(world, MONTH).cells;
  const b = generateRoster(world, MONTH).cells;
  assert.deepEqual([...a].map(([k, c]) => [k, c.status]), [...b].map(([k, c]) => [k, c.status]));
  assert.ok(a.has(cellKey(world.employees[0].id, '2026-12-01')));
});
