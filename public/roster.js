import { S, esc, $, $$, api, ix, rdata, fmtDate, monthDates, dowOf, DOW, STATUS, procLabel, empName, calendarLabel, openModal, toast, setRoster, run, summarizeDiff } from './core.js';
import { covCell, bindCoverageClicks } from './coverage.js';
import { TYPE_LABEL } from './components.js';

const CODE = { W: '·', WO: 'Off', H: 'Hol', L: 'Lv', CO: 'Comp' };

function staffOf(procs) {
  const c = ix(); const seen = new Map();
  for (const p of procs) for (const a of c.asgByProc.get(p.id) || []) {
    const cur = seen.get(a.employee_id);
    if (!cur || (cur.role === 'backup' && a.role === 'primary')) seen.set(a.employee_id, { emp: c.emp.get(a.employee_id), role: a.role });
  }
  return [...seen.values()].filter((x) => x.emp?.active).sort((a, b) => (a.role === b.role ? 0 : a.role === 'primary' ? -1 : 1) || a.emp.id - b.emp.id);
}

function asgSummary(empId) {
  const c = ix();
  const byBrand = new Map();
  for (const a of c.asgByEmp.get(empId) || []) {
    const p = c.proc.get(a.process_id); if (!p) continue;
    const b = c.brand.get(p.brand_id);
    if (!byBrand.has(b.name)) byBrand.set(b.name, []);
    byBrand.get(b.name).push(p.name + (a.role === 'backup' ? '*' : ''));
  }
  return [...byBrand].map(([b, ps]) => `${b} (${ps.join('/')})`).join(', ');
}

function headerCells(dates) {
  const c = ix();
  return dates.map((d) => `<th class="${dowOf(d) === 0 ? 'sun' : ''} ${c.holidays.has(d) ? 'hol' : ''}" title="${esc(c.holidays.get(d) || fmtDate(d))}">${Number(d.slice(8))}<small>${['S', 'M', 'T', 'W', 'T', 'F', 'S'][dowOf(d)]}</small></th>`).join('');
}

function empRow(emp, dates, roleTag = '') {
  const { cells, gapCause } = rdata();
  const tds = dates.map((d) => {
    const x = cells.get(`${emp.id}|${d}`);
    if (!x) return `<td class="c ${dowOf(d) === 0 ? 'sun' : ''}" data-e="${emp.id}" data-d="${d}">?</td>`;
    const cls = ['c', x.s, dowOf(d) === 0 ? 'sun' : '', x.manual ? 'manual' : '', x.comp ? 'compoff' : '', gapCause.has(`${emp.id}|${d}`) ? 'gapcause' : ''].join(' ');
    return `<td class="${cls}" data-e="${emp.id}" data-d="${d}" title="${esc(`${emp.name} · ${fmtDate(d)} · ${STATUS[x.s]}${x.note ? ' · ' + x.note : ''}${x.manual ? ' (manual edit)' : ''}`)}">${CODE[x.s]}</td>`;
  }).join('');
  const pod = ix().pod.get(emp.pod_id);
  return `<tr><td class="name" title="${esc(emp.name)}">${esc(emp.name)} ${roleTag}${emp.role === 'pod_lead' ? ' <span class="badge accent">lead</span>' : ''}</td><td class="asg" title="${esc(asgSummary(emp.id))}">${esc(asgSummary(emp.id))}</td>${tds}</tr>`;
}

function covRows(procs, dates) {
  return procs.filter((p) => p.active).map((p) => `<tr class="cvrow"><td class="name" colspan="2"><b>${esc(procLabel(p))}</b> <span class="muted small">${esc(calendarLabel(p))}</span></td>${dates.map((d) => covCell(p.id, d)).join('')}</tr>`).join('');
}

