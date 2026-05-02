const fetch = globalThis.fetch || require('node-fetch');
const { getAdmin } = require('./_firebase-admin');

const rateLimit = new Map();
const RATE_LIMIT = 10; // requests per minute
const RATE_WINDOW = 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimit.entries()) {
    if (now - entry.start > RATE_WINDOW * 2) rateLimit.delete(key);
  }
}, 60 * 1000);

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = rateLimit.get(ip) || { count: 0, start: now };
  if (now - entry.start > RATE_WINDOW) {
    entry.count = 1; entry.start = now;
  } else {
    entry.count++;
  }
  rateLimit.set(ip, entry);
  return entry.count <= RATE_LIMIT;
}

const ALLOWED_ORIGINS = [
  'https://lazyuniv-ai.vercel.app',  // production
  'http://localhost:3000',               // local dev
];

const DEVELOPER_EMAILS = ['jhyun.kim35@gmail.com'];

// Server-side quota gate. Returns { allowed, reason?, uid?, slot?, email? }
async function checkQuota(idToken) {
  if (!idToken) {
    return { allowed: false, reason: 'missing_token' };
  }
  let admin;
  try {
    admin = getAdmin();
  } catch (e) {
    console.error('[checkQuota] admin init failed:', e.message);
    return { allowed: false, reason: 'admin_init_failed' };
  }

  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(idToken);
  } catch (e) {
    console.error('[checkQuota] token verify failed:', e.message);
    return { allowed: false, reason: 'invalid_token' };
  }

  const uid = decoded.uid;
  const email = decoded.email || '';

  // Developer bypass — unlimited
  if (DEVELOPER_EMAILS.includes(email)) {
    return { allowed: true, uid, email, slot: 'developer' };
  }

  const ref = admin.firestore().collection('users').doc(uid);
  const snap = await ref.get();
  const data = snap.exists ? snap.data() : {};

  const now = new Date();

  // Monthly plan with valid expiry — unlimited
  const plan = data.plan || 'free';
  const planExpiry = data.planExpiry ? new Date(data.planExpiry) : null;
  if (plan === 'monthly' && planExpiry && planExpiry > now) {
    return { allowed: true, uid, email, slot: 'monthly' };
  }

  // Free tier — 3 per month
  const monthKey = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
  const monthCount = (data.usage && data.usage[monthKey]) || 0;
  if (monthCount < 3) {
    return { allowed: true, uid, email, slot: 'free', monthKey };
  }

  // Single-purchase quota
  const singlePurchases = data.singlePurchases || 0;
  if (singlePurchases > 0) {
    return { allowed: true, uid, email, slot: 'single', monthKey };
  }

  return { allowed: false, reason: 'quota_exceeded', uid, email, monthCount };
}

