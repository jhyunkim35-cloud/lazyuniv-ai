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

// String-aware bracket matcher: find the JSON array of objects in model output,
// tolerating prose before/after (bracketed headers like "[작업: ...]" are skipped
// because they aren't followed by '{' or ']') and max_tokens truncation (salvages
// every complete object and closes the array).
function _extractJsonArray(raw) {
  let start = -1;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '[' && /^\s*[{\]]/.test(raw.slice(i + 1, i + 8))) { start = i; break; }
  }
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false, lastObjEnd = -1;
  for (let i = start; i < raw.length; i++) {
    const c = raw[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '[' || c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 1) lastObjEnd = i; }
    else if (c === ']') { depth--; if (depth === 0) return raw.substring(start, i + 1); }
  }
  // Never closed → truncated output: keep the complete objects.
  return lastObjEnd !== -1 ? raw.substring(start, lastObjEnd + 1) + ']' : null;
}

function parseDeixisAnnotations(rawModelText, recText, pptText) {
  let arr;
  try {
    const slice = _extractJsonArray(rawModelText || '');
    if (!slice) return [];
    arr = JSON.parse(slice);
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
    // A non-integer slide (e.g. "99") must be REJECTED, not laundered to null —
    // null skips the slide-existence gate below, which would let hallucinated
    // slides through as "context-only" resolutions.
    if (a.slide !== null && a.slide !== undefined && !Number.isInteger(a.slide)) continue;
    const slide = Number.isInteger(a.slide) ? a.slide : null;
    if (a.conf !== 'high') continue;                       // threshold policy: high only
    if (q.length < 4 || q.length > 60) continue;
    // Multi-line quotes and quotes swallowing a speaker-label prefix break the
    // preview's line-start label pass (label styling + U15 name substitution).
    if (/\n/.test(q) || /(발화자|참석자)\s*\d+\s*:/.test(q)) continue;
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
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// escapedHtml: output of escHtml() over the raw record text (transcripts_view contract).
// Wraps the quoted span and appends a visually-distinct inferred chip.
function injectDeixisChips(escapedHtml, annotations) {
  let html = escapedHtml;
  for (const a of (annotations || [])) {
    const eq = _escHtmlForDeixis(a.q);
    if (_countOccurrences(html, eq) !== 1) continue; // escaping shifted things — skip, never guess
    const chip = `<span class="deixis-quote">${eq}</span><span class="deixis-chip" title="AI가 슬라이드 대조로 추론한 해석입니다">→ ${_escHtmlForDeixis(a.ref)}${Number.isInteger(a.slide) ? ` (p.${a.slide})` : ''}</span>`;
    // function replacer: ref may contain $-patterns (e.g. LaTeX $$) — must not trigger GetSubstitution
    html = html.replace(eq, () => chip);
  }
  return html;
}
