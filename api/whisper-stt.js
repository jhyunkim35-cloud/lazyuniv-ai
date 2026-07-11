// Whisper (Groq) + self-hosted pyannote diarization STT proxy — replaces
// AssemblyAI as the free-tier engine. Two endpoints, same client contract as
// assemblyai.js:
//   POST ?action=transcribe — { audio_url } -> { transcript_id, status }
//   GET  ?action=status&id  — poll status -> { status, text?, speaker_count?, audio_duration? }
//   GET  ?action=labels&id  — late speaker-label upgrade once the worker finishes
//
// U7b: pyannote.ai's hosted API is gone. Diarization now runs on a local
// Python worker (worker/diarize_worker.py) polling a Firestore job queue
// (diarizationJobs/{jobId}). Groq's Whisper still transcribes synchronously
// inside the request; the result is stashed in Storage so the status poll
// (or the worker-backed `labels` action) can merge it with diarization turns
// once the worker finishes.
//
// Auth: Firebase ID token in Authorization: Bearer <token>.
// Rate-limit: same distributed per-uid Firestore counter as assemblyai.js.

const fetch = globalThis.fetch || require('node-fetch');
const crypto = require('crypto');
const { getAdmin } = require('./_firebase-admin');
const { recordUsage } = require('./_usage');
const { mergeTranscript } = require('./_stt_merge');

const GROQ_TRANSCRIBE_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
// Grace window before a still-pending/running diarization job stops blocking
// transcript delivery — the transcript itself is the product, labels are an
// upgrade. See GRACE_MS usage in the status handler below.
const GRACE_MS = 3 * 60 * 1000;
const MAX_AUDIO_BYTES = 95 * 1024 * 1024; // Groq's file-size ceiling has some headroom below 100MB

// Distributed rate limit — identical scheme to api/assemblyai.js.
const RATE_LIMIT_PER_MIN = 100;
const RATE_BUCKET_MS = 60 * 1000;
const RATE_DOC_TTL_MS = 2 * 60 * 1000;

