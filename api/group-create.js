// POST /api/group-create
//   body: { lectureName, audioStoragePath, totalCost, expectedMinutes, noteId? }
//   auth: Authorization: Bearer <Firebase ID token>
//
// Creates a cost-splitting group:
// 1. Verifies caller owns the audio file (under users/<uid>/recordings/).
// 2. Generates an invite token + Firestore lectureGroup doc with creator as
//    only initial member (matches firestore.rules create predicate).
// 3. Copies the audio into groupRecordings/<gid>/audio.<ext> via Admin SDK
//    so all future members can read it (Storage rule cross-checks memberUids).
// 4. Writes a `members/<creator>` sub-doc marking the creator as already paid.
// 5. Writes a `recording` sub-doc with metadata (transcript filled later by
//    group-aware STT). No STT is started here — caller hits google-stt next
//    with the returned groupId.
//
// Returns { groupId, inviteToken, audioPath }. Idempotent on retry: if the
// caller passes the same audioStoragePath with `idempotencyKey`, we look for
// an existing active group and return it instead of double-creating.

const { getAdmin } = require('./_firebase-admin');
const {
  generateInviteToken,
  setCors,
  verifyUser,
  getBucket,
  ownsRecordingPath,
} = require('./_group_admin');

const MAX_LECTURE_NAME = 100;
const MAX_TOTAL_COST = 50000;        // sanity cap on declared cost (won)
const MAX_EXPECTED_MINUTES = 300;    // 5 hours upper bound

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

  const lectureName = String(body?.lectureName || '').trim();
  const audioStoragePath = String(body?.audioStoragePath || '').trim();
  const totalCost = Number(body?.totalCost);
  const expectedMinutes = Number(body?.expectedMinutes);
  const noteId = body?.noteId ? String(body.noteId).slice(0, 64) : null;
  const idempotencyKey = body?.idempotencyKey ? String(body.idempotencyKey).slice(0, 64) : null;

  // ── validation ──────────────────────────────────────────────────────────
  if (!lectureName || lectureName.length > MAX_LECTURE_NAME) {
    return res.status(400).json({ error: 'bad_lecture_name' });
  }
  if (!ownsRecordingPath(user.uid, audioStoragePath)) {
    return res.status(400).json({ error: 'bad_audio_path' });
  }
  if (!(totalCost > 0 && totalCost <= MAX_TOTAL_COST)) {
    return res.status(400).json({ error: 'bad_total_cost' });
  }
  if (!(expectedMinutes > 0 && expectedMinutes <= MAX_EXPECTED_MINUTES)) {
    return res.status(400).json({ error: 'bad_expected_minutes' });
  }

  const admin = getAdmin();
  const db = admin.firestore();
  const FV = admin.firestore.FieldValue;

  // ── idempotency: if caller retries with same key, return existing group ──
  if (idempotencyKey) {
    const dup = await db.collection('lectureGroups')
      .where('creatorUid', '==', user.uid)
      .where('idempotencyKey', '==', idempotencyKey)
      .where('status', '==', 'active')
      .limit(1)
      .get();
    if (!dup.empty) {
      const d = dup.docs[0];
      const data = d.data();
      return res.status(200).json({
        groupId: d.id,
        inviteToken: data.inviteToken,
        audioPath: data.groupAudioPath,
        already: true,
      });
    }
  }

  // ── verify source audio exists in Storage before group create ───────────
  const bucket = getBucket();
  const srcFile = bucket.file(audioStoragePath);
  const [srcExists] = await srcFile.exists();
  if (!srcExists) return res.status(404).json({ error: 'audio_not_found' });

  // ── generate group resource names ───────────────────────────────────────
  const inviteToken = generateInviteToken();
  const groupRef = db.collection('lectureGroups').doc();
  const groupId = groupRef.id;

  // Derive a clean extension from the source path (default .webm — recorder.js fallback)
  const ext = (audioStoragePath.match(/\.([a-zA-Z0-9]{1,6})$/) || [null, 'webm'])[1].toLowerCase();
  const groupAudioPath = `groupRecordings/${groupId}/audio.${ext}`;

  // ── copy audio into group bucket path ───────────────────────────────────
  try {
    await srcFile.copy(bucket.file(groupAudioPath));
  } catch (err) {
    console.error('[group-create] storage copy failed', err.message);
    return res.status(500).json({ error: 'storage_copy_failed', detail: err.message });
  }

  // ── create the group doc + creator member sub-doc + recording sub-doc ───
  // Done in a transaction so a partial state never leaks (e.g. group with
  // no members, which would fail subsequent reads).
  try {
    await db.runTransaction(async (tx) => {
      tx.set(groupRef, {
        creatorUid: user.uid,
        lectureName,
        totalCost,
        expectedMinutes,
        noteId: noteId || null,
        inviteToken,
        memberUids: [user.uid],     // satisfies firestore.rules create predicate
        groupAudioPath,             // for client display + STT input
        status: 'active',
        idempotencyKey: idempotencyKey || null,
        createdAt: FV.serverTimestamp(),
        updatedAt: FV.serverTimestamp(),
      });

      tx.set(groupRef.collection('members').doc(user.uid), {
        joinedAt: FV.serverTimestamp(),
        role: 'creator',
        shareAmount: totalCost,    // creator paid full upfront
        sharePaid: true,
        shareMethod: 'toss',
        displayName: user.displayName,
        photoURL: user.photoURL,
      });

      tx.set(groupRef.collection('recording').doc('meta'), {
        audioPath: groupAudioPath,
        transcript: null,
        sttStatus: 'pending',
        operationId: null,
        createdAt: FV.serverTimestamp(),
      });
    });
  } catch (err) {
    console.error('[group-create] firestore tx failed', err.message);
    // Best-effort cleanup of the copied file so we don't leak storage.
    try { await bucket.file(groupAudioPath).delete(); } catch {}
    return res.status(500).json({ error: 'group_create_failed', detail: err.message });
  }

  console.log(`[group-create] gid=${groupId} creator=${user.uid} lecture="${lectureName}"`);

  return res.status(200).json({
    groupId,
    inviteToken,
    audioPath: groupAudioPath,
  });
};
