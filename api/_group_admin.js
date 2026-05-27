// Shared helpers for group-create, group-join, and group-aware STT.
// All membership-mutating writes funnel through these helpers so the
// invariants (token verification, single-creator init, idempotent join)
// live in one place.

const crypto = require('crypto');
const { getAdmin } = require('./_firebase-admin');

// URL-safe token charset: 32 chars, lowercase, no ambiguous (0/O/1/l/i)
const TOKEN_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const TOKEN_LEN = 12;

function generateInviteToken() {
  const bytes = crypto.randomBytes(TOKEN_LEN);
  let s = '';
  for (let i = 0; i < TOKEN_LEN; i++) {
    s += TOKEN_ALPHABET[bytes[i] % TOKEN_ALPHABET.length];
  }
  return s;
}

function isValidInviteToken(t) {
  return typeof t === 'string'
      && t.length === TOKEN_LEN
      && /^[a-z2-9]+$/.test(t);
}

const CORS_ORIGINS = [
  'https://lazyuniv-ai.vercel.app',
  'https://notyx.vercel.app',
  'https://notyx.co.kr',
  'http://localhost:3000',
];

function setCors(req, res) {
  const origin = req.headers.origin;
  if (CORS_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Max-Age', '86400');
  }
}

async function verifyUser(req) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return null;
  try {
    const admin = getAdmin();
    const decoded = await admin.auth().verifyIdToken(token);
    // name/picture come from Firebase Auth (Google profile). Used by the
    // group page to render member rows; we trust this source so members
    // can't spoof each other's display names by writing their own row.
    return {
      uid: decoded.uid,
      email: decoded.email,
      displayName: decoded.name || decoded.email || decoded.uid.slice(0, 8),
      photoURL: decoded.picture || null,
    };
  } catch {
    return null;
  }
}

// Bucket name for Firebase Storage. We accept both legacy + new aliases —
// the actual bucket the app currently uses is `lazyuniv-ai.firebasestorage.app`.
function getBucket() {
  const admin = getAdmin();
  return admin.storage().bucket('lazyuniv-ai.firebasestorage.app');
}

// Verify the audio path belongs to the caller (prevents cross-user theft).
// Accepts paths like `users/<uid>/recordings/<filename>`.
function ownsRecordingPath(uid, storagePath) {
  if (typeof storagePath !== 'string') return false;
  const prefix = `users/${uid}/recordings/`;
  return storagePath.startsWith(prefix) && !storagePath.includes('..');
}

// Look up a group by invite token. Used by group-join.
// Returns the group doc snapshot or null.
async function findGroupByToken(token) {
  if (!isValidInviteToken(token)) return null;
  const admin = getAdmin();
  const db = admin.firestore();
  const q = await db.collection('lectureGroups')
    .where('inviteToken', '==', token)
    .where('status', '==', 'active')
    .limit(1)
    .get();
  if (q.empty) return null;
  return q.docs[0];
}

module.exports = {
  generateInviteToken,
  isValidInviteToken,
  setCors,
  verifyUser,
  getBucket,
  ownsRecordingPath,
  findGroupByToken,
};
