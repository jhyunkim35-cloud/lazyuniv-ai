// Read all in-app bug reports from the bugReports Firestore collection.
// Same admin bootstrap as find-admin-uid.js (.env.local FIREBASE_SERVICE_ACCOUNT).
// Usage: node scripts/read-bug-reports.js
const admin = require('firebase-admin');
const fs = require('fs');

// Service account: pass a JSON key file path as the first arg (preferred —
// no .env editing needed), or fall back to FIREBASE_SERVICE_ACCOUNT in .env.local.
let sa;
const argPath = process.argv[2];
if (argPath) {
  if (!fs.existsSync(argPath)) { console.error('NO_FILE: ' + argPath); process.exit(1); }
  sa = JSON.parse(fs.readFileSync(argPath, 'utf8'));
} else {
  require('dotenv').config({ path: '.env.local', override: true });
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) { console.error('NO_SA: pass a service-account JSON path as the first arg'); process.exit(1); }
  sa = JSON.parse(raw);
}

admin.initializeApp({ credential: admin.credential.cert(sa) });

(async () => {
  const snap = await admin.firestore().collection('bugReports').get();
  console.log('COUNT:', snap.size);
  const docs = [];
  snap.forEach(doc => {
    const d = doc.data();
    const { recentLogs, ...rest } = d; // drop bulky debug logs from the dump
    let ts = null;
    try { ts = d.createdAt?.toDate?.()?.toISOString?.() || null; } catch (_) {}
    docs.push({
      id: doc.id,
      ts: ts || d.createdAt || d.timestamp || null,
      ...rest,
      _logCount: Array.isArray(recentLogs) ? recentLogs.length : 0,
    });
  });
  docs.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
  docs.forEach(d => console.log('REPORT ' + JSON.stringify(d)));
  process.exit(0);
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });
