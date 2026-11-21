import { S, esc, api, $$, toast, fmtDate, procLabel, empName, ix, setRoster, run, summarizeDiff } from './core.js';

export const TYPE_LABEL = {
  COVERAGE_GAP: 'Nobody working', UNDERSTAFFED: 'Not enough people', LEAVE_VIOLATION: 'Scheduled during leave', WEEKLY_OFF_SHORT: 'Missing day off',
  CONSECUTIVE_WORK: 'Too many days in a row', OVERLOAD: 'Too much work in a day', NO_STAFF: 'Nobody assigned', INSUFFICIENT_HEADCOUNT: 'Too few people assigned',
  SHIFT_CONFLICT: 'Clashing shift times', SHIFT_MISMATCH: 'Different shift time', NOT_ROSTERED: 'Not on schedule', PREFERENCE: 'Request not granted',
};
const COST_BADGE = { none: ['ok', 'no side effects'], 'comp-off owed': ['warn', 'comp-off owed'], 'permanent change': ['accent', 'permanent change'], 'needs client approval': ['err', 'needs client approval'] };

export const isGap = (c) => c.type === 'COVERAGE_GAP' || c.type === 'UNDERSTAFFED';

export function conflictCard(c, { fix = true } = {}) {
  const sev = c.category === 'preference' ? 'info' : c.severity;
  const sevBadge = c.category === 'preference' ? '<span class="badge info">Request</span>' : c.severity === 'error' ? '<span class="badge err">Must fix</span>' : '<span class="badge warn">Warning</span>';
  const key = isGap(c) ? `${c.process_id}|${c.date}` : '';
  return `<div class="conf ${sev}" data-cid="${esc(c.id)}">
    <div class="hd">${sevBadge}<span class="badge">${esc(TYPE_LABEL[c.type] || c.type)}</span>${c.date ? `<b>${fmtDate(c.date)}</b>` : ''}
      ${c.sole_resource ? '<span class="badge err">only person, no backup</span>' : c.has_backup && isGap(c) ? '<span class="badge warn">backup could not cover</span>' : ''}
      <span class="spacer"></span>${fix && isGap(c) ? `<button class="small" data-fix="${key}">Suggest solutions</button>` : ''}</div>
    <div class="msg">${esc(c.message)}</div>
    ${key ? `<div class="fixes" data-for="${key}"></div>` : ''}
  </div>`;
}

export function optionHtml(o, i) {
  const [cls, label] = COST_BADGE[o.cost] || ['', o.cost];
  const warn = o.introduces ? `<div class="small" style="color:var(--err)">&#9888; Would cause ${o.introduces} new problem(s): ${esc((o.introduced || []).join(' | '))}</div>` : '';
  return `<div class="opt"><div class="body"><div class="ttl">${esc(o.title)}</div><div class="meta">${esc(o.detail || '')}</div>${warn}</div>
    <div style="text-align:right"><span class="badge ${cls}">${esc(label)}</span><br>${o.ops ? `<button class="small primary" data-apply="${i}" style="margin-top:6px">Use this</button>` : '<span class="small muted">human decision</span>'}</div></div>`;
}

/** wire up "Find fixes" buttons inside root */
export function bindConflictActions(root) {
  $$('[data-fix]', root).forEach((btn) => {
    btn.onclick = () => run(btn, async () => {
      const [process_id, date] = btn.dataset.fix.split('|');
      const box = root.querySelector(`.fixes[data-for="${btn.dataset.fix}"]`);
      if (box.dataset.open === '1') { box.innerHTML = ''; box.dataset.open = ''; return; }
      box.innerHTML = '<div class="muted small">Simulating candidate fixes…</div>';
      const r = await api('POST', '/api/roster/suggest', { month: S.month, process_id: Number(process_id), date });
      box.dataset.open = '1';
      showOptions(box, r.options || []);
    });
  });
}

export function showOptions(box, options) {
  if (!options.length) { box.innerHTML = '<div class="muted small">No automatic solution found. This needs your decision: move work to someone else, borrow cover, or agree an exception with the client.</div>'; return; }
  box.innerHTML = `<div class="small muted" style="margin-top:6px">Each option below was tried on the whole schedule first, so you can see what it would fix and what it might break.</div>${options.map(optionHtml).join('')}`;
  $$('[data-apply]', box).forEach((b) => {
    b.onclick = () => run(b, async () => {
      const o = options[Number(b.dataset.apply)];
      const p = await api('POST', '/api/roster/apply', { month: S.month, ops: o.ops, label: o.title });
      toast(`Applied. ${summarizeDiff(p.diff)}`, p.diff?.introduced.length ? 'warn' : 'ok');
      setRoster(p);
    });
  });
}

/** Lines explaining who is/was unavailable on a gap */
export function reasonLines(c) {
  return (c.reasons || []).map((r) => `${empName(r.employee_id)} (${r.role}): ${r.reason}`);
}
export { procLabel, ix };
