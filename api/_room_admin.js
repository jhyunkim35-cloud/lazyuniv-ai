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

// Code-based lookup: returns all active rooms with the given code. The
// caller (room-join) decides how to handle 0 / 1 / 2+ results. With 2+
// matches we surface a `code_collision` error and tell the user to use
// the invite link instead — first-match-wins was silently routing users
// to the wrong room when generic codes ("PSYC301") collided across
// schools, which is bad for trust.
//
// Cap at 10 to bound the query cost; if a code somehow has more than 10
// active rooms it's almost certainly abuse and the user shouldn't be
// joining by code anyway.
async function findActiveRoomsByLectureCode(lectureCode) {
  const c = normalizeCode(lectureCode);
  if (!isValidLectureCode(c)) return [];
  const admin = getAdmin();
  const db = admin.firestore();
  const q = await db.collection('studyRooms')
    .where('lectureCode', '==', c)
    .where('status', '==', 'active')
    .limit(10)
    .get();
  return q.docs;
}

// Count active rooms the user has created. Used by room-create to cap
// total active rooms per user (anti-abuse — without this a single user
// can spam thousands of rooms). 10 is generous for any real use case
// and trivially raisable once we have abuse signals.
async function countActiveRoomsByCreator(uid) {
  const admin = getAdmin();
  const db = admin.firestore();
  // `count()` aggregation skips reading the full docs — just returns the
  // count server-side. Much cheaper than fetching all rooms.
  const snap = await db.collection('studyRooms')
    .where('createdBy', '==', uid)
    .where('status', '==', 'active')
    .count()
    .get();
  return snap.data().count;
}

module.exports = {
  setCors,
  verifyUser,
  generateRoomToken,
  isValidInviteToken,
  normalizeCode,
  isValidLectureCode,
  findRoomByToken,
  findActiveRoomsByLectureCode,
  countActiveRoomsByCreator,
};
