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

// Distributed rate limit — mirrors api/claude.js. The old in-memory Map was
// a no-op on Vercel (each request can hit a fresh lambda with an empty Map)
// and keyed on IP, which over-limited students sharing one campus NAT. Now a
// per-uid Firestore counter bucketed per wall-clock minute. STT does a
// transcribe submit plus repeated status polls, so the ceiling is generous;
// economic abuse is already bounded by the Storage-URL allowlist below.
const RATE_LIMIT_PER_MIN = 100;
const RATE_BUCKET_MS = 60 * 1000;
const RATE_DOC_TTL_MS = 2 * 60 * 1000;

async function checkRateLimitDistributed(admin, key) {
  // Fail-open on any Firestore error so a transient hiccup never blocks STT.
  try {
    const bucket = Math.floor(Date.now() / RATE_BUCKET_MS);
    const ref = admin.firestore().collection('rateLimits').doc(`${key}_${bucket}`);
    return await admin.firestore().runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const count = snap.exists ? (snap.data().count || 0) : 0;
      if (count >= RATE_LIMIT_PER_MIN) return false;
      tx.set(ref, {
        count: admin.firestore.FieldValue.increment(1),
        expireAt: admin.firestore.Timestamp.fromMillis(Date.now() + RATE_DOC_TTL_MS),
      }, { merge: true });
      return true;
    });
  } catch (e) {
    console.error('[assemblyai rateLimit] fail-open:', e.message);
    return true;
  }
}

const ALLOWED_ORIGINS = [
  'https://lazyuniv-ai.vercel.app',
  'https://notyx.vercel.app',
  'https://notyx.co.kr',
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

  // Verify first so the rate limit can key on uid, not a shared campus IP.
  const user = await verifyUser(req);
  if (!user) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  // Distributed per-uid rate limit. Wrapped so an admin/Firestore failure
  // never blocks STT — the limit is a guard, not a gate.
  try {
    const rlAdmin = getAdmin();
    const allowed = await checkRateLimitDistributed(rlAdmin, `u_${user.uid}`);
    if (!allowed) {
      res.setHeader('Retry-After', '30');
      return res.status(429).json({ error: 'rate_limited' });
    }
  } catch (e) {
    console.error('[assemblyai rateLimit] skipped (admin init failed):', e.message);
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
          speech_models: ['universal'],
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

          // Rebuild transcript with "[hh:mm:ss] 발화자 N:" prefix.
          // Timestamps help the lecturer + student review specific moments,
          // and are also matched by separateSpeakers() (the same pattern
          // it expects from Clova STT). Times are derived from u.start (ms).
          function fmtTs(ms) {
            const total = Math.floor((ms || 0) / 1000);
            const h = Math.floor(total / 3600);
            const m = Math.floor((total % 3600) / 60);
            const s = total % 60;
            const pad = (n) => String(n).padStart(2, '0');
            return `[${pad(h)}:${pad(m)}:${pad(s)}]`;
          }
          const lines = [];
          let prevNum = null;
          for (const u of stJson.utterances) {
            const num = remap[u.speaker || '?'] ?? '?';
            const text = (u.text || '').trim();
            if (prevNum !== null && num !== prevNum) lines.push('');
            lines.push(`${fmtTs(u.start)} 발화자 ${num}: ${text}`);
            prevNum = num;
          }
          payload.text = lines.join('\n');
          // NOTE: We DO NOT include utterances in the response. On long
          // lectures (90+ min) the utterances array can balloon to 2-5 MB,
          // which combined with text pushes the Vercel response past the
          // 4.5 MB serverless body cap → response truncated mid-JSON →
          // client sees only the beginning of `text`. The client only uses
          // `text` anyway, so dropping utterances is lossless for the user.
          payload.speaker_count = sorted.length;
          // Debug: surface size discrepancies that hint at truncation.
          // If raw .text is much longer than our rebuilt text, something
          // dropped during utterance iteration; if utterances are short
          // but raw .text is long, raw .text wins.
          const rawLen = (stJson.text || '').length;
          const rebuiltLen = payload.text.length;
          console.log(`[assemblyai] completed: utterances=${stJson.utterances.length}, speakers=${sorted.length}, raw_text=${rawLen}chars, rebuilt=${rebuiltLen}chars, audio_duration=${stJson.audio_duration}s`);
          // Safety net: if rebuilt is dramatically shorter than raw (>20%
          // gap), the utterances field is incomplete and we'd lose data.
          // Fall back to raw text in that case (loses speaker labels but
          // preserves the lecture content).
          if (rawLen > 0 && rebuiltLen < rawLen * 0.8) {
            console.warn(`[assemblyai] rebuilt text only ${rebuiltLen}/${rawLen} chars — falling back to raw text`);
            payload.text = (stJson.text || '').trim();
            payload.fallback_to_raw = true;
          }
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
