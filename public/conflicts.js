import { S, esc, $, $$, api, ix, fmtDate, procLabel, empName, monthLabel, toast, setRoster, run, loadWorld, render, calendarLabel } from './core.js';
import { conflictCard, bindConflictActions, showOptions, TYPE_LABEL, isGap } from './components.js';
import { doPublish, doUnpublish, doApprovePod, doRequestChanges } from './actions.js';
import { groupGaps } from './dashboard.js';

// ── Conflicts tab ──────────────────────────────────────────────────────────────
export function renderConflicts(root) {
  const r = S.roster; const c = ix();
  if (!r.generated) { root.innerHTML = '<div class="card empty">Build the schedule first.</div>'; return; }
  const f = S.confFilter || (S.confFilter = { brand: '', type: '' });
  const keep = (x) => (!f.brand || String(x.brand_id) === f.brand) && (!f.type || x.type === f.type);
  const mand = r.conflicts.filter((x) => x.category === 'mandatory' && keep(x));
  const prefs = r.conflicts.filter((x) => x.category === 'preference' && keep(x));
  const gaps = mand.filter(isGap); const other = mand.filter((x) => !isGap(x));
  const groups = groupGaps(gaps);
  const types = [...new Set(r.conflicts.map((x) => x.type))];
  const published = r.meta.status === 'published';
  root.innerHTML = `<div class="card"><div class="row"><h2 style="margin:0">Problems to fix</h2><span class="badge ${r.stats.errors ? 'err' : 'ok'}">${r.stats.errors} to fix</span><span class="badge info">${r.stats.preferences} requests</span><span class="spacer"></span>
    <select id="cfBrand"><option value="">All brands</option>${S.world.brands.map((b) => `<option value="${b.id}" ${f.brand === String(b.id) ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}</select>
    <select id="cfType"><option value="">All types</option>${types.map((t) => `<option value="${t}" ${f.type === t ? 'selected' : ''}>${esc(TYPE_LABEL[t] || t)}</option>`).join('')}</select>
    ${published ? '<button id="unpub">Unpublish</button>' : '<button class="primary" id="pub">Publish schedule</button>'}</div>
    <p class="muted small" style="margin:6px 0 0"><b>Must fix</b> = a brand with nobody working, someone scheduled during leave, or a work-hours rule broken. <b>Requests</b> are nice-to-haves, like a preferred day off, and always give way to the first kind.</p></div>
  <div class="card"><div class="row"><h3 style="margin:0">Approvals</h3><span class="muted small">Each team lead approves their team's schedule, then the manager publishes. Any later change cancels the approval.</span></div>
    <table class="t" style="margin-top:6px"><thead><tr><th>Team</th><th>Team lead</th><th>To fix</th><th>Status</th><th></th></tr></thead><tbody>
    ${(r.approvals || []).map((a) => { const n = r.conflicts.filter((x) => x.category === 'mandatory' && x.severity === 'error' && x.pod_id === a.pod_id).length;
      return `<tr><td><b>${esc(a.pod)}</b></td><td>${esc(a.lead || '-')}</td><td>${n ? `<span class="badge err">${n}</span>` : '<span class="badge ok">0</span>'}</td>
      <td>${a.approved ? `<span class="badge ok">Approved by ${esc(a.by)}</span>` : a.stale ? '<span class="badge warn">Out of date - schedule changed since approval</span>' : '<span class="badge">Waiting</span>'}</td>
      <td style="white-space:nowrap">${a.approved ? '' : `<button class="small primary" data-approve="${a.pod_id}">Approve</button> `}<button class="small" data-changes="${a.pod_id}">Ask for changes</button></td></tr>`; }).join('')}</tbody></table></div>
  ${groups.length ? `<h3>Days with nobody working (${gaps.length})</h3>${groups.map((g) => {
    const p = c.proc.get(g.process_id);
    return `<details class="group" ${groups.length <= 3 ? 'open' : ''}><summary><b>${esc(procLabel(p))}</b><span class="badge err">${g.dates.length} day(s)</span><span class="muted small">${esc(calendarLabel(p))}</span>${g.sole ? '<span class="badge err">only person, no backup</span>' : ''}</summary>
      <div class="inner">${gaps.filter((x) => x.process_id === g.process_id).map((x) => conflictCard(x)).join('')}</div></details>`;
  }).join('')}` : ''}
  ${other.length ? `<h3>Other problems (${other.length})</h3>${other.map((x) => conflictCard(x, { fix: false })).join('')}` : ''}
  ${!mand.length ? '<div class="card"><span class="badge ok">All clear</span> Nothing to fix here. The schedule can be published.</div>' : ''}
  ${prefs.length ? `<details class="group"><summary><b>Requests that couldn't be granted</b><span class="badge info">${prefs.length}</span><span class="muted small">work coverage had to come first</span></summary><div class="inner">${prefs.map((x) => conflictCard(x, { fix: false })).join('')}</div></details>` : ''}`;
  $('#cfBrand', root).onchange = (e) => { f.brand = e.target.value; renderConflicts(root); };
  $('#cfType', root).onchange = (e) => { f.type = e.target.value; renderConflicts(root); };
  const pub = $('#pub', root); if (pub) pub.onclick = (e) => doPublish(e.target);
  const un = $('#unpub', root); if (un) un.onclick = (e) => doUnpublish(e.target);
  $$('[data-approve]', root).forEach((b) => { b.onclick = () => doApprovePod(Number(b.dataset.approve), b); });
  $$('[data-changes]', root).forEach((b) => { b.onclick = () => doRequestChanges(Number(b.dataset.changes), b); });
  bindConflictActions(root);
}

// ── Handle a change tab ────────────────────────────────────────────────────────
export function renderChanges(root) {
  const w = S.world; const c = ix();
  const pending = w.leaves.filter((l) => l.status === 'pending');
  const today = `${S.month}-10`;
  root.innerHTML = `<div class="card"><h2>What if something changes?</h2>
    <p class="muted">Check the effect before you approve anything. You'll see what happens if you do nothing, what the system can sort out by itself (changing as few days as possible), and which problems still need your decision. Nothing is saved until you approve.</p></div>
  <div class="grid cols-2">
    <div class="card"><h3>Leave waiting for approval</h3>${pending.length ? `<table class="t"><thead><tr><th>Employee</th><th>Dates</th><th>Type</th><th></th></tr></thead><tbody>${pending.map((l) => `<tr><td>${esc(empName(l.employee_id))}<div class="small muted">${esc(l.note || '')}</div></td><td>${fmtDate(l.start_date)}${l.end_date !== l.start_date ? ' – ' + fmtDate(l.end_date) : ''}</td><td>${l.type}</td><td><button class="small primary" data-prev-leave="${l.id}">See what would happen</button></td></tr>`).join('')}</tbody></table>` : '<p class="muted">No pending requests.</p>'}
      <h3 style="margin-top:16px">Someone will be away</h3>
      <div class="form2"><div><label>Employee</label><select id="nlEmp">${w.employees.filter((e) => e.active).map((e) => `<option value="${e.id}">${esc(e.name)}</option>`).join('')}</select></div>
      <div><label>Type</label><select id="nlType"><option>PL</option><option>SL</option><option>CL</option><option>COMPOFF</option><option>LWP</option></select></div>
      <div><label>From</label><input type="date" id="nlFrom" value="${today}"/></div><div><label>To</label><input type="date" id="nlTo" value="${today}"/></div></div>
      <div style="margin-top:10px"><button class="primary" id="nlPrev">See what would happen</button></div></div>
    <div class="card"><h3>A brand's needs change</h3><p class="small muted">For example, a client now wants support seven days a week, or two people instead of one.</p>
      <div class="form2"><div class="full"><label>Service</label><select id="rqProc">${w.processes.filter((p) => p.active).map((p) => `<option value="${p.id}">${esc(procLabel(p))} (${esc(calendarLabel(p))}, min ${p.min_staff})</option>`).join('')}</select></div>
      <div><label>Minimum people needed</label><input type="number" min="0" id="rqMin" value="2" /></div>
      <div><label>Days it runs</label><select id="rqCal"><option value="keep">keep as is</option><option value="365">Every day, including Sundays and holidays</option><option value="EXHOL">Every day except public holidays</option><option value="NOSUN">Closed on Sundays and holidays</option></select></div></div>
      <div style="margin-top:10px"><button class="primary" id="rqPrev">See what would happen</button></div></div>
  </div><div id="changeResult"></div>`;
  const out = $('#changeResult', root);
  $$('[data-prev-leave]', root).forEach((b) => { b.onclick = () => preview(out, { kind: 'leave', leave_id: Number(b.dataset.prevLeave) }, b); });
  $('#nlPrev', root).onclick = (e) => preview(out, { kind: 'leave', employee_id: Number($('#nlEmp', root).value), start_date: $('#nlFrom', root).value, end_date: $('#nlTo', root).value, type: $('#nlType', root).value }, e.target);
  $('#rqPrev', root).onclick = (e) => {
    const patch = { min_staff: Number($('#rqMin', root).value) };
    const cal = $('#rqCal', root).value;
    if (cal === '365') Object.assign(patch, { operating_days: [0, 1, 2, 3, 4, 5, 6], open_on_holidays: true });
    if (cal === 'EXHOL') Object.assign(patch, { operating_days: [0, 1, 2, 3, 4, 5, 6], open_on_holidays: false });
    if (cal === 'NOSUN') Object.assign(patch, { operating_days: [1, 2, 3, 4, 5, 6], open_on_holidays: false });
    preview(out, { kind: 'process', process_id: Number($('#rqProc', root).value), patch }, e.target);
  };
}

const stat = (label, s, hl) => `<div class="box ${hl ? 'hl' : ''}"><div class="small muted">${label}</div><div style="font-size:1.5rem;font-weight:700;color:${s.errors ? 'var(--err)' : 'var(--ok)'}">${s.errors}</div><div class="small muted">problems · ${s.coverage_pct}% of shifts staffed</div></div>`;

async function preview(out, change, btn) {
  await run(btn, async () => {
    out.innerHTML = '<div class="card muted">Working it out…</div>';
    const r = await api('POST', '/api/roster/whatif', { month: S.month, change });
    const a = r.afterRepair;
    const absorbed = a.introduced.length === 0;
    out.innerHTML = `<div class="card"><div class="row"><h3 style="margin:0">What would happen: ${esc(r.label)}</h3><span class="spacer"></span><span class="badge ${absorbed ? 'ok' : 'err'}">${absorbed ? 'the team can cover it' : `${a.introduced.length} problem(s) need your decision`}</span></div>
      <div class="stat3" style="margin:10px 0">${stat('Right now', r.base)}${stat('If approved and left as is', r.immediate.stats)}${stat('After the automatic fix', a.stats, true)}</div>
      ${absorbed ? '<p>✅ The rest of the team (including backups and moved days off) can cover everything.</p>' : `<p>⚠️ These can't be fixed automatically (<b>having someone working always comes before day-off requests</b>):</p>${a.introduced.slice(0, 8).map((x) => `<div class="conf"><div class="hd"><span class="badge err">${esc(TYPE_LABEL[x.type] || x.type)}</span><b>${x.date ? fmtDate(x.date) : ''}</b></div><div class="msg">${esc(x.message)}</div></div>`).join('')}`}
      ${r.suggestions.length ? `<h4>Ways to solve it (each one tried out first)</h4>${r.suggestions.map((s) => `<div class="small"><b>${esc(procLabel(c().proc.get(s.conflict.process_id)))} · ${fmtDate(s.conflict.date)}</b></div>${s.options.filter((o) => o.ops).slice(0, 3).map((o) => `<div class="opt"><div class="body"><div class="ttl">${esc(o.title)}</div><div class="meta">${esc(o.detail)}${o.introduces ? ` · creates ${o.introduces} new conflict(s)` : ''}</div></div><span class="badge ${o.cost === 'none' ? 'ok' : 'warn'}">${esc(o.cost)}</span></div>`).join('')}`).join('')}<p class="small muted">Approve the change, then apply a resolution from the Conflicts tab with one click.</p>` : ''}
      ${a.changed.length ? `<h4>Days the automatic fix would change (${a.changed.length})</h4><table class="t"><tbody>${a.changed.slice(0, 20).map((x) => `<tr><td>${esc(x.employee)}</td><td>${fmtDate(x.date)}</td><td>${x.from || '—'} → <b>${x.to}</b></td></tr>`).join('')}</tbody></table>` : ''}
      <div class="row" style="margin-top:12px"><button class="primary" id="commitBtn">Approve and fix the schedule</button><button id="cancelPrev">Cancel</button></div></div>`;
    $('#cancelPrev', out).onclick = () => { out.innerHTML = ''; };
    $('#commitBtn', out).onclick = (e) => run(e.target, async () => {
      const p = await api('POST', '/api/roster/commit', { month: S.month, change });
      await loadWorld(); setRoster(p);
      const open = p.conflicts.filter((x) => x.category === 'mandatory' && isGap(x) && a.introduced.some((y) => y.id === x.id));
      toast(`Change applied. ${p.repairs.map((x) => `${x.month}: ${x.changed} day(s) changed`).join(', ')}`, open.length ? 'warn' : 'ok');
      S.tab = open.length ? 'conflicts' : S.tab;
      if (open.length) { S.confFilter = { brand: String(open[0].brand_id), type: '' }; }
      render();
    });
  });
}
const c = () => ix();
