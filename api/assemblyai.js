// AssemblyAI proxy — keeps ASSEMBLYAI_API_KEY server-side. Two endpoints:
//   POST ?action=transcribe — { audio_url } -> { transcript_id }
//   GET  ?action=status&id  — poll status -> { status, text?, error? }
//
// The client uploads audio to Firebase Storage first (already wired for
// slide images) and passes the download URL here. AssemblyAI fetches the
// URL itself, so we never relay audio bytes through Vercel — sidesteps
// the 4.5 MB serverless body limit entirely.
//
// Auth: Firebase ID token in Authorization: Bearer <token>.
// Rate-limit: 30 req/min/IP (status polling allowance).

const fetch = globalThis.fetch || require('node-fetch');
const { getAdmin } = require('./_firebase-admin');
const { recordUsage } = require('./_usage');

const ASSEMBLYAI_BASE = 'https://api.assemblyai.com/v2';

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

const ALLOWED_ORIGINS = [
  'https://lazyuniv-ai.vercel.app',
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

async function verifyUser(req) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return null;
  try {
    const admin = getAdmin();
    const decoded = await admin.auth().verifyIdToken(token);
    return { uid: decoded.uid, email: decoded.email };
  } catch (e) {
    return null;
  }
}

// Allow only Firebase Storage URLs that belong to our project. Prevents
// abusing this proxy as a generic STT-on-arbitrary-URL service.
function isAllowedAudioUrl(url) {
  try {
    const u = new URL(url);
    if (!/^https:$/i.test(u.protocol)) return false;
    // Firebase Storage download URLs:
    //   https://firebasestorage.googleapis.com/v0/b/<bucket>/o/...
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

module.exports = async (req, res) => {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  const ip = req.headers['x-forwarded-for'] || req.connection?.remoteAddress || 'unknown';
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'rate_limited' });
  }

  const user = await verifyUser(req);
  if (!user) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const apiKey = process.env.ASSEMBLYAI_API_KEY;
  if (!apiKey) {
    console.error('[assemblyai] missing ASSEMBLYAI_API_KEY env');
    return res.status(500).json({ error: 'server_misconfigured' });
  }

  const action = (req.query?.action || '').toString();

  try {
    if (action === 'transcribe' && req.method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch { body = {}; }
      } else if (Buffer.isBuffer(body)) {
        try { body = JSON.parse(body.toString('utf8')); } catch { body = {}; }
      }
      const audio_url = body?.audio_url;
      if (!audio_url || typeof audio_url !== 'string') {
        return res.status(400).json({ error: 'missing_audio_url' });
      }
      if (!isAllowedAudioUrl(audio_url)) {
        return res.status(400).json({ error: 'audio_url_not_allowed' });
      }

      const trRes = await fetch(`${ASSEMBLYAI_BASE}/transcript`, {
        method: 'POST',
        headers: {
          'authorization': apiKey,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          audio_url,
          language_code: 'ko',
          speech_model: 'universal',
          speaker_labels: true,
          punctuate: true,
          format_text: true,
        }),
      });
      const trJson = await trRes.json().catch(() => ({}));
      if (!trRes.ok) {
        console.error('[assemblyai transcribe] failed', trRes.status, trJson);
        return res.status(trRes.status).json({ error: 'transcribe_failed', detail: trJson });
      }
      return res.status(200).json({ transcript_id: trJson.id, status: trJson.status });
    }

    if (action === 'status' && req.method === 'GET') {
      const id = (req.query?.id || '').toString();
      if (!id || !/^[A-Za-z0-9_-]{8,128}$/.test(id)) {
        return res.status(400).json({ error: 'bad_id' });
      }

      const stRes = await fetch(`${ASSEMBLYAI_BASE}/transcript/${encodeURIComponent(id)}`, {
        method: 'GET',
        headers: { 'authorization': apiKey },
      });
      const stJson = await stRes.json().catch(() => ({}));
      if (!stRes.ok) {
        console.error('[assemblyai status] failed', stRes.status, stJson);
        return res.status(stRes.status).json({ error: 'status_failed', detail: stJson });
      }

      const payload = {
        status: stJson.status, // queued | processing | completed | error
        audio_duration: stJson.audio_duration ?? null,
      };
      if (stJson.status === 'completed') {
        if (Array.isArray(stJson.utterances) && stJson.utterances.length) {
          // Sum speaking duration per speaker letter; word count is tiebreaker
          const totals = {};
          const wordCounts = {};
          for (const u of stJson.utterances) {
            const s = u.speaker || '?';
            totals[s] = (totals[s] || 0) + ((u.end || 0) - (u.start || 0));
            const wc = Array.isArray(u.words)
              ? u.words.length
              : (u.text || '').trim().split(/\s+/).filter(Boolean).length;
            wordCounts[s] = (wordCounts[s] || 0) + wc;
          }
          // Most speech → speaker 1 (dominant speaker / lecturer)
          const sorted = Object.keys(totals).sort((a, b) => {
            const diff = totals[b] - totals[a];
            return diff !== 0 ? diff : (wordCounts[b] || 0) - (wordCounts[a] || 0);
          });
          const remap = {};
          sorted.forEach((letter, i) => { remap[letter] = i + 1; });

          // Rebuild transcript with "발화자 N: " prefix; blank line on speaker change
          const lines = [];
          let prevNum = null;
          for (const u of stJson.utterances) {
            const num = remap[u.speaker || '?'] ?? '?';
            const text = (u.text || '').trim();
            if (prevNum !== null && num !== prevNum) lines.push('');
            lines.push(`발화자 ${num}: ${text}`);
            prevNum = num;
          }
          payload.text = lines.join('\n');
          payload.utterances = stJson.utterances.map(u => ({
            speaker: remap[u.speaker || '?'] ?? '?',
            text: (u.text || '').trim(),
            start: u.start,
            end: u.end,
          }));
          payload.speaker_count = sorted.length;
        } else {
          if (!stJson.utterances) {
            console.warn('[assemblyai] no utterances field in completed response — returning raw text');
          }
          payload.text = (stJson.text || '').trim();
        }
        // Record STT usage — audio_duration is seconds (float) from AssemblyAI.
        // This fires once per completed-status response; in normal polling the
        // client stops on first 'completed', so double-counting is unlikely.
        try {
          await recordUsage({
            uid: user.uid,
            kind: 'stt',
            increments: { sttSeconds: stJson.audio_duration || 0 },
          });
        } catch (e) {
          console.error('[usage] stt record failed:', e.message);
        }
      } else if (stJson.status === 'error') {
        payload.error_msg = stJson.error || 'transcription_error';
      }
      return res.status(200).json(payload);
    }

    return res.status(404).json({ error: 'unknown_action', got: action });
  } catch (err) {
    console.error('[assemblyai] unhandled', err);
    return res.status(500).json({ error: 'internal_error', message: err.message });
  }
};
