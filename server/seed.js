// Deterministic sample dataset: 4 pods, 36 employees, 25 brands (20 single-resource = 80%, 5 multi-resource),
// 3 operating calendars, shared processes, floaters (standby backups) and a few leaves.
// Two 7-day brands (StyleHub, PixelCam) deliberately have a sole resource and NO backup so the
// roster demonstrates unavoidable weekly-off gaps being flagged instead of hidden.

import { fileURLToPath } from 'node:url';
import { openDb, insert, update, saveCells, touchMeta, loadWorld, loadCells, logActivity, setSetting } from './db.js';
import { generateRoster } from './engine/generate.js';
import { shiftMonth, monthOf } from './engine/dates.js';

const ALL = [0, 1, 2, 3, 4, 5, 6];
const CAL = {
  '365': { operating_days: ALL, open_on_holidays: true }, // every day incl. Sundays and public holidays
  EXHOL: { operating_days: ALL, open_on_holidays: false }, // every day except public holidays
  NOSUN: { operating_days: [1, 2, 3, 4, 5, 6], open_on_holidays: false }, // Sundays and public holidays off
};

const PODS = ['Pod Alpha', 'Pod Beta', 'Pod Gamma', 'Pod Delta'];

// key: [name, pod, role, shift, preferred off dows]
const EMPLOYEES = {
  aarav: ['Aarav Sharma', 0, 'pod_lead', 'DAY', [0, 6]], priya: ['Priya Mehta', 0, 'agent', 'DAY', [6, 0]], rohit: ['Rohit Verma', 0, 'agent', 'DAY', [3]],
  sneha: ['Sneha Patel', 0, 'agent', 'DAY', []], karan: ['Karan Singh', 0, 'agent', 'DAY', [0]], ananya: ['Ananya Nair', 0, 'agent', 'DAY', [3]],
  vikram: ['Vikram Joshi', 0, 'agent', 'DAY', [1]], pooja: ['Pooja Gupta', 0, 'agent', 'FLEX', [5]], arjun: ['Arjun Kumar', 0, 'agent', 'DAY', []],
  divya: ['Divya Reddy', 1, 'pod_lead', 'DAY', []], nikhil: ['Nikhil Desai', 1, 'agent', 'DAY', [0]], shreya: ['Shreya Banerjee', 1, 'agent', 'DAY', [6]],
  aditya: ['Aditya Rao', 1, 'agent', 'EVENING', [6, 0]], kavya: ['Kavya Pillai', 1, 'agent', 'EVENING', [2]], manish: ['Manish Tiwari', 1, 'agent', 'DAY', []],
  riya: ['Riya Malhotra', 1, 'agent', 'DAY', [0]], suresh: ['Suresh Iyer', 1, 'agent', 'DAY', []], nisha: ['Nisha Chauhan', 1, 'agent', 'FLEX', [4]],
  rahul: ['Rahul Bose', 2, 'pod_lead', 'DAY', []], meera: ['Meera Kapoor', 2, 'agent', 'DAY', [5]], tarun: ['Tarun Saxena', 2, 'agent', 'DAY', [6]],
  ankita: ['Ankita Srivastava', 2, 'agent', 'DAY', []], dev: ['Dev Chaturvedi', 2, 'agent', 'DAY', []], pallavi: ['Pallavi Mishra', 2, 'agent', 'DAY', [0]],
  gaurav: ['Gaurav Pandey', 2, 'agent', 'DAY', []], simran: ['Simran Kaur', 2, 'agent', 'DAY', []], varun: ['Varun Agarwal', 2, 'agent', 'FLEX', [3]],
  tejal: ['Tejal Shah', 3, 'pod_lead', 'NIGHT', [0]], prakash: ['Prakash Nagar', 3, 'agent', 'DAY', [6]], swati: ['Swati Dubey', 3, 'agent', 'DAY', [0]],
  harsh: ['Harsh Vyas', 3, 'agent', 'DAY', []], isha: ['Isha Menon', 3, 'agent', 'DAY', []], jatin: ['Jatin Arora', 3, 'agent', 'DAY', []],
  komal: ['Komal Jain', 3, 'agent', 'DAY', [6]], lakshya: ['Lakshya Bhatt', 3, 'agent', 'DAY', []], neha: ['Neha Kulkarni', 3, 'agent', 'FLEX', [2]],
};

