// POST /api/group-join
//   body: { inviteToken }
//   auth: Authorization: Bearer <Firebase ID token>
//
// Adds the caller as a member of a lectureGroup identified by inviteToken.
// Idempotent: if the caller is already a member, returns the group info
// without re-adding (so re-clicking the invite link does nothing harmful).
//
// We use a transaction so the array union on `memberUids` and the per-member
// sub-doc creation happen atomically — otherwise a half-join could leave a
// member with read access but no settlement row, or vice versa.

const { getAdmin } = require('./_firebase-admin');
const {
  setCors,
  verifyUser,
  findGroupByToken,
  isValidInviteToken,
} = require('./_group_admin');

const MAX_MEMBERS_PER_GROUP = 30;

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

  const inviteToken = String(body?.inviteToken || '').trim().toLowerCase();
  if (!isValidInviteToken(inviteToken)) {
    return res.status(400).json({ error: 'bad_token' });
  }

  const groupSnap = await findGroupByToken(inviteToken);
  if (!groupSnap) return res.status(404).json({ error: 'group_not_found' });

  const admin = getAdmin();
  const db = admin.firestore();
  const FV = admin.firestore.FieldValue;
  const groupRef = groupSnap.ref;
  const groupData = groupSnap.data();

  // ── Already a member? Idempotent return. ──────────────────────────────
  if (Array.isArray(groupData.memberUids) && groupData.memberUids.includes(user.uid)) {
    return res.status(200).json({
      groupId: groupSnap.id,
      lectureName: groupData.lectureName,
      memberCount: groupData.memberUids.length,
      already: true,
    });
  }

  // ── Cap to keep memberUids array (and member doc fanout) bounded. ─────
  if ((groupData.memberUids?.length || 0) >= MAX_MEMBERS_PER_GROUP) {
    return res.status(403).json({ error: 'group_full', cap: MAX_MEMBERS_PER_GROUP });
  }

  try {
    await db.runTransaction(async (tx) => {
      // Re-read inside tx to avoid races on memberUids array.
      const fresh = await tx.get(groupRef);
      if (!fresh.exists) throw new Error('group_disappeared');
      const data = fresh.data();
      if (data.status !== 'active') throw new Error('group_inactive');

      const members = Array.isArray(data.memberUids) ? data.memberUids : [];
      if (members.includes(user.uid)) return;  // race-safe no-op
      if (members.length >= MAX_MEMBERS_PER_GROUP) throw new Error('group_full');

      tx.update(groupRef, {
        memberUids: FV.arrayUnion(user.uid),
        updatedAt: FV.serverTimestamp(),
      });
      tx.set(groupRef.collection('members').doc(user.uid), {
        joinedAt: FV.serverTimestamp(),
        role: 'member',
        shareAmount: 0,        // member declares + marks paid via client write
        sharePaid: false,
        shareMethod: null,
      });
    });
  } catch (err) {
    console.error('[group-join] tx failed', err.message);
    if (err.message === 'group_full') {
      return res.status(403).json({ error: 'group_full', cap: MAX_MEMBERS_PER_GROUP });
    }
    if (err.message === 'group_inactive') {
      return res.status(403).json({ error: 'group_inactive' });
    }
    return res.status(500).json({ error: 'join_failed', detail: err.message });
  }

  console.log(`[group-join] uid=${user.uid} gid=${groupSnap.id}`);

  const fresh = await groupRef.get();
  const freshData = fresh.data();
  return res.status(200).json({
    groupId: groupSnap.id,
    lectureName: freshData.lectureName,
    memberCount: (freshData.memberUids || []).length,
    already: false,
  });
};
