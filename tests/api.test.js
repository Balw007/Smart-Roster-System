import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.js';
import { seedDatabase } from '../server/seed.js';
import { createApp } from '../server/app.js';

const MONTH = '2026-12';
let server; let base;
const call = async (method, url, body) => {
  const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, json, headers: r.headers };
};

before(async () => {
  const db = openDb(':memory:');
  seedDatabase(db, { month: MONTH });
  server = createApp(db).listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

test('world + pre-generated roster are served', async () => {
  const w = (await call('GET', '/api/world')).json;
  assert.equal(w.employees.length, 36);
  assert.equal(w.brands.length, 25);
  const r = (await call('GET', `/api/roster?month=${MONTH}`)).json;
  assert.equal(r.generated, true);
  assert.equal(r.cells.length, 36 * 31);
  assert.ok(r.stats.coverage_pct > 99);
  assert.equal((await call('GET', '/api/roster?month=bad')).status, 400);
  const empty = (await call('GET', '/api/roster?month=2030-01')).json;
  assert.equal(empty.generated, false);
});

test('change handling: preview -> commit -> suggestion -> apply -> resolved', async () => {
  const w = (await call('GET', '/api/world')).json;
  const pending = w.leaves.find((l) => l.status === 'pending' && l.start_date === `${MONTH}-14`);
  const denimCs = w.processes.find((p) => p.name === 'CS' && w.brands.find((b) => b.id === p.brand_id).name === 'DenimCo');

  const preview = (await call('POST', '/api/roster/whatif', { month: MONTH, change: { kind: 'leave', leave_id: pending.id } })).json;
  assert.ok(preview.immediate.introduced.some((c) => c.process_id === denimCs.id && c.date === `${MONTH}-14`));
  assert.ok(preview.afterRepair.introduced.length > 0, 'a sole resource cannot be repaired automatically');
  assert.ok(preview.suggestions.length > 0 && preview.suggestions[0].options.length > 0);
  // preview must not persist anything
  assert.equal((await call('GET', '/api/leaves')).json.find((l) => l.id === pending.id).status, 'pending');
  const unchanged = (await call('GET', `/api/roster?month=${MONTH}`)).json;
  assert.ok(!unchanged.conflicts.some((c) => c.process_id === denimCs.id));

  const commit = (await call('POST', '/api/roster/commit', { month: MONTH, change: { kind: 'leave', leave_id: pending.id } })).json;
  assert.equal((await call('GET', '/api/leaves')).json.find((l) => l.id === pending.id).status, 'approved');
  const gap = commit.conflicts.find((c) => c.process_id === denimCs.id && c.date === `${MONTH}-14`);
  assert.ok(gap, 'gap flagged after approval');

  const sug = (await call('POST', '/api/roster/suggest', { month: MONTH, process_id: denimCs.id, date: `${MONTH}-14` })).json;
  const fix = sug.options.find((o) => o.ops && o.introduces === 0);
  assert.ok(fix);
  const applied = (await call('POST', '/api/roster/apply', { month: MONTH, ops: fix.ops, label: fix.title })).json;
  assert.ok(!applied.conflicts.some((c) => c.process_id === denimCs.id && c.date === `${MONTH}-14`));
  assert.ok(applied.diff.resolved.length >= 1);
});

test('publishing is blocked by open mandatory conflicts, allowed with override, and later changes raise a notification', async () => {
  const blocked = await call('POST', '/api/roster/publish', { month: MONTH });
  assert.equal(blocked.status, 409);
  const ok = await call('POST', '/api/roster/publish', { month: MONTH, force: true });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.meta.status, 'published');
  const w = (await call('GET', '/api/world')).json;
  const emp = w.employees[0];
  const edit = await call('POST', '/api/roster/cell', { month: MONTH, employee_id: emp.id, date: `${MONTH}-02`, status: 'WO' });
  assert.equal(edit.status, 200);
  assert.ok(edit.json.cells.some((c) => c[0] === emp.id && c[1] === `${MONTH}-02` && c[2] === 'WO' && c[3] === 1));
  const act = (await call('GET', `/api/activity?month=${MONTH}`)).json;
  assert.ok(act.some((a) => a.kind === 'PUBLISHED_ROSTER_CHANGED'));
});

test('new brands, processes, employees and assignments need no code change and flow into the roster', async () => {
  const w = (await call('GET', '/api/world')).json;
  const pod = w.pods[0];
  const emp = (await call('POST', '/api/employees', { name: 'Test Person', pod_id: pod.id, shift: 'DAY', preferred_off_days: [0] })).json;
  const brand = (await call('POST', '/api/brands', { name: 'NewBrand', pod_id: pod.id, active: true })).json;
  const proc = (await call('POST', '/api/processes', { brand_id: brand.id, name: 'CS', operating_days: [0, 1, 2, 3, 4, 5, 6], open_on_holidays: true, min_staff: 1, shift: 'DAY' })).json;
  await call('POST', '/api/assignments', { employee_id: emp.id, process_id: proc.id, role: 'primary' });
  // before regeneration the new person is flagged as not rostered and the new process has a gap
  let r = (await call('GET', `/api/roster?month=${MONTH}`)).json;
  assert.ok(r.conflicts.some((c) => c.type === 'NOT_ROSTERED' && c.employee_id === emp.id));
  r = (await call('POST', '/api/roster/generate', { month: MONTH, mode: 'repair' })).json;
  assert.ok(!r.conflicts.some((c) => c.type === 'NOT_ROSTERED'));
  assert.ok(r.cells.some((c) => c[0] === emp.id));
  // single resource on a 7-day process with no backup -> weekly-off gaps surfaced
  assert.ok(r.conflicts.some((c) => c.process_id === proc.id && c.type === 'COVERAGE_GAP'));
});

test('bad input is rejected with clear messages', async () => {
  assert.equal((await call('POST', '/api/leaves', { employee_id: 1, start_date: '2026-12-10', end_date: '2026-12-01' })).status, 400);
  assert.equal((await call('POST', '/api/employees', {})).status, 400);
  assert.equal((await call('POST', '/api/processes', { brand_id: 1, name: 'X', operating_days: [9] })).status, 400);
  assert.equal((await call('POST', '/api/roster/cell', { month: MONTH, employee_id: 1, date: '2027-01-01', status: 'W' })).status, 400);
  assert.equal((await call('POST', '/api/roster/cell', { month: MONTH, employee_id: 1, date: `${MONTH}-02`, status: 'XX' })).status, 400);
  assert.equal((await call('DELETE', '/api/brands/99999')).status, 404);
});

test('CSV export', async () => {
  const r = await call('GET', `/api/roster/export.csv?month=${MONTH}`);
  assert.match(r.headers.get('content-type'), /text\/csv/);
  assert.ok(r.json.split('\n').length >= 37);
});

test('alternative plans can be compared without saving, and one can be adopted', async () => {
  const before = await call('GET', `/api/roster?month=${MONTH}`);
  const cmp = await call('POST', '/api/roster/compare', { month: MONTH });
  assert.equal(cmp.status, 200);
  assert.deepEqual(cmp.json.plans.map((p) => p.key), ['balanced', 'preferences', 'fairness']);
  for (const p of cmp.json.plans) assert.ok(p.coverage_pct > 95 && typeof p.preferences_missed === 'number');
  const pref = cmp.json.plans.find((p) => p.key === 'preferences');
  const bal = cmp.json.plans.find((p) => p.key === 'balanced');
  assert.ok(pref.preferences_missed <= bal.preferences_missed, 'preference-first misses no more preferences');
  const after = await call('GET', `/api/roster?month=${MONTH}`);
  assert.equal(after.json.meta.version, before.json.meta.version, 'compare must not change the roster');
  const adopted = await call('POST', '/api/roster/generate', { month: MONTH, mode: 'full', strategy: 'fairness' });
  assert.equal(adopted.status, 200);
});

test('pod lead approvals gate publishing and go stale after any edit', async () => {
  await call('POST', '/api/roster/unpublish', { month: MONTH });
  const gated = await call('POST', '/api/roster/publish', { month: MONTH, force: false });
  assert.equal(gated.status, 409);
  const state = (await call('GET', `/api/roster?month=${MONTH}`)).json.approvals;
  assert.ok(state.length >= 4 && state.every((a) => !a.approved));
  const a = await call('POST', '/api/roster/approve-pod', { month: MONTH, pod_id: state[0].pod_id, acknowledge: true });
  assert.equal(a.status, 200);
  assert.equal(a.json.approvals.find((x) => x.pod_id === state[0].pod_id).approved, true);
  // any later edit makes the sign-off stale
  const cell = a.json.cells.find((c) => c[2] === 'W');
  await call('POST', '/api/roster/cell', { month: MONTH, employee_id: cell[0], date: cell[1], status: 'WO' });
  const after = (await call('GET', `/api/roster?month=${MONTH}`)).json.approvals.find((x) => x.pod_id === state[0].pod_id);
  assert.equal(after.approved, false);
  assert.equal(after.stale, true);
});