function gridHtml({ groups, procs = [], summary = false }) {
  const dates = monthDates(S.month);
  const sections = groups.map((g) => `${g.title ? `<tr class="podrow"><td colspan="${dates.length + 2}">${g.title}</td></tr>` : ''}${g.emps.map((x) => empRow(x.emp, dates, x.role === 'backup' ? '<span class="tag backup">backup</span>' : '')).join('')}`).join('');
  let sum = '';
  if (summary) {
    const { cells } = rdata();
    const all = groups.flatMap((g) => g.emps.map((x) => x.emp));
    const working = dates.map((d) => all.filter((e) => cells.get(`${e.id}|${d}`)?.s === 'W').length);
    const gaps = dates.map((d) => Object.values(S.roster.coverage).filter((m) => m[d]?.[3] > 0).length);
    sum = `<tr class="sumrow"><td class="name" colspan="2" style="text-align:left">Working</td>${working.map((n) => `<td>${n}</td>`).join('')}</tr><tr class="sumrow"><td class="name" colspan="2" style="text-align:left">Processes short</td>${gaps.map((n) => `<td style="${n ? 'background:#fde0dc;color:#b42318' : ''}">${n || ''}</td>`).join('')}</tr>`;
  }
  return `<div class="gridwrap"><table class="g"><thead><tr><th class="name">Employee</th><th class="asg" style="background:var(--panel2);position:sticky;top:0;z-index:3">Handles</th>${headerCells(dates)}</tr></thead><tbody>${covRows(procs, dates)}${sections}${sum}</tbody></table></div>`;
}

const LEGEND = `<div class="legend"><span><span class="sw" style="background:var(--W)"></span>Working</span><span><span class="sw" style="background:var(--WO)"></span>Off - weekly day off</span><span><span class="sw" style="background:var(--H)"></span>Hol - public holiday</span><span><span class="sw" style="background:var(--L)"></span>Lv - on leave</span><span><span class="sw" style="background:var(--CO)"></span>Comp - day off in return for extra work</span><span><span class="sw" style="box-shadow:inset 0 0 0 2px #e5483b"></span>absence leaves a shift with nobody</span><span><span class="sw" style="background:#fff;position:relative"><i style="position:absolute;top:2px;right:2px;width:5px;height:5px;border-radius:50%;background:var(--accent)"></i></span>manual edit</span><span class="muted">Click any day to change it. * marks a backup standing in.</span></div>`;

