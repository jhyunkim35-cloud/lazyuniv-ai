// Assert-based smoke test for api/_stt_merge.js. Run: node scripts/test_stt_merge.js
'use strict';

const assert = require('assert');
const { mergeTranscript, formatClock } = require('../api/_stt_merge');

function speakerNums(text) {
  return [...text.matchAll(/발화자 (\d+):/g)].map(m => Number(m[1]));
}

// formatClock ------------------------------------------------------------
assert.strictEqual(formatClock(0), '00:00:00');
assert.strictEqual(formatClock(3661), '01:01:01');
console.log('[ok] formatClock');

// (a) single-speaker lecture — everything 발화자 1 ------------------------
{
  const whisper = {
    duration: 8,
    segments: [{ start: 0, end: 4, text: ' 안녕하세요 오늘은 강의를 시작하겠습니다' }],
    words: [
      { word: ' 안녕', start: 0.5, end: 1.0 },
      { word: '하세요', start: 1.0, end: 1.5 },
      { word: ' 오늘은', start: 2.0, end: 2.5 },
      { word: ' 강의를', start: 2.5, end: 3.0 },
      { word: ' 시작하겠습니다', start: 3.0, end: 4.0 },
    ],
  };
  const turns = [{ start: 0, end: 10, speaker: 'SPEAKER_00' }];
  const { text, speakerCount, fallback } = mergeTranscript(whisper, turns);
  assert.strictEqual(fallback, false);
  assert.strictEqual(speakerCount, 1);
  assert.strictEqual(text.split('\n\n').length, 1);
  const nums = speakerNums(text);
  assert.deepStrictEqual([...new Set(nums)], [1]);
  assert.ok(text.startsWith('[00:00:00] 발화자 1:'));
  console.log('[ok] (a) single-speaker lecture');
}

// (b) 3 speakers, one Whisper segment spanning speaker changes -----------
{
  const whisper = {
    duration: 16,
    segments: [{ start: 0, end: 16, text: ' segment spanning three speakers' }],
    words: [
      { word: ' w1', start: 1, end: 2 },
      { word: ' w2', start: 3, end: 4 },
      { word: ' w3', start: 6, end: 7 },
      { word: ' w4', start: 8, end: 9 },
      { word: ' w5', start: 11, end: 12 },
      { word: ' w6', start: 13, end: 14 },
    ],
  };
  const turns = [
    { start: 0, end: 5, speaker: 'SPEAKER_00' },
    { start: 5, end: 10, speaker: 'SPEAKER_01' },
    { start: 10, end: 16, speaker: 'SPEAKER_02' },
  ];
  const { text, speakerCount, fallback } = mergeTranscript(whisper, turns);
  assert.strictEqual(fallback, false);
  assert.strictEqual(speakerCount, 3);
  const paras = text.split('\n\n');
  assert.strictEqual(paras.length, 3);
  assert.ok(paras[0].includes('w1') && paras[0].includes('w2'));
  assert.ok(paras[1].includes('w3') && paras[1].includes('w4'));
  assert.ok(paras[2].includes('w5') && paras[2].includes('w6'));
  const nums = speakerNums(text);
  assert.strictEqual(new Set(nums).size, 3); // three distinct speaker numbers, split at turn boundaries
  console.log('[ok] (b) 3-speaker segment split at turn boundaries');
}

// (c) boundary bleed — 1 stray word smoothed back into surrounding speaker
{
  const whisper = {
    duration: 6,
    segments: [{ start: 0, end: 6, text: ' one speaker with a diarization blip' }],
    words: [
      { word: ' w1', start: 0.5, end: 1.0 },
      { word: ' w2', start: 1.5, end: 2.0 },
      { word: ' blip', start: 3.1, end: 3.2 }, // falls in the tiny SPEAKER_01 sliver below
      { word: ' w4', start: 4.0, end: 4.5 },
      { word: ' w5', start: 5.0, end: 5.5 },
    ],
  };
  const turns = [
    { start: 0, end: 3, speaker: 'SPEAKER_00' },
    { start: 3, end: 3.3, speaker: 'SPEAKER_01' }, // spurious diarizer blip
    { start: 3.3, end: 10, speaker: 'SPEAKER_00' },
  ];
  const { text, speakerCount, fallback } = mergeTranscript(whisper, turns);
  assert.strictEqual(fallback, false);
  assert.strictEqual(speakerCount, 1); // the blip run got smoothed away entirely
  assert.strictEqual(text.split('\n\n').length, 1);
  assert.ok(text.includes('발화자 1'));
  assert.ok(!text.includes('발화자 2'));
  console.log('[ok] (c) boundary bleed smoothed');
}

