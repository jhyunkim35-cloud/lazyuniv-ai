// Google Cloud Speech-to-Text (Chirp_2) proxy — keeps service account credentials server-side.
//   POST ?action=transcribe — { audio_url, expectedMinutes } -> { operation_id }
//   GET  ?action=status&id  — poll status -> { status, text?, error_msg?, speaker_count?, audio_duration? }
//
// Auth: Firebase ID token in Authorization: Bearer <token>.
// Entitlement: user must have an unconsumed sttEntitlements doc in Firestore.
// Rate-limit: 30 req/min/IP.
//
// Service account: GOOGLE_STT_SERVICE_ACCOUNT env (preferred) or FIREBASE_SERVICE_ACCOUNT.
// The same key material is used to mint a short-lived OAuth2 token scoped to
// https://www.googleapis.com/auth/cloud-platform; the service account must have
// the Cloud Speech-to-Text API role in GCP.

const crypto = require('crypto');
const fetch = globalThis.fetch || require('node-fetch');
const { getAdmin } = require('./_firebase-admin');
const { recordUsage } = require('./_usage');

const SPEECH_BASE = 'https://speech.googleapis.com/v1';

// ── Rate limiting ─────────────────────────────────────────────────────────────
const rateLimit = new Map();
const RATE_LIMIT = 30;
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

// ── CORS ──────────────────────────────────────────────────────────────────────
const ALLOWED_ORIGINS = [
  'https://lazyuniv-ai.vercel.app',
  'https://notyx.vercel.app',
  'http://localhost:3000',
];

function setCors(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Max-Age', '86400');
  }
}

// ── Firebase auth ─────────────────────────────────────────────────────────────
async function verifyUser(req) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return null;
  try {
    const admin = getAdmin();
    const decoded = await admin.auth().verifyIdToken(token);
    return { uid: decoded.uid, email: decoded.email };
  } catch {
    return null;
  }
}

// ── URL validation ────────────────────────────────────────────────────────────
function isAllowedAudioUrl(url) {
  try {
    const u = new URL(url);
    if (!/^https:$/i.test(u.protocol)) return false;
    if (u.hostname !== 'firebasestorage.googleapis.com') return false;
    if (!u.pathname.startsWith('/v0/b/lazyuniv-ai.firebasestorage.app/')
        && !u.pathname.startsWith('/v0/b/lazyuniv-ai.appspot.com/')) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

// ── Google access token (cached per container) ────────────────────────────────
let _cachedToken = null;
let _tokenExpiry = 0;

function getServiceAccount() {
  const raw = process.env.GOOGLE_STT_SERVICE_ACCOUNT || process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('missing GOOGLE_STT_SERVICE_ACCOUNT or FIREBASE_SERVICE_ACCOUNT env var');
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error('service account env is not valid JSON: ' + e.message);
  }
}

function makeJwt(sa) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  })).toString('base64url');
  const signing = `${header}.${payload}`;
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(signing);
  const sig = sign.sign(sa.private_key, 'base64url');
  return `${signing}.${sig}`;
}

async function getAccessToken() {
  const now = Date.now();
  if (_cachedToken && _tokenExpiry > now + 60_000) return _cachedToken;

  const sa = getServiceAccount();
  const jwt = makeJwt(sa);

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    throw new Error(`Google token exchange failed (${res.status}): ${JSON.stringify(json)}`);
  }
  _cachedToken = json.access_token;
  _tokenExpiry = now + (json.expires_in || 3600) * 1000;
  return _cachedToken;
}

// ── Transcript formatting ─────────────────────────────────────────────────────

// Parse Google Duration string "1.234s" → seconds (float)
function parseDuration(d) {
  if (!d) return 0;
  if (typeof d === 'number') return d;
  return parseFloat(d.replace('s', '')) || 0;
}

function fmtTs(seconds) {
  const total = Math.floor(seconds || 0);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return `[${pad(h)}:${pad(m)}:${pad(s)}]`;
}

