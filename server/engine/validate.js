// Roster validation: turns (master data + roster cells) into coverage figures and conflicts.
//
// Mandatory constraints (severity "error"): staffing minimums per process/day, leave, weekly-off entitlement,
// max consecutive working days, employee capacity, shift compatibility, configuration sanity.
// Preferences (severity "info", category "preference") never block publishing.
//
// Backups are *standby* resources: a backup only counts for a process on a day when the primaries are short
// AND the backup is working, shift-compatible and has spare capacity. That keeps "backup" meaningful.

import { monthDates, monthWeeks, horizonDates, horizonWeeks, fmt, dow, dowName } from './dates.js';
import { buildIndex, cellKey, fixedStatus, offsNeeded, outsideWeekNaturalOffs, shiftCompatible, STATUS_LABEL } from './rules.js';

const SEV_ORDER = { error: 0, warning: 1, info: 2 };

export function validateRoster(world, month, cells) {
  const ix = buildIndex(world);
  const S = ix.settings;
  const dates = monthDates(month);
  const conflicts = [];
  const coverage = {}; // procId -> { date: [required, [primary ids], [backup ids], missing] }
  const loadByDate = new Map();

  const hasMonthCells = cells && dates.some((d) => [...cells.values()].some((c) => c.date === d && c.source !== 'spill'));
  if (!hasMonthCells) {
    return { generated: false, conflicts: [], coverage: {}, stats: emptyStats(), employeeStats: {}, internal: { loadByDate } };
  }

  const statusOf = (e, d) => cells.get(cellKey(e, d))?.status ?? null;
  const nameOf = (id) => ix.empById.get(id)?.name ?? `#${id}`;
  const reasonFor = (e, d) => {
    const s = statusOf(e, d);
    if (s === null) return 'not on the roster';
    if (s === 'WO') return 'weekly off';
    if (s === 'H') return 'public holiday off';
    if (s === 'CO') return 'comp-off';
    if (s === 'L') return `on ${(ix.leaveOn(e, d)?.type || 'leave').toLowerCase()} leave`;
    return 'working';
  };
  const add = (c) => { c.id = c.id || `${c.type}|${c.process_id ?? ''}|${c.employee_id ?? ''}|${c.date ?? ''}`; c.category = c.category || 'mandatory'; conflicts.push(c); };

  // employees that have no roster cells at all (added after generation)
  for (const e of ix.employees) {
    if (!dates.some((d) => cells.has(cellKey(e.id, d)))) {
      add({ type: 'NOT_ROSTERED', severity: 'warning', employee_id: e.id, pod_id: e.pod_id, message: `${e.name} has no roster for ${month}. Use "Quick fix" or "Build schedule" to include them.` });
    }
  }

  let requiredDays = 0;
  let coveredDays = 0;

  for (const d of dates) {
    const load = new Map();
    const recs = [];
    for (const p of ix.activeProcesses) {
      const r = ix.required(p, d);
      if (r === 0) continue;
      const assigns = ix.assignsByProc.get(p.id) || [];
      const prim = assigns.filter((a) => a.role === 'primary').map((a) => a.employee_id);
      const covers = (ix.coversByProcDate.get(`${p.id}|${d}`) || []).filter((id) => ix.empById.get(id)?.active);
      const team = [...new Set([...prim, ...covers])];
      const workingPrim = team.filter((id) => statusOf(id, d) === 'W');
      for (const id of workingPrim) load.set(id, (load.get(id) || 0) + p.load);
      recs.push({ p, r, assigns, team, workingPrim, backup: [], skipped: [] });
    }
    // second phase: activate standby backups where primaries are short
    for (const rec of recs) {
      const { p, r } = rec;
      const deficit = r - rec.workingPrim.length;
      if (deficit <= 0) continue;
      const cands = [];
      for (const a of rec.assigns.filter((x) => x.role === 'backup')) {
        const b = ix.empById.get(a.employee_id);
        if (statusOf(b.id, d) !== 'W') { rec.skipped.push({ employee_id: b.id, role: 'backup', reason: reasonFor(b.id, d) }); continue; }
        if (!shiftCompatible(b.shift, p.shift)) { rec.skipped.push({ employee_id: b.id, role: 'backup', reason: `shift mismatch (${b.shift} vs ${p.shift})` }); continue; }
        if ((load.get(b.id) || 0) + p.load > ix.maxLoad(b)) { rec.skipped.push({ employee_id: b.id, role: 'backup', reason: 'already at capacity' }); continue; }
        cands.push(b);
      }
      cands.sort((x, y) => (load.get(x.id) || 0) - (load.get(y.id) || 0) || x.id - y.id);
      for (const b of cands.slice(0, deficit)) { rec.backup.push(b.id); load.set(b.id, (load.get(b.id) || 0) + p.load); }
    }
    loadByDate.set(d, load);

    for (const rec of recs) {
      const { p, r } = rec;
      const covered = rec.workingPrim.length + rec.backup.length;
      const missing = Math.max(0, r - covered);
      if (!coverage[p.id]) coverage[p.id] = {};
      coverage[p.id][d] = [r, rec.workingPrim, rec.backup, missing];
      requiredDays++;
      if (missing === 0) { coveredDays++; continue; }

      const brand = ix.brandById.get(p.brand_id);
      const reasons = [
        ...rec.team.filter((id) => !rec.workingPrim.includes(id)).map((id) => ({ employee_id: id, role: 'primary', reason: reasonFor(id, d) })),
        ...rec.skipped,
      ];
      const primaryIds = rec.assigns.filter((a) => a.role === 'primary').map((a) => a.employee_id);
      const hasBackup = rec.assigns.some((a) => a.role === 'backup');
      const causes = new Set(reasons.map((x) => x.reason));
      let cause = 'UNASSIGNED';
      if (reasons.length) cause = [...causes].every((c) => c === 'weekly off') ? 'WEEKLY_OFF' : [...causes].every((c) => c.includes('leave') || c === 'comp-off') ? 'LEAVE' : 'MIXED';
      const sole = primaryIds.length === 1;
      const who = reasons.map((x) => `${nameOf(x.employee_id)} (${x.reason})`).join(', ');
      const headline = covered === 0
        ? `${brand.name} › ${p.name} has nobody working on ${fmt(d)} (needs ${r}).`
        : `${brand.name} › ${p.name} is understaffed on ${fmt(d)}: ${covered} of ${r} required.`;
      add({
        type: covered === 0 ? 'COVERAGE_GAP' : 'UNDERSTAFFED', severity: 'error', date: d, process_id: p.id, brand_id: brand.id, pod_id: brand.pod_id,
        employee_ids: reasons.map((x) => x.employee_id), cause, sole_resource: sole && !hasBackup, has_backup: hasBackup, reasons,
        message: `${headline}${who ? ' Unavailable: ' + who + '.' : ' Nobody is assigned.'}${sole && !hasBackup ? ' They are the only person on this and no backup is set up.' : ''}`,
      });
    }

    for (const [id, l] of load) {
      const e = ix.empById.get(id);
      if (l > ix.maxLoad(e)) add({ type: 'OVERLOAD', severity: 'error', date: d, employee_id: id, pod_id: e.pod_id, message: `${e.name} is carrying ${l} load points on ${fmt(d)} (capacity ${ix.maxLoad(e)}). Overlapping responsibilities across brands need re-balancing.` });
    }
  }

  // ── per employee rules ───────────────────────────────────────────────────────
  const weeks = monthWeeks(month);
  const hweeks = horizonWeeks(month);
  const hdates = horizonDates(month);
  const employeeStats = {};
  for (const e of ix.employees) {
    const st = { W: 0, WO: 0, H: 0, L: 0, CO: 0, weekend_offs: 0, worked_holidays: 0, compoff_due: 0 };
    employeeStats[e.id] = st;
    if (!dates.some((d) => cells.has(cellKey(e.id, d)))) continue;

    // leave violations & counts
    for (const d of dates) {
      const c = cells.get(cellKey(e.id, d));
      if (!c) continue;
      st[c.status]++;
      if (c.status === 'WO' && (dow(d) === 0 || dow(d) === 6)) st.weekend_offs++;
      if (c.status === 'W' && ix.holidaySet.has(d)) st.worked_holidays++;
      if (c.compoff_due) st.compoff_due++;
      const leave = ix.leaveOn(e.id, d);
      if (c.status === 'W' && leave) add({ type: 'LEAVE_VIOLATION', severity: 'error', date: d, employee_id: e.id, pod_id: e.pod_id, message: `${e.name} is rostered to work on ${fmt(d)} but has approved ${leave.type.toLowerCase()} leave.` });
    }

    // weekly-off entitlement (whole Monday-Sunday weeks; falls back to the in-month part if the neighbour month has no roster yet)
    for (const wk of hweeks) {
      const full = wk.every((d) => cells.has(cellKey(e.id, d)));
      const days = full ? wk : wk.filter((d) => dates.includes(d));
      if (!days.some((d) => dates.includes(d))) continue;
      let need = full ? ix.offsPerWeek(e) : offsNeeded(ix, e, days.length);
      const leaveDays = days.filter((d) => ['L', 'CO'].includes(statusOf(e.id, d))).length;
      if (leaveDays >= S.leave_waiver_days) need -= 1;
      const have = days.filter((d) => statusOf(e.id, d) === 'WO').length + (full ? 0 : outsideWeekNaturalOffs(ix, e, days));
      if (have < need) add({ type: 'WEEKLY_OFF_SHORT', severity: 'error', date: wk[0], employee_id: e.id, pod_id: e.pod_id, message: `${e.name} has ${have} weekly off(s) in the week of ${fmt(wk[0])} but is entitled to ${need}.` });
    }

    // max consecutive working days
    let run = 0; let start = null;
    for (const d of hdates) {
      if (statusOf(e.id, d) === 'W') { if (run === 0) start = d; run++; if (run === S.max_consecutive_work + 1 && dates.includes(d)) add({ type: 'CONSECUTIVE_WORK', severity: 'error', date: start, employee_id: e.id, pod_id: e.pod_id, message: `${e.name} works more than ${S.max_consecutive_work} days in a row starting ${fmt(start)}.` }); }
      else run = 0;
    }

    // preferences (soft)
    const pref = e.preferred_off_days || [];
    if (pref.length) {
      for (const wk of weeks) {
        const chosen = wk.filter((d) => statusOf(e.id, d) === 'WO' && !fixedStatus(ix, e, d));
        if (chosen.length && !chosen.some((d) => pref.includes(dow(d)))) {
          add({ type: 'PREFERENCE', severity: 'info', category: 'preference', date: wk[0], employee_id: e.id, pod_id: e.pod_id, message: `${e.name} prefers ${pref.map(dowName).join('/')} off but got ${chosen.map(fmt).join(', ')} (week of ${fmt(wk[0])}) - coverage took priority.` });
        }
      }
    }
  }

  // ── configuration sanity ─────────────────────────────────────────────────────
  for (const p of ix.activeProcesses) {
    const brand = ix.brandById.get(p.brand_id);
    const maxReq = Math.max(0, ...dates.map((d) => ix.required(p, d)));
    if (maxReq === 0) continue;
    const assigned = new Set((ix.assignsByProc.get(p.id) || []).map((a) => a.employee_id));
    if (assigned.size === 0) add({ type: 'NO_STAFF', severity: 'error', process_id: p.id, brand_id: brand.id, pod_id: brand.pod_id, message: `${brand.name} › ${p.name} operates but has nobody assigned.` });
    else if (assigned.size < maxReq) add({ type: 'INSUFFICIENT_HEADCOUNT', severity: 'error', process_id: p.id, brand_id: brand.id, pod_id: brand.pod_id, message: `${brand.name} › ${p.name} needs ${maxReq} people on some days but only ${assigned.size} are assigned.` });
  }
  for (const e of ix.employees) {
    const asg = ix.assignsByEmp.get(e.id) || [];
    const prim = asg.filter((a) => a.role === 'primary').map((a) => ix.procById.get(a.process_id));
    const shifts = [...new Set(prim.map((p) => p.shift).filter((s) => s !== 'FLEX'))];
    if (shifts.length > 1) add({ type: 'SHIFT_CONFLICT', severity: 'error', employee_id: e.id, pod_id: e.pod_id, message: `${e.name} is primary on processes with incompatible shifts (${shifts.join(' + ')}).` });
    const mismatch = asg.map((a) => ix.procById.get(a.process_id)).filter((p) => e.shift !== 'FLEX' && p.shift !== 'FLEX' && e.shift !== p.shift);
    if (mismatch.length) add({ type: 'SHIFT_MISMATCH', severity: 'warning', employee_id: e.id, pod_id: e.pod_id, message: `${e.name} works ${e.shift} shift but is assigned to ${mismatch.map((p) => `${ix.brandById.get(p.brand_id).name} › ${p.name} (${p.shift})`).join(', ')}.` });
  }

  conflicts.sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity] || (a.date || '').localeCompare(b.date || '') || a.message.localeCompare(b.message));

  const stats = {
    required_slots: requiredDays,
    covered_slots: coveredDays,
    coverage_pct: requiredDays ? Math.round((coveredDays / requiredDays) * 1000) / 10 : 100,
    errors: conflicts.filter((c) => c.severity === 'error').length,
    warnings: conflicts.filter((c) => c.severity === 'warning').length,
    preferences: conflicts.filter((c) => c.category === 'preference').length,
  };
  return { generated: true, conflicts, coverage, stats, employeeStats, internal: { loadByDate } };
}

function emptyStats() {
  return { required_slots: 0, covered_slots: 0, coverage_pct: 0, errors: 0, warnings: 0, preferences: 0 };
}

/** Compare two conflict lists by id: what did a change introduce / resolve? */
export function diffConflicts(before, after) {
  const mand = (list) => list.filter((c) => c.category === 'mandatory');
  const b = new Map(mand(before).map((c) => [c.id, c]));
  const a = new Map(mand(after).map((c) => [c.id, c]));
  return {
    introduced: [...a.values()].filter((c) => !b.has(c.id)),
    resolved: [...b.values()].filter((c) => !a.has(c.id)),
  };
}

export { STATUS_LABEL };
