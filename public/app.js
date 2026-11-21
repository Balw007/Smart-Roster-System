import { S, $, $$, esc, api, setRender, render, loadWorld, loadRoster, loadActivity, monthLabel, shiftMonth, toast } from './core.js';
import { renderDashboard } from './dashboard.js';
import { renderRoster } from './roster.js';
import { renderCoverage } from './coverage.js';
import { renderConflicts, renderChanges } from './conflicts.js';
import { renderSetup } from './setup.js';
import { doGenerate, doPublish, doUnpublish, doComparePlans } from './actions.js';

const TABS = [['dashboard', 'Overview'], ['roster', 'Schedule'], ['coverage', 'Staffing'], ['conflicts', 'Problems'], ['changes', 'What if?'], ['setup', 'Setup']];
const VIEWS = { dashboard: renderDashboard, roster: renderRoster, coverage: renderCoverage, conflicts: renderConflicts, changes: renderChanges, setup: renderSetup };

function paint() {
  if (!S.world || !S.roster) return;
  const r = S.roster;
  $('#monthPicker').value = S.month;
  const chip = $('#statusChip');
  chip.className = `chip ${r.meta.status}`;
  chip.textContent = !r.generated ? 'no schedule yet' : r.meta.status === 'published' ? 'Published' : 'Draft';
  $('#tabs').innerHTML = TABS.map(([k, l]) => `<button data-tab="${k}" class="${S.tab === k ? 'active' : ''}">${l}${k === 'conflicts' && r.generated ? ` <span class="badge ${r.stats.errors ? 'err' : 'ok'}">${r.stats.errors}</span>` : ''}</button>`).join('');
  $$('#tabs button').forEach((b) => { b.onclick = () => { S.tab = b.dataset.tab; render(); }; });
  $('#headerActions').innerHTML = r.generated
    ? `<button id="hCmp" title="See a few different ways to build the schedule, side by side">Compare options</button><button id="hRepair" title="Fix problems by changing as little as possible">Quick fix</button><button id="hKeep" title="Rebuild the schedule but keep the changes you made by hand">Rebuild, keep my edits</button><button id="hFull" title="Throw everything away and build again">Rebuild from scratch</button>${r.meta.status === 'published' ? '<button id="hUnpub">Unpublish</button>' : '<button class="primary" id="hPub">Publish</button>'}`
    : '<button class="primary" id="hGen">Build schedule</button>';
  const on = (id, fn) => { const el = $(id); if (el) el.onclick = (e) => fn(e.target); };
  on('#hGen', (b) => doGenerate('full', b)); on('#hRepair', (b) => doGenerate('repair', b)); on('#hKeep', (b) => doGenerate('keep-manual', b));
  on('#hCmp', (b) => doComparePlans(b)); on('#hFull', (b) => doGenerate('full', b)); on('#hPub', (b) => doPublish(b)); on('#hUnpub', (b) => doUnpublish(b));
  const view = $('#view');
  const scroll = window.scrollY;
  VIEWS[S.tab](view);
  window.scrollTo(0, scroll);
}

async function setMonth(m) {
  S.month = m;
  history.replaceState(null, '', `#${S.tab}/${m}`);
  await Promise.all([loadRoster(), loadActivity()]);
  render();
}

async function init() {
  setRender(paint);
  $('#view').innerHTML = '<div class="empty">Loading…</div>';
  await loadWorld();
  const h = location.hash.slice(1).split('/');
  const rosters = S.world.rosters.filter((x) => x.status !== 'none');
  const demo = rosters.length ? rosters[rosters.length - 1].month : new Date().toISOString().slice(0, 7);
  S.month = /^\d{4}-\d{2}$/.test(h[1] || '') ? h[1] : demo;
  if (TABS.some(([k]) => k === h[0])) S.tab = h[0];
  await Promise.all([loadRoster(), loadActivity()]);
  $('#prevMonth').onclick = () => setMonth(shiftMonth(S.month, -1));
  $('#nextMonth').onclick = () => setMonth(shiftMonth(S.month, 1));
  $('#monthPicker').onchange = (e) => e.target.value && setMonth(e.target.value);
  render();
}
init().catch((e) => { $('#view').innerHTML = `<div class="card empty">Failed to load: ${esc(e.message)}</div>`; });
