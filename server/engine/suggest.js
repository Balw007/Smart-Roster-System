// Resolution suggestions for a coverage gap.
//
// Instead of guessing, every candidate fix is *simulated*: we apply it in memory, re-run the full validator
// and keep it only if it resolves the target gap. Each option reports how many NEW mandatory problems it
// would create elsewhere (e.g. pulling someone off another brand), so the manager sees the real trade-off.

import { buildIndex, cellKey, fixedStatus, shiftCompatible } from './rules.js';
import { validateRoster, diffConflicts } from './validate.js';
import { applyOps } from './ops.js';
import { fmt, monthWeeks } from './dates.js';

const COST_RANK = { none: 0, 'comp-off owed': 1, 'permanent change': 2, 'needs client approval': 3 };

export function suggestFixes(world, month, cells, { process_id, date }, { limit = 6 } = {}) {
  const ix = buildIndex(world);
  const p = ix.procById.get(process_id);
  if (!p) return { target: null, options: [] };
  const base = validateRoster(world, month, cells);
  const targetIds = base.conflicts.filter((c) => c.process_id === process_id && c.date === date && ['COVERAGE_GAP', 'UNDERSTAFFED'].includes(c.type)).map((c) => c.id);
  if (!targetIds.length) return { target: null, options: [], note: 'No open gap for this process on this date.' };

  const brand = ix.brandById.get(p.brand_id);
  const status = (e, d) => cells.get(cellKey(e, d))?.status ?? null;
  const load = base.internal.loadByDate.get(date) || new Map();
  const staffIds = new Set((ix.assignsByProc.get(p.id) || []).map((a) => a.employee_id));
  const week = monthWeeks(month).find((w) => w.includes(date)) || [date];
  const podOf = (e) => ix.podById.get(e.pod_id)?.name || '';
  const brandPod = brand.pod_id;
  const cands = [];

  // 1. swap a weekly off inside the same week
  for (const id of staffIds) {
    const e = ix.empById.get(id);
    if (status(id, date) !== 'WO' || fixedStatus(ix, e, date)) continue;
    for (const d2 of week) {
      if (d2 === date || status(id, d2) !== 'W' || fixedStatus(ix, e, d2)) continue;
      cands.push({ type: 'SWAP_OFF', cost: 'none', title: `Move ${e.name}'s weekly off from ${fmt(date)} to ${fmt(d2)}`, detail: `${e.name} works ${fmt(date)} and takes the off on ${fmt(d2)} instead.`, ops: [{ type: 'SET_CELL', employee_id: id, date, status: 'W' }, { type: 'SET_CELL', employee_id: id, date: d2, status: 'WO' }] });
    }
  }

  // 2. cross-cover by someone already working that day (not assigned to this process)
  const free = ix.employees
    .filter((e) => !staffIds.has(e.id) && status(e.id, date) === 'W' && shiftCompatible(e.shift, p.shift))
    .map((e) => ({ e, l: load.get(e.id) || 0 }))
    .filter((x) => x.l + p.load <= ix.maxLoad(x.e))
    .sort((a, b) => (b.e.pod_id === brandPod) - (a.e.pod_id === brandPod) || a.l - b.l || a.e.id - b.e.id)
    .slice(0, 10);
  for (const { e, l } of free) {
    cands.push({ type: 'CROSS_COVER', cost: 'none', title: `Ask ${e.name} (${podOf(e)}) to also cover ${p.name} on ${fmt(date)}`, detail: `Already working, load ${l}/${ix.maxLoad(e)} - fits capacity and shift (${e.shift}).`, ops: [{ type: 'ADD_COVER', process_id, employee_id: e.id, date }] });
  }

  // 3. call in someone who is on a weekly off (comp-off owed)
  const offs = ix.employees
    .filter((e) => status(e.id, date) === 'WO' && !fixedStatus(ix, e, date) && shiftCompatible(e.shift, p.shift))
    .sort((a, b) => (staffIds.has(b.id)) - (staffIds.has(a.id)) || (b.pod_id === brandPod) - (a.pod_id === brandPod) || a.id - b.id)
    .slice(0, 6);
  for (const e of offs) {
    cands.push({ type: 'CALL_IN', cost: 'comp-off owed', title: `Call in ${e.name} on their weekly off (${fmt(date)}) and owe a comp-off`, detail: `${e.name} (${podOf(e)}) is off that day; working it creates a comp-off credit.`, ops: [{ type: 'ADD_COVER', process_id, employee_id: e.id, date }, { type: 'SET_CELL', employee_id: e.id, date, status: 'W', compoff_due: 1, note: 'Called in - comp-off due' }] });
  }

  // 4. structural: add a standing backup (only if the process has none)
  const hasBackup = (ix.assignsByProc.get(p.id) || []).some((a) => a.role === 'backup');
  if (!hasBackup) {
    const pool = ix.employees
      .filter((e) => !staffIds.has(e.id) && shiftCompatible(e.shift, p.shift) && status(e.id, date) === 'W')
      .map((e) => ({ e, l: load.get(e.id) || 0 }))
      .sort((a, b) => (b.e.pod_id === brandPod) - (a.e.pod_id === brandPod) || a.l - b.l)
      .slice(0, 4);
    for (const { e } of pool) {
      cands.push({ type: 'ADD_BACKUP', cost: 'permanent change', title: `Add ${e.name} as a standing backup for ${brand.name} › ${p.name}`, detail: 'Fixes this gap and every future weekly-off gap of this process (recurring risk). Backup activates only when primaries are short.', ops: [{ type: 'ADD_BACKUP', process_id, employee_id: e.id }] });
    }
  }

  // 5. last resort: agreed exception with the client
  const covered = (base.coverage[process_id]?.[date]?.[1].length || 0) + (base.coverage[process_id]?.[date]?.[2].length || 0);
  cands.push({ type: 'RELAX_REQUIREMENT', cost: 'needs client approval', title: `Record a client-approved exception: reduce ${p.name} requirement on ${fmt(date)} to ${covered}`, detail: 'Only valid if the client agrees to reduced coverage for that day. Logged in the activity feed.', ops: [{ type: 'SET_REQUIREMENT', process_id, date, min_staff: covered }] });

  // simulate each candidate
  const baseErr = new Set(base.conflicts.filter((c) => c.category === 'mandatory').map((c) => c.id));
  const results = [];
  for (const c of cands) {
    const sim = applyOps(world, cells, c.ops, month);
    const v = validateRoster(sim.world, month, sim.cells);
    const stillOpen = v.conflicts.some((x) => targetIds.includes(x.id));
    if (stillOpen) continue;
    const diff = diffConflicts(base.conflicts, v.conflicts);
    results.push({ ...c, introduces: diff.introduced.length, introduced: diff.introduced.slice(0, 3).map((x) => x.message), resolves: diff.resolved.length });
  }
  results.sort((a, b) => a.introduces - b.introduces || COST_RANK[a.cost] - COST_RANK[b.cost] || b.resolves - a.resolves);

  // keep a few of each kind so the manager sees genuinely different levers, not six variants of one
  const quota = { SWAP_OFF: 2, CROSS_COVER: 3, CALL_IN: 2, ADD_BACKUP: 2, RELAX_REQUIREMENT: 1 };
  const used = {};
  const options = results.filter((o) => (used[o.type] = (used[o.type] || 0) + 1) <= quota[o.type]).slice(0, limit + 3);

  // informational: leave-related levers a human decides
  const info = [];
  for (const l of world.leaves) {
    if (!staffIds.has(l.employee_id) || l.start_date > date || l.end_date < date) continue;
    const e = ix.empById.get(l.employee_id);
    info.push({ type: l.status === 'pending' ? 'REVIEW_PENDING_LEAVE' : 'RESCHEDULE_LEAVE', cost: 'none', ops: null, title: l.status === 'pending' ? `Review ${e.name}'s pending leave request (${fmt(l.start_date)} - ${fmt(l.end_date)}) before approving` : `Ask ${e.name} to reschedule approved leave (${fmt(l.start_date)} - ${fmt(l.end_date)})`, detail: 'Human decision - the system does not touch leave automatically.' });
  }

  return { target: { process_id, date, conflict_ids: targetIds }, options: [...options, ...info] };
}
