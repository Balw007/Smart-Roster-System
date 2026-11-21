# Smart Roster Management System

Monthly roster generation for a multi-brand operations company: 36 employees, 4 pods, 25 brands
(20 single-resource, 5 multi-resource), per-process operating calendars, leaves / comp-offs / holidays,
conflict detection, manual edits with validation, and a "handle a change" flow.

**Live app:** _<add your deployed URL>_  |  **Demo video:** _<add link>_

## Run locally

Requires **Node 22.13+** (uses the built-in `node:sqlite`; no database to install).

```bash
npm install
npm start            # http://localhost:3000  (seeds sample data + a generated roster on first run)
npm test             # 22 engine + API tests
npm run seed         # wipe and re-seed sample data
```
Config is in `.env.example` (`PORT`, `DB_PATH`). No authentication: this is a single-manager demo (see question 8).

## Tour (what to click)

1. **Overview** – a plain-English summary, shifts staffed, problems to fix, day-by-day staffing bars, team status, brands with no backup.
2. **Schedule** – Company / Pod / Brand / Process / Employee views. Click a day to change it; the system shows what the change breaks and offers Undo.
3. **Staffing** – day-by-day map of people needed vs people working for each service.
4. **Problems** – must-fix problems vs nice-to-have requests; **Suggest solutions** tries each option first and applies one with a click.
5. **What if?** – preview a pending leave (Rohit, sole resource of DenimCo) or a requirement change; compare *current / if approved / after minimal repair*, then approve.
6. **Setup** (brands & services, employees, teams, holidays, leave) – add/edit employees, pods, brands, processes (calendar presets + per-weekday minimums), assignments, holidays, leaves, covers, rules. Brands are added dynamically, no code change.
7. **Compare options** (header button) – builds Balanced / Preference-first / Fairness-first rosters side by side (coverage, conflicts, preferences missed, weekend-off spread, cells changed) without saving; adopt one with a click.
8. **Approvals** (Problems tab) – each pod lead signs off their pod, then the manager publishes. A sign-off is tied to the roster version, so any later edit marks it *stale*. Pod leads can also request changes (roster returns to draft). Publishing is blocked (409) while mandatory conflicts or pod sign-offs are missing, unless the manager overrides; overrides are logged.
9. Publish / unpublish, CSV export, activity log and in-app notifications when a published roster changes.

StyleHub and PixelCam are *deliberately* sole-resource 365-day brands with no backup, so you can see unavoidable gaps being flagged rather than hidden.

## Assumptions
- Leaves/comp-offs: a week with ≥3 leave days waives one weekly off. Default 1 weekly off, max 6 consecutive working days.
- Boundary weeks are planned as whole Mon–Sun weeks across month borders, so a weekly off can sit in the neighbouring month.
- Backups are standby: they count only when primaries are short, and only if working, shift-compatible and under their daily load cap.
- Holidays in the seed data are illustrative. A day when all of a person's processes are closed is a natural off (WO / H).

## Tell Us How You Think

**1. How did you model employees, brands, processes, pods and their relationships?**
Pods have a lead and members. A brand belongs to a pod and has one or more processes (CS, ACC, NDR, RET…). The *process* is the unit of coverage: it owns the operating calendar (weekdays + whether it opens on public holidays), the minimum staff (default, per weekday, per date) and a shift. Employees link to processes through *assignments* with a role, `primary` or `backup`, so one person can serve many processes across brands and one process can have many people. Leaves, holidays and date-specific covers are separate tables. A brand is "single-resource" or "multi-resource" purely from the data (how many people are assigned), never a flag.

**2. How does the system generate a roster and decide it is valid?**
Fixed statuses go in first (leave, comp-off, never-available weekdays, days the employee's processes are closed). Then weekly offs are placed week by week, tightest-staffed employees first, scoring each candidate day: a huge penalty per newly created shortfall, a bonus for preferred days, weekend fairness, spreading offs across dates, a hard-ish penalty for exceeding the consecutive-days limit. A repair pass then moves offs within the week to remove remaining shortfalls. Validity is a separate pure function (`validateRoster`) used by the generator, the manual editor and the what-if simulator, so there is one definition of "satisfies the constraints". It emits mandatory conflicts (coverage gap, understaffed, leave violation, weekly off short, consecutive work, overload, shift conflict…) and separate soft preference notes.

**3. Single-resource vs multi-resource brands?**
Same model, different behaviour that falls out of the data. With several primaries, the optimiser staggers offs so the minimum is still met and absorbs a leave. With one primary, any off or leave is by definition a gap unless a backup exists. The dashboard calls out "7-day, one person, no backup" brands as structural risk, because no schedule can fix them; the fix is organisational (add a backup).

**4. An employee who runs all of a brand's processes is unavailable on a required day?**
It is flagged as a mandatory COVERAGE_GAP tagged "sole resource, no backup" with the cause (weekly off / leave). **Find fixes** then simulates: another person covers just that date; swap the weekly off to another day; call the person in and owe a comp-off; add a standing backup (structural fix); or record a client-approved exception. Each option shows the new conflicts it would introduce, and only options that actually resolve the gap are offered. Nothing is applied automatically.

**5. Conflicting requirements or insufficient staffing?**
Priority is explicit: mandatory (client coverage, leave, labour rules, capacity) beats preferences, always. Preference misses are reported as info. Genuine shortages are reported as conflicts instead of being silently papered over, and publishing is blocked (409) while mandatory conflicts remain, unless a manager forces it, which is logged. A config problem (e.g. a process with nobody assigned) is surfaced as its own conflict.

**6. What is automated and what stays human?**
Automated: the first-draft roster, validation, impact analysis, fix suggestions, minimal repair after a change, notifications on edits to a published roster. Human: approving leaves, pod-lead sign-off and manager publish, choosing among resolutions (they trade cost to people vs client risk), forcing a publish with open conflicts, granting client exceptions. These are judgement calls with consequences for real people, so the system recommends and simulates but a manager decides.

**7. If the company doubled its team and brand count?**
The engine is already O(employees × days) with indexed lookups, so size is fine for hundreds of people. I would move from SQLite to Postgres, add auth and roles (pod lead sees only their pod, manager sees all), run generation as a background job per pod, replace the greedy week-by-week optimiser with a constraint solver (OR-Tools CP-SAT) for global optimality on the tight pods, and add pagination/virtualisation in the grid.

**8. One more week?**
First: real authentication (pod leads can currently approve from the UI without logging in), then a real notification channel (email/Slack) for published-roster changes. Next: a solver-based optimiser (CP-SAT), Excel/Sheets export, AI-written conflict explanations, shift-level (not just day-level) rostering, leave balances and approval workflow, and fairness reporting over several months (weekend and night distribution).

## Project layout
```
server/engine/   dates, rules, generate, validate, suggest, ops   (pure functions, no I/O)
server/          db.js (SQLite), app.js (Express API), seed.js, index.js
public/          vanilla-JS SPA, no build step
tests/           engine + API tests (node --test)
```

## Deploy
- **Render**: push to GitHub → New Web Service → pick the repo (`render.yaml` is picked up). Free tier re-seeds demo data on restart.
- **Docker**: `docker build -t roster . && docker run -p 3000:3000 -v roster-data:/data roster`