// brand: [name, pod, notes, [[process, calendar, minStaff, shift, {dow: min}, primaries[], backups[]], ...]]
const BRANDS = [
  ['UrbanStyle', 0, 'Fashion - dedicated: Priya runs everything, Pooja is standby', [
    ['CS', '365', 1, 'DAY', {}, ['priya'], ['pooja']], ['ACC', 'EXHOL', 1, 'DAY', {}, ['priya'], ['pooja']], ['NDR', 'NOSUN', 1, 'DAY', {}, ['priya'], ['pooja']]]],
  ['DenimCo', 0, 'Fashion - dedicated, Sunday off', [['CS', 'NOSUN', 1, 'DAY', {}, ['rohit'], []], ['NDR', 'NOSUN', 1, 'DAY', {}, ['rohit'], []]]],
  ['StyleHub', 0, 'Fashion - dedicated, 7-day CS with NO backup (demo of unavoidable gaps)', [
    ['CS', '365', 1, 'DAY', {}, ['karan'], []], ['RET', 'EXHOL', 1, 'DAY', {}, ['karan'], []], ['NDR', 'NOSUN', 1, 'DAY', {}, ['karan'], []]]],
  ['ThreadWorks', 0, 'Fashion - 2 people, separate processes', [['CS', 'NOSUN', 1, 'DAY', {}, ['sneha'], []], ['ACC', 'NOSUN', 1, 'DAY', {}, ['arjun'], []]]],
  ['ModernKart', 0, 'Fashion - 3 people, CS shared (2 needed Saturdays), ACC and NDR separate', [
    ['CS', '365', 1, 'DAY', { 6: 2 }, ['aarav', 'ananya'], []], ['ACC', 'EXHOL', 1, 'DAY', {}, ['ananya'], ['pooja']], ['NDR', 'NOSUN', 1, 'DAY', {}, ['vikram'], []]]],
  ['TechNova', 1, 'Electronics - dedicated, Nisha standby', [['CS', 'EXHOL', 1, 'DAY', {}, ['nikhil'], ['nisha']], ['ACC', 'NOSUN', 1, 'DAY', {}, ['nikhil'], ['nisha']]]],
  ['GadgetHub', 1, 'Electronics - dedicated 7-day, Nisha standby', [
    ['CS', '365', 1, 'DAY', {}, ['shreya'], ['nisha']], ['ACC', 'EXHOL', 1, 'DAY', {}, ['shreya'], ['nisha']], ['RET', 'NOSUN', 1, 'DAY', {}, ['shreya'], ['nisha']]]],
  ['SmartGadgets', 1, 'Electronics - 2 people sharing CS (evening shift), NDR with Kavya', [
    ['CS', '365', 1, 'EVENING', { 6: 2 }, ['aditya', 'kavya'], []], ['NDR', 'NOSUN', 1, 'EVENING', {}, ['kavya'], []]]],
  ['AudioPeak', 1, 'Electronics - dedicated, Sunday off', [['CS', 'NOSUN', 1, 'DAY', {}, ['manish'], []], ['NDR', 'NOSUN', 1, 'DAY', {}, ['manish'], []]]],
  ['PixelCam', 1, 'Electronics - dedicated, 7-day CS with NO backup (demo of unavoidable gaps)', [['CS', '365', 1, 'DAY', {}, ['riya'], []], ['ACC', 'NOSUN', 1, 'DAY', {}, ['riya'], []]]],
  ['ChargeUp', 1, 'Electronics - dedicated, Sunday off', [['CS', 'NOSUN', 1, 'DAY', {}, ['suresh'], []], ['NDR', 'NOSUN', 1, 'DAY', {}, ['suresh'], []]]],
  ['VoltGear', 1, 'Electronics - dedicated, Sunday off', [['CS', 'NOSUN', 1, 'DAY', {}, ['divya'], []], ['ACC', 'NOSUN', 1, 'DAY', {}, ['divya'], []], ['RET', 'NOSUN', 1, 'DAY', {}, ['divya'], []]]],
  ['HomeEssentials', 2, 'Home - dedicated, Sunday off', [['CS', 'NOSUN', 1, 'DAY', {}, ['rahul'], []], ['NDR', 'NOSUN', 1, 'DAY', {}, ['rahul'], []]]],
  ['KitchenPro', 2, 'Home - dedicated, Sunday off (Meera also runs CozyHome)', [['CS', 'NOSUN', 1, 'DAY', {}, ['meera'], []]]],
  ['CozyHome', 2, 'Home - dedicated 7-day CS, Varun standby (same employee as KitchenPro)', [['CS', 'EXHOL', 1, 'DAY', {}, ['meera'], ['varun']], ['ACC', 'NOSUN', 1, 'DAY', {}, ['meera'], ['varun']]]],
  ['HomeDecor', 2, 'Home - 3 people on 3 separate processes', [
    ['CS', '365', 1, 'DAY', {}, ['tarun'], ['varun']], ['ACC', 'NOSUN', 1, 'DAY', {}, ['ankita'], []], ['NDR', 'NOSUN', 1, 'DAY', {}, ['dev'], []]]],
  ['PureNest', 2, 'Home - dedicated 7-day, Varun standby', [['CS', '365', 1, 'DAY', {}, ['pallavi'], ['varun']], ['RET', 'EXHOL', 1, 'DAY', {}, ['pallavi'], ['varun']]]],
  ['SleepWell', 2, 'Home - dedicated, Sunday off', [['CS', 'NOSUN', 1, 'DAY', {}, ['gaurav'], []], ['ACC', 'NOSUN', 1, 'DAY', {}, ['gaurav'], []]]],
  ['LinenLuxe', 2, 'Home - dedicated, Sunday off', [['CS', 'NOSUN', 1, 'DAY', {}, ['simran'], []], ['NDR', 'NOSUN', 1, 'DAY', {}, ['simran'], []]]],
  ['GlowSkin', 3, 'Beauty - dedicated night-support brand run by the pod lead, Neha standby', [
    ['CS', '365', 1, 'NIGHT', {}, ['tejal'], ['neha']], ['ACC', 'EXHOL', 1, 'NIGHT', {}, ['tejal'], ['neha']], ['RET', 'NOSUN', 1, 'NIGHT', {}, ['tejal'], ['neha']]]],
  ['NaturalGlow', 3, 'Beauty - 3 people: CS shared (2 on Saturdays), ACC and RET separate', [
    ['CS', '365', 1, 'DAY', { 6: 2 }, ['prakash', 'swati'], []], ['ACC', 'EXHOL', 1, 'DAY', {}, ['swati'], ['neha']], ['RET', 'NOSUN', 1, 'DAY', {}, ['harsh'], []]]],
  ['PureSkin', 3, 'Beauty - dedicated, Sunday off', [['CS', 'NOSUN', 1, 'DAY', {}, ['isha'], []]]],
  ['HerbalCare', 3, 'Beauty - dedicated, Sunday off', [['CS', 'NOSUN', 1, 'DAY', {}, ['jatin'], []], ['RET', 'NOSUN', 1, 'DAY', {}, ['jatin'], []]]],
  ['YogaZen', 3, 'Sports - dedicated 7-day CS, Neha standby', [['CS', 'EXHOL', 1, 'DAY', {}, ['komal'], ['neha']], ['ACC', 'NOSUN', 1, 'DAY', {}, ['komal'], ['neha']]]],
  ['RunnerX', 3, 'Sports - dedicated, Sunday off', [['CS', 'NOSUN', 1, 'DAY', {}, ['lakshya'], []], ['NDR', 'NOSUN', 1, 'DAY', {}, ['lakshya'], []]]],
];