async function checkRateLimitDistributed(admin, key) {
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
    console.error('[whisper-stt rateLimit] fail-open:', e.message);
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

// Allow only Firebase Storage URLs that belong to our project — same guard
// as assemblyai.js / google-stt.js.
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

function getBucket() {
  const admin = getAdmin();
  return admin.storage().bucket('lazyuniv-ai.firebasestorage.app');
}

function tmpPath(uid, jobId) {
  return `stt_tmp/${uid}/${jobId}.json`;
}

// Load the stashed (trimmed) Whisper verbose_json for a job. Throws on
// missing file — callers map that to 404 (uid-scoped path doubles as the
// cross-user access guard).
async function loadStash(uid, jobId) {
  const [buf] = await getBucket().file(tmpPath(uid, jobId)).download();
  return JSON.parse(buf.toString('utf8'));
}

async function meterStt(uid, duration) {
  try {
    await recordUsage({ uid, kind: 'stt', increments: { sttSeconds: Math.round(duration || 0) } });
  } catch (e) {
    console.error('[usage] stt record failed:', e.message);
  }
}

// Firebase download URLs keep the literal file extension before the query string.
function extFromUrl(url) {
  const m = url.split('?')[0].match(/\.(\w{2,5})$/);
  return m ? m[1].toLowerCase() : null;
}

// Read a fetch Response body as JSON, falling back to raw text (truncated)
// so provider error messages surface without ever touching our own keys.
async function safeJson(res) {
  const text = await res.text().catch(() => '');
  try { return JSON.parse(text); } catch { return { message: text.slice(0, 500) }; }
}

// Trim Whisper's verbose_json down to the fields _stt_merge.js needs —
// Groq/OpenAI segments otherwise carry big `tokens` arrays etc. that would
// bloat the Storage tmp file for no benefit.
function trimWhisperResult(json) {
  const segments = Array.isArray(json.segments) ? json.segments.map(s => ({
    start: s.start,
    end: s.end,
    text: s.text,
    no_speech_prob: s.no_speech_prob,
    words: Array.isArray(s.words) ? s.words.map(w => ({ word: w.word, start: w.start, end: w.end })) : undefined,
  })) : [];
  const words = Array.isArray(json.words)
    ? json.words.map(w => ({ word: w.word, start: w.start, end: w.end }))
    : undefined;
  return { duration: json.duration, segments, words };
}

module.exports = async (req, res) => {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  const user = await verifyUser(req);
  if (!user) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  try {
    const rlAdmin = getAdmin();
    const allowed = await checkRateLimitDistributed(rlAdmin, `u_${user.uid}`);
    if (!allowed) {
      res.setHeader('Retry-After', '30');
      return res.status(429).json({ error: 'rate_limited' });
    }
  } catch (e) {
    console.error('[whisper-stt rateLimit] skipped (admin init failed):', e.message);
  }

  const GROQ_API_KEY = process.env.GROQ_API_KEY;
  if (!GROQ_API_KEY) {
    console.error('[whisper-stt] missing GROQ_API_KEY env');
    return res.status(500).json({ error: 'stt_not_configured' });
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

      // 1. Enqueue the (async) diarization job for the local worker to pick up.
      const jobId = crypto.randomUUID();
      const admin = getAdmin();
      await admin.firestore().collection('diarizationJobs').doc(jobId).set({
        uid: user.uid,
        audioUrl: audio_url,
        status: 'pending',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // 2. Transcribe synchronously with Groq Whisper.
      let buf;
      try {
        const audioRes = await fetch(audio_url);
        if (!audioRes.ok) throw new Error(`audio fetch failed (${audioRes.status})`);
        buf = Buffer.from(await audioRes.arrayBuffer());
      } catch (e) {
        console.error('[whisper-stt] audio fetch failed', e.message);
        return res.status(502).json({ error: 'audio_fetch_failed' });
      }
      if (buf.byteLength > MAX_AUDIO_BYTES) {
        return res.status(413).json({ error: 'file_too_large' });
      }

      const ext = extFromUrl(audio_url) || 'webm';
      const form = new FormData();
      form.append('file', new Blob([buf]), `audio.${ext}`);
      form.append('model', 'whisper-large-v3-turbo');
      form.append('language', 'ko');
      form.append('response_format', 'verbose_json');
      form.append('temperature', '0');
      form.append('timestamp_granularities[]', 'word');
      form.append('timestamp_granularities[]', 'segment');
      // U7e: optional vocabulary-biasing prompt (lecture-material terminology
      // extracted client-side). Sanitize defensively even though the client
      // already caps it — Whisper silently keeps only the final 224 tokens.
      if (typeof body?.prompt === 'string') {
        const p = body.prompt.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);
        if (p) form.append('prompt', p);
      }

      const groqRes = await fetch(GROQ_TRANSCRIBE_URL, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${GROQ_API_KEY}` },
        body: form,
      });
      const groqJson = await safeJson(groqRes);
      if (!groqRes.ok) {
        console.error('[whisper-stt] groq transcribe failed', groqRes.status, groqJson);
        return res.status(502).json({ error: 'transcribe_failed', detail: groqJson });
      }

      // 3. Persist the (trimmed) Whisper result for the status poll to merge later.
      try {
        const bucket = getBucket();
        await bucket.file(tmpPath(user.uid, jobId)).save(
          JSON.stringify(trimWhisperResult(groqJson)),
          { contentType: 'application/json' }
        );
      } catch (e) {
        console.error('[whisper-stt] persist whisper result failed', e.message);
        return res.status(500).json({ error: 'persist_failed' });
      }

      return res.status(200).json({ transcript_id: jobId, status: 'queued' });
    }

    if (action === 'status' && req.method === 'GET') {
      const id = (req.query?.id || '').toString();
      if (!id || !/^[A-Za-z0-9_-]{8,128}$/.test(id)) {
        return res.status(400).json({ error: 'bad_id' });
      }

      const admin = getAdmin();
      const jobSnap = await admin.firestore().collection('diarizationJobs').doc(id).get();
      if (!jobSnap.exists) {
        return res.status(404).json({ error: 'not_found' });
      }
      const job = jobSnap.data();
      const jstatus = job.status;

      if (jstatus === 'failed') {
        // Diarization failed — the transcript is worth more than the speaker
        // labels, so never fail the whole job over it. Fall back to plain
        // unlabeled Whisper text.
        try {
          const whisper = await loadStash(user.uid, id);
          const { text } = mergeTranscript(whisper, null);
          await meterStt(user.uid, whisper.duration);
          return res.status(200).json({
            status: 'completed',
            text,
            speaker_count: 0,
            audio_duration: whisper.duration ?? null,
            diarization_failed: true,
          });
        } catch (e) {
          console.error('[whisper-stt] diarization-failed fallback load failed', e.message);
          return res.status(404).json({ error: 'not_found' });
        }
      }

      if (jstatus === 'succeeded') {
        // Succeeded — merge diarization turns with the stashed Whisper result.
        const turns = Array.isArray(job.turns) ? job.turns : [];
        let whisper;
        try {
          whisper = await loadStash(user.uid, id);
        } catch (e) {
          // Missing tmp file — expired, or the job belongs to another uid
          // (uid-scoped path). Either way: not found.
          return res.status(404).json({ error: 'not_found' });
        }

        const { text, speakerCount } = mergeTranscript(whisper, turns);
        const audio_duration = whisper.duration ?? null;
        await meterStt(user.uid, audio_duration);

        // Tmp file is intentionally NOT deleted here: if this response is lost
        // in transit the client re-polls, and the merge must stay reproducible.
        // Cleanup = Storage lifecycle rule on the stt_tmp/ prefix (console).

        return res.status(200).json({
          status: 'completed',
          text,
          speaker_count: speakerCount,
          audio_duration,
        });
      }

      // 'pending' / 'running' (and any other not-yet-terminal status): the
      // worker hasn't finished diarizing yet. Keep the client polling inside
      // the grace window; past it, the transcript is worth more than making
      // the user wait on speaker labels, so deliver it unlabeled now — the
      // worker keeps running and `action=labels` upgrades it later.
      const createdAtMs = job.createdAt?.toMillis?.() ?? Date.now();
      const age = Date.now() - createdAtMs;
      if (age < GRACE_MS) {
        return res.status(200).json({ status: 'processing' });
      }

      try {
        const whisper = await loadStash(user.uid, id);
        const { text } = mergeTranscript(whisper, null);
        await meterStt(user.uid, whisper.duration);
        return res.status(200).json({
          status: 'completed',
          text,
          speaker_count: 0,
          audio_duration: whisper.duration ?? null,
          diarization_pending: true,
          diarization_job: id,
        });
      } catch (e) {
        console.error('[whisper-stt] grace-expiry unlabeled delivery load failed', e.message);
        return res.status(404).json({ error: 'not_found' });
      }
    }

    if (action === 'labels' && req.method === 'GET') {
      const id = (req.query?.id || '').toString();
      if (!id || !/^[A-Za-z0-9_-]{8,128}$/.test(id)) {
        return res.status(400).json({ error: 'bad_id' });
      }

      const admin = getAdmin();
      const jobSnap = await admin.firestore().collection('diarizationJobs').doc(id).get();
      if (!jobSnap.exists) {
        return res.status(404).json({ error: 'not_found' });
      }
      const job = jobSnap.data();
      if (job.uid !== user.uid) {
        return res.status(404).json({ error: 'not_found' });
      }

      if (job.status !== 'succeeded') {
        return res.status(200).json({ ready: false, status: job.status });
      }

      const turns = Array.isArray(job.turns) ? job.turns : [];
      let whisper;
      try {
        whisper = await loadStash(user.uid, id);
      } catch (e) {
        return res.status(404).json({ error: 'not_found' });
      }

      // Not metered here — the delivery poll (status action) already recorded
      // usage; this is purely a label upgrade on already-billed audio.
      const { text, speakerCount } = mergeTranscript(whisper, turns);
      return res.status(200).json({
        ready: true,
        text,
        speaker_count: speakerCount,
        audio_duration: whisper.duration ?? null,
      });
    }

    return res.status(404).json({ error: 'unknown_action', got: action });
  } catch (err) {
    console.error('[whisper-stt] unhandled', err);
    return res.status(500).json({ error: 'internal_error', message: err.message });
  }
};
