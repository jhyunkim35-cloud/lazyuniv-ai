// Find the Firebase Auth UID for the admin user (김준현).
// One-shot script for setting ADMIN_UID Vercel env. Safe to delete after.
//
// Usage: node scripts/find-admin-uid.js
// Requires: .env.local with FIREBASE_SERVICE_ACCOUNT (run `vercel env pull` first)

require('dotenv').config({ path: '.env.local' });
const admin = require('firebase-admin');

const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
if (!raw) {
  console.error('FIREBASE_SERVICE_ACCOUNT not in .env.local — run `vercel env pull`');
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(raw)),
});

(async () => {
  const result = await admin.auth().listUsers(1000);
  console.log(`\nTotal users: ${result.users.length}\n`);
  const matches = result.users.filter(u =>
    (u.displayName || '').includes('김준현') ||
    (u.displayName || '').toLowerCase().includes('jhyun')
  );
  console.log(`Matches for "김준현" / "jhyun":\n`);
  matches.forEach(u => {
    console.log(`  uid:         ${u.uid}`);
    console.log(`  displayName: ${u.displayName}`);
    console.log(`  email:       ${u.email}`);
    console.log(`  created:     ${u.metadata.creationTime}`);
    console.log(`  lastSignIn:  ${u.metadata.lastSignInTime}`);
    console.log('');
  });
  process.exit(0);
})();