// Illustrative public holidays - fully editable in Setup > Holidays.
const HOLIDAYS = [
  ['2026-01-26', 'Republic Day'], ['2026-03-04', 'Holi'], ['2026-04-03', 'Good Friday'], ['2026-05-01', 'Maharashtra Day'],
  ['2026-08-15', 'Independence Day'], ['2026-10-02', 'Gandhi Jayanti'], ['2026-10-20', 'Dussehra'], ['2026-11-08', 'Diwali'],
  ['2026-11-24', 'Guru Nanak Jayanti'], ['2026-12-25', 'Christmas'],
  ['2027-01-26', 'Republic Day'], ['2027-05-01', 'Maharashtra Day'], ['2027-08-15', 'Independence Day'], ['2027-10-02', 'Gandhi Jayanti'], ['2027-12-25', 'Christmas'],
];

export const defaultDemoMonth = () => shiftMonth(new Date().toISOString().slice(0, 7), 1);

export function clearAll(db) {
  for (const t of ['activity', 'pod_approvals', 'roster_cells', 'roster_meta', 'covers', 'leaves', 'assignments', 'processes', 'brands', 'employees', 'pods', 'holidays', 'settings']) db.exec(`DELETE FROM ${t}`);
}

export function seedDatabase(db, { month = defaultDemoMonth(), generate = true } = {}) {
  const podIds = PODS.map((name) => insert(db, 'pods', { name }).id);
  const emp = {};
  for (const [key, [name, pod, role, shift, prefs]] of Object.entries(EMPLOYEES)) {
    emp[key] = insert(db, 'employees', { code: `EMP${String(Object.keys(emp).length + 1).padStart(3, '0')}`, name, email: `${name.toLowerCase().replace(/\s+/g, '.')}@example.com`, pod_id: podIds[pod], role, shift, preferred_off_days: prefs, unavailable_dows: [], active: true }).id;
  }
  PODS.forEach((_, i) => {
    const lead = Object.entries(EMPLOYEES).find(([, v]) => v[1] === i && v[2] === 'pod_lead');
    update(db, 'pods', podIds[i], { lead_id: emp[lead[0]] });
  });

  for (const [name, pod, notes, procs] of BRANDS) {
    const b = insert(db, 'brands', { name, pod_id: podIds[pod], notes, active: true });
    for (const [pname, cal, min, shift, byDow, prim, back] of procs) {
      const p = insert(db, 'processes', { brand_id: b.id, name: pname, ...CAL[cal], min_staff: min, min_staff_by_dow: byDow, min_staff_by_date: {}, shift, load: 1, active: true });
      for (const k of prim) insert(db, 'assignments', { employee_id: emp[k], process_id: p.id, role: 'primary' });
      for (const k of back) insert(db, 'assignments', { employee_id: emp[k], process_id: p.id, role: 'backup' });
    }
  }
  for (const [date, name] of HOLIDAYS) insert(db, 'holidays', { date, name });
  setSetting(db, 'weekly_offs_per_week', 1);

  // Sample leaves for the demo month and the month before it (approved ones are covered by standby backups)
  const prev = shiftMonth(month, -1);
  for (const m of [prev, month]) {
    insert(db, 'leaves', { employee_id: emp.priya, start_date: `${m}-08`, end_date: `${m}-10`, type: 'PL', status: 'approved', note: 'Family function' });
    insert(db, 'leaves', { employee_id: emp.nikhil, start_date: `${m}-15`, end_date: `${m}-16`, type: 'SL', status: 'approved', note: 'Sick leave' });
    insert(db, 'leaves', { employee_id: emp.pallavi, start_date: `${m}-21`, end_date: `${m}-21`, type: 'COMPOFF', status: 'approved', note: 'Comp-off for holiday work' });
    insert(db, 'leaves', { employee_id: emp.komal, start_date: `${m}-03`, end_date: `${m}-04`, type: 'PL', status: 'approved', note: '' });
  }
  // Pending requests: approving these is the "handle a change" demo
  insert(db, 'leaves', { employee_id: emp.rohit, start_date: `${month}-14`, end_date: `${month}-15`, type: 'PL', status: 'pending', note: 'Sole resource of DenimCo' });
  insert(db, 'leaves', { employee_id: emp.aditya, start_date: `${month}-19`, end_date: `${month}-19`, type: 'PL', status: 'pending', note: 'Saturday needs 2 on SmartGadgets CS' });

  if (generate) {
    const world = loadWorld(db);
    for (const m of [prev, month]) {
      const { cells } = generateRoster(world, m, { existing: loadCells(db, m) });
      saveCells(db, m, cells);
      touchMeta(db, m, { status: 'draft', generated_at: new Date().toISOString() });
      logActivity(db, m, 'GENERATED', `Schedule for ${m} built from sample data.`);
    }
  }
  return { month, employees: Object.keys(emp).length };
}

// CLI: `npm run seed`
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const db = openDb();
  if (process.argv.includes('--force')) clearAll(db);
  const r = seedDatabase(db);
  console.log(`Seeded ${r.employees} employees. Demo month: ${r.month}`);
}
