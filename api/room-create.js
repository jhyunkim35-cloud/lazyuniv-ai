// POST /api/room-create
//   body: { lectureName, schoolCode?, lectureCode? }
//   auth: Authorization: Bearer <Firebase ID token>
//
// Creates a study room — same-lecture peers share study time + progress
// only. Unlike group-create, there's no audio file involved: study rooms
// are pure activity-counter sharing surfaces.
//
// 1. Validates lectureName + optional (schoolCode, lectureCode) pair.
// 2. Creates studyRoom doc + members/<creator> sub-doc in a transaction.
// 3. Member sub-doc starts with all counters at zero; round 3 (activity
//    tracking) will increment them via direct member-row writes.
//
// Returns { roomId, inviteToken }.
//
// No idempotencyKey: unlike group-create, there's no expensive side effect
// (no audio copy). Accidental duplicate rooms are easy to leave + rejoin
// from the UI, and we'd rather keep the endpoint simple.

const { getAdmin } = require('./_firebase-admin');
const {
  setCors,
  verifyUser,
  generateRoomToken,
  normalizeCode,
  isValidLectureCode,
  isValidSchoolCode,
} = require('./_room_admin');

const MAX_LECTURE_NAME = 100;

module.exports = async (req, res) => {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  const user = await verifyUser(req);
  if (!user) return res.status(401).json({ error: 'unauthorized' });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }

  // ── validation ──────────────────────────────────────────────────────────
  const lectureName = String(body?.lectureName || '').trim();
  if (!lectureName || lectureName.length > MAX_LECTURE_NAME) {
    return res.status(400).json({ error: 'bad_lecture_name' });
  }

  // schoolCode + lectureCode are optional but must travel together —
  // having only one half makes code-based join impossible.
  let schoolCode = body?.schoolCode != null ? normalizeCode(String(body.schoolCode)) : null;
  let lectureCode = body?.lectureCode != null ? normalizeCode(String(body.lectureCode)) : null;
  if (schoolCode === '') schoolCode = null;
  if (lectureCode === '') lectureCode = null;
  if ((schoolCode || lectureCode) && !(schoolCode && lectureCode)) {
    return res.status(400).json({ error: 'codes_must_pair' });
  }
  if (schoolCode && !isValidSchoolCode(schoolCode)) {
    return res.status(400).json({ error: 'bad_school_code' });
  }
  if (lectureCode && !isValidLectureCode(lectureCode)) {
    return res.status(400).json({ error: 'bad_lecture_code' });
  }

  const admin = getAdmin();
  const db = admin.firestore();
  const FV = admin.firestore.FieldValue;

  const inviteToken = generateRoomToken();
  const roomRef = db.collection('studyRooms').doc();
  const roomId = roomRef.id;

  // ── create room doc + creator member sub-doc in one transaction ─────────
  // Atomic so a partial state never leaks (room with no members would fail
  // the rules read predicate since it'd have memberUids=[] vs. uid).
  try {
    await db.runTransaction(async (tx) => {
      tx.set(roomRef, {
        createdBy: user.uid,
        lectureName,
        schoolCode: schoolCode || null,
        lectureCode: lectureCode || null,
        inviteToken,
        memberUids: [user.uid],   // satisfies firestore.rules create predicate
        status: 'active',
        createdAt: FV.serverTimestamp(),
        updatedAt: FV.serverTimestamp(),
      });

      tx.set(roomRef.collection('members').doc(user.uid), {
        joinedAt: FV.serverTimestamp(),
        displayName: user.displayName,
        photoURL: user.photoURL,
        studyMinutes: 0,
        notesCount: 0,
        progressPct: 0,
        lastActiveAt: FV.serverTimestamp(),
      });
    });
  } catch (err) {
    console.error('[room-create] firestore tx failed', err.message);
    return res.status(500).json({ error: 'room_create_failed', detail: err.message });
  }

  console.log(
    `[room-create] rid=${roomId} creator=${user.uid} lecture="${lectureName}"` +
    (lectureCode ? ` code=${schoolCode}/${lectureCode}` : '')
  );

  return res.status(200).json({ roomId, inviteToken });
};