// With diarization, Google puts all words+speakerTag in the LAST result.
// Prior results contain the plain per-segment transcripts (no speaker info).
function buildTranscript(results) {
  if (!results || results.length === 0) return { text: '', speaker_count: 0, audio_duration: null };

  // Look for words with speaker labels, starting from the last result.
  let diarizedWords = [];
  for (let i = results.length - 1; i >= 0; i--) {
    const alt = (results[i].alternatives || [])[0];
    if (!alt) continue;
    const words = Array.isArray(alt.words) ? alt.words : [];
    const withSpeaker = words.filter(w => w.speakerTag || w.speakerLabel);
    if (withSpeaker.length > 0) {
      diarizedWords = words; // use ALL words from this result (some may lack tag for silence)
      break;
    }
  }

  if (diarizedWords.length === 0) {
    // No diarization info: fall back to concatenating raw segment transcripts
    console.warn('[google-stt] no speaker info in results, falling back to raw transcript');
    const lines = results
      .map(r => ((r.alternatives || [])[0]?.transcript || '').trim())
      .filter(Boolean);
    return { text: lines.join(' '), speaker_count: 0, audio_duration: null };
  }

  // Compute per-speaker totals (duration as primary, word count as tiebreaker)
  const durationTotals = {};
  const wordCounts = {};
  let lastEndTime = 0;
  for (const w of diarizedWords) {
    const spk = String(w.speakerLabel || w.speakerTag || '0');
    const start = parseDuration(w.startTime);
    const end = parseDuration(w.endTime);
    durationTotals[spk] = (durationTotals[spk] || 0) + Math.max(0, end - start);
    wordCounts[spk] = (wordCounts[spk] || 0) + 1;
    if (end > lastEndTime) lastEndTime = end;
  }

  // Most speaking time → 발화자 1
  const sorted = Object.keys(durationTotals).sort((a, b) => {
    const diff = durationTotals[b] - durationTotals[a];
    return diff !== 0 ? diff : (wordCounts[b] || 0) - (wordCounts[a] || 0);
  });
  const remap = {};
  sorted.forEach((spk, i) => { remap[spk] = i + 1; });

  // Group consecutive same-speaker words into utterances
  const utterances = [];
  let current = null;
  for (const w of diarizedWords) {
    const spk = String(w.speakerLabel || w.speakerTag || '0');
    if (!current || current.spk !== spk) {
      if (current) utterances.push(current);
      current = { spk, startTime: parseDuration(w.startTime), words: [] };
    }
    if (w.word) current.words.push(w.word);
  }
  if (current) utterances.push(current);

  // Build "[hh:mm:ss] 발화자 N:" lines — same format as assemblyai.js
  const lines = [];
  let prevNum = null;
  for (const u of utterances) {
    if (!u.words.length) continue;
    const num = remap[u.spk] ?? '?';
    const text = u.words.join(' ').trim();
    if (prevNum !== null && num !== prevNum) lines.push('');
    lines.push(`${fmtTs(u.startTime)} 발화자 ${num}: ${text}`);
    prevNum = num;
  }

  return {
    text: lines.join('\n'),
    speaker_count: sorted.length,
    audio_duration: lastEndTime || null,
  };
}