// (d) hallucinated segment in a 30s+ silence gap — dropped ----------------
{
  const whisper = {
    duration: 45,
    segments: [
      {
        start: 0, end: 5, text: ' 안녕하세요 강의 시작합니다',
        words: [
          { word: ' 안녕', start: 0.5, end: 1 },
          { word: '하세요', start: 1, end: 1.5 },
          { word: ' 강의', start: 2, end: 2.5 },
          { word: ' 시작합니다', start: 2.5, end: 3 },
        ],
      },
      {
        // Whisper hallucination during silence — no diarization turn nearby
        start: 20, end: 22, text: ' 구독과 좋아요 부탁드립니다',
        words: [
          { word: ' 구독과', start: 20.2, end: 20.6 },
          { word: ' 좋아요', start: 20.6, end: 21.0 },
          { word: ' 부탁드립니다', start: 21.0, end: 21.5 },
        ],
      },
      {
        start: 40, end: 45, text: ' 감사합니다 다음시간에 뵙겠습니다',
        words: [
          { word: ' 감사합니다', start: 40.5, end: 41 },
          { word: ' 다음시간에', start: 41.5, end: 42 },
          { word: ' 뵙겠습니다', start: 42, end: 42.5 },
        ],
      },
    ],
  };
  const turns = [
    { start: 0, end: 5, speaker: 'SPEAKER_00' },
    { start: 40, end: 45, speaker: 'SPEAKER_00' },
  ];
  const { text, speakerCount, fallback } = mergeTranscript(whisper, turns);
  assert.strictEqual(fallback, false);
  assert.ok(!text.includes('구독과'), 'hallucinated segment should be dropped');
  assert.ok(!text.includes('좋아요'));
  assert.ok(text.includes('안녕'));
  assert.ok(text.includes('감사합니다'));
  console.log('[ok] (d) hallucinated silence-gap segment dropped, speakerCount=' + speakerCount);
}

// (e) turns=null — plain-text fallback ------------------------------------
{
  const whisper = {
    duration: 4,
    segments: [
      { start: 0, end: 2, text: ' 안녕하세요' },
      { start: 2, end: 4, text: ' 테스트입니다' },
    ],
  };
  const { text, speakerCount, fallback } = mergeTranscript(whisper, null);
  assert.strictEqual(fallback, true);
  assert.strictEqual(speakerCount, 0);
  assert.strictEqual(text, '안녕하세요 테스트입니다');
  assert.ok(!text.includes('발화자'));
  console.log('[ok] (e) turns=null plain-text fallback');

  const emptyTurns = mergeTranscript(whisper, []);
  assert.strictEqual(emptyTurns.fallback, true);
  console.log('[ok] (e2) turns=[] also falls back');
}

// (f) dominant speaker SPEAKER_02 → remapped to 발화자 1 -------------------
{
  const whisper = {
    duration: 14,
    segments: [{ start: 0, end: 14, text: ' three speakers, SPEAKER_02 dominant' }],
    words: [
      { word: ' A0', start: 0.2, end: 0.8 },   // SPEAKER_00, 0.6s total
      { word: ' B1', start: 2.2, end: 2.8 },   // SPEAKER_01, 0.6s total
      { word: ' C2a', start: 4.5, end: 6.0 },  // SPEAKER_02
      { word: ' C2b', start: 6.2, end: 7.0 },  // SPEAKER_02, 2.3s total — dominant
    ],
  };
  const turns = [
    { start: 0, end: 2, speaker: 'SPEAKER_00' },
    { start: 2, end: 4, speaker: 'SPEAKER_01' },
    { start: 4, end: 14, speaker: 'SPEAKER_02' },
  ];
  const { text, speakerCount, fallback } = mergeTranscript(whisper, turns);
  assert.strictEqual(fallback, false);
  assert.strictEqual(speakerCount, 3);
  const paras = text.split('\n\n');
  const dominantPara = paras.find(p => p.includes('C2a'));
  assert.ok(dominantPara, 'expected a paragraph with SPEAKER_02 words');
  assert.ok(dominantPara.startsWith('[' ) && dominantPara.includes('발화자 1:'), 'dominant speaker should be remapped to 발화자 1: ' + dominantPara);
  console.log('[ok] (f) dominant speaker SPEAKER_02 remapped to 발화자 1');
}

console.log('\nAll _stt_merge tests passed.');
