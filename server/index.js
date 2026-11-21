import { openDb, list } from './db.js';
import { seedDatabase } from './seed.js';
import { createApp } from './app.js';

const db = openDb();
if (list(db, 'employees').length === 0) {
  const r = seedDatabase(db);
  console.log(`Empty database - seeded ${r.employees} employees (demo month ${r.month}).`);
}
const port = process.env.PORT || 3000;
createApp(db).listen(port, () => console.log(`Smart Roster running on http://localhost:${port}`));