// ── Handler ───────────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  const ip = req.headers['x-forwarded-for'] || req.connection?.remoteAddress || 'unknown';
  if (!checkRateLimit(ip)) return res.status(429).json({ error: 'rate_limited' });

  const user = await verifyUser(req);
  if (!user) return res.status(401).json({ error: 'unauthorized' });

  const action = (req.query?.action || '').toString();

  try {
    // ── POST ?action=transcribe ───────────────────────────────────────────────
    if (action === 'transcribe' && req.method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch { body = {}; }
      } else if (Buffer.isBuffer(body)) {
        try { body = JSON.parse(body.toString('utf8')); } catch { body = {}; }
      }

      const audio_url = body?.audio_url;
      const expectedMinutes = Number(body?.expectedMinutes) || 0;

      if (!audio_url || typeof audio_url !== 'string') {
        return res.status(400).json({ error: 'missing_audio_url' });
      }
      if (!isAllowedAudioUrl(audio_url)) {
        return res.status(400).json({ error: 'audio_url_not_allowed' });
      }
      if (expectedMinutes <= 0) {
        return res.status(400).json({ error: 'missing_expected_minutes' });
      }

      // ── Entitlement check ─────────────────────────────────────────────────
      const admin = getAdmin();
      const db = admin.firestore();
      const FV = admin.firestore.FieldValue;

      const entQuery = await db
        .collection('users').doc(user.uid)
        .collection('sttEntitlements')
        .where('consumed', '==', false)
        .orderBy('paidAt', 'desc')
        .limit(1)
        .get();

      if (entQuery.empty) {
        return res.status(402).json({ error: 'no_entitlement' });
      }

      const entDoc = entQuery.docs[0];
      const entData = entDoc.data();

      if (entData.minutes < expectedMinutes) {
        return res.status(400).json({
          error: 'audio_exceeds_paid_minutes',
          paid: entData.minutes,
          requested: expectedMinutes,
        });
      }

      // Mark consumed before STT call; rollback if STT fails to start.
      await entDoc.ref.update({
        consumed: true,
        consumedAt: FV.serverTimestamp(),
      });

      // ── Trigger Google Cloud Speech long-running recognition ───────────────
      let operationId;
      try {
        const token = await getAccessToken();
        const sttRes = await fetch(`${SPEECH_BASE}/speech:longrunningrecognize`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            config: {
              model: 'chirp_2',
              languageCode: 'ko-KR',
              enableSpeakerDiarization: true,
              diarizationConfig: { minSpeakerCount: 1, maxSpeakerCount: 6 },
              enableWordTimeOffsets: true,
            },
            audio: { uri: audio_url },
          }),
        });

        const sttJson = await sttRes.json().catch(() => ({}));
        if (!sttRes.ok) {
          console.error('[google-stt transcribe] STT start failed', sttRes.status, JSON.stringify(sttJson));
          await entDoc.ref.update({ consumed: false, consumedAt: null });
          return res.status(sttRes.status).json({ error: 'stt_start_failed', detail: sttJson });
        }

        operationId = sttJson.name;
        if (!operationId) {
          await entDoc.ref.update({ consumed: false, consumedAt: null });
          return res.status(500).json({ error: 'no_operation_id', detail: sttJson });
        }
      } catch (err) {
        try { await entDoc.ref.update({ consumed: false, consumedAt: null }); } catch {}
        throw err;
      }

      // Persist operation_id in entitlement for audit; fire-and-forget
      entDoc.ref.update({ transcriptId: operationId }).catch(() => {});

      console.log(`[google-stt] started op=${operationId} uid=${user.uid} paid=${entData.minutes}min requested=${expectedMinutes}min`);
      return res.status(200).json({ operation_id: operationId, status: 'queued' });
    }

    // ── GET ?action=status&id=... ─────────────────────────────────────────────
    if (action === 'status' && req.method === 'GET') {
      const id = (req.query?.id || '').toString();
      // Google operation IDs are typically numeric strings; allow alphanumeric + safe path chars
      if (!id || !/^[\w./:@-]{1,256}$/.test(id)) {
        return res.status(400).json({ error: 'bad_id' });
      }

      const token = await getAccessToken();
      const opRes = await fetch(`${SPEECH_BASE}/operations/${encodeURIComponent(id)}`, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${token}` },
      });
      const opJson = await opRes.json().catch(() => ({}));

      if (!opRes.ok) {
        console.error('[google-stt status] failed', opRes.status, JSON.stringify(opJson));
        return res.status(opRes.status).json({ error: 'status_failed', detail: opJson });
      }

      // Top-level error from Google API itself
      if (opJson.error) {
        return res.status(200).json({
          status: 'error',
          error_msg: opJson.error.message || 'transcription_error',
        });
      }

      if (!opJson.done) {
        const progressPercent = opJson.metadata?.progressPercent ?? null;
        const status = (progressPercent !== null && progressPercent > 0) ? 'processing' : 'queued';
        return res.status(200).json({ status });
      }

      // done=true but no response means transcription-level failure
      if (!opJson.response) {
        return res.status(200).json({ status: 'error', error_msg: 'transcription_error' });
      }

      const results = opJson.response.results || [];
      const { text, speaker_count, audio_duration } = buildTranscript(results);

      console.log(`[google-stt] completed: results=${results.length} speakers=${speaker_count} text=${text.length}chars audio_duration=${audio_duration}s`);

      // Record STT usage — fire once on first completed poll (same assumption as assemblyai.js)
      try {
        await recordUsage({
          uid: user.uid,
          kind: 'stt',
          increments: { sttSeconds: audio_duration || 0 },
        });
      } catch (e) {
        console.error('[usage] stt record failed:', e.message);
      }

      return res.status(200).json({
        status: 'completed',
        text,
        speaker_count,
        audio_duration,
      });
    }

    return res.status(404).json({ error: 'unknown_action', got: action });
  } catch (err) {
    console.error('[google-stt] unhandled', err);
    return res.status(500).json({ error: 'internal_error', message: err.message });
  }
};