module.exports = async (req, res) => {
  const origin = req.headers.origin || '';
  if (!ALLOWED_ORIGINS.some(o => origin === o)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  res.setHeader('Access-Control-Allow-Origin', origin);

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const xff = req.headers['x-forwarded-for'] || '';
  const ip = xff.split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Too many requests. Please wait.' });
  }

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'API key not configured' });
  }

  // ─────────────────────────────────────────────────────────────────
  // B1: Quota check & billing — analysisId-based
  //
  // Old model: client sends `isFirstCall: true` on its first request of an
  // analysis. Quota was checked + decremented on that flag. Problem: the
  // client could just send `isFirstCall: false` on every call from the
  // browser console and bypass billing entirely.
  //
  // New model: client generates a UUID per analysis and sends it as
  // `analysisId` on EVERY call of that analysis (auto-injected from a
  // module-level variable in api.js). The server treats the FIRST request
  // for any given analysisId as the billable event, regardless of any
  // client-supplied flag. Subsequent calls with the same id pass through
  // for free because the analysis was already billed.
  //
  // Idempotency: writes are wrapped in a Firestore transaction that
  // creates an `analysisSessions/{analysisId}` doc and increments usage
  // atomically. Two concurrent requests with the same id race on the
  // create — only one wins, the other becomes a no-op replay.
  //
  // Backward compat: requests without analysisId fall back to the legacy
  // isFirstCall path so any old client / non-pipeline call (quiz,
  // classify, vision) keeps working unchanged.
  //
  // The analysisSessions collection is configured with a TTL on
  // `expireAt` in GCP Console → Firestore → TTL policies. We write
  // expireAt = now + 7 days so docs are deleted ~7 days after creation.
  // (Firestore TTL deletes when the timestamp value is older than the
  // current time, so we cannot use createdAt directly — that would
  // trigger immediate deletion.)
  // ─────────────────────────────────────────────────────────────────
  const analysisId = typeof req.body?.analysisId === 'string' ? req.body.analysisId : null;
  const feature = req.body?.feature || 'unknown';
  const isFirstCall = req.body?.isFirstCall === true;

  // billCtx records what the request needs at billOnSuccess time:
  //   { mode: 'analysisId', sessionRef, quota, alreadyBilled }  — new path
  //   { mode: 'legacy', uid, slot, monthKey }                   — old isFirstCall
  //   null                                                       — no billing
  let billCtx = null;

  // Only feature='noteAnalysis' is currently a billable feature. quiz,
  // classify, vision, essayGrade are part of the free tier — keep them
  // out of the quota system entirely so users can drill notes without
  // burning their analysis count.
  const isBillable = feature === 'noteAnalysis';

  if (isBillable && analysisId) {
    // New path: analysisId-driven idempotent billing.
    let admin;
    try {
      admin = getAdmin();
    } catch (e) {
      console.error('[B1] admin init failed:', e.message);
      return res.status(500).json({ error: { type: 'admin_init_failed', message: '서버 설정 오류입니다.' } });
    }

    // Verify token before touching Firestore — checkQuota does this too,
    // but we need uid first to build the session ref.
    let decoded;
    try {
      decoded = await admin.auth().verifyIdToken(req.body?.idToken);
    } catch (e) {
      return res.status(403).json({ error: { type: 'invalid_token', message: '인증이 필요합니다. 다시 로그인 후 시도해주세요.' } });
    }
    const uid = decoded.uid;

    // Sanity-check the analysisId shape before using it as a doc id —
    // keep it tight to Firestore-safe characters and a sane length so a
    // hostile client can't pollute the collection with weird ids.
    if (!/^[a-zA-Z0-9_-]{8,64}$/.test(analysisId)) {
      return res.status(400).json({ error: { type: 'bad_analysis_id', message: '잘못된 분석 ID 형식.' } });
    }

    const sessionRef = admin.firestore()
      .collection('users').doc(uid)
      .collection('analysisSessions').doc(analysisId);

    let sessionDoc;
    try {
      sessionDoc = await sessionRef.get();
    } catch (e) {
      console.error('[B1] sessionRef.get failed:', e.message);
      // Fail open — don't block usable analyses on a Firestore hiccup.
      // Worst case: this call goes unbilled. Better than 500-erroring the
      // user mid-pipeline.
      sessionDoc = { exists: false, _readFailed: true };
    }

    if (sessionDoc.exists) {
      // Already billed earlier in this analysis — let the request through.
      billCtx = { mode: 'analysisId', alreadyBilled: true };
    } else if (sessionDoc._readFailed) {
      // Couldn't verify state. Don't bill, don't block.
      billCtx = { mode: 'analysisId', alreadyBilled: true, _readFailed: true };
    } else {
      // First call for this analysis — full quota check.
      const quota = await checkQuota(req.body?.idToken);
      if (!quota.allowed) {
        const message = quota.reason === 'quota_exceeded'
          ? '월 무료 한도(3회)를 초과했습니다.'
          : (quota.reason === 'invalid_token' || quota.reason === 'missing_token'
            ? '인증이 필요합니다. 다시 로그인 후 시도해주세요.'
            : '서버 설정 오류입니다. 관리자에게 문의해주세요.');
        return res.status(403).json({ error: { type: quota.reason, message } });
      }
      billCtx = { mode: 'analysisId', alreadyBilled: false, sessionRef, quota, uid };
    }
  } else if (isBillable && isFirstCall) {
    // Legacy path: old client without analysisId. Keep the existing
    // behavior so nothing breaks while clients are mid-roll-out.
    const quota = await checkQuota(req.body?.idToken);
    if (!quota.allowed) {
      const message = quota.reason === 'quota_exceeded'
        ? '월 무료 한도(3회)를 초과했습니다.'
        : (quota.reason === 'invalid_token' || quota.reason === 'missing_token'
          ? '인증이 필요합니다. 다시 로그인 후 시도해주세요.'
          : '서버 설정 오류입니다. 관리자에게 문의해주세요.');
      return res.status(403).json({ error: { type: quota.reason, message } });
    }
    billCtx = { mode: 'legacy', alreadyBilled: false, uid: quota.uid, slot: quota.slot, monthKey: quota.monthKey };
  }

  req._billCtx = billCtx;

  // Strip our custom fields before forwarding to Anthropic
  const upstreamBody = { ...req.body };
  delete upstreamBody.idToken;
  delete upstreamBody.isFirstCall;
  delete upstreamBody.feature;
  delete upstreamBody.analysisId;

  // Bill the user for this analysis on success. Idempotent at three levels:
  //   1. The `billed` flag prevents double-bill within a single request even
  //      if called from both stream + non-stream branches.
  //   2. analysisId mode wraps the create+increment in a Firestore transaction
  //      so two concurrent requests with the same analysisId race on the
  //      sessionDoc create — only one wins, the other becomes a no-op.
  //   3. alreadyBilled context flag short-circuits when an earlier call in
  //      the same analysis already paid.
  let billed = false;
  async function billOnSuccess() {
    if (billed) return;
    billed = true;

    const ctx = req._billCtx;
    if (!ctx || ctx.alreadyBilled) return;

    try {
      const admin = getAdmin();

      if (ctx.mode === 'analysisId') {
        // New path: atomic session create + usage decrement.
        const { sessionRef, quota, uid } = ctx;
        if (!sessionRef || !quota || !uid) return;
        // Developer/monthly slots are unlimited — still record the session
        // doc so future calls in the same analysis short-circuit on the
        // alreadyBilled branch (saves a quota check).
        await admin.firestore().runTransaction(async (tx) => {
          const fresh = await tx.get(sessionRef);
          if (fresh.exists) return; // another concurrent request already billed

          // expireAt = now + 7 days. Stored as a client-computed Timestamp
          // (not serverTimestamp) because TTL policies need a concrete
          // future time to compare against, not a sentinel.
          const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
          tx.create(sessionRef, {
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            expireAt: admin.firestore.Timestamp.fromMillis(Date.now() + SEVEN_DAYS_MS),
            feature: 'noteAnalysis',
            slot: quota.slot,
          });

          if (quota.slot === 'developer' || quota.slot === 'monthly') return;

          const userRef = admin.firestore().collection('users').doc(uid);
          if (quota.slot === 'free' && quota.monthKey) {
            tx.set(
              userRef,
              { usage: { [quota.monthKey]: admin.firestore.FieldValue.increment(1) } },
              { merge: true }
            );
          } else if (quota.slot === 'single') {
            tx.set(
              userRef,
              { singlePurchases: admin.firestore.FieldValue.increment(-1) },
              { merge: true }
            );
          }
        });
      } else if (ctx.mode === 'legacy') {
        // Old isFirstCall path — keep working for any client that hasn't
        // been updated to send analysisId yet.
        if (ctx.slot === 'developer' || ctx.slot === 'monthly') return;
        const ref = admin.firestore().collection('users').doc(ctx.uid);
        if (ctx.slot === 'free' && ctx.monthKey) {
          await ref.set(
            { usage: { [ctx.monthKey]: admin.firestore.FieldValue.increment(1) } },
            { merge: true }
          );
        } else if (ctx.slot === 'single') {
          await ref.set(
            { singlePurchases: admin.firestore.FieldValue.increment(-1) },
            { merge: true }
          );
        }
      }
    } catch (e) {
      // Fail open — don't block the user response on billing error.
      console.error('[bill] failed:', e.message);
    }
  }

  try {
    const isStream = upstreamBody.stream === true;
    const MAX_RETRIES = 3;
    const RETRY_DELAY_MS = 2000;

    let response;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'prompt-caching-2024-07-31,advisor-tool-2026-03-01',
        },
        body: JSON.stringify(upstreamBody),
      });

      if (response.status !== 529 || attempt === MAX_RETRIES) break;
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
    }

    if (isStream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      // Only bill if upstream returned 2xx — otherwise we're streaming an
      // error envelope and the user got nothing usable.
      const upstreamOk = response.ok;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(decoder.decode(value, { stream: true }));
        }
        if (upstreamOk) await billOnSuccess();
      } finally {
        res.end();
      }
    } else {
      const data = await response.json();
      if (response.ok) await billOnSuccess();
      res.status(response.status).json(data);
    }
  } catch (error) {
    console.error('Proxy error:', error);
    res.status(500).json({ error: error.message });
  }
};
