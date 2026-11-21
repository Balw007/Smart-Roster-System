// Core domain rules shared by generation, validation and suggestions.
// Everything here is pure: it works on a plain `world` object (master data) and never touches the DB.

import { dow, weekStart, addDays } from './dates.js';

export const DEFAULT_SETTINGS = {
  weekly_offs_per_week: 1, // default number of weekly offs per full week
  max_consecutive_work: 6, // hard labour rule: never more than N working days in a row
  default_max_daily_load: 8, // default "capacity" of an employee (sum of process load points per day)
  leave_waiver_days: 3, // >= N leave/comp-off days in a week waive one weekly off
};

export const STATUS_LABEL = { W: 'Working', WO: 'Weekly off', H: 'Public holiday', L: 'Leave', CO: 'Comp-off' };
export const OFF_STATUSES = new Set(['WO', 'H', 'L', 'CO']);

export const cellKey = (employeeId, date) => `${employeeId}|${date}`;

export function shiftCompatible(a, b) {
  return a === 'FLEX' || b === 'FLEX' || a === b;
}

/** Build lookup indexes once per operation. */
export function buildIndex(world) {
  const settings = { ...DEFAULT_SETTINGS, ...(world.settings || {}) };
  const employees = world.employees.filter((e) => e.active);
  const empById = new Map(world.employees.map((e) => [e.id, e]));
  const procById = new Map(world.processes.map((p) => [p.id, p]));
  const brandById = new Map(world.brands.map((b) => [b.id, b]));
  const podById = new Map((world.pods || []).map((p) => [p.id, p]));
  const holidaySet = new Set(world.holidays.map((h) => h.date));
  const holidayName = new Map(world.holidays.map((h) => [h.date, h.name]));

  const activeProc = (p) => !!(p && p.active && brandById.get(p.brand_id)?.active);

  const assignsByEmp = new Map();
  const assignsByProc = new Map();
  for (const a of world.assignments) {
    const p = procById.get(a.process_id);
    const e = empById.get(a.employee_id);
    if (!activeProc(p) || !e || !e.active) continue;
    if (!assignsByEmp.has(e.id)) assignsByEmp.set(e.id, []);
    if (!assignsByProc.has(p.id)) assignsByProc.set(p.id, []);
    assignsByEmp.get(e.id).push(a);
    assignsByProc.get(p.id).push(a);
  }

  // approved leaves, indexed per employee
  const leavesByEmp = new Map();
  for (const l of world.leaves) {
    if (l.status !== 'approved') continue;
    if (!leavesByEmp.has(l.employee_id)) leavesByEmp.set(l.employee_id, []);
    leavesByEmp.get(l.employee_id).push(l);
  }

  // date-specific cover assignments
  const coversByProcDate = new Map();
  const coverProcsByEmpDate = new Map();
  for (const c of world.covers || []) {
    const k1 = `${c.process_id}|${c.date}`;
    if (!coversByProcDate.has(k1)) coversByProcDate.set(k1, []);
    coversByProcDate.get(k1).push(c.employee_id);
    const k2 = cellKey(c.employee_id, c.date);
    if (!coverProcsByEmpDate.has(k2)) coverProcsByEmpDate.set(k2, []);
    coverProcsByEmpDate.get(k2).push(c.process_id);
  }

  const ix = {
    world, settings, employees, empById, procById, brandById, podById, holidaySet, holidayName,
    assignsByEmp, assignsByProc, leavesByEmp, coversByProcDate, coverProcsByEmpDate,
    activeProcesses: world.processes.filter(activeProc),
  };

  ix.leaveOn = (empId, date) => (leavesByEmp.get(empId) || []).find((l) => l.start_date <= date && date <= l.end_date) || null;
  ix.required = (p, date) => (brandById.get(p.brand_id)?.active ? requiredStaff(p, date, holidaySet) : 0);
  ix.maxLoad = (e) => e.max_daily_load ?? settings.default_max_daily_load;
  ix.offsPerWeek = (e) => e.weekly_offs_per_week ?? settings.weekly_offs_per_week;
  /** processes an employee is responsible for on a date: permanent assignments + date-specific covers */
  ix.procsOnDate = (empId, date) => {
    const ids = new Set((assignsByEmp.get(empId) || []).map((a) => a.process_id));
    for (const pid of coverProcsByEmpDate.get(cellKey(empId, date)) || []) ids.add(pid);
    return [...ids].map((id) => procById.get(id)).filter((p) => p && activeProc(p));
  };
  return ix;
}

/**
 * Operating calendar of a process: how many people must be working on `date`.
 * 0 means the process is closed that day. This is the *brand/process* calendar and is
 * deliberately separate from an individual employee's working schedule.
 */
export function requiredStaff(p, date, holidaySet) {
  if (!p.active) return 0;
  const d = dow(date);
  if (holidaySet.has(date) && !p.open_on_holidays) return 0;
  if (!p.operating_days.includes(d)) return 0;
  const byDate = p.min_staff_by_date?.[date];
  if (byDate != null) return byDate;
  const byDow = p.min_staff_by_dow?.[d];
  if (byDow != null) return byDow;
  return p.min_staff;
}

/**
 * Status that is *forced* for an employee on a date, independent of the weekly-off optimisation.
 * Returns { status, natural, note } or null when the employee is a free candidate.
 *  - approved leave / comp-off
 *  - employee-level unavailable weekdays (e.g. part-timer who never works Saturday)
 *  - "natural" offs: every process the employee handles is closed that day
 */
export function fixedStatus(ix, emp, date) {
  const leave = ix.leaveOn(emp.id, date);
  if (leave) {
    return { status: leave.type === 'COMPOFF' ? 'CO' : 'L', natural: false, note: leave.type === 'COMPOFF' ? 'Approved comp-off' : `Approved ${leave.type.toLowerCase()} leave` };
  }
  if ((emp.unavailable_dows || []).includes(dow(date))) return { status: 'WO', natural: true, note: 'Employee unavailable this weekday' };
  const procs = ix.procsOnDate(emp.id, date);
  const allClosed = procs.length === 0 ? dow(date) === 0 || ix.holidaySet.has(date) : procs.every((p) => ix.required(p, date) === 0);
  if (allClosed) {
    if (ix.holidaySet.has(date)) return { status: 'H', natural: true, note: ix.holidayName.get(date) };
    return { status: 'WO', natural: true, note: 'Assigned processes closed' };
  }
  return null;
}

/** Number of weekly offs an employee needs in a (possibly partial) week of `n` days of the month. */
export function offsNeeded(ix, emp, n) {
  const w = ix.offsPerWeek(emp);
  return n >= 7 ? w : Math.round((w * n) / 7);
}

export function assignedProcessCount(ix, procId) {
  return (ix.assignsByProc.get(procId) || []).length;
}

/**
 * Natural weekly offs that fall on days of the ISO week *outside* the month being planned
 * (e.g. the Sunday of 3 Jan when planning December's last, partial week). They still count
 * towards that week's weekly-off entitlement.
 */
export function outsideWeekNaturalOffs(ix, emp, wk) {
  const start = weekStart(wk[0]);
  let n = 0;
  for (let i = 0; i < 7; i++) {
    const d = addDays(start, i);
    if (wk.includes(d)) continue;
    const fx = fixedStatus(ix, emp, d);
    if (fx && fx.natural && fx.status === 'WO') n++;
  }
  return n;
}
