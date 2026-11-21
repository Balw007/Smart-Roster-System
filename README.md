© 2026 Balwinder Singh. All rights reserved. Submitted for assessment; viewing is permitted, copying or reuse is not.

# Smart Roster Management System

Plans a month of staff schedules for a company that looks after many brands: 36 employees, 4 teams (pods) and 25 brands. It spots problems, suggests fixes and lets you test changes before saving them.

**Author:** Balwinder Singh | **Live app:** https://smart-roster-system-jmui.onrender.com | **Demo video:** https://drive.google.com/file/d/1pkXaL5f5Aaq4ZzFFc36cU7b2SK_O957g/view?usp=sharing

> **Note:** The live app runs on a free server that sleeps when idle. Please allow 30-60 seconds for the first load, then refresh if the page looks blank.

## Run it locally

Needs **Node 22.13 or newer**. No database to install.

```bash
npm install
npm start      # http://localhost:3000, loads sample data on first run
npm test       # 22 automated tests
```

Settings are in `.env.example`. There is no login, because this is a single-manager demo.

## What to click

1. **Overview** – the month in plain words: shifts covered, problems left, thin days, brands with no backup.
2. **Schedule** – everyone, every day. Click a day to change it. It shows what the change fixes or breaks, and you can undo it.
3. **Staffing** – people needed vs people working, for each service and day.
4. **Problems** – "must fix" problems vs "nice to have" requests. **Suggest solutions** tests each idea first, then you apply one. Each team lead approves their team here before the manager publishes.
5. **What if?** – try a leave or a change in a brand's needs without saving.
6. **Setup** – brands, employees, teams, holidays and leave.
7. **Compare options** (top button) – builds the month three ways side by side. Pick one.

StyleHub and PixelCam have one person and no backup on purpose, to show how unavoidable gaps are flagged.

## Assumptions

- 1 weekly off per week, at most 6 working days in a row.
- A week with 3 or more leave days gives up one weekly off.
- Weeks run Monday to Sunday, so an off can fall in the neighbouring month.
- Backups only count when the main people are short.

## Tell Us How You Think

**1. How did you model employees, brands, processes, pods and their relationships?**
A pod has a lead and members. A brand belongs to a pod and has processes (CS, ACC, NDR, RET). The process is what must be covered: it has its working days, its minimum people and its shift. Employees are linked to processes as the main person or a backup, so one person can serve many brands and one process can have many people.

**2. How does the system generate a roster and decide it is valid?**
It fills in the fixed days first (leave, comp-offs, closed days). Then it places weekly offs week by week, scoring each day: it avoids shortages most of all, then favours preferences and fair weekends. A last pass fixes leftover gaps. One separate checker decides if a schedule is valid, and the generator, the editor and the What if? screen all use it.

**3. Single-resource vs multi-resource brands?**
It is the same model. With several people, offs are staggered so the brand is always covered. With one person, any off is a gap unless there is a backup, so the dashboard flags it as a risk that only a backup can fix.

**4. An employee who runs all of a brand's processes is unavailable on a required day?**
It shows as a must-fix problem, "only person, no backup". **Suggest solutions** then offers tested options: someone else covers that day, swap the off day, call the person in and give a comp-off, add a permanent backup, or record a client-approved exception. Nothing is applied automatically.

**5. Conflicting requirements or insufficient staffing?**
Must-fix rules (coverage, leave, work-hour limits) always beat preferences. Shortages are shown, never hidden. Publishing is blocked while must-fix problems remain, unless a manager overrides it, and every override is logged.

**6. What is automated and what stays human?**
Automated: the first draft, the checks, the impact of a change, suggested fixes and notices when a published schedule changes. Human: approving leave, team lead sign-off, publishing, choosing between fixes and agreeing exceptions with clients. These affect real people, so a manager decides.

**7. If the company doubled its team and brand count?**
The engine would cope with hundreds of people. I would move to Postgres, add logins and roles, run planning per team in the background, and use a constraint solver (OR-Tools) for the tightest teams.

**8. One more week?**
Real logins first, since team leads can currently approve without signing in. Then email or Slack notifications, a constraint-solver planner, Excel export, planning by shift, leave balances and fairness reports across months.

## Project layout

```
server/engine/   planning rules and checks (pure functions)
server/          SQLite database, API, sample data
public/          plain JavaScript web app, no build step
tests/           engine and API tests
```

## Deploy

- **Render**: New Web Service, pick the repo (Docker runtime, uses the included `Dockerfile`).
- **Docker**: `docker build -t roster . && docker run -p 3000:3000 -v roster-data:/data roster`
