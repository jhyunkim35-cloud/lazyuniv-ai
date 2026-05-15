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

// Lecture/school codes are short identifiers users type to find each
// other's rooms (e.g. "PSYC301" + "SNU"). Normalize aggressively before
// storage AND lookup: case-folded, all whitespace stripped, so " snu " and
// "SNU" both resolve to the same row in findRoomByLectureCode.
function normalizeCode(s) {
  return String(s || '').trim().replace(/\s+/g, '').toUpperCase();
}

// Lecture codes are typically short course identifiers (~10 chars).
// 20 chars covers "MATH-101A", "ECON3030", "PSYC301", etc. Allowed:
// letters/digits/dot/dash/underscore — no spaces (those get normalized
// away upstream, but we still reject anything that slipped through).
function isValidLectureCode(c) {
  return typeof c === 'string'
      && c.length >= 1
      && c.length <= 20
      && /^[A-Z0-9._-]+$/i.test(c);
}

// School codes can be domain-style ("YONSEI.AC.KR") or abbreviated
// ("SNU"). 30 chars accommodates either without becoming a free-text
// field. Same charset rule as lecture codes.
function isValidSchoolCode(c) {
  return typeof c === 'string'
      && c.length >= 1
      && c.length <= 30
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

// Code-based lookup: (schoolCode, lectureCode) together address a single
// "class," but multiple users might race to create rooms for it. We just
// return the first match — duplicate-room cleanup is out of scope. Users
// who land in a different instance than their friends can leave + rejoin
// via invite link (UI in round 2). Codes are normalized again here as a
// safety net in case a caller forgot.
async function findRoomByLectureCode(schoolCode, lectureCode) {
  const s = normalizeCode(schoolCode);
  const l = normalizeCode(lectureCode);
  if (!isValidSchoolCode(s) || !isValidLectureCode(l)) return null;
  const admin = getAdmin();
  const db = admin.firestore();
  const q = await db.collection('studyRooms')
    .where('schoolCode', '==', s)
    .where('lectureCode', '==', l)
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
  isValidSchoolCode,
  findRoomByToken,
  findRoomByLectureCode,
};
