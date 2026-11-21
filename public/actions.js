import { S, api, run, toast, loadWorld, setRoster, summarizeDiff, openModal, esc } from './core.js';

export function doGenerate(mode, btn) {
  const msg = { full: 'Rebuild from scratch? Changes you made by hand this month will be lost.', 'keep-manual': 'Rebuild everything except the days you changed by hand?', repair: null }[mode];
  if (msg && S.roster?.generated && !window.confirm(msg)) return Promise.resolve();
  return run(btn, async () => {
    const p = await api('POST', '/api/roster/generate', { month: S.month, mode });
    await loadWorld();
    setRoster(p);
    const n = p.stats.errors;
    toast(mode === 'repair' ? `Fixed - ${p.changed.length} day(s) changed, ${n} problem(s) left` : `Schedule built - ${n} problem(s) to fix, ${p.stats.coverage_pct}% of shifts staffed`, n ? 'warn' : 'ok');
  });
}

export function doPublish(btn) {
  return run(btn, async () => {
    let force = false;
    const errs = S.roster.stats.errors;
    if (errs > 0) {
      if (!window.confirm(`${errs} problem(s) still need fixing.\n\nPublishing now means you accept them (for example, a brand that cannot be fully covered). Publish anyway?`)) return;
      force = true;
    }
    const waiting = (S.roster.approvals || []).filter((a) => !a.approved);
    if (waiting.length) {
      if (!window.confirm(`Team lead approval is still missing for: ${waiting.map((a) => a.pod).join(', ')}.\n\nPublish anyway as the manager?`)) return;
      force = true;
    }
    const p = await api('POST', '/api/roster/publish', { month: S.month, force });
    setRoster(p); toast('Schedule published', 'ok');
  });
}

export function doUnpublish(btn) {
  return run(btn, async () => { setRoster(await api('POST', '/api/roster/unpublish', { month: S.month })); toast('Moved back to draft'); });
}

export function doApprovePod(podId, btn) {
  return run(btn, async () => {
    const pod = S.roster.approvals.find((a) => a.pod_id === podId);
    const open = S.roster.conflicts.filter((c) => c.category === 'mandatory' && c.severity === 'error' && c.pod_id === podId).length;
    if (open && !window.confirm(`${pod.pod} still has ${open} problem(s) to fix. Approve anyway?`)) return;
    setRoster(await api('POST', '/api/roster/approve-pod', { month: S.month, pod_id: podId, acknowledge: open > 0 }));
    toast(`${pod.pod} approved`, 'ok');
  });
}

export function doRequestChanges(podId, btn) {
  const note = window.prompt('What should change? (visible in the activity log)');
  if (note === null) return Promise.resolve();
  return run(btn, async () => { setRoster(await api('POST', '/api/roster/request-changes', { month: S.month, pod_id: podId, note })); toast('Changes requested - schedule is back in draft', 'warn'); });
}

/** Build alternative plans (different soft priorities), compare, and optionally adopt one. */
export function doComparePlans(btn) {
  return run(btn, async () => {
    const { plans } = await api('POST', '/api/roster/compare', { month: S.month });
    const best = (k, low = true) => { const v = plans.map((p) => p[k]); const t = low ? Math.min(...v) : Math.max(...v); return (p) => (p[k] === t ? ' class="best"' : ''); };
    const bPref = best('preferences_missed'), bSpread = best('weekend_spread'), bMax = best('max_weekend_offs'), bCov = best('coverage_pct', false), bMand = best('mandatory'), bChg = best('changed_cells');
    const m = openModal({
      title: 'Compare options', wide: true,
      body: `<p class="muted small">Each option follows the same rules: shifts must be staffed and work-hour limits are never broken. They differ only in how they balance <b>people's day-off requests</b> against <b>sharing weekends fairly</b>. Nothing is saved until you choose one.</p>
        <table class="t cmp"><thead><tr><th></th>${plans.map((p) => `<th>${esc(p.label)}<div class="muted small" style="font-weight:400">${esc(p.blurb)}</div></th>`).join('')}</tr></thead><tbody>
        <tr><td>Shifts with enough people</td>${plans.map((p) => `<td${bCov(p)}>${p.coverage_pct}%</td>`).join('')}</tr>
        <tr><td>Problems to fix</td>${plans.map((p) => `<td${bMand(p)}>${p.mandatory}</td>`).join('')}</tr>
        <tr><td>Day-off requests not granted</td>${plans.map((p) => `<td${bPref(p)}>${p.preferences_missed}</td>`).join('')}</tr>
        <tr><td>Most weekend days off for one person</td>${plans.map((p) => `<td${bMax(p)}>${p.max_weekend_offs}</td>`).join('')}</tr>
        <tr><td>Unevenness of weekend days off (lower = fairer)</td>${plans.map((p) => `<td${bSpread(p)}>${p.weekend_spread}</td>`).join('')}</tr>
        <tr><td>Days that differ from the current schedule</td>${plans.map((p) => `<td${bChg(p)}>${p.changed_cells}</td>`).join('')}</tr>
        <tr><td></td>${plans.map((p) => `<td><button class="primary" data-adopt="${p.key}">Choose this option</button></td>`).join('')}</tr></tbody></table>
        <p class="muted small">Identical columns are normal: it means the goals don't clash here. For example, every day-off request that staffing allows is already granted, so the rest could not be.</p>
        <p class="muted small">Choosing an option rebuilds the month (changes made by hand are lost).</p>`,
      footer: '<button data-c>Close</button>',
    });
    m.$('[data-c]').onclick = m.close;
    m.$$('[data-adopt]').forEach((b) => { b.onclick = () => run(b, async () => {
      if (S.roster?.generated && !window.confirm('Choose this option? The month is rebuilt and changes made by hand are lost.')) return;
      const p = await api('POST', '/api/roster/generate', { month: S.month, mode: 'full', strategy: b.dataset.adopt });
      await loadWorld(); setRoster(p); m.close(); toast(`${plans.find((x) => x.key === b.dataset.adopt).label} option chosen`, 'ok');
    }); });
  });
}
export { summarizeDiff };
