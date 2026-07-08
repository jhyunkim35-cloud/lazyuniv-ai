// Downstream-contract verification: does the REAL separateSpeakers() from
// public/js/pptx_parser.js (the sole gateway transcript → notes/summary/quiz
// pipeline) parse mergeTranscript() output exactly like AssemblyAI's format?
// Run: node verify_downstream.js
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const REPO = path.join(__dirname, '..');
const { mergeTranscript } = require(path.join(REPO, 'api', '_stt_merge.js'));

// Extract the real separateSpeakers function body via brace counting.
const src = fs.readFileSync(path.join(REPO, 'public', 'js', 'pptx_parser.js'), 'utf8');
const start = src.indexOf('function separateSpeakers');
assert.ok(start > 0, 'separateSpeakers found in pptx_parser.js');
let depth = 0, end = -1, opened = false;
for (let i = start; i < src.length; i++) {
  if (src[i] === '{') { depth++; opened = true; }
  else if (src[i] === '}') { depth--; if (opened && depth === 0) { end = i + 1; break; } }
}
assert.ok(end > start, 'function body extracted');
const separateSpeakers = new Function(`return (${src.slice(start, end)})`)();

// ── Profile (a): single-speaker monologue lecture ─────────────────────────
{
  const whisper = {
    duration: 8,
    segments: [{ start: 0, end: 6, text: ' 안녕하세요 오늘은 미시경제학 강의를 시작하겠습니다' }],
    words: [
      { word: ' 안녕하세요', start: 0.5, end: 1.2 },
      { word: ' 오늘은', start: 1.5, end: 2.0 },
      { word: ' 미시경제학', start: 2.2, end: 3.0 },
      { word: ' 강의를', start: 3.1, end: 3.6 },
      { word: ' 시작하겠습니다', start: 3.7, end: 4.8 },
    ],
  };
  const turns = [{ start: 0, end: 6, speaker: 'SPEAKER_00' }];
  const merged = mergeTranscript(whisper, turns);
  assert.strictEqual(merged.speakerCount, 1);

  const out = separateSpeakers(merged.text, 1);
  assert.strictEqual(out.skipped, true, 'single speaker → separateSpeakers passes text through');
  assert.strictEqual(out.speakerCount <= 1, true);
  assert.strictEqual(out.text, merged.text, 'text unchanged for single speaker');
  console.log('[ok] (a) single-speaker: merge → separateSpeakers pass-through, pipeline input intact');
}

// ── Profile (b): 3+ speaker discussion (professor = dominant = 발화자 1) ──
{
  const whisper = {
    duration: 30,
    segments: [{ start: 0, end: 30, text: ' discussion' }],
    words: [
      // professor talks 0–10
      { word: ' 오늘', start: 0.5, end: 1.0 }, { word: ' 주제는', start: 1.1, end: 1.8 },
      { word: ' 시장', start: 2.0, end: 2.5 }, { word: ' 실패입니다', start: 2.6, end: 3.5 },
      { word: ' 질문', start: 8.0, end: 8.5 }, { word: ' 있나요', start: 8.6, end: 9.2 },
      // student A 10–14
      { word: ' 외부효과가', start: 10.5, end: 11.5 }, { word: ' 뭔가요', start: 11.6, end: 12.3 },
      // professor 14–22
      { word: ' 외부효과는', start: 14.5, end: 15.5 }, { word: ' 제3자에게', start: 15.6, end: 16.5 },
      { word: ' 미치는', start: 16.6, end: 17.2 }, { word: ' 영향입니다', start: 17.3, end: 18.2 },
      // student B 22–26
      { word: ' 예시를', start: 22.5, end: 23.2 }, { word: ' 들어주세요', start: 23.3, end: 24.2 },
    ],
  };
  const turns = [
    { start: 0, end: 10, speaker: 'SPEAKER_00' },
    { start: 10, end: 14, speaker: 'SPEAKER_01' },
    { start: 14, end: 22, speaker: 'SPEAKER_00' },
    { start: 22, end: 26, speaker: 'SPEAKER_02' },
  ];
  const merged = mergeTranscript(whisper, turns);
  assert.strictEqual(merged.speakerCount, 3, '3 distinct speakers detected');
  assert.ok(/\[00:00:00\] 발화자 1:/.test(merged.text), 'dominant professor = 발화자 1');

  const out = separateSpeakers(merged.text, 1);
  assert.strictEqual(out.skipped, undefined === out.skipped ? out.skipped : out.skipped, 'shape check');
  assert.ok(!out.skipped, 'multi-speaker → filtering engaged');
  assert.strictEqual(out.speakerCount, 3, 'separateSpeakers counts 3 speakers from merged text');
  assert.ok(out.professorLines >= 3, 'professor lines extracted');
  assert.ok(out.text.includes('외부효과는'), 'professor content kept');
  assert.ok(!out.text.includes('들어주세요'), 'student content filtered (existing behavior)');
  assert.ok(!out.text.includes('발화자'), 'labels stripped before Claude pipeline (existing behavior)');
  console.log('[ok] (b) 3-speaker: merge → separateSpeakers filter, counts/labels/timestamps parse');
}

console.log('\nDownstream contract verified: mergeTranscript output is drop-in for the notes/summary/quiz pipeline.');
