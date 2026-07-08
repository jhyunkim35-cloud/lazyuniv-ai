// WhisperX-style diarization merge: assigns pyannote speaker turns to Groq
// Whisper word timestamps, smooths boundary bleed, drops silence-gap
// hallucinations, and formats into the same "[hh:mm:ss] 발화자 N: text"
// shape api/assemblyai.js produces (so pptx_parser.js's separateSpeakers()
// keeps working unchanged).
//
// Pure module — no Firebase/network imports — independently testable via
// scripts/test_stt_merge.js.
'use strict';

const HALLUCINATION_GAP_S = 2;   // Whisper segment with zero turn overlap AND nearest turn farther than this → dropped
const NEAREST_TURN_GAP_S = 2;    // word with zero turn overlap snaps to a turn within this gap
const SMOOTH_MAX_WORDS = 2;      // stray run this short (words) …
const SMOOTH_MAX_DUR_S = 1;      // … and this short (seconds) gets relabeled to its surrounding speaker
const PARAGRAPH_MAX_DUR_S = 40;  // force a paragraph break past this duration
const PARAGRAPH_PAUSE_S = 2;     // force a paragraph break on a pause this long

function formatClock(seconds) {
  const total = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

function overlapDuration(aStart, aEnd, bStart, bEnd) {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

// Gap between two (possibly touching/overlapping) intervals; 0 if they overlap.
function gapBetween(aStart, aEnd, bStart, bEnd) {
  if (aEnd <= bStart) return bStart - aEnd;
  if (bEnd <= aStart) return aStart - bEnd;
  return 0;
}

// Groq/OpenAI verbose_json puts word timestamps either top-level
// (whisper.words) or nested per segment (segments[].words); some responses
// have neither (segment-only granularity) — fall back to one "word" per
// segment so the rest of the pipeline is word-shaped either way.
function extractWords(whisper) {
  const segments = Array.isArray(whisper.segments) ? whisper.segments : [];
  if (Array.isArray(whisper.words) && whisper.words.length) {
    return whisper.words.map(w => ({ word: w.word || '', start: w.start ?? 0, end: w.end ?? w.start ?? 0 }));
  }
  const nested = [];
  for (const seg of segments) {
    if (Array.isArray(seg.words)) {
      for (const w of seg.words) nested.push({ word: w.word || '', start: w.start ?? 0, end: w.end ?? w.start ?? 0 });
    }
  }
  if (nested.length) return nested;
  return segments.map(s => ({ word: s.text || '', start: s.start ?? 0, end: s.end ?? s.start ?? 0 }));
}

// Drop whole segments that never overlap any diarization turn and sit more
// than HALLUCINATION_GAP_S away from the nearest one — Whisper's classic
// failure mode of inventing "구독과 좋아요" style closers over dead air.
function dropHallucinatedSegments(segments, turns) {
  return segments.filter(seg => {
    const hasOverlap = turns.some(t => overlapDuration(seg.start, seg.end, t.start, t.end) > 0);
    if (hasOverlap) return true;
    const nearestGap = Math.min(...turns.map(t => gapBetween(seg.start, seg.end, t.start, t.end)));
    return nearestGap <= HALLUCINATION_GAP_S;
  });
}

// Each word → the turn with max temporal overlap (ties → longer turn).
// A word with no overlap snaps to the nearest turn within NEAREST_TURN_GAP_S;
// beyond that it's left null and filled from a neighboring word below.
function assignSpeakers(words, turns) {
  const assigned = words.map(w => {
    const ws = w.start, we = w.end;
    let best = null, bestScore = 0, bestDur = -1;
    for (const t of turns) {
      // Zero-length word timestamps fall through to the nearest-turn
      // fallback below (gap 0), which resolves them to the containing turn.
      const score = overlapDuration(ws, we, t.start, t.end);
      if (score <= 0) continue;
      const turnDur = t.end - t.start;
      if (score > bestScore || (score === bestScore && turnDur > bestDur)) {
        best = t; bestScore = score; bestDur = turnDur;
      }
    }
    if (best) return best.speaker;
    let nearest = null, nearestGap = Infinity;
    for (const t of turns) {
      const g = gapBetween(ws, we, t.start, t.end);
      if (g < nearestGap) { nearestGap = g; nearest = t; }
    }
    return (nearest && nearestGap <= NEAREST_TURN_GAP_S) ? nearest.speaker : null;
  });

  // Fill unresolved words: forward-fill from the previous resolved word,
  // then backward-fill any still-null leading run from the next resolved one.
  let last = null;
  for (let i = 0; i < assigned.length; i++) {
    if (assigned[i] === null) assigned[i] = last;
    else last = assigned[i];
  }
  let next = null;
  for (let i = assigned.length - 1; i >= 0; i--) {
    if (assigned[i] === null) assigned[i] = next;
    else next = assigned[i];
  }
  // ponytail: ultimate fallback if literally nothing ever matched (degenerate
  // input) — pin everything to the first turn rather than leaving nulls.
  if (assigned.includes(null) && turns.length) {
    const fallback = turns[0].speaker;
    for (let i = 0; i < assigned.length; i++) if (assigned[i] === null) assigned[i] = fallback;
  }
  return assigned;
}

function buildRuns(words, speakers) {
  const runs = [];
  for (let i = 0; i < words.length; i++) {
    const last = runs[runs.length - 1];
    if (last && last.speaker === speakers[i]) last.words.push(words[i]);
    else runs.push({ speaker: speakers[i], words: [words[i]] });
  }
  return runs;
}

function runDuration(run) {
  const first = run.words[0], last = run.words[run.words.length - 1];
  return (last.end ?? last.start ?? 0) - (first.start ?? 0);
}

// A run of ≤2 words, <1s, sandwiched between two runs of the SAME speaker →
// classic diarization boundary bleed. Relabel it away.
// ponytail: single pass, doesn't cascade through adjacent short runs — fine
// for the isolated-stray-word case this targets; revisit if real transcripts
// show chains of bleed.
function smoothBoundaryBleed(runs) {
  for (let i = 1; i < runs.length - 1; i++) {
    const prev = runs[i - 1], cur = runs[i], nxt = runs[i + 1];
    if (cur.speaker === prev.speaker) continue;
    if (prev.speaker !== nxt.speaker) continue; // ambiguous surrounding — leave alone
    if (cur.words.length > SMOOTH_MAX_WORDS) continue;
    if (runDuration(cur) >= SMOOTH_MAX_DUR_S) continue;
    cur.speaker = prev.speaker;
  }
  // Re-merge runs that now share a speaker with their neighbor.
  const merged = [];
  for (const r of runs) {
    const last = merged[merged.length - 1];
    if (last && last.speaker === r.speaker) last.words.push(...r.words);
    else merged.push({ speaker: r.speaker, words: r.words.slice() });
  }
  return merged;
}

// Most-talking speaker → 발화자 1 (mirrors assemblyai.js's dominant-speaker remap).
function rankSpeakers(runs) {
  const totals = {};
  for (const r of runs) {
    const dur = r.words.reduce((sum, w) => sum + Math.max(0, (w.end ?? w.start ?? 0) - (w.start ?? 0)), 0);
    totals[r.speaker] = (totals[r.speaker] || 0) + dur;
  }
  const sorted = Object.keys(totals).sort((a, b) => totals[b] - totals[a]);
  const remap = {};
  sorted.forEach((sp, i) => { remap[sp] = i + 1; });
  return { remap, speakerCount: sorted.length };
}

// OpenAI-style word tokens carry their own leading space; Groq's Korean word
// tokens don't (verified on real audio — bare eojeol like "안녕하세요").
// Concatenate, inserting a space only when the boundary has none.
function joinWords(words) {
  let out = '';
  for (const w of words) {
    const t = w.word || '';
    if (out && t && !/^\s/.test(t) && !/\s$/.test(out)) out += ' ';
    out += t;
  }
  return out.trim();
}

// One paragraph per speaker run, further split on a >2s pause or once a
// same-speaker run exceeds ~40s (mirrors assemblyai.js's per-utterance grain).
function paragraphsFromRuns(runs, remap) {
  const paragraphs = [];
  for (const run of runs) {
    let cur = null;
    for (const w of run.words) {
      const ws = w.start, we = w.end;
      if (cur) {
        const pause = ws - cur.lastEnd;
        const dur = we - cur.firstStart;
        if (pause > PARAGRAPH_PAUSE_S || dur > PARAGRAPH_MAX_DUR_S) {
          paragraphs.push(cur);
          cur = null;
        }
      }
      if (!cur) cur = { speaker: run.speaker, firstStart: ws, lastEnd: we, words: [] };
      cur.words.push(w);
      cur.lastEnd = we;
    }
    if (cur) paragraphs.push(cur);
  }
  return paragraphs.map(p => `[${formatClock(p.firstStart)}] 발화자 ${remap[p.speaker]}: ${joinWords(p.words)}`);
}

/**
 * @param {{duration?:number, segments:Array<{start:number,end:number,text:string,no_speech_prob?:number,words?:Array}>, words?:Array<{word:string,start:number,end:number}>}} whisper
 * @param {Array<{start:number,end:number,speaker:string}>|null} turns
 * @returns {{text:string, speakerCount:number, fallback:boolean}}
 */
function mergeTranscript(whisper, turns) {
  const segments = Array.isArray(whisper?.segments) ? whisper.segments : [];

  if (!Array.isArray(turns) || !turns.length) {
    // No diarization — hand back plain Whisper text, no speaker labels.
    const text = segments.map(s => s.text || '').join('').trim();
    return { text, speakerCount: 0, fallback: true };
  }
  if (!segments.length) return { text: '', speakerCount: 0, fallback: false };

  const kept = dropHallucinatedSegments(segments, turns);
  const keptSet = new Set(kept);
  const dropped = segments.filter(s => !keptSet.has(s));

  const words = extractWords({ ...whisper, segments: kept })
    // Top-level whisper.words spans the whole clip regardless of which
    // segments got dropped above — filter those out by time range too.
    .filter(w => {
      if (!dropped.length) return true;
      const mid = ((w.start ?? 0) + (w.end ?? w.start ?? 0)) / 2;
      return !dropped.some(d => d.start <= mid && mid <= d.end);
    });

  if (!words.length) return { text: '', speakerCount: 0, fallback: false };

  const speakers = assignSpeakers(words, turns);
  let runs = buildRuns(words, speakers);
  runs = smoothBoundaryBleed(runs);
  const { remap, speakerCount } = rankSpeakers(runs);
  const paragraphs = paragraphsFromRuns(runs, remap);

  return { text: paragraphs.join('\n\n'), speakerCount, fallback: false };
}

module.exports = { mergeTranscript, formatClock };
