// Shared helpers for room-create, room-join, and (future) room-aware
// activity tracking. Mirrors api/_group_admin.js so the auth + CORS surface
// stays consistent across the cost-splitting groups and study-rooms features.
//
// We re-export the auth helpers verbatim from _group_admin instead of
// duplicating: same Firebase token format, same allowed origins. Tokens use
// the same generator too — they live in different collections so room and
// group tokens with identical strings are unrelated entities.

const { getAdmin } = require('./_firebase-admin');
const {
  setCors,
  verifyUser,
  generateInviteToken,
  isValidInviteToken,
} = require('./_group_admin');

// Room invite tokens use the exact same shape as group invite tokens.
// Wrapped in a named export so callers reading room-create.js see intent
// without having to know the indirection chain.
function generateRoomToken() {
  return generateInviteToken();
}

// "Invite codes" are user-chosen short identifiers (UI shows them as
// "초대 코드"). The creator picks one when making the room ("산심2026",
// "PSYC301", whatever), shares it verbally, and friends type it in to
// join — no need to copy a 12-char auto-token. Internally we keep the
// field name `lectureCode` for schema continuity; UI labels differ.
//
// Normalize aggressively before storage AND lookup: case-folded, all
// whitespace stripped, so " psyc301 " and "PSYC301" both resolve to the
// same row.
function normalizeCode(s) {
  return String(s || '').trim().replace(/\s+/g, '').toUpperCase();
}

// 20 chars covers anything a user would type by hand ("PSYC301",
// "SANSIM2026", "MATH-101A"). Allowed: letters/digits/dot/dash/underscore.
function isValidLectureCode(c) {
  return typeof c === 'string'
      && c.length >= 1
      && c.length <= 20
      && /^[A-Z0-9._-]+$/i.test(c);
}

// Look up a study room by invite token. Mirrors findGroupByToken — only
// active rooms are returned so archived rooms can't be re-joined.
async function findRoomByToken(token) {
  if (!isValidInviteToken(token)) return null;
  const admin = getAdmin();
  const db = admin.firestore();
  const q = await db.collection('studyRooms')
    .where('inviteToken', '==', token)
    .where('status', '==', 'active')
    .limit(1)
    .get();
  if (q.empty) return null;
  return q.docs[0];
}

// Code-based lookup: a single user-chosen code finds an active room. If
// the user picked a generic code that collides with someone else's room
// (e.g. "PSYC301" at two different universities), the first active match
// wins — they can leave and rejoin via the right invite link. Encouraging
// distinctive codes is a UX job, not a backend job.
async function findRoomByLectureCode(lectureCode) {
  const c = normalizeCode(lectureCode);
  if (!isValidLectureCode(c)) return null;
  const admin = getAdmin();
  const db = admin.firestore();
  const q = await db.collection('studyRooms')
    .where('lectureCode', '==', c)
    .where('status', '==', 'active')
    .limit(1)
    .get();
  if (q.empty) return null;
  return q.docs[0];
}

module.exports = {
  setCors,
  verifyUser,
  generateRoomToken,
  isValidInviteToken,
  normalizeCode,
  isValidLectureCode,
  findRoomByToken,
  findRoomByLectureCode,
};