export function renderRoster(root) {
  const r = S.roster; const c = ix();
  if (!r.generated) { root.innerHTML = '<div class="card empty"><h3>No roster for this month yet</h3><p>Use <b>Generate roster</b> in the top bar.</p></div>'; return; }
  const v = S.rosterView;
  const kinds = [['company', 'Company'], ['pod', 'Pod'], ['brand', 'Brand'], ['process', 'Process'], ['employee', 'Employee']];
  const opts = {
    pod: S.world.pods.map((p) => [p.id, p.name]),
    brand: S.world.brands.filter((b) => b.active).map((b) => [b.id, b.name]),
    process: S.world.processes.filter((p) => p.active).map((p) => [p.id, procLabel(p)]),
    employee: S.world.employees.filter((e) => e.active).map((e) => [e.id, e.name]),
  };
  if (v.kind !== 'company' && !opts[v.kind].some(([id]) => id === v.id)) v.id = opts[v.kind][0]?.[0] ?? null;

  let body = '';
  if (v.kind === 'company') {
    const groups = S.world.pods.map((p) => ({ title: `${esc(p.name)} <span class="muted small">· lead ${esc(c.emp.get(p.lead_id)?.name || '—')}</span>`, emps: S.world.employees.filter((e) => e.active && e.pod_id === p.id).map((emp) => ({ emp })) }));
    const unassigned = S.world.employees.filter((e) => e.active && !c.pod.has(e.pod_id));
    if (unassigned.length) groups.push({ title: 'No pod', emps: unassigned.map((emp) => ({ emp })) });
    body = gridHtml({ groups, summary: true });
  } else if (v.kind === 'pod') {
    const pod = c.pod.get(v.id);
    const brands = S.world.brands.filter((b) => b.active && b.pod_id === v.id);
    const procs = brands.flatMap((b) => c.procsByBrand.get(b.id) || []);
    body = `<p class="muted">Lead: <b>${esc(c.emp.get(pod?.lead_id)?.name || '—')}</b> · ${brands.length} brands · coverage of every process owned by this pod is shown above the team.</p>` +
      gridHtml({ groups: [{ title: '', emps: S.world.employees.filter((e) => e.active && e.pod_id === v.id).map((emp) => ({ emp })) }], procs });
  } else if (v.kind === 'brand') {
    const procs = c.procsByBrand.get(v.id) || [];
    const b = c.brand.get(v.id);
    body = `<p class="muted">${esc(b?.notes || '')}</p>` + gridHtml({ groups: [{ title: '', emps: staffOf(procs) }], procs });
  } else if (v.kind === 'process') {
    const p = c.proc.get(v.id);
    body = `<p class="muted">Operating calendar: <b>${esc(calendarLabel(p))}</b> · shift ${p.shift} · minimum ${p.min_staff}${Object.keys(p.min_staff_by_dow || {}).length ? ' (higher on ' + Object.entries(p.min_staff_by_dow).map(([d, n]) => `${DOW[d]}: ${n}`).join(', ') + ')' : ''}</p>` + gridHtml({ groups: [{ title: '', emps: staffOf([p]) }], procs: [p] });
  } else if (v.kind === 'employee') {
    body = employeeView(c.emp.get(v.id));
  }

  root.innerHTML = `<div class="card"><div class="row"><div class="seg" id="kindSeg">${kinds.map(([k, l]) => `<button data-k="${k}" class="${v.kind === k ? 'active' : ''}">${l}</button>`).join('')}</div>
    ${v.kind !== 'company' ? `<select id="viewId">${opts[v.kind].map(([id, l]) => `<option value="${id}" ${id === v.id ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>` : ''}
    <span class="spacer"></span><a href="/api/roster/export.csv?month=${S.month}" download><button class="small">&#8681; Export CSV</button></a></div>
    ${LEGEND}${body}</div>`;
  $$('#kindSeg button', root).forEach((b) => { b.onclick = () => { S.rosterView = { kind: b.dataset.k, id: null }; renderRoster(root); }; });
  const sel = $('#viewId', root); if (sel) sel.onchange = () => { v.id = Number(sel.value); renderRoster(root); };
  $$('td.c[data-e]', root).forEach((td) => { td.onclick = () => editCell(Number(td.dataset.e), td.dataset.d); });
  $$('.cal .day[data-d]', root).forEach((el) => { el.onclick = () => editCell(Number(el.dataset.e), el.dataset.d); });
  bindCoverageClicks(root);
}

function employeeView(emp) {
  const { cells, gapCause } = rdata();
  const st = S.roster.employeeStats[emp.id] || {};
  const dates = monthDates(S.month);
  const lead = (dowOf(dates[0]) + 6) % 7;
  const cal = [...Array(lead).fill(null), ...dates].map((d) => {
    if (!d) return '<div class="day out"></div>';
    const x = cells.get(`${emp.id}|${d}`);
    const hol = ix().holidays.get(d);
    return `<div class="day ${x?.s || ''} ${gapCause.has(`${emp.id}|${d}`) ? 'gapcause' : ''}" data-e="${emp.id}" data-d="${d}"><b>${Number(d.slice(8))}</b> <span class="muted">${DOW[dowOf(d)]}</span><div>${x ? STATUS[x.s] : '—'}${x?.manual ? ' ✎' : ''}${x?.comp ? ' (+1 comp-off)' : ''}</div>${hol ? `<div class="small" style="color:#5b34c4">${esc(hol)}</div>` : ''}${x?.note && x.s !== 'W' && !hol ? `<div class="small muted">${esc(x.note)}</div>` : ''}</div>`;
  }).join('');
  const asg = (ix().asgByEmp.get(emp.id) || []).map((a) => { const p = ix().proc.get(a.process_id); return `<tr><td>${esc(procLabel(p))}</td><td><span class="tag ${a.role}">${a.role}</span></td><td>${esc(calendarLabel(p))}</td><td>${p.shift}</td></tr>`; }).join('');
  const myConf = S.roster.conflicts.filter((x) => x.employee_id === emp.id || x.employee_ids?.includes(emp.id));
  return `<div class="grid cols-2" style="grid-template-columns:2fr 1fr"><div><div class="cal">${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => `<div class="dh">${d}</div>`).join('')}${cal}</div></div>
    <div><div class="card"><h4>${esc(emp.name)}</h4><div class="small muted">${esc(ix().pod.get(emp.pod_id)?.name || '')} · ${emp.shift} shift · preferred off: ${(emp.preferred_off_days || []).map((d) => DOW[d]).join('/') || 'none'}</div>
      <div class="row" style="margin-top:8px"><span class="badge ok">${st.W ?? 0} working</span><span class="badge warn">${st.WO ?? 0} weekly off</span><span class="badge info">${st.H ?? 0} holiday</span><span class="badge info">${st.L ?? 0} leave</span><span class="badge info">${st.CO ?? 0} comp-off</span></div>
      <div class="small muted" style="margin-top:6px">${st.weekend_offs ?? 0} weekend offs · ${st.worked_holidays ?? 0} public holidays worked · ${st.compoff_due ?? 0} comp-off(s) owed</div></div>
      <div class="card"><h4>Responsibilities</h4><table class="t"><tbody>${asg || '<tr><td class="muted">No assignments</td></tr>'}</tbody></table></div>
      <div class="card"><h4>Issues touching ${esc(emp.name.split(' ')[0])}</h4>${myConf.slice(0, 8).map((x) => `<div class="small" style="margin-bottom:6px">${x.category === 'preference' ? '🔹' : '🔴'} ${esc(x.message)}</div>`).join('') || '<span class="muted small">None</span>'}</div></div></div>`;
}

// ── manual edit with validation + undo ──────────────────────────────────────────
export function editCell(empId, date) {
  const c = ix(); const emp = c.emp.get(empId); const x = rdata().cells.get(`${empId}|${date}`);
  const cur = x?.s || 'W';
  const procs = [...new Set((c.asgByEmp.get(empId) || []).map((a) => a.process_id))].map((id) => c.proc.get(id));
  const needs = procs.map((p) => { const rec = S.roster.coverage[p.id]?.[date]; return rec ? `<tr><td>${esc(procLabel(p))}</td><td>requires ${rec[0]}, covered ${rec[1].length + rec[2].length}</td></tr>` : `<tr><td>${esc(procLabel(p))}</td><td class="muted">closed</td></tr>`; }).join('');
  const m = openModal({
    title: `${emp.name} · ${fmtDate(date)}`,
    body: `<p class="muted small">${esc(S.world.holidays.find((h) => h.date === date)?.name || '')}</p>
      <label>Status</label><div class="row">${Object.entries(STATUS).map(([k, l]) => `<label style="margin:0;color:var(--ink)"><input type="radio" name="st" value="${k}" ${k === cur ? 'checked' : ''}/> ${l}</label>`).join('')}</div>
      <label>Note (optional)</label><input id="cellNote" style="width:100%" value="${esc(x?.note || '')}" />
      <label style="color:var(--ink)"><input type="checkbox" id="cellComp" ${x?.comp ? 'checked' : ''}/> Mark as worked on a day off (comp-off owed)</label>
      <h4 style="margin-top:14px">Processes affected on this day</h4><table class="t"><tbody>${needs || '<tr><td class="muted">No assignments</td></tr>'}</tbody></table>
      <p class="small muted">The whole roster is re-validated when you save and you'll see exactly what the change breaks or fixes.</p>`,
    footer: '<button data-close2>Cancel</button><button class="primary" id="saveCell">Save &amp; validate</button>',
  });
  m.$('[data-close2]').onclick = m.close;
  m.$('#saveCell').onclick = (e) => run(e.target, async () => {
    const status = m.$('input[name=st]:checked').value;
    const p = await api('POST', '/api/roster/cell', { month: S.month, employee_id: empId, date, status, note: m.$('#cellNote').value, compoff_due: m.$('#cellComp').checked });
    m.close(); setRoster(p);
    if (p.diff.introduced.length) impactModal(emp, date, cur, p.diff);
    else toast(`Saved. ${summarizeDiff(p.diff)}`, 'ok');
  });
}

function impactModal(emp, date, previous, diff) {
  const m = openModal({
    title: 'This change creates new problems', wide: true,
    body: `<p><b>${esc(emp.name)}</b> on ${fmtDate(date)}: ${diff.introduced.length} new problem(s)${diff.resolved.length ? `, ${diff.resolved.length} resolved` : ''}.</p>
      ${diff.introduced.map((c) => `<div class="conf"><div class="hd"><span class="badge err">${esc(TYPE_LABEL[c.type] || c.type)}</span><b>${c.date ? fmtDate(c.date) : ''}</b></div><div class="msg">${esc(c.message)}</div></div>`).join('')}`,
    footer: '<button id="keep">Keep change</button><button class="danger" id="undo">Undo change</button>',
  });
  m.$('#keep').onclick = m.close;
  m.$('#undo').onclick = (e) => run(e.target, async () => { const p = await api('POST', '/api/roster/cell', { month: S.month, employee_id: emp.id, date, status: previous }); m.close(); setRoster(p); toast('Change undone', 'ok'); });
}
