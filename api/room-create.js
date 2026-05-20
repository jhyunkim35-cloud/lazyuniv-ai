// POST /api/room-create
//   body: { lectureName, lectureCode? }
//   auth: Authorization: Bearer <Firebase ID token>
//
// Creates a study room — same-lecture peers share study time + progress
// only. Unlike group-create, there's no audio file involved: study rooms
// are pure activity-counter sharing surfaces.
//
// 1. Validates lectureName + optional lectureCode (the user-chosen short
//    "invite code" used as a verbal alternative to the 12-char URL token).
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
  countActiveRoomsByCreator,
} = require('./_room_admin');

const MAX_LECTURE_NAME = 100;
// Per-user active-room cap. 10 is well above any plausible student
// workload (one room per class would be ~6 max), gives slack for tests
// and rejoins, and bounds the cost of a single abusive account.
const MAX_ROOMS_PER_USER = 10;

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

  // Idempotency: the client generates a fresh key per modal session and
  // sends it on every retry. If we see the same (uid, key) tuple already,
  // we return the existing room instead of double-creating. This handles
  // double-clicks, network retries, and slow connections gracefully. The
  // client-side `submitBtn.disabled` is the first line of defense; this
  // is the backend safety net for cases the client misses (e.g. user
  // hits Enter twice into a still-focused input before the disable lands).
  const idempotencyKey = body?.idempotencyKey
    ? String(body.idempotencyKey).slice(0, 64)
    : null;

  // lectureCode is the user-chosen short identifier ("초대 코드" in UI).
  // Optional — if omitted, the room can only be joined via the auto-token
  // invite link.
  let lectureCode = body?.lectureCode != null ? normalizeCode(String(body.lectureCode)) : null;
  if (lectureCode === '') lectureCode = null;
  if (lectureCode && !isValidLectureCode(lectureCode)) {
    return res.status(400).json({ error: 'bad_lecture_code' });
  }

  const admin = getAdmin();
  const db = admin.firestore();
  const FV = admin.firestore.FieldValue;

  // ── idempotency: if caller retries with same key, return existing room ──
  // We scope the lookup by (createdBy, idempotencyKey) so two users can
  // accidentally pick the same client-generated key without colliding.
  if (idempotencyKey) {
    const dup = await db.collection('studyRooms')
      .where('createdBy', '==', user.uid)
      .where('idempotencyKey', '==', idempotencyKey)
      .where('status', '==', 'active')
      .limit(1)
      .get();
    if (!dup.empty) {
      const existing = dup.docs[0];
      console.log(`[room-create] idem hit rid=${existing.id} creator=${user.uid}`);
      return res.status(200).json({
        roomId: existing.id,
        inviteToken: existing.data().inviteToken,
        idempotent: true,
      });
    }
  }

  // ── per-user active-room cap ────────────────────────────────────────────
  // Cheap server-side count() aggregation (no full doc reads). We check
  // BEFORE the transaction so a user hitting the limit gets a clean 403
  // instead of a half-applied write. Tiny race (two concurrent creates
  // squeezing past the cap) is acceptable — cap is a soft anti-abuse
  // signal, not a hard security invariant.
  try {
    const activeCount = await countActiveRoomsByCreator(user.uid);
    if (activeCount >= MAX_ROOMS_PER_USER) {
      return res.status(403).json({
        error: 'too_many_rooms',
        cap: MAX_ROOMS_PER_USER,
        current: activeCount,
      });
    }
  } catch (err) {
    // count() can fail before the aggregate index is fully provisioned;
    // log + continue rather than blocking legitimate creates.
    console.warn('[room-create] cap check failed (continuing):', err.message);
  }

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
        lectureCode: lectureCode || null,
        inviteToken,
        idempotencyKey: idempotencyKey || null,
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
    (lectureCode ? ` code=${lectureCode}` : '')
  );

  return res.status(200).json({ roomId, inviteToken });
};
