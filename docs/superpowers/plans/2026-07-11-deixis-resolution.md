# U17 Deixis Resolution Layer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When professors say vague references ("이거", "저 식", "여기 대입하면"), infer the actual referent (formula/definition/diagram) from the paired slide deck, store it as a non-destructive annotation layer, feed it to note generation, and render it distinctly in the transcript preview UI.

**Architecture:** One Sonnet 4.6 call per analysis (only when transcript+PPT both present AND a client-side regex finds deixis candidates), placed *before* agent1 in the pipeline and sharing agent1's exact cache prefix (the U12 byte-identical-prefix pattern, run in reverse: the deixis call *writes* the cache entry that agent1 then *reads* at 0.1×). Output is a validated JSON annotation array `{q, ref, slide, conf}`; only `conf: "high"` items survive. Annotations are (a) injected into agent1's **uncached user prompt** as a clearly-labeled inference section (the cached prefix stays byte-identical to today's contract — zero risk to U12/Q3 cache sharing), and (b) saved to the transcript Firestore record as a `deixisAnnotations` field beside `text` (the U15 `speakerNames` precedent — original text NEVER mutated). Transcript preview renders each annotation as a visually-distinct inferred chip after the quoted span.

**Tech Stack:** Vanilla JS globals (no modules), existing `/api/claude` proxy via `callClaudeOnce`, Firestore `transcripts` collection, node-runnable assert tests.

## Global Constraints

- **NEVER mutate transcript `text`** — neither the Firestore record nor `storedFilteredText`. Annotations are a separate field / a separate prompt section.
- **Confidence threshold policy (decided): keep ONLY `conf === "high"`.** Medium/low are discarded entirely (not stored, not displayed). Ambiguity beats misinformation.
- **Mechanical validation is mandatory** (quote uniqueness, slide existence, length caps) — model self-rating alone is not trusted.
- **The agent1 cached prefix must remain byte-identical** to the deixis call's cached block and across all agent1 chunk/revision/critic calls. Any annotation content goes in the uncached user-prompt region only.
- **Fail-open:** any error/timeout/parse failure in the deixis stage → empty annotations, pipeline proceeds exactly as today.
- `node --check public/js/<file>.js` after every JS edit. Cache-bust `?v=` in `index.html` for frontend changes.
- **git push HARDBLOCKED — local commits only.** Working tree contains unrelated U7e WIP in `recorder.js` / `index.html` / worker files: stage ONLY your own hunks (`git add` new files; for shared files use `git diff <file> | git apply --cached` of a filtered patch, or coordinate at final commit — do NOT commit U7e hunks).
- Korean for user-facing strings; English for code comments.
- Model: `claude-sonnet-4-6` for the resolution call (cost analysis below). Do not use Opus.

## Cost & latency (for reference)

60-min STEM lecture ≈ 30k-token prefix (deck+transcript+instructions). Deixis call: 30k × 1.25× write ($0.1125) + ~2k out ($0.03); agent1 then READS the prefix at 0.1× ($0.009) instead of writing it ($0.1125). **Net marginal cost ≈ $0.04 ≈ ₩55/lecture** (Sonnet quality at Haiku price; without the cache trick it would be ~₩150). Latency: +10~20s before agent1 starts, masked by the U10 draft-summary hero; stage skipped entirely when no PPT, no transcript, or no regex candidates.

## Data schema

Transcript record (Firestore `users/{uid}/transcripts/{id}`), new optional field:

```js
// deixisAnnotations: [{ q: string, ref: string, slide: number|null, conf: 'high' }]
//   q     — verbatim quote from this record's text (10–60 chars), unique within it, containing the deixis
//   ref   — resolved referent, concrete (e.g. '오일러 공식 e^{iθ}=cosθ+i·sinθ'), 2–120 chars
//   slide — slide/page number in the paired deck, or null for verbal-context referents
//   conf  — always 'high' (lower confidences are dropped before storage)
```

---

### Task 1: `public/js/deixis.js` — pure helpers + node test

**Files:**
- Create: `public/js/deixis.js`
- Create: `scripts/test_deixis.js` (mirrors `scripts/test_stt_merge.js` style: plain asserts, `node scripts/test_deixis.js`)

**Interfaces (Produces — later tasks rely on these exact names):**
- `detectDeixisCandidates(text) -> boolean`
- `buildDeixisUserPrompt() -> string` (constant instruction; source material lives in the shared cache prefix)
- `parseDeixisAnnotations(rawModelText, recText, pptText) -> Array<{q,ref,slide,conf}>` (validated, high-conf only, ≤40)
- `buildDeixisSection(annotations) -> string` ('' when empty)
- `assignAnnotationsToRecordText(annotations, recordText) -> Array` (subset whose `q` occurs exactly once in `recordText`)
- `injectDeixisChips(escapedHtml, annotations) -> string` (operates on escHtml-ed text; wraps quote + appends chip)

- [ ] **Step 1: Write the failing test**

```js
// scripts/test_deixis.js — run: node scripts/test_deixis.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'deixis.js'), 'utf8');
eval(src); // file defines plain globals, browser-style

// 1) candidate detection
assert.strictEqual(detectDeixisCandidates('이 식을 여기에 대입하면 됩니다'), true);
assert.strictEqual(detectDeixisCandidates('아까 그 정리를 다시 봅시다'), true);
assert.strictEqual(detectDeixisCandidates('오일러 공식은 중요합니다'), false);

// 2) parse + validate: keeps only high-conf, unique-quote, existing-slide items
const rec = '[00:01:00] 발화자 1: 이 식을 여기 대입하면 값이 나옵니다.\n\n[00:02:00] 발화자 1: 그 정리는 다음 시간에 봅니다.';
const ppt = '[슬라이드 8]\n제목: 오일러 공식\n내용: e^{iθ}=cosθ+i·sinθ';
const raw = '설명입니다.\n[' + JSON.stringify({q:'이 식을 여기 대입하면', ref:'오일러 공식 e^{iθ}=cosθ+i·sinθ', slide:8, conf:'high'})
  + ',' + JSON.stringify({q:'그 정리는', ref:'뭔가 정리', slide:8, conf:'medium'})            // dropped: not high
  + ',' + JSON.stringify({q:'없는 인용문', ref:'X', slide:8, conf:'high'})                    // dropped: quote absent
  + ',' + JSON.stringify({q:'값이 나옵니다', ref:'X', slide:99, conf:'high'})                 // dropped: slide 99 not in deck
  + ']';
const anns = parseDeixisAnnotations(raw, rec, ppt);
assert.strictEqual(anns.length, 1);
assert.strictEqual(anns[0].q, '이 식을 여기 대입하면');

// 3) parse failure / garbage → []
assert.deepStrictEqual(parseDeixisAnnotations('no json here', rec, ppt), []);

// 4) section building
const section = buildDeixisSection(anns);
assert.ok(section.includes('지시어 해석 주석'));
assert.ok(section.includes('슬라이드 8'));
assert.strictEqual(buildDeixisSection([]), '');

// 5) per-record assignment: quote must appear exactly once in that record's raw text
assert.strictEqual(assignAnnotationsToRecordText(anns, rec).length, 1);
assert.strictEqual(assignAnnotationsToRecordText(anns, '전혀 다른 텍스트').length, 0);

// 6) chip injection into escaped HTML (no double-annotation, chip is a span)
const esc = rec.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const html = injectDeixisChips(esc, anns);
assert.ok(html.includes('deixis-chip'));
assert.ok(html.includes('오일러 공식'));
assert.strictEqual((html.match(/deixis-chip/g) || []).length, 1);

console.log('test_deixis: ALL PASS');
```

- [ ] **Step 2: Run to verify failure** — `node scripts/test_deixis.js` → fails (file missing / functions undefined).

- [ ] **Step 3: Implement `public/js/deixis.js`**

```js
// U17: deixis-resolution helpers (pure — no DOM, no network). Loaded before pipeline.js.
// Resolution = one Sonnet call per analysis that shares agent1's cache prefix; these
// helpers gate, validate, and format around that call.

// Korean demonstratives + verbal back-references. Cheap gate: skip the LLM call when absent.
const DEIXIS_RE = /(이|그|저)\s?(거|것|식|정리|공식|부분|그림|표|정의|문제)|여기(에|서|다|에다)?\s?(대입|넣|보)|저기|아까\s?(그|말한|본)|방금\s?(말한|본|그)/;

function detectDeixisCandidates(text) {
  return DEIXIS_RE.test(text || '');
}

function buildDeixisUserPrompt() {
  // The shared cache prefix already carries [PPT 참고 자료] + [강의 녹취록] (and
  // note-writing instructions, which this call must ignore — stated explicitly).
  return `지금은 노트를 작성하지 마세요. 위의 [형식]·[규칙] 지시는 이 작업에 적용되지 않습니다.

[작업: 지시어 해석]
위 [강의 녹취록]에서 화자가 "이거", "저 식", "여기", "아까 그 정리" 같은 지시어로 [PPT 참고 자료]의 구체적 대상(공식·정리·정의·그림·표)을 가리키는 부분을 찾아, 무엇을 가리키는지 해석하세요.

규칙:
1. q: 지시어를 포함한 녹취록 원문 인용 (10~60자, 녹취록에서 딱 한 번만 등장하는 고유한 구간을 골라 토씨 하나 바꾸지 말고 그대로 복사)
2. ref: 가리키는 대상을 구체적으로 (이름 + 짧은 수식/정의, 120자 이내)
3. slide: 해당 슬라이드/페이지 번호 (녹취 맥락만으로 해석된 경우 null)
4. conf: 확신도 "high"/"medium"/"low" — 슬라이드 내용과 발화 맥락이 명확히 일치할 때만 "high"
5. 확실하지 않으면 아예 출력하지 마세요. 틀린 해석은 해석 없음보다 나쁩니다.
6. 발화 안에서 이미 스스로 해소되는 지시어(바로 앞 문장에 대상이 명시된 경우)는 제외
7. 최대 40개

출력은 JSON 배열만: [{"q":"...","ref":"...","slide":8,"conf":"high"}]
해석할 것이 없으면 [] 만 출력하세요.`;
}

function _countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let n = 0, i = 0;
  while ((i = haystack.indexOf(needle, i)) !== -1) { n++; i += needle.length; }
  return n;
}

function parseDeixisAnnotations(rawModelText, recText, pptText) {
  let arr;
  try {
    const m = (rawModelText || '').match(/\[[\s\S]*\]/);
    if (!m) return [];
    arr = JSON.parse(m[0]);
  } catch (_) { return []; }
  if (!Array.isArray(arr)) return [];
  const slideNums = new Set(
    [...(pptText || '').matchAll(/\[(?:슬라이드|페이지) (\d+)\]/g)].map(m => parseInt(m[1], 10))
  );
  const seen = new Set();
  const out = [];
  for (const a of arr) {
    if (!a || typeof a !== 'object') continue;
    const q = typeof a.q === 'string' ? a.q.trim() : '';
    const ref = typeof a.ref === 'string' ? a.ref.trim() : '';
    const slide = Number.isInteger(a.slide) ? a.slide : null;
    if (a.conf !== 'high') continue;                       // threshold policy: high only
    if (q.length < 4 || q.length > 60) continue;
    if (ref.length < 2 || ref.length > 120) continue;
    if (_countOccurrences(recText || '', q) !== 1) continue; // must anchor uniquely
    if (slide !== null && !slideNums.has(slide)) continue;   // hallucinated slide → drop
    if (seen.has(q)) continue;
    seen.add(q);
    out.push({ q, ref, slide, conf: 'high' });
    if (out.length >= 40) break;
  }
  return out;
}

function buildDeixisSection(annotations) {
  if (!annotations || annotations.length === 0) return '';
  const lines = annotations.map(a =>
    `- "${a.q}" → ${a.ref}${a.slide !== null ? ` (슬라이드 ${a.slide})` : ''}`);
  return `[지시어 해석 주석 — 시스템이 슬라이드 대조로 추론한 참고 정보이며 발화 원문이 아님]
노트 작성 시 아래 지시어를 해석된 대상으로 구체화하세요. 단, 발화를 직접 인용할 때는 원문을 유지하세요.
${lines.join('\n')}

`;
}

function assignAnnotationsToRecordText(annotations, recordText) {
  const t = recordText || '';
  return (annotations || []).filter(a => _countOccurrences(t, a.q) === 1);
}

function _escHtmlForDeixis(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// escapedHtml: output of escHtml() over the raw record text (transcripts_view contract).
// Wraps the quoted span and appends a visually-distinct inferred chip.
function injectDeixisChips(escapedHtml, annotations) {
  let html = escapedHtml;
  for (const a of (annotations || [])) {
    const eq = _escHtmlForDeixis(a.q);
    if (_countOccurrences(html, eq) !== 1) continue; // escaping shifted things — skip, never guess
    const chip = `<span class="deixis-quote">${eq}</span><span class="deixis-chip" title="AI가 슬라이드 대조로 추론한 해석입니다">→ ${_escHtmlForDeixis(a.ref)}${a.slide !== null ? ` (p.${a.slide})` : ''}</span>`;
    html = html.replace(eq, chip);
  }
  return html;
}
```

- [ ] **Step 4: Verify** — `node --check public/js/deixis.js` then `node scripts/test_deixis.js` → `test_deixis: ALL PASS`.

- [ ] **Step 5: Commit**

```bash
git add public/js/deixis.js scripts/test_deixis.js
git commit -m "feat(U17): deixis-resolution pure helpers + node tests (detection gate, high-conf validation, prompt/section/chip builders)"
```

---

### Task 2: pipeline wiring — prefix extraction + resolution stage + prompt threading

**Files:**
- Modify: `public/js/pipeline.js` (three spots: prefix builder extraction at `agent1_writeNotes` ~:1326-1349; stage in `runAgentPipeline` ~:14-71; deixis section prepended to agent1 user prompts)

**Interfaces:**
- Consumes: Task 1 functions (globals).
- Produces: `buildAgent1CachePrefix(pptText, recText) -> string` (single source of truth for the shared prefix); global `storedDeixisAnnotations` (array, reset per run); `agent1_writeNotes` gains optional `deixisSection` param (7th).

- [ ] **Step 1: Extract the prefix builder.** In `pipeline.js`, replace the inline prefix construction at :1326-1348 with a call to a new top-level function placed just above `agent1_writeNotes`. The body is MOVED verbatim (byte-identical output is the whole point):

```js
// U17: single source of truth for agent1's cached prefix. The deixis stage sends
// this EXACT string as its cached block so agent1 reads the cache it wrote (0.1x).
// Any byte drift here silently breaks both that and the U12 cached-critic path.
function buildAgent1CachePrefix(pptText, recText) {
  const { formatSection, rulesSection } = getNoteFormatBlocks();
  const hasTxt = recText && recText.trim().length > 0;
  const hasPpt = pptText && pptText.trim().length > 0;
  const systemPrompt = getAgent1SystemPrompt();
  let cachePrefix = `${systemPrompt}\n\n[형식]\n${formatSection}\n\n[규칙]\n${rulesSection}`;
  if (hasPpt) cachePrefix += `\n\n${PPT_STRUCTURE_CLAUSE}\n\n[PPT 참고 자료]\n${pptText}`;
  if (hasTxt) cachePrefix += `\n\n[강의 녹취록]\n${recText}`;
  return cachePrefix;
}
```

⚠️ The original at :1327-1333 uses a template literal with real newlines — when moving it, preserve the exact byte sequence (`\n` escapes above must produce identical output; verify with the smoke assertion in Step 4). Inside `agent1_writeNotes`, the block becomes `let cachePrefix = buildAgent1CachePrefix(pptText, recText);` and `_agent1CachePrefix = cachePrefix;` stays.

- [ ] **Step 2: Add the resolution stage.** Near the top of `pipeline.js` add the global; inside `runAgentPipeline`, after the existing per-run resets (`_agent1CachePrefix = null;` at ~:22) add the stage so it runs before the `agent1_writeNotes` call at ~:71:

```js
let storedDeixisAnnotations = [];   // U17: high-conf annotations from the current run
```

```js
  // U17: deixis-resolution stage — before agent1 so notes are written with resolved
  // referents. Shares agent1's exact cache prefix (writes the entry agent1 reads).
  storedDeixisAnnotations = [];
  let deixisSection = '';
  if (storedPptText && storedFilteredText && detectDeixisCandidates(storedFilteredText)) {
    try {
      setAgentNode(1, 'loading', '지시어 해석 중…');
      const prefix = buildAgent1CachePrefix(storedPptText, storedFilteredText);
      const raw = await callClaudeOnce(apiKey, buildDeixisUserPrompt(), MINIMAL_SYSTEM,
        2000, 'claude-sonnet-4-6', prefix, { isFirstCall: false, feature: 'noteAnalysis' });
      storedDeixisAnnotations = parseDeixisAnnotations(raw, storedFilteredText, storedPptText);
      deixisSection = buildDeixisSection(storedDeixisAnnotations);
      agentLog(1, `지시어 해석 ${storedDeixisAnnotations.length}건 (고신뢰만 채택)`);
    } catch (e) {
      console.warn('[deixis] resolution skipped:', e); // fail-open: notes proceed unannotated
    }
  }
```

Adjust to the actual local structure of `runAgentPipeline` (mode branches): compute `deixisSection` once before the branch that calls `agent1_writeNotes`, and pass it into every `agent1_writeNotes(...)` call site as the new 7th argument.

- [ ] **Step 3: Thread the section into agent1's uncached prompts.** Change the signature to `async function agent1_writeNotes(apiKey, pptText, recText, critiqueText = '', targetBodyEl = null, meta = {}, deixisSection = '')` and prepend `deixisSection` to each `userPrompt` construction inside it (revision mode ~:1369, PPT-only mode ~:1381 — skip this one, it has no transcript, section is '' anyway — single-pass and chunked modes). Pattern: `const userPrompt = deixisSection + '위 PPT 자료와 강의 녹취록을 바탕으로…'`. **Do NOT touch `cachePrefix`** — the section lives only in the uncached second text block.

- [ ] **Step 4: Verify.**
  - `node --check public/js/pipeline.js`
  - `node scripts/test_deixis.js` still green.
  - Byte-identity smoke: append a temporary assertion to `scripts/test_deixis.js` run or eyeball via `node -e` extracting both old/new construction on a fixture — minimum bar: manually diff the moved literal against `git show HEAD:public/js/pipeline.js` lines 1327-1348 and confirm the emitted format markers (`[형식]`, `[규칙]`, `[PPT 참고 자료]`, `[강의 녹취록]`, blank-line spacing) are unchanged.
  - `bash scripts/acceptance/*.spec.sh` relevant specs still green (at minimum the U12 spec, which asserts the cached-critic contract).

- [ ] **Step 5: Commit**

```bash
git add public/js/pipeline.js
git commit -m "feat(U17): deixis stage in pipeline — prefix builder extracted (byte-identical), Sonnet resolution call prewarms agent1 cache, section threaded into uncached prompts"
```

---

### Task 3: storage + id threading + UI chips + index.html

**Files:**
- Modify: `public/js/transcripts_store.js` (add `saveDeixisAnnotationsFS`, schema comment)
- Modify: `public/js/transcripts_view.js` (tag File with `_transcriptId` at :261; render chips in `renderTranscriptPreviewBody` ~:425-442)
- Modify: `public/js/recorder.js` (one line: tag File at :1496 — ⚠️ U7e WIP lives in this file; touch ONLY this line)
- Modify: `public/js/note_creation.js` (collect ids at ~:107-115; save annotations after `runAgentPipeline` at ~:131)
- Modify: `public/index.html` (script tag for `deixis.js`, chip CSS, cache-bust `?v=` — ⚠️ U7e WIP in this file too)

**Interfaces:**
- Consumes: `storedDeixisAnnotations` global (Task 2), `assignAnnotationsToRecordText` / `injectDeixisChips` (Task 1).
- Produces: `saveDeixisAnnotationsFS(id, annotations)`; transcript record field `deixisAnnotations`.

- [ ] **Step 1: Store helper** — in `transcripts_store.js`, mirror `saveSpeakerNamesFS` (:150-156):

```js
  // U17: deixis annotation layer — stored beside text, text itself never rewritten
  // (same contract as speakerNames). [{q, ref, slide, conf:'high'}]
  async function saveDeixisAnnotationsFS(id, deixisAnnotations) {
    const col = userTranscriptsCol();
    if (!col) return;
    await col.doc(id).set({ deixisAnnotations, updatedAt: new Date().toISOString() }, { merge: true });
  }
```

Export/expose the same way `saveSpeakerNamesFS` is exposed (check bottom of file for the window/global pattern and follow it exactly).

- [ ] **Step 2: Tag Files with their record id.**
  - `transcripts_view.js:261` → after `const file = new File(...)` add `file._transcriptId = t.id;`
  - `recorder.js:1496` → after `const file = new File(...)` add `file._transcriptId = id;` (use the id variable that `deliverTranscript` saved the record under — read the surrounding function to pick the correct identifier).

- [ ] **Step 3: Save after analysis** — in `note_creation.js`, while merging transcripts (~:111-114) collect `const recIds = recFiles.map(s => s.file._transcriptId).filter(Boolean);` and the per-file raw texts; after `await runAgentPipeline(apiKey);` (~:131) add:

```js
    // U17: persist high-conf deixis annotations back onto their source transcript
    // records (display layer for the preview modal). Fire-and-forget; text untouched.
    if (typeof storedDeixisAnnotations !== 'undefined' && storedDeixisAnnotations.length > 0) {
      for (let i = 0; i < recFiles.length; i++) {
        const tid = recFiles[i].file._transcriptId;
        if (!tid) continue;
        const recRaw = await recFiles[i].file.text();
        const mine = assignAnnotationsToRecordText(storedDeixisAnnotations, recRaw);
        if (mine.length > 0) saveDeixisAnnotationsFS(tid, mine).catch(e => console.warn('[deixis] save failed:', e));
      }
    }
```

Note: the File content is `applySpeakerNames(t.text, ...)` output, not the raw record text — quotes still match because name substitution only rewrites `발화자 N:` label prefixes, never sentence bodies. If a quote happens to contain a label (rare), `assignAnnotationsToRecordText` at render time re-filters against the true record text, so a mismatch degrades to "chip not shown", never a wrong anchor.

- [ ] **Step 4: Render chips** — in `transcripts_view.js` `renderTranscriptPreviewBody(rawText, speakerNames)`: change signature to `(rawText, speakerNames, deixisAnnotations)` and, after the existing escHtml step but before/independent of the speaker-label span pass, run `if (deixisAnnotations?.length) escaped = injectDeixisChips(escaped, assignAnnotationsToRecordText(deixisAnnotations, rawText));` (order the two passes so label-wrapping regex still matches — label spans wrap line prefixes, chips wrap mid-line quotes; verify no overlap breakage with a quick manual test). Update the three call sites (:384, :485, :515) to pass `t.deixisAnnotations`.

- [ ] **Step 5: index.html** — add `<script src="js/deixis.js?v=u17deixis"></script>` immediately BEFORE the `pipeline.js` script tag (load order matters); bump `pipeline.js` / `transcripts_view.js` / `transcripts_store.js` / `note_creation.js` / `recorder.js` `?v=` values to `u17deixis`; add CSS near other chip styles:

```css
.deixis-quote { border-bottom: 1px dashed var(--accent, #8b5cf6); }
.deixis-chip {
  display: inline-block; margin: 0 2px; padding: 0 6px; border-radius: 8px;
  font-size: 0.78em; font-style: italic; opacity: 0.85;
  background: color-mix(in srgb, var(--accent, #8b5cf6) 12%, transparent);
  color: var(--accent, #8b5cf6); vertical-align: baseline;
}
```

(Reuse the app's actual accent variable — inspect existing `.page-cite-chip` CSS and match its variable names/dark-theme handling instead of inventing new ones.)

- [ ] **Step 6: Verify** — `node --check` on all five touched JS files; `node scripts/test_deixis.js`; grep `index.html` for exactly one `deixis.js` script tag positioned before `pipeline.js`.

- [ ] **Step 7: Commit (selective staging — U7e WIP must not ride along)**

```bash
git add public/js/transcripts_store.js public/js/transcripts_view.js public/js/note_creation.js
# recorder.js and index.html contain unrelated U7e WIP — stage only our hunks:
git diff public/js/recorder.js > /tmp/rec.patch   # inspect: keep ONLY the _transcriptId hunk
git diff public/index.html > /tmp/idx.patch        # inspect: keep ONLY deixis script/CSS/?v hunks
# edit patches down to our hunks, then: git apply --cached /tmp/rec.patch /tmp/idx.patch
git commit -m "feat(U17): deixis annotation storage (speakerNames-pattern field), transcript-id threading, preview chip rendering, cache-bust"
```

If patch surgery proves error-prone, acceptable fallback: `git add -N` + `git diff` review, or stage the whole file ONLY after verifying `git diff --cached` contains zero U7e hunks. Never commit hunks you didn't write.

---

### Task 4: acceptance spec

**Files:**
- Create: `scripts/acceptance/u17_deixis.spec.sh` (mirror the structure of an existing spec, e.g. `u15` — greps + node test invocation, exit non-zero on failure)

- [ ] **Step 1: Write the spec** — assertions (grep-based, source-of-truth style used by existing specs):
  1. `node scripts/test_deixis.js` passes.
  2. `deixis.js` defines all six Task-1 functions.
  3. `pipeline.js` contains `buildAgent1CachePrefix` and `agent1_writeNotes` uses it (`cachePrefix = buildAgent1CachePrefix`).
  4. Resolution call uses `claude-sonnet-4-6` + `MINIMAL_SYSTEM` + the prefix (cache-share contract).
  5. Threshold: `parseDeixisAnnotations` contains `conf !== 'high'` (high-only policy).
  6. `transcripts_store.js` has `saveDeixisAnnotationsFS` and does NOT write `text` in it (zero-mutation guard: the set() payload must not contain `text`).
  7. `index.html` loads `deixis.js` before `pipeline.js` and `?v=u17deixis` present.
  8. `node --check` all touched files.

- [ ] **Step 2: Run** — `bash scripts/acceptance/u17_deixis.spec.sh` → green; then run the full acceptance suite (do NOT pipe through `tail` — exit codes get masked; loop specs and check `$?` each, per the 07-09 lesson).

- [ ] **Step 3: Commit**

```bash
git add scripts/acceptance/u17_deixis.spec.sh
git commit -m "test(U17): acceptance spec — helper contracts, cache-share wiring, high-conf threshold, zero-mutation guard"
```

---

### Task 5 (Phase 3 — run by Fable, not a subagent): live-behavior verification

Not a code task. Checklist: synthetic E2E with a fixture transcript+deck through `parseDeixisAnnotations` on real model output (one manual `callClaudeOnce`-equivalent via curl to `/api/claude` is not possible locally — instead run the resolution prompt against the API through a small node script with a fixture, using the dev key if available, else validate prompt+parse offline); manual precision review of every emitted annotation (precision > recall); confirm `usage.cache_read_input_tokens` behavior can be observed in claude.js metering when live; confirm transcript record `text` byte-identical before/after (Firestore read); `/ponytail-review`.
