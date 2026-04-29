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

  // Server-side quota check (only for first call of an analysis)
  const isFirstCall = req.body?.isFirstCall === true;
  if (isFirstCall) {
    const quota = await checkQuota(req.body?.idToken);
    if (!quota.allowed) {
      const message = quota.reason === 'quota_exceeded'
        ? '월 무료 한도(3회)를 초과했습니다.'
        : (quota.reason === 'invalid_token' || quota.reason === 'missing_token'
          ? '인증이 필요합니다. 다시 로그인 후 시도해주세요.'
          : '서버 설정 오류입니다. 관리자에게 문의해주세요.');
      return res.status(403).json({
        error: { type: quota.reason, message },
      });
    }
    // Stash for downstream use (e.g. R3 increment).
    req._usageContext = quota;
  }

  // Strip our custom fields before forwarding to Anthropic
  const upstreamBody = { ...req.body };
  delete upstreamBody.idToken;
  delete upstreamBody.isFirstCall;
  delete upstreamBody.feature;

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

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(decoder.decode(value, { stream: true }));
      }
      res.end();
    } else {
      const data = await response.json();
      res.status(response.status).json(data);
    }
  } catch (error) {
    console.error('Proxy error:', error);
    res.status(500).json({ error: error.message });
  }
};
