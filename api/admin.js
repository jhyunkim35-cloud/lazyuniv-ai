const { getAdmin } = require('./_firebase-admin');

const ALLOWED_ORIGINS = [
  'https://lazyuniv-ai.vercel.app',
  'http://localhost:3000',
];

function setCors(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization');
}

function toIso(val) {
  if (!val) return null;
  if (typeof val.toDate === 'function') return val.toDate().toISOString();
  if (val instanceof Date) return val.toISOString();
  if (typeof val === 'string') return val;
  return null;
}

function serializeUsageDoc(data) {
  if (!data) return null;
  return {
    noteCount:       data.noteCount       || 0,
    quizCount:       data.quizCount       || 0,
    classifyCount:   data.classifyCount   || 0,
    inputTokens:     data.inputTokens     || 0,
    outputTokens:    data.outputTokens    || 0,
    cachedTokens:    data.cachedTokens    || 0,
    sttSeconds:      data.sttSeconds      || 0,
    paymentCount:    data.paymentCount    || 0,
    paymentTotalKRW: data.paymentTotalKRW || 0,
    lastActivityAt:  toIso(data.lastActivityAt),
  };
}

// Last 3 calendar months: current, prev, prev-prev
function last3Months() {
  const now = new Date();
  const months = [];
  for (let i = 0; i < 3; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push(d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'));
  }
  return months;
}

module.exports = async (req, res) => {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });

  const ADMIN_UID = process.env.ADMIN_UID;
  if (!ADMIN_UID) {
    return res.status(503).json({ error: 'admin_not_configured' });
  }

  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'unauthorized' });

  let admin;
  try {
    admin = getAdmin();
  } catch (e) {
    console.error('[admin] admin init failed:', e.message);
    return res.status(500).json({ error: 'server_error' });
  }

  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(token);
  } catch (e) {
    return res.status(401).json({ error: 'invalid_token' });
  }

  if (decoded.uid !== ADMIN_UID) {
    return res.status(403).json({ error: 'forbidden' });
  }

  const action = (req.query?.action || '').toString();
  if (action !== 'overview') {
    return res.status(400).json({ error: 'unknown_action', got: action });
  }

  try {
    const db = admin.firestore();
    const months = last3Months();

    // Paginate: return up to 200 users + optional nextCursor
    const cursor = (req.query?.cursor || '').toString() || null;
    let q = db.collection('users')
      .orderBy(admin.firestore.FieldPath.documentId())
      .limit(201);
    if (cursor) q = q.startAfter(cursor);

    const usersSnap = await q.get();
    const hasMore = usersSnap.docs.length > 200;
    const userDocs = hasMore ? usersSnap.docs.slice(0, 200) : usersSnap.docs;
    const nextCursor = hasMore ? userDocs[199].id : null;

    // Fetch usage subcollections for all users in parallel
    const users = await Promise.all(userDocs.map(async (doc) => {
      const data = doc.data();
      const uid = doc.id;

      const usageEntries = await Promise.all(
        months.map(async (month) => {
          try {
            const snap = await db.collection('users').doc(uid)
              .collection('usage').doc(month).get();
            return [month, snap.exists ? serializeUsageDoc(snap.data()) : null];
          } catch {
            return [month, null];
          }
        })
      );

      const usage = {};
      for (const [month, udata] of usageEntries) {
        if (udata) usage[month] = udata;
      }

      return {
        uid,
        plan:           data.plan           || 'free',
        planExpiry:     data.planExpiry      || null,
        lastOrderId:    data.lastOrderId     || null,
        lastPaymentAt:  data.lastPaymentAt   || null,
        singlePurchases: data.singlePurchases || 0,
        displayName:    data.displayName     || null,
        email:          data.email           || null,
        createdAt:      toIso(data.createdAt) || null,
        usage,
      };
    }));

    const result = { users };
    if (nextCursor) result.nextCursor = nextCursor;
    return res.status(200).json(result);
  } catch (e) {
    console.error('[admin] overview failed:', e);
    return res.status(500).json({ error: 'internal_error', message: e.message });
  }
};
