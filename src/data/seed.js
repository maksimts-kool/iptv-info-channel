// CLI shim for `npm run seed`: create a couple of demo users so you can see the
// channel immediately. The actual seeding lives in store.js (seedDemo); this just
// prints the result. No-op if any user already exists.
import { seedDemo } from './store.js';

const { skipped, existing, created } = seedDemo();
if (skipped) {
  console.log(`Users already exist (${existing}). Skipping seed.`);
} else {
  for (const u of created) {
    console.log(`Created ${u.username}: token=${u.token}  plan=${u.plan_id}  expires=${u.expires_at}`);
  }
  console.log('\nDone. Open the admin panel at /admin to manage users and copy their m3u links.');
}
