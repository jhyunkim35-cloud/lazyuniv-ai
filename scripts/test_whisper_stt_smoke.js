// Mocked end-to-end smoke of api/whisper-stt.js: exercises the full
// transcribe → poll(processing) → poll(completed) contract, the
// diarization-failed fallback, grace-expiry unlabeled delivery, the `labels`
// late-upgrade action, auth, URL allowlist, and re-poll idempotency — with
// Groq + Firestore (diarizationJobs queue, U7b) all stubbed.
// Run: node scripts/test_whisper_stt_smoke.js
'use strict';
const path = require('path');
const assert = require('assert');

const REPO = path.join(__dirname, '..');
process.env.GROQ_API_KEY = 'gk_test_fake';

// ── In-memory Firebase admin stub ─────────────────────────────────────────
const store = new Map();          // Storage: path -> whisper JSON string
const jobsStore = new Map();      // Firestore: diarizationJobs/{id} -> job data
const usageCalls = [];

function resolveTS(v) {
  // Mimic admin.firestore.FieldValue.serverTimestamp() resolving to a
  // Firestore Timestamp-like object with .toMillis() — real Firestore
  // resolves this server-side; here it just resolves to "now".
  return (v && v.__serverTimestamp) ? { toMillis: () => Date.now() } : v;
}

function diarizationJobsCollection() {
  return {
    doc: (id) => ({
      set: async (data) => {
        const resolved = {};
        for (const k of Object.keys(data)) resolved[k] = resolveTS(data[k]);
        jobsStore.set(id, resolved);
      },
      get: async () => {
        const data = jobsStore.get(id);
        return { exists: !!data, data: () => data };
      },
      update: async (patch) => {
        const cur = jobsStore.get(id) || {};
        const merged = { ...cur };
        for (const k of Object.keys(patch)) merged[k] = resolveTS(patch[k]);
        jobsStore.set(id, merged);
      },
    }),
  };
}

const firestoreFn = () => ({
  collection: (name) => (name === 'diarizationJobs' ? diarizationJobsCollection() : { doc: () => ({}) }),
  runTransaction: async (fn) => fn({ get: async () => ({ exists: false }), set: () => {} }),
});
firestoreFn.FieldValue = { increment: (n) => n, serverTimestamp: () => ({ __serverTimestamp: true }) };
firestoreFn.Timestamp = { fromMillis: (ms) => ms };
const fakeAdmin = {
  auth: () => ({
    verifyIdToken: async (t) => {
      if (t === 'good-token') return { uid: 'u1', email: 'test@notyx.co.kr' };
      if (t === 'other-token') return { uid: 'u2', email: 'other@notyx.co.kr' };
      throw new Error('invalid token');
    },
  }),
  firestore: firestoreFn,
  storage: () => ({
    bucket: () => ({
      file: (p) => ({
        save: async (data) => { store.set(p, data); },
        download: async () => {
          if (!store.has(p)) { const e = new Error('No such object'); throw e; }
          return [Buffer.from(store.get(p))];
        },
        delete: async () => { store.delete(p); },
      }),
    }),
  }),
};

function stubModule(abs, exportsObj) {
  const resolved = require.resolve(abs);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}
stubModule(path.join(REPO, 'api', '_firebase-admin.js'), { getAdmin: () => fakeAdmin });
stubModule(path.join(REPO, 'api', '_usage.js'), { recordUsage: async (x) => { usageCalls.push(x); } });

// ── Provider fetch mock (must exist BEFORE the handler module loads) ──────
const AUDIO_URL = 'https://firebasestorage.googleapis.com/v0/b/lazyuniv-ai.firebasestorage.app/o/users%2Fu1%2Frecordings%2Flecture.webm?alt=media&token=t';
const GROQ_FIXTURE = {
  duration: 30,
  segments: [{ start: 0, end: 30, text: ' discussion', tokens: [1, 2, 3] }],
  words: [
    { word: ' 오늘', start: 0.5, end: 1.0 }, { word: ' 주제는', start: 1.1, end: 1.8 },
    { word: ' 시장', start: 2.0, end: 2.5 }, { word: ' 실패입니다', start: 2.6, end: 3.5 },
    { word: ' 외부효과가', start: 10.5, end: 11.5 }, { word: ' 뭔가요', start: 11.6, end: 12.3 },
    { word: ' 외부효과는', start: 14.5, end: 15.5 }, { word: ' 영향입니다', start: 15.6, end: 16.5 },
    { word: ' 예시를', start: 22.5, end: 23.2 }, { word: ' 들어주세요', start: 23.3, end: 24.2 },
  ],
};
const TURNS = [
  { start: 0, end: 10, speaker: 'SPEAKER_00' },
  { start: 10, end: 14, speaker: 'SPEAKER_01' },
  { start: 14, end: 22, speaker: 'SPEAKER_00' },
  { start: 22, end: 26, speaker: 'SPEAKER_02' },
];

