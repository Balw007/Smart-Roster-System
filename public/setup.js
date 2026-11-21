import { S, esc, $, $$, api, ix, DOW, fmtDate, procLabel, empName, calendarLabel, brandInfo, openModal, toast, run, loadWorld, loadRoster, loadActivity, render, brandInfo as bi } from './core.js';

const SHIFTS = ['DAY', 'EVENING', 'NIGHT', 'FLEX'];
const refOpts = (kind) => {
  const w = S.world;
  if (kind === 'pods') return [['', '— none —'], ...w.pods.map((p) => [p.id, p.name])];
  if (kind === 'employees') return [['', '— none —'], ...w.employees.map((e) => [e.id, e.name])];
  if (kind === 'brands') return w.brands.map((b) => [b.id, b.name]);
  if (kind === 'processes') return w.processes.map((p) => [p.id, procLabel(p)]);
  return [];
};

// field spec: k=key, l=label, t=type (text|number|date|select|ref|dows|bool|dowmap|json|calendar), opts, full, req
const FIELDS = {
  employees: [
    { k: 'name', l: 'Name', req: 1 }, { k: 'code', l: 'Employee code' }, { k: 'email', l: 'Email' },
    { k: 'pod_id', l: 'Pod', t: 'ref', ref: 'pods' }, { k: 'role', l: 'Role', t: 'select', opts: ['agent', 'pod_lead', 'manager'] }, { k: 'shift', l: 'Shift', t: 'select', opts: SHIFTS },
    { k: 'preferred_off_days', l: 'Days they would like off (a request, not a rule)', t: 'dows', full: 1 },
    { k: 'unavailable_dows', l: 'Days they can never work (a rule, e.g. part-timer)', t: 'dows', full: 1 },
    { k: 'weekly_offs_per_week', l: 'Days off per week (leave blank for the company default)', t: 'number', nullable: 1 }, { k: 'max_daily_load', l: 'Most work they can take on in a day (blank = default)', t: 'number', nullable: 1 },
    { k: 'active', l: 'Active', t: 'bool' },
  ],
  pods: [{ k: 'name', l: 'Pod name', req: 1 }, { k: 'lead_id', l: 'Pod lead', t: 'ref', ref: 'employees' }],
  holidays: [{ k: 'date', l: 'Date', t: 'date', req: 1 }, { k: 'name', l: 'Name', req: 1 }],
  leaves: [
    { k: 'employee_id', l: 'Employee', t: 'ref', ref: 'employees', req: 1 }, { k: 'type', l: 'Type', t: 'select', opts: ['PL', 'SL', 'CL', 'LWP', 'COMPOFF'] },
    { k: 'start_date', l: 'From', t: 'date', req: 1 }, { k: 'end_date', l: 'To', t: 'date', req: 1 },
    { k: 'status', l: 'Status', t: 'select', opts: ['approved', 'pending', 'rejected'] }, { k: 'note', l: 'Note' },
  ],
  covers: [
    { k: 'process_id', l: 'Process', t: 'ref', ref: 'processes', req: 1 }, { k: 'employee_id', l: 'Covering employee', t: 'ref', ref: 'employees', req: 1 },
    { k: 'date', l: 'Date', t: 'date', req: 1 }, { k: 'note', l: 'Note' },
  ],
  brands: [{ k: 'name', l: 'Brand name', req: 1 }, { k: 'pod_id', l: 'Pod', t: 'ref', ref: 'pods' }, { k: 'notes', l: 'Notes', full: 1 }, { k: 'active', l: 'Active', t: 'bool' }],
  processes: [
    { k: 'brand_id', l: 'Brand', t: 'ref', ref: 'brands', req: 1 }, { k: 'name', l: 'Service (CS, ACC, NDR, RET…)', req: 1 },
    { k: '_cal', l: 'Days this service runs', t: 'calendar', full: 1 },
    { k: 'operating_days', l: 'Days it runs', t: 'dows', full: 1 }, { k: 'open_on_holidays', l: 'Also runs on public holidays', t: 'bool' },
    { k: 'min_staff', l: 'Minimum people needed each day it runs', t: 'number', req: 1 }, { k: 'shift', l: 'Shift', t: 'select', opts: SHIFTS },
    { k: 'min_staff_by_dow', l: 'Different minimum on certain weekdays (blank = same as above)', t: 'dowmap', full: 1 },
    { k: 'min_staff_by_date', l: 'Minimum on specific dates (JSON, e.g. {"2026-12-25": 3})', t: 'json', full: 1 },
    { k: 'load', l: 'Workload size (points)', t: 'number' }, { k: 'active', l: 'Active', t: 'bool' },
  ],
  assignments: [
    { k: 'employee_id', l: 'Employee', t: 'ref', ref: 'employees', req: 1 }, { k: 'process_id', l: 'Process', t: 'ref', ref: 'processes', req: 1 },
    { k: 'role', l: 'Role', t: 'select', opts: ['primary', 'backup'] },
  ],
};
const DEFAULTS = {
  employees: { role: 'agent', shift: 'DAY', preferred_off_days: [], unavailable_dows: [], active: true },
  pods: {}, holidays: {}, leaves: { type: 'PL', status: 'approved' }, covers: {}, brands: { active: true },
  processes: { operating_days: [1, 2, 3, 4, 5, 6], open_on_holidays: false, min_staff: 1, shift: 'DAY', min_staff_by_dow: {}, min_staff_by_date: {}, load: 1, active: true },
  assignments: { role: 'primary' },
};
const PRESETS = { '365': { operating_days: [0, 1, 2, 3, 4, 5, 6], open_on_holidays: true }, EXHOL: { operating_days: [0, 1, 2, 3, 4, 5, 6], open_on_holidays: false }, NOSUN: { operating_days: [1, 2, 3, 4, 5, 6], open_on_holidays: false } };

