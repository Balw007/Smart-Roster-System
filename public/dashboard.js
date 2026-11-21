import { S, esc, $, $$, ix, fmtDate, procLabel, brandInfo, monthLabel, render } from './core.js';
import { doGenerate } from './actions.js';
import { isGap } from './components.js';

const monthLong = (m) => new Date(m + '-01T00:00:00Z').toLocaleString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });

export function groupGaps(conflicts) {
  const m = new Map();
  for (const c of conflicts.filter(isGap)) {
    if (!m.has(c.process_id)) m.set(c.process_id, { process_id: c.process_id, brand_id: c.brand_id, dates: [], sole: c.sole_resource, causes: new Set() });
    const g = m.get(c.process_id); g.dates.push(c.date); g.causes.add(c.cause);
  }
  return [...m.values()].sort((a, b) => b.dates.length - a.dates.length);
}

export function renderDashboard(root) {
  const r = S.roster; const c = ix(); const w = S.world;
  if (!r.generated) {
    root.innerHTML = `<div class="card empty"><h2>No schedule for ${monthLabel(S.month)} yet</h2><p>The system will plan everyone's days off around each brand's opening days, leave, holidays and the number of people each brand needs.</p><button class="primary" id="genBtn">Build the schedule for ${monthLabel(S.month)}</button></div>`;
    $('#genBtn', root).onclick = (e) => doGenerate('full', e.target);
    return;
  }
  const st = r.stats; const mand = r.conflicts.filter((x) => x.category === 'mandatory');
  const groups = groupGaps(mand);
  const risky = w.brands.filter((b) => b.active).map((b) => ({ b, info: brandInfo(b.id) })).filter((x) => x.info.risk.length);
  const multi = w.brands.filter((b) => b.active && brandInfo(b.id).people > 1).length;
  const single = w.brands.filter((b) => b.active).length - multi;
  const act = (S.activity || []).slice(0, 8);
  const days = Object.keys(S.roster.coverage[Object.keys(S.roster.coverage)[0]] || {}).filter((d) => d.startsWith(S.month)).sort();
  const dayTot = days.map((d) => { let req = 0; let miss = 0; for (const pid of Object.keys(S.roster.coverage)) { const x = S.roster.coverage[pid][d]; if (x && x[0] > 0) { req += x[0]; miss += x[3]; } } return { d, req, miss, pct: req ? Math.round(((req - miss) / req) * 100) : 100 }; });
  const dowOf = (d) => new Date(d + 'T00:00:00Z').getUTCDay();
  const hol = new Set((w.holidays || []).map((h) => h.date));
  const pods = w.pods.map((p) => ({ p, n: mand.filter((x) => x.pod_id === p.id).length, members: w.employees.filter((e) => e.pod_id === p.id && e.active).length }));
  const gapDays = dayTot.filter((t) => t.miss > 0).length;
  const headline = !st.errors
    ? `Every shift is staffed. The schedule is ready to publish.`
    : `${st.covered_slots} of ${st.required_slots} shifts are staffed. ${st.errors} ${st.errors === 1 ? 'problem needs' : 'problems need'} your attention${groups.length ? `, across ${groups.length} ${groups.length === 1 ? 'service' : 'services'}` : ''}.`;
  root.innerHTML = `
  <div class="card lead"><div class="eyebrow">${r.meta.status === 'published' ? 'Published' : 'Draft'} schedule</div><h2>${monthLong(S.month)}</h2><p>${headline} ${st.errors ? `Most of these are brands that have <b>only one person</b> and no backup, so nobody can cover when that person is off.` : ''}</p></div>
  <div class="card stats">
    <div class="stat"><div class="num ${st.coverage_pct >= 99.5 ? 'good' : ''}">${st.coverage_pct}%</div><div class="lbl">of shifts have enough people</div></div>
    <div class="stat"><div class="num ${st.errors ? 'bad' : 'good'}">${st.errors}</div><div class="lbl">problems to fix before publishing</div></div>
    <div class="stat"><div class="num">${st.preferences}</div><div class="lbl">day-off requests that couldn't be granted</div></div>
    <div class="stat"><div class="num">${w.employees.filter((e) => e.active).length}</div><div class="lbl">people · ${w.pods.length} teams · ${w.brands.filter((b) => b.active).length} brands</div></div>
    <div class="stat"><div class="num">${(r.approvals || []).filter((a) => a.approved).length}<span class="muted" style="font-size:1.1rem"> of ${(r.approvals || []).length}</span></div><div class="lbl">team leads have approved</div></div>
  </div>
  <div class="grid cols-2">
    <div class="card"><h3>Staffing day by day</h3>
      <div class="bars">${dayTot.map((t) => { const wd = dowOf(t.d); const cls = !t.req ? 'shut' : t.pct >= 100 ? '' : t.pct >= 95 ? 'warn' : 'bad'; return `<div class="col" title="${fmtDate(t.d)}: ${t.req ? (t.miss ? `${t.miss} of ${t.req} shifts have nobody` : 'fully staffed') : 'nothing required'}"><div class="stick ${cls}" style="height:${t.req ? Math.max(8, t.pct) : 4}%"></div><div class="d ${hol.has(t.d) ? 'hd' : wd === 0 || wd === 6 ? 'we' : ''}">${Number(t.d.slice(8))}</div></div>`; }).join('')}</div>
      <p class="helptext">One bar per day. Grey-blue means everyone needed is working. ${gapDays ? `Gold or red marks the ${gapDays} ${gapDays === 1 ? 'day' : 'days'} when a shift has nobody.` : ''} Purple dates are weekends; bold gold dates are public holidays.</p></div>
    <div class="card"><h3>By team</h3>
      ${pods.map(({ p, n, members }) => `<div class="teamrow"><b>${esc(p.name)}</b><span class="muted small">${members} people</span>${n ? `<span class="badge err">${n} to fix</span>` : '<span class="badge ok">all good</span>'}</div>`).join('')}
      <p class="helptext">A "problem" is something that breaks a rule, like a brand with nobody working or someone scheduled during approved leave.</p></div>
  </div>
  <div class="grid cols-2">
    <div class="card"><div class="row"><h3 style="margin:0">What needs attention</h3><span class="spacer"></span><button class="small" data-go="conflicts">See all problems</button></div>
      ${groups.length ? `<table class="t" style="margin-top:8px"><thead><tr><th>Service</th><th>Days with nobody</th><th>Why</th></tr></thead><tbody>${groups.slice(0, 8).map((g) => `<tr><td><b>${esc(procLabel(c.proc.get(g.process_id)))}</b></td><td>${g.dates.length} <span class="muted small">(${g.dates.slice(0, 4).map((d) => fmtDate(d)).join(', ')}${g.dates.length > 4 ? '…' : ''})</span></td><td>${g.sole ? '<span class="badge err">only person, no backup</span>' : ''} <span class="badge">${[...g.causes].join(', ').toLowerCase().replace('_', ' ')}</span></td></tr>`).join('')}</tbody></table>` : '<p class="muted">Nothing to fix. Every service has someone working on every day it is open.</p>'}
      ${mand.filter((x) => !isGap(x)).length ? `<p class="small" style="color:var(--err)">+ ${mand.filter((x) => !isGap(x)).length} other problem(s) (rules, leave or setup).</p>` : ''}</div>
    <div class="card"><div class="row"><h3 style="margin:0">Brands with no backup</h3></div>
      <p class="small muted">These brands run every day with one person. Whenever that person has a day off, the brand has nobody. Adding a backup or a second person fixes it for good.</p>
      ${risky.length ? `<table class="t"><tbody>${risky.map(({ b, info }) => `<tr><td><b>${esc(b.name)}</b> <span class="muted small">${esc(c.pod.get(b.pod_id)?.name || '')}</span></td><td>${info.risk.map((p) => `<span class="tag">${esc(p.name)}</span>`).join('')}</td><td><span class="badge err">${info.type}</span></td></tr>`).join('')}</tbody></table>` : '<p class="muted">None. Every brand that runs seven days a week has a backup or a second person.</p>'}</div>
  </div>
  <div class="card"><h3>Recent activity</h3>${act.length ? `<table class="t"><tbody>${act.map((a) => `<tr><td class="small muted" style="white-space:nowrap">${new Date(a.ts).toLocaleString()}</td><td>${a.kind === 'PUBLISHED_ROSTER_CHANGED' ? '<span class="badge warn">notify</span> ' : ''}${esc(a.message)}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">Nothing yet.</p>'}</div>`;
  $$('[data-go]', root).forEach((b) => { b.onclick = () => { S.tab = b.dataset.go; render(); }; });
}
