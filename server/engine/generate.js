// Roster generation.
//
// Approach (deterministic, explainable, no black box):
//  1. Lock in everything that is NOT a choice: approved leave / comp-off, employee-unavailable weekdays,
//     "natural" offs (every process the employee handles is closed that day, e.g. Sundays for a
//     Sunday-off brand, public holidays for a holiday-off brand) and any manual edits we were told to keep.
//  2. For each Monday-based week, every employee still owes N weekly offs. We choose WHICH day greedily,
//     scoring each candidate day:
//        + huge penalty if the off would drop a process below its required staffing (mandatory constraint)
//        + small penalty for eating into slack (prefer days where there is spare cover)
//        - bonus for the employee's preferred off days (soft preference, always loses to coverage)
//        + fairness / spread terms (weekend offs shared out, offs not stacked on one date)
//        + hard penalty for breaking the max-consecutive-working-days rule
//        - stability bonus for keeping the previous roster's choice (this is what makes "repair" minimal)
//     Tightest employees (sole resources of 7-day processes) are placed first.
//  3. Repair pass: for any remaining shortfall, try moving a weekly off within its week to a day that
//     does not create a new shortfall. Whatever cannot be fixed automatically is left as a visible gap -
//     the validator flags it and the suggestion engine proposes human-approved fixes.

import { monthDates, horizonDates, horizonWeeks, dow, diffDays, addDays, weekStart } from './dates.js';
import { buildIndex, fixedStatus, cellKey } from './rules.js';

const HUGE = 1000;

/** Planning strategies: coverage always dominates (HUGE); these only shift the soft trade-offs. */
export const STRATEGIES = {
  balanced: { label: 'Balanced', blurb: 'Default: coverage first, then a sensible mix of preferences and fairness.', w: { pref: 1, fair: 1, spread: 1 } },
  preferences: { label: 'Preference-first', blurb: 'Grants as many preferred weekly-off days as coverage allows.', w: { pref: 3, fair: 0.5, spread: 0.5 } },
  fairness: { label: 'Fairness-first', blurb: 'Spreads weekend offs evenly across people and dates.', w: { pref: 0.2, fair: 8, spread: 3 } },
};