function fieldHtml(f, v) {
  const id = `f_${f.k}`; const cls = f.full ? 'full' : '';
  const L = `<label for="${id}">${esc(f.l)}${f.req ? ' *' : ''}</label>`;
  switch (f.t) {
    case 'number': return `<div class="${cls}">${L}<input id="${id}" type="number" min="0" value="${v ?? ''}"/></div>`;
    case 'date': return `<div class="${cls}">${L}<input id="${id}" type="date" value="${esc(v || '')}"/></div>`;
    case 'select': return `<div class="${cls}">${L}<select id="${id}">${f.opts.map((o) => `<option ${o === v ? 'selected' : ''}>${o}</option>`).join('')}</select></div>`;
    case 'ref': return `<div class="${cls}">${L}<select id="${id}">${refOpts(f.ref).map(([val, l]) => `<option value="${val}" ${String(val) === String(v ?? '') ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></div>`;
    case 'bool': return `<div class="${cls}"><label style="margin-top:22px;color:var(--ink)"><input id="${id}" type="checkbox" ${v ? 'checked' : ''}/> ${esc(f.l)}</label></div>`;
    case 'dows': return `<div class="${cls}">${L}<div class="dows" id="${id}">${DOW.map((d, i) => `<label><input type="checkbox" data-dow="${i}" ${(v || []).includes(i) ? 'checked' : ''}/>${d}</label>`).join('')}</div></div>`;
    case 'dowmap': return `<div class="${cls}">${L}<div class="dowmap" id="${id}">${DOW.map((d, i) => `<div>${d}<input type="number" min="0" data-dow="${i}" value="${(v || {})[i] ?? ''}"/></div>`).join('')}</div></div>`;
    case 'json': return `<div class="${cls}">${L}<textarea id="${id}" rows="2">${esc(JSON.stringify(v || {}))}</textarea></div>`;
    case 'calendar': return `<div class="${cls}">${L}<select id="${id}"><option value="">custom (choose days below)</option><option value="365">Every day, including Sundays and public holidays</option><option value="EXHOL">Every day except public holidays</option><option value="NOSUN">Closed on Sundays and public holidays</option></select></div>`;
    default: return `<div class="${cls}">${L}<input id="${id}" value="${esc(v ?? '')}"/></div>`;
  }
}

function readForm(m, table) {
  const out = {};
  for (const f of FIELDS[table]) {
    if (f.t === 'calendar') continue;
    const el = m.$(`#f_${f.k}`);
    if (f.t === 'number') out[f.k] = el.value === '' ? (f.nullable ? null : undefined) : Number(el.value);
    else if (f.t === 'bool') out[f.k] = el.checked;
    else if (f.t === 'dows') out[f.k] = [...el.querySelectorAll('input:checked')].map((i) => Number(i.dataset.dow));
    else if (f.t === 'dowmap') { const o = {}; el.querySelectorAll('input').forEach((i) => { if (i.value !== '') o[i.dataset.dow] = Number(i.value); }); out[f.k] = o; }
    else if (f.t === 'json') { try { out[f.k] = JSON.parse(el.value || '{}'); } catch { throw new Error('Invalid JSON in "' + f.l + '"'); } }
    else if (f.t === 'ref') out[f.k] = el.value === '' ? null : Number(el.value);
    else out[f.k] = el.value;
  }
  return out;
}

export function editRecord(table, row, { onSaved, title } = {}) {
  const data = row ? { ...row } : { ...JSON.parse(JSON.stringify(DEFAULTS[table])), ...(onSaved?.prefill || {}) };
  const m = openModal({
    title: title || `${row ? 'Edit' : 'Add'} ${table.replace(/s$/, '')}`,
    body: `<div class="form2">${FIELDS[table].map((f) => fieldHtml(f, data[f.k])).join('')}</div>${table === 'leaves' ? '<label style="color:var(--ink)"><input type="checkbox" id="autoRepair" checked/> Auto-repair the roster after saving an approved leave</label>' : ''}<div id="formErr" class="small" style="color:var(--err);margin-top:8px"></div>`,
    footer: `${row ? '<button class="danger" id="delRec" style="margin-right:auto">Delete</button>' : ''}<button data-c>Cancel</button><button class="primary" id="saveRec">Save</button>`,
  });
  m.$('[data-c]').onclick = m.close;
  const cal = m.$('#f_calendar') || m.$('#f__cal');
  if (cal) cal.onchange = () => {
    const p = PRESETS[cal.value]; if (!p) return;
    m.$$('#f_operating_days input').forEach((i) => { i.checked = p.operating_days.includes(Number(i.dataset.dow)); });
    m.$('#f_open_on_holidays').checked = p.open_on_holidays;
  };
  m.$('#saveRec').onclick = (e) => run(e.target, async () => {
    try {
      const body = readForm(m, table);
      if (table === 'leaves' && m.$('#autoRepair')?.checked) body.auto_repair = true;
      const saved = row ? await api('PUT', `/api/${table}/${row.id}`, body) : await api('POST', `/api/${table}`, body);
      m.close(); await afterChange(`${table.replace(/s$/, '')} saved`); onSaved?.(saved);
    } catch (err) { m.$('#formErr').textContent = err.message; }
  });
  const del = m.$('#delRec');
  if (del) del.onclick = (e) => run(e.target, async () => {
    if (!window.confirm('Delete this? Anything linked to it (assignments, schedule days) is removed too.')) return;
    await api('DELETE', `/api/${table}/${row.id}`); m.close(); await afterChange('deleted');
  });
}

/** After master-data changes the roster is re-validated live; tell the manager what that means. */
async function afterChange(what) {
  await loadWorld(); await loadRoster(); await loadActivity(); render();
  const r = S.roster;
  const unrostered = r.conflicts.filter((c) => c.type === 'NOT_ROSTERED').length;
  if (unrostered) toast(`Saved. ${unrostered} new employee(s) are not on this month's schedule yet - use Quick fix.`, 'warn');
  else toast(`Saved. The schedule was re-checked: ${r.stats.errors} problem(s) to fix.`, r.stats.errors ? 'warn' : 'ok');
}

// ── tables ─────────────────────────────────────────────────────────────────────
const TABLE_COLS = {
  employees: [['Name', (e) => `<b>${esc(e.name)}</b> <span class="muted small">${esc(e.code || '')}</span>${e.role === 'pod_lead' ? ' <span class="badge accent">lead</span>' : ''}${e.active ? '' : ' <span class="badge">inactive</span>'}`], ['Pod', (e) => esc(ix().pod.get(e.pod_id)?.name || '—')], ['Shift', (e) => e.shift],
    ['Handles', (e) => (ix().asgByEmp.get(e.id) || []).map((a) => `<span class="tag ${a.role}">${esc(procLabel(ix().proc.get(a.process_id)))}</span>`).join('') || '<span class="muted">—</span>'],
    ['Prefers off', (e) => (e.preferred_off_days || []).map((d) => DOW[d]).join('/') || '—']],
  pods: [['Pod', (p) => `<b>${esc(p.name)}</b>`], ['Lead', (p) => esc(empName(p.lead_id) || '—')], ['Members', (p) => S.world.employees.filter((e) => e.pod_id === p.id && e.active).length], ['Brands', (p) => S.world.brands.filter((b) => b.pod_id === p.id).length]],
  holidays: [['Date', (h) => fmtDate(h.date) + ' ' + h.date.slice(0, 4)], ['Holiday', (h) => esc(h.name)]],
  leaves: [['Employee', (l) => esc(empName(l.employee_id))], ['From', (l) => fmtDate(l.start_date)], ['To', (l) => fmtDate(l.end_date)], ['Type', (l) => l.type], ['Status', (l) => `<span class="badge ${l.status === 'approved' ? 'ok' : l.status === 'pending' ? 'warn' : ''}">${l.status}</span>`], ['Note', (l) => esc(l.note || '')]],
  covers: [['Process', (c) => esc(procLabel(ix().proc.get(c.process_id)))], ['Employee', (c) => esc(empName(c.employee_id))], ['Date', (c) => fmtDate(c.date)], ['Note', (c) => esc(c.note || '')]],
  assignments: [['Employee', (a) => esc(empName(a.employee_id))], ['Process', (a) => esc(procLabel(ix().proc.get(a.process_id)))], ['Role', (a) => `<span class="tag ${a.role}">${a.role}</span>`]],
};
const SORT = { holidays: (a, b) => a.date.localeCompare(b.date), leaves: (a, b) => b.start_date.localeCompare(a.start_date), covers: (a, b) => a.date.localeCompare(b.date) };

function genericTable(root, table, label) {
  const rows = [...S.world[table]].sort(SORT[table] || ((a, b) => a.id - b.id));
  root.innerHTML = `<div class="card"><div class="row"><h3 style="margin:0">${label} <span class="badge">${rows.length}</span></h3><span class="spacer"></span><button class="primary" id="addRec">+ Add</button></div>
    <table class="t" style="margin-top:8px"><thead><tr>${TABLE_COLS[table].map(([h]) => `<th>${h}</th>`).join('')}<th></th></tr></thead><tbody>${rows.map((r) => `<tr>${TABLE_COLS[table].map(([, f]) => `<td>${f(r)}</td>`).join('')}<td style="text-align:right"><button class="small" data-edit="${r.id}">Edit</button></td></tr>`).join('') || `<tr><td colspan="9" class="empty">Nothing yet</td></tr>`}</tbody></table></div>`;
  $('#addRec', root).onclick = () => editRecord(table, null);
  $$('[data-edit]', root).forEach((b) => { b.onclick = () => editRecord(table, S.world[table].find((r) => r.id === Number(b.dataset.edit))); });
}

// ── brands & processes (main configuration screen) ─────────────────────────────
function brandsView(root) {
  const c = ix();
  root.innerHTML = `<div class="row" style="margin-bottom:10px"><p class="muted" style="margin:0;flex:1">Each service (like customer support) has its own <b>opening days</b> and <b>minimum people</b>. People are linked to a service as the <b>main person</b> or as a <b>backup</b> who steps in when needed. Change anything here and the schedule re-checks itself.</p><button class="primary" id="addBrand">+ Add brand</button></div>
  ${S.world.brands.map((b) => {
    const info = brandInfo(b.id);
    const procs = c.procsByBrand.get(b.id) || [];
    return `<div class="card" style="${b.active ? '' : 'opacity:.55'}"><div class="row"><h3 style="margin:0">${esc(b.name)}</h3><span class="badge ${info.people > 1 ? 'accent' : ''}">${info.type}</span>${info.risk.length ? '<span class="badge err">Runs 7 days, no backup</span>' : ''}<span class="muted small">${esc(c.pod.get(b.pod_id)?.name || 'no pod')}</span><span class="spacer"></span>
      <button class="small" data-addproc="${b.id}">+ Service</button><button class="small" data-editbrand="${b.id}">Edit brand</button></div>
      ${b.notes ? `<div class="small muted">${esc(b.notes)}</div>` : ''}
      <table class="t" style="margin-top:6px"><thead><tr><th>Service</th><th>Days it runs</th><th>Minimum</th><th>Shift</th><th>People</th><th></th></tr></thead><tbody>
      ${procs.map((p) => { const mins = Object.entries(p.min_staff_by_dow || {}).map(([d, n]) => `${DOW[d]}: ${n}`).join(', ');
        return `<tr><td><b>${esc(p.name)}</b>${p.active ? '' : ' <span class="badge">inactive</span>'}</td><td>${esc(calendarLabel(p))}</td><td>${p.min_staff}${mins ? ` <span class="muted small">(${mins})</span>` : ''}</td><td>${p.shift}</td>
        <td>${(c.asgByProc.get(p.id) || []).map((a) => `<span class="tag ${a.role}" title="Click to remove" data-rmasg="${a.id}" style="cursor:pointer">${esc(empName(a.employee_id))}${a.role === 'backup' ? ' (backup)' : ''} &times;</span>`).join('') || '<span class="badge err">nobody</span>'}</td>
        <td style="white-space:nowrap"><button class="small" data-assign="${p.id}">+ Assign</button> <button class="small" data-editproc="${p.id}">Edit</button></td></tr>`; }).join('') || '<tr><td colspan="6" class="muted">No processes yet</td></tr>'}</tbody></table></div>`;
  }).join('')}`;
  $('#addBrand', root).onclick = () => editRecord('brands', null);
  $$('[data-editbrand]', root).forEach((b) => { b.onclick = () => editRecord('brands', c.brand.get(Number(b.dataset.editbrand))); });
  $$('[data-addproc]', root).forEach((b) => { b.onclick = () => editRecord('processes', null, { onSaved: Object.assign(() => {}, { prefill: { brand_id: Number(b.dataset.addproc) } }) }); });
  $$('[data-editproc]', root).forEach((b) => { b.onclick = () => editRecord('processes', c.proc.get(Number(b.dataset.editproc))); });
  $$('[data-assign]', root).forEach((b) => { b.onclick = () => editRecord('assignments', null, { title: `Assign to ${procLabel(c.proc.get(Number(b.dataset.assign)))}`, onSaved: Object.assign(() => {}, { prefill: { process_id: Number(b.dataset.assign) } }) }); });
  $$('[data-rmasg]', root).forEach((t) => { t.onclick = async () => { if (!window.confirm('Remove this assignment?')) return; try { await api('DELETE', `/api/assignments/${t.dataset.rmasg}`); await afterChange('assignment removed'); } catch (e) { toast(e.message, 'err'); } }; });
}

function rulesView(root) {
  const s = S.world.settings;
  root.innerHTML = `<div class="card" style="max-width:640px"><h3>Company-wide rules</h3><p class="muted small">Opening days and the number of people each brand needs are set per service. These are the defaults for people.</p>
    <div class="form2"><div><label>Days off per week (default)</label><input id="rs1" type="number" min="0" value="${s.weekly_offs_per_week}"/></div><div><label>Most days in a row someone can work</label><input id="rs2" type="number" min="1" value="${s.max_consecutive_work}"/></div>
    <div><label>Most work one person can take on in a day (default)</label><input id="rs3" type="number" min="1" value="${s.default_max_daily_load}"/></div><div><label>Days of leave in a week that cancel that week's day off</label><input id="rs4" type="number" min="1" value="${s.leave_waiver_days}"/></div></div>
    <div style="margin-top:12px"><button class="primary" id="saveRules">Save rules</button></div></div>`;
  $('#saveRules', root).onclick = (e) => run(e.target, async () => {
    await api('PUT', '/api/settings', { weekly_offs_per_week: Number($('#rs1').value), max_consecutive_work: Number($('#rs2').value), default_max_daily_load: Number($('#rs3').value), leave_waiver_days: Number($('#rs4').value) });
    await afterChange('rules');
  });
}

const SUBTABS = [['brands', 'Brands & services'], ['employees', 'Employees'], ['pods', 'Teams'], ['assignments', 'Who works on what'], ['holidays', 'Public holidays'], ['leaves', 'Leaves & comp-offs'], ['covers', 'Date-specific cover'], ['rules', 'Rules']];
export function renderSetup(root) {
  const t = S.setupTab;
  root.innerHTML = `<div class="seg" id="subtabs" style="margin-bottom:12px;flex-wrap:wrap">${SUBTABS.map(([k, l]) => `<button data-t="${k}" class="${t === k ? 'active' : ''}">${l}</button>`).join('')}</div><div id="subbody"></div>`;
  $$('#subtabs button', root).forEach((b) => { b.onclick = () => { S.setupTab = b.dataset.t; renderSetup(root); }; });
  const body = $('#subbody', root);
  if (t === 'brands') brandsView(body);
  else if (t === 'rules') rulesView(body);
  else genericTable(body, t, SUBTABS.find(([k]) => k === t)[1]);
}
