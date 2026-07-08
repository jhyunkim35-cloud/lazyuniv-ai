// Mocked end-to-end smoke of api/whisper-stt.js: exercises the full
// transcribe → poll(processing) → poll(completed) contract, the
// diarization-failed fallback, auth, URL allowlist, and re-poll idempotency —
// with Groq/pyannote/Firebase all stubbed. Run: node smoke_whisper_stt.js
'use strict';
const path = require('path');
const assert = require('assert');

const REPO = path.join(__dirname, '..');
process.env.GROQ_API_KEY = 'gk_test_fake';
process.env.PYANNOTEAI_API_KEY = 'pa_test_fake';

// ── In-memory Firebase admin stub ─────────────────────────────────────────
const store = new Map();
const usageCalls = [];
const firestoreFn = () => ({
  collection: () => ({ doc: () => ({}) }),
  runTransaction: async (fn) => fn({ get: async () => ({ exists: false }), set: () => {} }),
});
firestoreFn.FieldValue = { increment: (n) => n };
firestoreFn.Timestamp = { fromMillis: (ms) => ms };
const fakeAdmin = {
  auth: () => ({
    verifyIdToken: async (t) => {
      if (t !== 'good-token') throw new Error('invalid token');
      return { uid: 'u1', email: 'test@notyx.co.kr' };
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
let jobPhase = 'running'; // mutated by the test script
let diarizeSubmits = 0;

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
  if (u.includes('api.pyannote.ai/v1/diarize')) {
    diarizeSubmits++;
    const body = JSON.parse(opts.body);
    assert.strictEqual(body.url, AUDIO_URL, 'pyannote gets the storage url');
    assert.strictEqual(body.model, 'community-1', 'community-1 model selected');
    assert.ok(opts.headers.Authorization.includes('pa_test_fake'));
    return jsonRes(200, { jobId: 'job_smoke_00001', status: 'created' });
  }
  if (u.includes('api.pyannote.ai/v1/jobs/')) {
    if (jobPhase === 'running') return jsonRes(200, { status: 'running' });
    if (jobPhase === 'failed') return jsonRes(200, { status: 'failed' });
    return jsonRes(200, { status: 'succeeded', output: { diarization: TURNS } });
  }
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
  res = makeRes();
  await handler(makeReq({ query: { action: 'transcribe' }, body: { audio_url: AUDIO_URL } }), res);
  assert.strictEqual(res._status, 200, JSON.stringify(res._json));
  assert.strictEqual(res._json.transcript_id, 'job_smoke_00001');
  assert.strictEqual(res._json.status, 'queued');
  const tmpKey = 'stt_tmp/u1/job_smoke_00001.json';
  assert.ok(store.has(tmpKey), 'whisper JSON stashed in Storage');
  const stashed = JSON.parse(store.get(tmpKey));
  assert.ok(!('tokens' in (stashed.segments[0] || {})), 'verbose_json trimmed (tokens dropped)');
  console.log('[ok] transcribe: pyannote job + Groq transcript + Storage stash');

  // 4. poll while diarization runs
  res = makeRes();
  await handler(makeReq({ method: 'GET', query: { action: 'status', id: 'job_smoke_00001' } }), res);
  assert.strictEqual(res._json.status, 'processing');
  console.log('[ok] status: running → processing');

  // 5. poll after success → merged labeled transcript
  jobPhase = 'succeeded';
  res = makeRes();
  await handler(makeReq({ method: 'GET', query: { action: 'status', id: 'job_smoke_00001' } }), res);
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
  await handler(makeReq({ method: 'GET', query: { action: 'status', id: 'job_smoke_00001' } }), res);
  assert.strictEqual(res._json.status, 'completed');
  assert.strictEqual(res._json.speaker_count, 3);
  // Note: re-poll re-records usage (usageCalls now 2) — mirrors assemblyai.js,
  // which also meters on every completed status fetch; client stops polling
  // on first success so this only happens in lost-response recovery.
  assert.strictEqual(usageCalls.length, 2);
  console.log('[ok] re-poll after completion → same result (tmp not deleted)');

  // 7. diarization-failed fallback: plain text, usage still metered
  jobPhase = 'failed';
  res = makeRes();
  await handler(makeReq({ method: 'GET', query: { action: 'status', id: 'job_smoke_00001' } }), res);
  assert.strictEqual(res._json.status, 'completed');
  assert.strictEqual(res._json.diarization_failed, true);
  assert.strictEqual(res._json.speaker_count, 0);
  assert.ok(!res._json.text.includes('발화자'), 'fallback text unlabeled');
  assert.ok(res._json.text.includes('discussion'), 'fallback keeps whisper text');
  assert.strictEqual(usageCalls.length, 3, 'usage recorded on fallback too');
  console.log('[ok] diarization failed → plain-text fallback, usage metered');

  assert.strictEqual(diarizeSubmits, 1);
  console.log('\nwhisper-stt.js mocked E2E smoke: ALL GREEN');
})().catch((e) => { console.error('SMOKE FAILED:', e); process.exit(1); });
