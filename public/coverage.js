import { S, esc, $, $$, ix, rdata, fmtDate, monthDates, dowOf, procLabel, empName, calendarLabel, openModal, STATUS } from './core.js';
import { conflictCard, bindConflictActions } from './components.js';

/** One heat-map cell: "working / required" for a process on a date */
export function covCell(pid, d, extra = '') {
  const rec = S.roster.coverage[pid]?.[d];
  if (!rec) return `<td class="cv closed" title="Process closed">–</td>`;
  const [req, prim, back, missing] = rec;
  const have = prim.length + back.length;
  const cls = missing === 0 ? (back.length ? 'ok bk' : 'ok') : have === 0 ? 'gap' : 'short';
  const tip = `${procLabel(ix().proc.get(pid))} · ${fmtDate(d)}: ${have}/${req}${back.length ? ' (standby backup active)' : ''}`;
  return `<td class="cv ${cls} ${extra}" data-p="${pid}" data-d="${d}" title="${esc(tip)}">${have}/${req}${back.length ? '*' : ''}</td>`;
}

export function bindCoverageClicks(root) {
  $$('td.cv[data-p]', root).forEach((td) => { td.onclick = () => openCoverageDetail(Number(td.dataset.p), td.dataset.d); });
}

export function openCoverageDetail(pid, date) {
  const c = ix(); const p = c.proc.get(pid); const rec = S.roster.coverage[pid]?.[date];
  const cells = rdata().cells;
  const team = (c.asgByProc.get(pid) || []);
  const rows = team.map((a) => {
    const s = cells.get(`${a.employee_id}|${date}`)?.s;
    let state;
    if (!rec) state = '—';
    else if (rec[1].includes(a.employee_id)) state = '<span class="badge ok">working</span>';
    else if (rec[2].includes(a.employee_id)) state = '<span class="badge ok">standby backup activated</span>';
    else if (s === 'W') state = a.role === 'backup' ? '<span class="badge">standby, not needed</span>' : '<span class="badge warn">working (not counted)</span>';
    else state = `<span class="badge err">${esc(STATUS[s] || 'not on schedule')}</span>`;
    return `<tr><td>${esc(empName(a.employee_id))}</td><td><span class="tag ${a.role}">${a.role}</span></td><td>${state}</td></tr>`;
  }).join('');
  const gap = rdata().gapsByProcDate.get(`${pid}|${date}`);
  const m = openModal({
    wide: true, title: `${procLabel(p)} · ${fmtDate(date)}`,
    body: `<div class="row small muted"><span>Calendar: <b>${esc(calendarLabel(p))}</b></span><span>Shift: <b>${p.shift}</b></span><span>Required: <b>${rec ? rec[0] : 0}</b></span>${S.world.holidays.some((h) => h.date === date) ? '<span class="badge info">public holiday</span>' : ''}</div>
      <table class="t" style="margin:10px 0"><thead><tr><th>Assigned</th><th>Role</th><th>On ${fmtDate(date)}</th></tr></thead><tbody>${rows || '<tr><td colspan="3" class="muted">Nobody assigned to this process</td></tr>'}</tbody></table>
      ${gap ? conflictCard(gap) : '<div class="badge ok">Requirement met</div>'}`,
  });
  bindConflictActions(m.el);
}

export function renderCoverage(root) {
  const r = S.roster; const c = ix();
  if (!r.generated) { root.innerHTML = '<div class="card empty">Build the schedule first.</div>'; return; }
  const st = S.coverageFilter || (S.coverageFilter = { pod: '', onlyProblems: false });
  const dates = monthDates(S.month);
  const brands = S.world.brands.filter((b) => b.active && (!st.pod || String(b.pod_id) === st.pod));
  let body = '';
  for (const b of brands) {
    const procs = (c.procsByBrand.get(b.id) || []).filter((p) => p.active && r.coverage[p.id]);
    const rowsHtml = procs.filter((p) => !st.onlyProblems || dates.some((d) => r.coverage[p.id][d]?.[3] > 0)).map((p) => `<tr><td class="name">${esc(p.name)} <span class="muted small">${esc(calendarLabel(p))} · ${p.shift}</span></td>${dates.map((d) => covCell(p.id, d)).join('')}</tr>`).join('');
    if (!rowsHtml) continue;
    const info = (S.brandInfo ? S.brandInfo(b.id) : null);
    body += `<tr class="podrow"><td colspan="${dates.length + 1}">${esc(b.name)} <span class="muted small">· ${esc(c.pod.get(b.pod_id)?.name || '')}</span></td></tr>${rowsHtml}`;
  }
  root.innerHTML = `<div class="card"><div class="row"><h2 style="margin:0">Staffing by day</h2><span class="spacer"></span>
    <label style="margin:0">Pod <select id="cvPod"><option value="">All</option>${S.world.pods.map((p) => `<option value="${p.id}" ${st.pod === String(p.id) ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
    <label style="margin:0"><input type="checkbox" id="cvProb" ${st.onlyProblems ? 'checked' : ''}/> only processes with gaps</label></div>
    <div class="legend"><span><span class="sw" style="background:var(--ok-bg)"></span>covered (working/required)</span><span><span class="sw" style="background:#bfe9d6;box-shadow:inset 0 0 0 2px #46b58b"></span>covered by standby backup (*)</span><span><span class="sw" style="background:#fbd78a"></span>understaffed</span><span><span class="sw" style="background:#f6a79f"></span>no coverage</span><span><span class="sw" style="background:#f3f4f8"></span>process closed that day</span><span class="muted">Click any cell for details and fixes.</span></div>
    <div class="gridwrap"><table class="g"><thead><tr><th class="name">Process</th>${dates.map((d) => `<th class="${dowOf(d) === 0 ? 'sun' : ''} ${c.holidays.has(d) ? 'hol' : ''}" title="${esc(c.holidays.get(d) || '')}">${Number(d.slice(8))}<small>${['S', 'M', 'T', 'W', 'T', 'F', 'S'][dowOf(d)]}</small></th>`).join('')}</tr></thead><tbody>${body || `<tr><td colspan="${dates.length + 1}" class="empty">Nothing to show</td></tr>`}</tbody></table></div></div>`;
  $('#cvPod', root).onchange = (e) => { st.pod = e.target.value; renderCoverage(root); };
  $('#cvProb', root).onchange = (e) => { st.onlyProblems = e.target.checked; renderCoverage(root); };
  bindCoverageClicks(root);
}