function jsonRes(status, obj) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(obj),
    arrayBuffer: async () => Buffer.from(JSON.stringify(obj)),
  };
}

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.startsWith('https://firebasestorage.googleapis.com/')) {
    return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array(2048).buffer, text: async () => '' };
  }
  if (u.includes('api.groq.com/openai/v1/audio/transcriptions')) {
    assert.ok(opts.headers.Authorization.includes('gk_test_fake'));
    assert.ok(opts.body && typeof opts.body.append === 'function' || opts.body instanceof FormData, 'multipart form sent');
    return jsonRes(200, GROQ_FIXTURE);
  }
  throw new Error('unexpected fetch: ' + u);
};

const handler = require(path.join(REPO, 'api', 'whisper-stt.js'));

function makeReq(over) {
  return Object.assign({
    method: 'POST',
    headers: { authorization: 'Bearer good-token', origin: 'https://notyx.co.kr' },
    query: {},
    body: {},
  }, over);
}
function makeRes() {
  const r = { _status: 0, _json: null, headers: {} };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.status = (c) => { r._status = c; return r; };
  r.json = (j) => { r._json = j; return r; };
  r.end = () => r;
  return r;
}

async function transcribe() {
  const res = makeRes();
  await handler(makeReq({ query: { action: 'transcribe' }, body: { audio_url: AUDIO_URL } }), res);
  assert.strictEqual(res._status, 200, JSON.stringify(res._json));
  assert.strictEqual(res._json.status, 'queued');
  return res._json.transcript_id;
}

