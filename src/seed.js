// Optional: create a couple of demo users so you can see the channel immediately.
// Run with: npm run seed
import { Users } from './db.js';

function dateInDays(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const existing = Users.all();
if (existing.length > 0) {
  console.log(`Users already exist (${existing.length}). Skipping seed.`);
  process.exit(0);
}

const demos = [
  { username: 'Alice', plan_id: 'pro', expires_at: dateInDays(90) },      // active
  { username: 'Bob', plan_id: 'standard', expires_at: dateInDays(4) },     // expiring soon
  { username: 'Charlie', plan_id: 'standard', expires_at: dateInDays(-3) },// expired
];

for (const d of demos) {
  const u = Users.create(d);
  console.log(`Created ${u.username}: token=${u.token}  plan=${u.plan_id}  expires=${u.expires_at}`);
}
console.log('\nDone. Open the admin panel at /admin to manage users and copy their m3u links.');
