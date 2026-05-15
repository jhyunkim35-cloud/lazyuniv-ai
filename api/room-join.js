// POST /api/room-join
//   body: { inviteToken } OR { lectureCode }
//   auth: Authorization: Bearer <Firebase ID token>
//
// Adds the caller as a member of a study room. Two lookup paths:
//   1. Invite-token  — 12-char auto-token from the invite link.
//   2. Invite-code   — the user-chosen short code ("초대 코드"). If two
//      rooms picked the same generic code, the first active match wins;
//      users who land in the wrong instance can leave and rejoin via the
//      correct invite link.
//
// Idempotent: already a member -> return existing room info. Same per-room
// member cap as cost-splitting groups (30).

const { getAdmin } = require('./_firebase-admin');
const {
  setCors,
  verifyUser,
  isValidInviteToken,
  findRoomByToken,
  findRoomByLectureCode,
  normalizeCode,
  isValidLectureCode,
} = require('./_room_admin');

const MAX_MEMBERS_PER_ROOM = 30;

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

  // ── resolve which room to join ──────────────────────────────────────────
  // inviteToken wins when both are supplied (more specific = less ambiguous).
  let roomSnap = null;
  const inviteToken = body?.inviteToken
    ? String(body.inviteToken).trim().toLowerCase()
    : null;

  if (inviteToken) {
    if (!isValidInviteToken(inviteToken)) {
      return res.status(400).json({ error: 'bad_token' });
    }
    roomSnap = await findRoomByToken(inviteToken);
    if (!roomSnap) return res.status(404).json({ error: 'room_not_found' });
  } else {
    const lectureCode = body?.lectureCode != null ? normalizeCode(String(body.lectureCode)) : null;
    if (!lectureCode) {
      return res.status(400).json({ error: 'missing_lookup' });
    }
    if (!isValidLectureCode(lectureCode)) return res.status(400).json({ error: 'bad_lecture_code' });
    roomSnap = await findRoomByLectureCode(lectureCode);
    if (!roomSnap) return res.status(404).json({ error: 'room_not_found' });
  }

  const admin = getAdmin();
  const db = admin.firestore();
  const FV = admin.firestore.FieldValue;
  const roomRef = roomSnap.ref;
  const roomData = roomSnap.data();

  // ── already a member? Idempotent return so re-clicking an invite link
  //    is a no-op instead of producing a "joined twice" error. ─────────────
  if (Array.isArray(roomData.memberUids) && roomData.memberUids.includes(user.uid)) {
    return res.status(200).json({
      roomId: roomSnap.id,
      lectureName: roomData.lectureName,
      memberCount: roomData.memberUids.length,
      already: true,
    });
  }

  // ── soft cap so memberUids array (and member doc fanout) stays bounded.
  //    Re-checked inside the transaction below to close the race window. ──
  if ((roomData.memberUids?.length || 0) >= MAX_MEMBERS_PER_ROOM) {
    return res.status(403).json({ error: 'room_full', cap: MAX_MEMBERS_PER_ROOM });
  }

  try {
    await db.runTransaction(async (tx) => {
      // Re-read inside the tx so we don't race two concurrent joins
      // onto a full or just-archived room.
      const fresh = await tx.get(roomRef);
      if (!fresh.exists) throw new Error('room_disappeared');
      const data = fresh.data();
      if (data.status !== 'active') throw new Error('room_inactive');

      const members = Array.isArray(data.memberUids) ? data.memberUids : [];
      if (members.includes(user.uid)) return;   // race-safe no-op
      if (members.length >= MAX_MEMBERS_PER_ROOM) throw new Error('room_full');

      tx.update(roomRef, {
        memberUids: FV.arrayUnion(user.uid),
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
    console.error('[room-join] tx failed', err.message);
    if (err.message === 'room_full') {
      return res.status(403).json({ error: 'room_full', cap: MAX_MEMBERS_PER_ROOM });
    }
    if (err.message === 'room_inactive') {
      return res.status(403).json({ error: 'room_inactive' });
    }
    return res.status(500).json({ error: 'join_failed', detail: err.message });
  }

  console.log(`[room-join] uid=${user.uid} rid=${roomSnap.id}`);

  const fresh = await roomRef.get();
  const freshData = fresh.data();
  return res.status(200).json({
    roomId: roomSnap.id,
    lectureName: freshData.lectureName,
    memberCount: (freshData.memberUids || []).length,
    already: false,
  });
};