(async () => {
  // 1. unauthorized
  let res = makeRes();
  await handler(makeReq({ headers: { origin: 'https://notyx.co.kr' } }), res);
  assert.strictEqual(res._status, 401);
  console.log('[ok] 401 without Firebase token');

  // 2. disallowed audio_url
  res = makeRes();
  await handler(makeReq({ query: { action: 'transcribe' }, body: { audio_url: 'https://evil.example.com/a.webm' } }), res);
  assert.strictEqual(res._status, 400);
  assert.strictEqual(res._json.error, 'audio_url_not_allowed');
  console.log('[ok] 400 for non-Firebase audio_url');

  // 3. transcribe happy path
  const jobId = await transcribe();
  assert.ok(/^[A-Za-z0-9_-]{8,}$/.test(jobId), 'jobId looks like a crypto.randomUUID()');
  const job = jobsStore.get(jobId);
  assert.ok(job, 'diarizationJobs doc created');
  assert.strictEqual(job.uid, 'u1');
  assert.strictEqual(job.audioUrl, AUDIO_URL);
  assert.strictEqual(job.status, 'pending');
  const tmpKey = `stt_tmp/u1/${jobId}.json`;
  assert.ok(store.has(tmpKey), 'whisper JSON stashed in Storage');
  const stashed = JSON.parse(store.get(tmpKey));
  assert.ok(!('tokens' in (stashed.segments[0] || {})), 'verbose_json trimmed (tokens dropped)');
  console.log('[ok] transcribe: diarizationJobs doc enqueued + Groq transcript + Storage stash');

  // 4. poll while diarization runs (fresh job, within grace window)
  res = makeRes();
  await handler(makeReq({ method: 'GET', query: { action: 'status', id: jobId } }), res);
  assert.strictEqual(res._json.status, 'processing');
  console.log('[ok] status: pending, within grace window → processing');

  // 5. poll after success → merged labeled transcript
  jobsStore.set(jobId, { ...jobsStore.get(jobId), status: 'succeeded', turns: TURNS });
  res = makeRes();
  await handler(makeReq({ method: 'GET', query: { action: 'status', id: jobId } }), res);
  assert.strictEqual(res._json.status, 'completed');
  assert.strictEqual(res._json.speaker_count, 3);
  assert.strictEqual(res._json.audio_duration, 30);
  assert.ok(/\[00:00:00\] 발화자 1:/.test(res._json.text), 'dominant speaker labeled 발화자 1');
  assert.ok(res._json.text.includes('발화자 2') && res._json.text.includes('발화자 3'), 'all 3 speakers present');
  assert.strictEqual(usageCalls.length, 1);
  assert.strictEqual(usageCalls[0].increments.sttSeconds, 30);
  console.log('[ok] status: succeeded → merged 3-speaker transcript + usage metered');

  // 6. re-poll idempotency (lost-response recovery)
  res = makeRes();
  await handler(makeReq({ method: 'GET', query: { action: 'status', id: jobId } }), res);
  assert.strictEqual(res._json.status, 'completed');
  assert.strictEqual(res._json.speaker_count, 3);
  // Note: re-poll re-records usage (usageCalls now 2) — mirrors assemblyai.js,
  // which also meters on every completed status fetch; client stops polling
  // on first success so this only happens in lost-response recovery.
  assert.strictEqual(usageCalls.length, 2);
  console.log('[ok] re-poll after completion → same result (tmp not deleted)');

  // 7. labels action on the now-succeeded job → ready with the same merge
  res = makeRes();
  await handler(makeReq({ method: 'GET', query: { action: 'labels', id: jobId } }), res);
  assert.strictEqual(res._status, 200);
  assert.strictEqual(res._json.ready, true);
  assert.strictEqual(res._json.speaker_count, 3);
  assert.strictEqual(usageCalls.length, 2, 'labels action does not re-meter usage');
  console.log('[ok] labels: ready → same merged transcript, no extra usage record');

  // 8. diarization-failed fallback: plain text, usage still metered
  const jobId2 = await transcribe();
  jobsStore.set(jobId2, { ...jobsStore.get(jobId2), status: 'failed' });
  res = makeRes();
  await handler(makeReq({ method: 'GET', query: { action: 'status', id: jobId2 } }), res);
  assert.strictEqual(res._json.status, 'completed');
  assert.strictEqual(res._json.diarization_failed, true);
  assert.strictEqual(res._json.speaker_count, 0);
  assert.ok(!res._json.text.includes('발화자'), 'fallback text unlabeled');
  assert.ok(res._json.text.includes('discussion'), 'fallback keeps whisper text');
  assert.strictEqual(usageCalls.length, 3, 'usage recorded on fallback too');
  console.log('[ok] diarization failed → plain-text fallback, usage metered');

  // 9. grace-expiry unlabeled delivery: job still pending, but createdAt is
  // old enough that the client shouldn't be left waiting on speaker labels.
  const jobId3 = await transcribe();
  jobsStore.set(jobId3, {
    ...jobsStore.get(jobId3),
    createdAt: { toMillis: () => Date.now() - 4 * 60 * 1000 }, // > GRACE_MS (3min), still 'pending'
  });
  res = makeRes();
  await handler(makeReq({ method: 'GET', query: { action: 'status', id: jobId3 } }), res);
  assert.strictEqual(res._json.status, 'completed');
  assert.strictEqual(res._json.diarization_pending, true);
  assert.strictEqual(res._json.diarization_job, jobId3);
  assert.strictEqual(res._json.speaker_count, 0);
  assert.ok(!res._json.text.includes('발화자'), 'unlabeled delivery has no speaker prefixes');
  assert.strictEqual(usageCalls.length, 4, 'usage metered on grace-expiry delivery too');
  console.log('[ok] status: grace window expired while still pending → unlabeled delivery, worker keeps running');

  // 10. labels: not ready (job from #9 is still 'pending' server-side)
  res = makeRes();
  await handler(makeReq({ method: 'GET', query: { action: 'labels', id: jobId3 } }), res);
  assert.strictEqual(res._status, 200);
  assert.strictEqual(res._json.ready, false);
  assert.strictEqual(res._json.status, 'pending');
  console.log('[ok] labels: not ready → {ready:false, status}');

  // 11. labels: wrong-uid → 404 (job belongs to u1, request authenticated as u2)
  res = makeRes();
  await handler(makeReq({
    method: 'GET',
    headers: { authorization: 'Bearer other-token', origin: 'https://notyx.co.kr' },
    query: { action: 'labels', id: jobId3 },
  }), res);
  assert.strictEqual(res._status, 404);
  console.log('[ok] labels: wrong uid → 404 not_found');

  console.log('\nwhisper-stt.js mocked E2E smoke: ALL GREEN');
})().catch((e) => { console.error('SMOKE FAILED:', e); process.exit(1); });
