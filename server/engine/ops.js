// "Operations" are small, serialisable changes (set a cell, add a cover, add a backup, ...).
// The same op list is used to (a) simulate a change in memory for what-if / suggestions and
// (b) persist the change once the manager approves it (see db.js persistOps).

import { cellKey } from './rules.js';
import { eachDate } from './dates.js';

export function applyOps(world, cells, ops, month) {
  const w = { ...world, assignments: [...world.assignments], covers: [...(world.covers || [])], leaves: [...world.leaves], processes: [...world.processes] };
  const c = new Map(cells);
  let tmp = -1;
  for (const op of ops) {
    switch (op.type) {
      case 'SET_CELL': {
        const k = cellKey(op.employee_id, op.date);
        const old = c.get(k) || {};
        c.set(k, { ...old, employee_id: op.employee_id, date: op.date, status: op.status, source: 'manual', note: op.note ?? old.note ?? '', compoff_due: op.compoff_due ? 1 : 0 });
        break;
      }
      case 'ADD_COVER':
        w.covers.push({ id: tmp--, process_id: op.process_id, employee_id: op.employee_id, date: op.date, note: op.note || '' });
        break;
      case 'ADD_BACKUP':
        w.assignments.push({ id: tmp--, employee_id: op.employee_id, process_id: op.process_id, role: 'backup' });
        break;
      case 'SET_REQUIREMENT': {
        w.processes = w.processes.map((p) => (p.id === op.process_id ? { ...p, min_staff_by_date: { ...(p.min_staff_by_date || {}), [op.date]: op.min_staff } } : p));
        break;
      }
      case 'PATCH_PROCESS':
        w.processes = w.processes.map((p) => (p.id === op.process_id ? { ...p, ...op.patch } : p));
        break;
      case 'ADD_LEAVE': {
        const l = { id: tmp--, status: 'approved', ...op.leave };
        w.leaves.push(l);
        for (const d of eachDate(l.start_date, l.end_date)) {
          if (month && d.slice(0, 7) !== month) continue;
          const k = cellKey(l.employee_id, d);
          if (c.has(k)) c.set(k, { ...c.get(k), status: l.type === 'COMPOFF' ? 'CO' : 'L', source: 'auto', note: 'Approved leave', compoff_due: 0 });
        }
        break;
      }
      default:
        throw new Error(`Unknown op ${op.type}`);
    }
  }
  return { world: w, cells: c };
}
