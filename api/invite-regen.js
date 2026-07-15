// POST /api/invite-regen
//   body: { type: 'group' | 'room', id: <docId> }
//   auth: Authorization: Bearer <Firebase ID token>
//
// Creator-only leak kill-switch: mints a fresh inviteToken for a
// lectureGroup or studyRoom, instantly invalidating any previously shared
// invite link. Both join endpoints look rooms/groups up BY token, so the
// old link 404s the moment this write lands — no grace window.
//
// Must run through the Admin SDK: firestore.rules whitelist client updates
// to ['status', 'updatedAt'] only, so inviteToken is unwritable from the
// client by design (a member can't rotate someone else's token via console).

const { getAdmin } = require('./_firebase-admin');
const {
  setCors,
  verifyUser,
  generateInviteToken,
} = require('./_group_admin');

// type -> { collection, creator-field } mapping. Both features share the
// same token shape/generator; only the collection and ownership field differ.
const TARGETS = {
  group: { col: 'lectureGroups', creatorField: 'creatorUid' },
  room:  { col: 'studyRooms',    creatorField: 'createdBy' },
};

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

  const target = TARGETS[body?.type];
  const id = String(body?.id || '').trim();
  // Firestore doc ids are short opaque strings; bound length to reject junk.
  if (!target || !id || id.length > 128 || id.includes('/')) {
    return res.status(400).json({ error: 'bad_request' });
  }

  const admin = getAdmin();
  const db = admin.firestore();
  const ref = db.collection(target.col).doc(id);

  const snap = await ref.get();
  if (!snap.exists) return res.status(404).json({ error: 'not_found' });

  const data = snap.data();
  if (data[target.creatorField] !== user.uid) {
    return res.status(403).json({ error: 'not_creator' });
  }
  if (data.status !== 'active') {
    return res.status(403).json({ error: 'inactive' });
  }

  const inviteToken = generateInviteToken();
  await ref.update({
    inviteToken,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  console.log(`[invite-regen] uid=${user.uid} type=${body.type} id=${id}`);
  return res.status(200).json({ inviteToken });
};
