// Real-provider verification harness for the U7 Whisper+diarization pipeline.
// Runs the ACTUAL Groq + pyannote.ai APIs on a local Korean audio file, merges
// with api/_stt_merge.js, and checks the downstream separateSpeakers contract.
//
// Usage:
//   node scripts/verify_real_audio.js <audio-file> [--model community-1|precision-2]
//
// Keys: GROQ_API_KEY + PYANNOTEAI_API_KEY from env, .env.harness.local, or .env.local.
'use strict';
const fs = require('fs');
const path = require('path');

for (const f of ['.env.harness.local', '.env.local']) {
  const p = path.join(__dirname, '..', f);
  if (fs.existsSync(p)) { try { require('dotenv').config({ path: p }); } catch {} }
}

const { mergeTranscript } = require('../api/_stt_merge');

const GROQ_KEY = process.env.GROQ_API_KEY;
const PYA_KEY = process.env.PYANNOTEAI_API_KEY;
const audioPath = process.argv[2];
const model = process.argv.includes('--model') ? process.argv[process.argv.indexOf('--model') + 1] : 'community-1';

if (!GROQ_KEY || !PYA_KEY) {
  console.error('Missing GROQ_API_KEY / PYANNOTEAI_API_KEY (put them in .env.harness.local).');
  process.exit(1);
}
if (!audioPath || !fs.existsSync(audioPath)) {
  console.error('Usage: node scripts/verify_real_audio.js <audio-file> [--model community-1]');
  process.exit(1);
}

async function jfetch(url, opts) {
  const res = await fetch(url, opts);
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 300) }; }
  if (!res.ok) throw new Error(`${url} → ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
  return json;
}

(async () => {
  const buf = fs.readFileSync(audioPath);
  const name = path.basename(audioPath);
  console.log(`audio: ${name} (${(buf.length / 1024 / 1024).toFixed(1)}MB) | diarization model: ${model}`);

  // 1. pyannote: declare media:// key → PUT file → submit diarization job
  const mediaKey = `media://verify-${name.replace(/[^A-Za-z0-9]/g, '')}-${buf.length}`;
  const t0 = Date.now();
  const { url: putUrl } = await jfetch('https://api.pyannote.ai/v1/media/input', {
    method: 'POST',
    headers: { Authorization: `Bearer ${PYA_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: mediaKey }),
  });
  const putRes = await fetch(putUrl, { method: 'PUT', body: buf });
  if (!putRes.ok) throw new Error(`media upload PUT failed: ${putRes.status}`);
  const { jobId } = await jfetch('https://api.pyannote.ai/v1/diarize', {
    method: 'POST',
    headers: { Authorization: `Bearer ${PYA_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: mediaKey, model }),
  });
  console.log(`[1] pyannote job submitted: ${jobId} (upload ${(Date.now() - t0) / 1000 | 0}s)`);

  // 2. Groq Whisper transcription (same params as api/whisper-stt.js)
  const t1 = Date.now();
  const form = new FormData();
  form.append('file', new Blob([buf]), name);
  form.append('model', 'whisper-large-v3-turbo');
  form.append('language', 'ko');
  form.append('response_format', 'verbose_json');
  form.append('temperature', '0');
  form.append('timestamp_granularities[]', 'word');
  form.append('timestamp_granularities[]', 'segment');
  const whisper = await jfetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST', headers: { Authorization: `Bearer ${GROQ_KEY}` }, body: form,
  });
  const groqSecs = (Date.now() - t1) / 1000;
  console.log(`[2] Groq done in ${groqSecs.toFixed(1)}s — duration ${Math.round(whisper.duration)}s, segments ${whisper.segments?.length}, words ${whisper.words?.length ?? '(per-segment)'}`);

  // 3. Poll diarization
  let job;
  for (let i = 0; i < 300; i++) {
    job = await jfetch(`https://api.pyannote.ai/v1/jobs/${jobId}`, { headers: { Authorization: `Bearer ${PYA_KEY}` } });
    if (['succeeded', 'failed', 'canceled'].includes(job.status)) break;
    await new Promise(r => setTimeout(r, 2000));
  }
  const diarSecs = (Date.now() - t0) / 1000;
  if (job.status !== 'succeeded') throw new Error(`diarization ${job.status}: ${JSON.stringify(job).slice(0, 300)}`);
  const turns = job.output?.diarization || [];
  const speakers = [...new Set(turns.map(t => t.speaker))];
  console.log(`[3] diarization succeeded in ${diarSecs.toFixed(0)}s — ${turns.length} turns, ${speakers.length} speakers detected (unknown-N auto)`);

  // 4. Merge
  const { text, speakerCount, fallback } = mergeTranscript(whisper, turns);
  console.log(`[4] merge: speaker_count=${speakerCount} fallback=${fallback}`);
  console.log('--- transcript head ---');
  console.log(text.split('\n').slice(0, 30).join('\n'));
  console.log('--- transcript tail ---');
  console.log(text.split('\n').slice(-10).join('\n'));

  // 5. Downstream contract (real separateSpeakers from pptx_parser.js)
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'pptx_parser.js'), 'utf8');
  const start = src.indexOf('function separateSpeakers');
  let depth = 0, end = -1, opened = false;
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') { depth++; opened = true; }
    else if (src[i] === '}') { depth--; if (opened && depth === 0) { end = i + 1; break; } }
  }
  const separateSpeakers = new Function(`return (${src.slice(start, end)})`)();
  const ds = separateSpeakers(text, 1);
  console.log(`[5] separateSpeakers: skipped=${!!ds.skipped} speakerCount=${ds.speakerCount} professorLines=${ds.professorLines} totalLines=${ds.totalLines}`);

  // 6. Cost & latency report
  const hrs = (whisper.duration || 0) / 3600;
  const newCost = hrs * 0.04 + hrs * (model === 'community-1' ? 0.041 : 0.13);
  const oldCost = hrs * 0.15;
  console.log(`[6] cost for this file: new ~$${newCost.toFixed(4)} vs AssemblyAI ~$${oldCost.toFixed(4)} (${Math.round((1 - newCost / oldCost) * 100)}% cheaper)`);
  console.log(`    wall-clock: groq ${groqSecs.toFixed(0)}s, diarization total ${diarSecs.toFixed(0)}s`);
  console.log('\nVERIFY: read the transcript head above — check speaker labels against who actually speaks.');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