export function generateRoster(world, month, { existing = null, keepManual = false, previous = null, strategy = 'balanced' } = {}) {
  const W = (STRATEGIES[strategy] || STRATEGIES.balanced).w;
  const ix = buildIndex(world);
  const S = ix.settings;
  // Plan whole Monday-Sunday weeks: the horizon extends into neighbouring months so a weekly off that
  // belongs to a boundary week can land on the other side of the boundary.
  const dates = horizonDates(month);
  const inMonth = new Set(monthDates(month));
  const weeks = horizonWeeks(month);
  const emps = ix.employees;
  const cells = new Map();
  const natural = new Set();
  const pendingChosen = [];
  const chosen = new Set(); // keys of weekly-offs picked by the optimiser (movable)

  // ── 1. fixed statuses ────────────────────────────────────────────────────────
  for (const e of emps) {
    for (const d of dates) {
      const k = cellKey(e.id, d);
      const leave = ix.leaveOn(e.id, d);
      const old = existing?.get(k);
      if (!inMonth.has(d) && old && old.source !== 'spill') {
        cells.set(k, { ...old, pinned: true }); // the neighbouring month already decided this day
        continue;
      }
      if (leave) {
        cells.set(k, { employee_id: e.id, date: d, status: leave.type === 'COMPOFF' ? 'CO' : 'L', source: 'auto', note: leave.type === 'COMPOFF' ? 'Approved comp-off' : `Approved ${leave.type.toLowerCase()} leave`, compoff_due: 0 });
        continue;
      }
      if (inMonth.has(d) && old && old.source === 'spill') {
        cells.set(k, { ...old, source: 'auto' }); // honour the decision the previous/next month's plan already made
        continue;
      }
      if (keepManual && old && old.source === 'manual') {
        cells.set(k, { ...old });
        continue;
      }
      const prevOff = previous?.get(k);
      if (inMonth.has(d) && prevOff && prevOff.status === 'WO' && prevOff.source === 'auto' && !fixedStatus(ix, e, d)) {
        // repair: carry the existing weekly off over untouched; the shortfall pass below may still move it
        cells.set(k, { employee_id: e.id, date: d, status: 'WO', source: 'auto', note: prevOff.note || 'Weekly off', compoff_due: 0 });
        pendingChosen.push(k);
        continue;
      }
      const fx = fixedStatus(ix, e, d);
      if (fx) {
        cells.set(k, { employee_id: e.id, date: d, status: fx.status, source: 'auto', note: fx.note || '', compoff_due: 0 });
        if (fx.natural) natural.add(k);
      }
    }
  }

  for (const k of pendingChosen) chosen.add(k);
  // ── coverage bookkeeping (everyone not yet off counts as available) ──────────
  const cov = new Map(); // `${procId}|${date}` -> available head-count
  const covKey = (p, d) => `${p}|${d}`;
  const isOff = (k) => { const c = cells.get(k); return c && c.status !== 'W'; };
  for (const e of emps) {
    for (const d of dates) {
      if (isOff(cellKey(e.id, d))) continue;
      for (const p of ix.procsOnDate(e.id, d)) {
        if (ix.required(p, d) > 0) cov.set(covKey(p.id, d), (cov.get(covKey(p.id, d)) || 0) + 1);
      }
    }
  }
  const markOff = (e, d) => { for (const p of ix.procsOnDate(e.id, d)) if (ix.required(p, d) > 0) cov.set(covKey(p.id, d), (cov.get(covKey(p.id, d)) || 0) - 1); };
  const unmarkOff = (e, d) => { for (const p of ix.procsOnDate(e.id, d)) if (ix.required(p, d) > 0) cov.set(covKey(p.id, d), (cov.get(covKey(p.id, d)) || 0) + 1); };

  // per-date and per-employee trackers
  const offOnDate = new Map();
  for (const e of emps) for (const d of dates) { if (isOff(cellKey(e.id, d)) && !natural.has(cellKey(e.id, d))) offOnDate.set(d, (offOnDate.get(d) || 0) + 1); }
  const weekendOffs = new Map(emps.map((e) => [e.id, 0]));
  const lastOffDow = new Map();
  const lastOffPos = new Map(); // weekday position (0=Mon..6=Sun) of the previous week's chosen off

  // streak helper: working days between nearest non-working neighbours around d
  const nonWorking = (e, d) => { const c = cells.get(cellKey(e.id, d)); return !!c && c.status !== 'W'; };
  const streakIfOff = (e, d) => {
    // days worked immediately before d
    let before = 0; let x = addDays(d, -1);
    while (x >= dates[0] && !nonWorking(e, x)) { before++; x = addDays(x, -1); }
    if (x < dates[0]) before += 0; // unknown previous month: assume the streak starts at month start
    // forward run only counts if it is bounded by an already-fixed day off (leave etc.); undecided future days are unknown
    // Only a bounding day inside THIS week is trusted: a far-away fixed off (e.g. a holiday weeks later) does not
    // bound the run, because the weekly offs of the weeks in between are not placed yet and will break it.
    let after = 0; x = addDays(d, 1);
    const weekEnd = addDays(weekStart(d), 6);
    while (x <= weekEnd && !nonWorking(e, x)) { after++; x = addDays(x, 1); }
    if (x > weekEnd) after = 0;
    return Math.max(before, after);
  };

  const hashPart = (e, d) => ((e.id * 31 + diffDays(dates[0], d) * 17) % 13) * 0.01;

  function score(e, d, procs) {
    let s = 0;
    for (const p of procs) {
      const r = ix.required(p, d);
      if (r === 0) continue;
      const c = cov.get(covKey(p.id, d)) || 0; // includes e
      const after = c - 1;
      if (after < r) s += HUGE * ((r - after) - Math.max(0, r - c));
      else s += 30 / (after - r + 1);
    }
    const pref = e.preferred_off_days || [];
    if (pref.includes(dow(d))) s -= 40 * W.pref;
    if (dow(d) === 0 || dow(d) === 6) s += 20 * W.fair * weekendOffs.get(e.id);
    if (lastOffDow.get(e.id) === dow(d)) s -= 8;
    // With a 6-day work limit the weekly off can only drift EARLIER week over week, never later, so
    // starting the week early would force that employee onto early-week offs (and expose more processes) for good.
    const kept = previous?.get(cellKey(e.id, d));
    const keepsPrevious = kept?.status === 'WO' && kept.source === 'auto';
    if (!keepsPrevious) { // when repairing, trust the existing plan instead of re-optimising the position
      const pos = (dow(d) + 6) % 7;
      const last = lastOffPos.get(e.id);
      if (last !== undefined && pos < last) s += 400 * (last - pos);
      s += 4 * (6 - pos);
    }
    if (previous?.get(cellKey(e.id, d))?.status === 'WO' && previous.get(cellKey(e.id, d)).source === 'auto') s -= 200;
    s += 3 * W.spread * (offOnDate.get(d) || 0);
    if (streakIfOff(e, d) > S.max_consecutive_work) s += 5000; // labour rule: stronger than any coverage shortfall
    s += hashPart(e, d);
    return s;
  }

  function placeOff(e, d, why = '') {
    const k = cellKey(e.id, d);
    markOff(e, d);
    cells.set(k, { employee_id: e.id, date: d, status: 'WO', source: 'auto', note: why, compoff_due: 0 });
    chosen.add(k);
    offOnDate.set(d, (offOnDate.get(d) || 0) + 1);
    if (dow(d) === 0 || dow(d) === 6) weekendOffs.set(e.id, weekendOffs.get(e.id) + 1);
    lastOffDow.set(e.id, dow(d));
    lastOffPos.set(e.id, (dow(d) + 6) % 7);
  }

  // ── 2. weekly offs, week by week ─────────────────────────────────────────────
  const staffRatio = (e) => {
    const procs = (ix.assignsByEmp.get(e.id) || []).map((a) => ix.procById.get(a.process_id));
    if (!procs.length) return Infinity;
    return Math.min(...procs.map((p) => (ix.assignsByProc.get(p.id) || []).length / Math.max(1, p.min_staff)));
  };

  for (const wk of weeks) {
    const jobs = [];
    for (const e of emps) {
      let need = ix.offsPerWeek(e);
      const have = wk.filter((d) => cells.get(cellKey(e.id, d))?.status === 'WO').length;
      const leaveDays = wk.filter((d) => ['L', 'CO'].includes(cells.get(cellKey(e.id, d))?.status)).length;
      need -= have;
      if (leaveDays >= S.leave_waiver_days) need -= 1;
      const cands = wk.filter((d) => !cells.has(cellKey(e.id, d)));
      need = Math.max(0, Math.min(need, cands.length));
      if (need > 0) jobs.push({ e, need, tight: staffRatio(e) });
    }
    jobs.sort((a, b) => a.tight - b.tight || a.e.id - b.e.id);
    for (const job of jobs) {
      for (let i = 0; i < job.need; i++) {
        const cands = wk.filter((d) => !cells.has(cellKey(job.e.id, d)));
        let best = null;
        for (const d of cands) {
          const sc = score(job.e, d, ix.procsOnDate(job.e.id, d));
          if (!best || sc < best.sc) best = { d, sc };
        }
        if (best) placeOff(job.e, best.d, 'Weekly off');
      }
    }
  }

  // ── 3. repair pass: move weekly offs within their week to remove shortfalls ──
  const moves = [];
  const shortfalls = () => {
    const out = [];
    for (const p of ix.activeProcesses) for (const d of dates) {
      const r = ix.required(p, d);
      if (r > 0 && (cov.get(covKey(p.id, d)) || 0) < r) out.push({ p, d });
    }
    return out;
  };
  const weekOf = (d) => weeks.find((w) => w.includes(d));

  for (let pass = 0; pass < 4; pass++) {
    let progress = false;
    for (const { p, d } of shortfalls()) {
      if ((cov.get(covKey(p.id, d)) || 0) >= ix.required(p, d)) continue;
      const staff = (ix.assignsByProc.get(p.id) || []).map((a) => ix.empById.get(a.employee_id));
      for (const e of staff) {
        const k = cellKey(e.id, d);
        if (!chosen.has(k)) continue; // only optimiser-chosen offs are movable
        for (const d2 of weekOf(d)) {
          if (d2 === d || cells.has(cellKey(e.id, d2))) continue;
          const procs2 = ix.procsOnDate(e.id, d2);
          const ok = procs2.every((q) => { const r = ix.required(q, d2); return r === 0 || (cov.get(covKey(q.id, d2)) || 0) - 1 >= r; });
          if (!ok) continue;
          // streak guard (evaluated with the old off removed)
          const orig = cells.get(k);
          cells.delete(k);
          if (streakIfOff(e, d2) > S.max_consecutive_work) { cells.set(k, orig); continue; }
          unmarkOff(e, d); chosen.delete(k);
          offOnDate.set(d, (offOnDate.get(d) || 1) - 1);
          if (dow(d) === 0 || dow(d) === 6) weekendOffs.set(e.id, weekendOffs.get(e.id) - 1);
          placeOff(e, d2, 'Weekly off (moved to keep coverage)');
          moves.push({ employee_id: e.id, from: d, to: d2, process_id: p.id });
          progress = true;
          break;
        }
        if ((cov.get(covKey(p.id, d)) || 0) >= ix.required(p, d)) break;
      }
    }
    if (!progress) break;
  }

  // ── 4. everyone else works ───────────────────────────────────────────────────
  for (const e of emps) for (const d of dates) {
    const k = cellKey(e.id, d);
    if (!cells.has(k)) cells.set(k, { employee_id: e.id, date: d, status: 'W', source: 'auto', note: '', compoff_due: 0 });
  }
  // cells outside the month are only *spill* (planned on behalf of the neighbour); pinned ones are not ours to write
  for (const [k, c] of [...cells]) {
    if (!inMonth.has(c.date)) { if (c.pinned) cells.delete(k); else c.source = 'spill'; }
  }
  // comp-off credit: worked on a public holiday
  for (const c of cells.values()) if (c.status === 'W' && ix.holidaySet.has(c.date) && c.source === 'auto') c.note = c.note || 'Worked public holiday';

  return { cells, moves };
}

/** Cells whose status differs between two rosters (for "what did the repair touch?") */
export function diffCells(before, after) {
  const out = [];
  for (const [k, c] of after) {
    const b = before?.get(k);
    if (!b || b.status !== c.status) out.push({ employee_id: c.employee_id, date: c.date, from: b?.status ?? null, to: c.status });
  }
  return out;
}
