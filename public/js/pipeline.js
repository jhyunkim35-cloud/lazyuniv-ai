// Agent pipeline orchestration, note writers, critic.
// Depends on: constants.js (analyzeBtn, storedPptText, storedFilteredText, storedNotesText, storedHighlightedTranscript, currentNoteId, currentSummaryLayers, currentStudyTools, DONE_SIGNAL, MAX_ITERATIONS, MAX_TOKENS_NOTES, MAX_TOKENS_CRITIQUE, iterChipData, debugLog), markdown.js (renderMarkdown, escHtml, citeChip), api.js (callClaudeOnce, callClaudeStream), ui.js (agentLog, setProgress, setAgentNode, resetAgentNodes, makeAgentDot, updateIterCounter, addIterChip, updateETA, startElapsedTimer, stopElapsedTimer, showToast, showSuccessToast), firestore_sync.js (getNoteFS, saveNoteFS).

async function runAgentPipeline(apiKey, targetBodyEl = null) {
  resetAgentNodes();
  const _heroEl = document.getElementById('summaryHero');  // R3: hide stale summary hero on new run
  if (_heroEl) _heroEl.hidden = true;
  currentSummaryLayers = null;  // R4: reset multilayer summary so a failed synth doesn't leak the previous note's layers
  currentStudyTools = null;  // R8+R9: reset study tools so a new analysis doesn't leak the previous note's mindmap/memorize/concepts
  const _stCard = document.getElementById('studyToolsCard');  // R8+R9: hide stale card too (same reason as hero above)
  if (_stCard) _stCard.hidden = true;
  iterChipData = [];
  startElapsedTimer();
  debugLog('PIPE', 'Pipeline start');
  agentLog(0, `노트 작성·비평 루프 시작… (최대 ${MAX_ITERATIONS}회)`);

  // B1: generate one analysisId for the entire pipeline. api.js auto-injects
  // this into every fetch body so the server bills the analysis exactly
  // once on the first call and treats every subsequent call as a no-op
  // replay. Cleared in finally so quiz/classify/vision calls outside the
  // pipeline don't accidentally piggyback on it.
  _currentAnalysisId = uuidv4().replace(/-/g, '').slice(0, 32);
  debugLog('PIPE', 'analysisId=' + _currentAnalysisId);

  const iterTimings = [];
  let notesText    = '';
  let critiqueText = '';

  try {
    setAgentNode(0, 'done', '스킵 — 원본 전달');

    for (let iter = 1; iter <= MAX_ITERATIONS; iter++) {
      const iterStart = Date.now();
      updateIterCounter('running', iter);
      agentLog(0, `━━━ ${iter}차 시작 ━━━`);

      /* ── Remove previously inserted slide figures before re-writing ── */
      const iterTargetEl = targetBodyEl || document.getElementById('finalNotesBody');
      iterTargetEl.querySelectorAll('figure[data-slide-inserted]').forEach(f => f.remove());

      if (iter === 1) {
        /* ── Iter 1: Sonnet writes full note ── */
        debugLog('PIPE', `Iter ${iter} — Agent1 start, hasTxt=${!!storedFilteredText}, critique=${!!critiqueText}`);
        const fmtName = getFormatDisplayName();
        if (!targetBodyEl) {
          document.getElementById('notesCardTitle').textContent = `📚 통합 학습 노트 (작성 중… ${fmtName})`;
        }
        analyzeBtn.textContent = `⏳ Agent 1: 노트 작성 중… (${fmtName})`;
        setProgress(20, `Agent 1: 노트 작성 중… ${fmtName}`);
        notesText = await agent1_writeNotes(apiKey, storedPptText, storedFilteredText, '', targetBodyEl, { isFirstCall: true, feature: 'noteAnalysis' });
        debugLog('PIPE', `Iter ${iter} — Agent1 done, notes=${notesText.length}chars`);
        if (!targetBodyEl) document.getElementById('notesCardTitle').textContent = '📚 통합 학습 노트';

        /* ── Iter 1: Sonnet critiques ── */
        analyzeBtn.textContent = `⏳ Agent 2: ${iter}차 검토 중…`;
        setProgress(45, `Agent 2: ${iter}차 검토 중…`);
        critiqueText = await agent2_critiqueNotes(apiKey, notesText, storedPptText, storedFilteredText, iter);

        // Guard: if Agent2 returned a meta-report instead of a real critique, keep Agent1 notes as-is
        const CRITIC_META_MARKERS = ['검토 보고서', '제출된 학습 노트', '요청사항', '수정 불가'];
        const criticIsMeta = CRITIC_META_MARKERS.some(m => critiqueText.includes(m));
        if (criticIsMeta) {
          console.warn('Agent2 returned meta-report instead of critique — using Agent1 notes as-is');
          agentLog(0, '⚠️ Agent2가 메타 보고서를 반환 — Agent1 노트를 최종 결과로 사용');
          updateIterCounter('done', iter);
          addIterChip(iter, true);
          break;
        }

        const isDone = critiqueText.includes(DONE_SIGNAL);
        const hasCritical = critiqueText.includes('[CRITICAL]');
        // R2-B: skip Iter 2 when critique only flags NORMAL/MINOR. The system
        // prompt makes the critic output summary statistics (not specific fix
        // lines) for those, so the JSON patch step would match 0 entries and
        // fall through to no-op or expensive Haiku full-rewrite. Cut the
        // round-trip entirely — Iter 1 notes are the final output in this case.
        const skipPatch = isDone || !hasCritical;
        debugLog('PIPE', `Iter ${iter} — Agent2 done, isDone=${isDone}, hasCritical=${hasCritical}, skipPatch=${skipPatch}, critique=${critiqueText.length}chars`);

        const iterDuration = Date.now() - iterStart;
        iterTimings.push(iterDuration);
        updateIterCounter('done', iter);
        addIterChip(iter, skipPatch);

        if (skipPatch) {
          updateETA(iterTimings, 0);
          const finalBar = document.getElementById('agentFinalBar');
          const skipReason = isDone
            ? '학습 노트가 원본과 일치합니다'
            : '핵심 수정사항 없음 — NORMAL/MINOR만 발견, 패치 생략';
          finalBar.innerHTML =
            `✅ ${iter}차 검토 완료 — ${skipReason} (총 ${Math.round(iterTimings.reduce((a,b)=>a+b,0)/1000)}초 소요)`;
          finalBar.classList.add('visible');
          agentLog(0, `━━━ 완료 (${iter}차에 검토 통과${isDone ? '' : ', CRITICAL 없음'}) ━━━`);
          break;
        }

        /* prepare iter 2 */
        agentLog(0, `수정 사항 발견 → ${iter + 1}차 Haiku 패치 진행`);
        updateETA(iterTimings, 1);
        await new Promise(r => setTimeout(r, 300));
        for (let n = 1; n <= 2; n++) {
          document.getElementById('anode'   + n).className   = 'agent-node';
          document.getElementById('astatus' + n).textContent = `${iter + 1}차 준비`;
        }
        document.getElementById('aconn1').classList.remove('active');

      } else {
        /* ── Iter 2+: Haiku applies critical fixes only, skip re-critique ── */
        debugLog('PIPE', `Iter ${iter} — Haiku patch start, critique=${critiqueText.length}chars`);
        if (!targetBodyEl) {
          document.getElementById('notesCardTitle').textContent = `📚 통합 학습 노트 (${iter}차 Haiku 패치 중…)`;
        }
        analyzeBtn.textContent = `⏳ Haiku: ${iter}차 핵심 수정 중…`;
        setProgress(65, `Haiku: ${iter}차 핵심 수정 중…`);
        const prePatchNotes = notesText;
        notesText = await agent1_patchNotes(apiKey, notesText, critiqueText, targetBodyEl);
        debugLog('PIPE', `Iter ${iter} — Haiku patch done, notes=${notesText.length}chars`);

        // Guard: if Haiku patch produced meta-content, revert to pre-patch notes
        const PATCH_META_MARKERS = ['검토 보고서', '요청사항', '[CRITICAL]'];
        const patchIsMeta = PATCH_META_MARKERS.some(m => notesText.includes(m));
        if (patchIsMeta) {
          console.warn('Haiku patch produced meta-content — reverting to pre-patch notes');
          agentLog(1, '⚠️ Haiku 패치 결과에 메타 콘텐츠 감지 — 패치 전 노트로 복원');
          notesText = prePatchNotes;
          const iterTargetEl2 = targetBodyEl || document.getElementById('finalNotesBody');
          iterTargetEl2.innerHTML = renderMarkdown(notesText);
          storedNotesText = notesText;
        }
        if (!targetBodyEl) document.getElementById('notesCardTitle').textContent = '📚 통합 학습 노트';

        const iterDuration = Date.now() - iterStart;
        iterTimings.push(iterDuration);
        updateIterCounter('done', iter);
        addIterChip(iter, false);

        const finalBar = document.getElementById('agentFinalBar');
        finalBar.innerHTML =
          `✅ Haiku 패치 완료 — 최종 노트가 위에 표시됩니다 (총 ${Math.round(iterTimings.reduce((a,b)=>a+b,0)/1000)}초 소요)`;
        finalBar.classList.add('visible');
        agentLog(0, `━━━ Haiku 패치 완료 — 종료 ━━━`);
        break;
      }
    }

    /* ── Transcript highlighting ── */
    if (storedFilteredText) {
      storedHighlightedTranscript = await highlightTranscript(apiKey, storedFilteredText, storedNotesText);
    }
    debugLog('PIPE', 'Pipeline complete');
    if (typeof markNoteCreated === 'function') markNoteCreated().catch(() => {});
  } catch (err) {
    agentLog(0, `오류 발생: ${err.message}`);
    throw err;  // propagate to caller — single-mode and batch handlers both handle toasting
  } finally {
    stopElapsedTimer();
    // B1: clear analysisId so quiz/classify/vision calls after the pipeline
    // don't accidentally inherit it (they have feature !== 'noteAnalysis' so
    // it would be ignored anyway, but cleaner to null it out).
    _currentAnalysisId = null;
  }
}

/* ═══════════════════════════════════════════════
   Note format template (2-layer: skeleton + flesh)
═══════════════════════════════════════════════ */
function getFormatDisplayName() {
  return '📖 학습 가이드 형식';
}

function getAgent1SystemPrompt() {
  return `당신은 대학 강의 학습 가이드 작성 전문가입니다. PPT 슬라이드 구조를 뼈대로 삼고, 강의 녹취록의 교수님 설명을 녹여 시험 대비에 최적화된 학습 가이드를 작성합니다. 모든 출력은 한국어로 작성하세요. 내용이 없는 슬라이드(표지, 섹션 구분, Q&A, 이미지만 있는 슬라이드 등)는 다루지 마세요. 내용이 있는 슬라이드만 빠짐없이 다루되, 각 개념은 시험에 필요한 수준으로 서술하세요. Tables from slides MUST be recreated as markdown tables. NEVER use <br> or HTML tags inside markdown tables — use semicolons or commas instead. When the transcript contains additional explanations not in the PPT (e.g. concept distinctions, real-world examples, exam-related mentions), these MUST be included in the notes.`;
}

function getNoteFormatBlocks() {
  return {
    formatSection:
`**요약**: 강의 핵심 2~3문장 압축

# 대주제
---
## 소주제 — **키워드1**, **키워드2** p.번호

- **핵심 용어** : 정의 1줄 압축
    - 부연/세부사항 (서브불릿)
    - ex) 짧은 예시
- **다음 개념** : 정의
    - 세부 → 결과/흐름은 화살표
- 비교 2개 이상이면 표 사용

| 구분 | A | B |
|---|---|---|
| 항목 | 내용 | 내용 |

⭐ 교수님 강조사항 (명시적 강조 시에만)

[변환 예시 — 아래 PPT→노트 쌍을 참고하여 동일한 밀도와 스타일로 작성할 것]

예시1: 정의 변환
PPT 원문: "감각(Sensation)은 빛, 색, 소리, 냄새, 촉각 등 기본적인 자극에 대한 감각 기관(눈, 코, 입, 손가락…)의 즉각적인 반응을 말한다. 감각은 여러 감각기관을 통해 유입된 정보이지만 해석되지 않는 물리적 상태 그대로 저장됨"
→ 노트:
- **감각 Sensation** : 자극에 대한 감각기관의 즉각적 반응
    - 해석 없이 물리적 상태로 저장

예시2: 구성요소 나열
PPT 원문: "상담의 구성요소 — 내담자 Client: 도움을 필요로 하는 사람 / 상담자 Counselor: 전문 지식과 기법을 가지고 내담자를 돕는 사람 / 상담관계 Working Alliance: 관계의 신뢰(라포; rapport)를 바탕으로 함께 작업하는 관계"
→ 노트:
- **내담자 Client** : 도움을 필요로 하는 사람
- **상담자 Counselor** : 전문 지식과 기법을 가지고 내담자를 돕는 사람
- **상담 관계 Working Alliance** : 관계의 신뢰(라포) 바탕으로 함께 작업하는 관계

예시3: 교수님 구두 설명 추가 (PPT에 없는 내용을 서브불릿으로)
PPT 원문: "교육자(Educator) — 내담자에게 지식이나 기술을 가르쳐서 역량을 강화하는 것을 돕는 역할. ex) 심리 교육(psychoeducation), 대처 기술 훈련, 정보 제공"
교수님 설명(녹취록): "심리 교육이라는 건 내담자가 본인을 이해할 수 있도록 심리 이론을 알려주는 거고, 대처 기술 훈련은 예를 들면 공황장애 환자에게 봉지 들고 다니기, 얘기하기 전에 숫자 세기 같은 걸 가르치는 거예요"
→ 노트:
- **교육자 Educator** : 내담자에게 지식/기술 가르쳐 역량 강화를 돕는 역할
    - 심리 교육 - 내담자가 본인을 이해할 수 있도록 심리 이론 알려줌
    - 대처 기술 훈련
    - 공황장애 → 봉지 들고 다니기, 얘기 하기 전에 숫자 세기
    - 정보 제공 - 약물 치료 받으면 좋을테니 ~~가봐라

예시4: 비교 항목 → 표
PPT 원문: "유사 인접 학문 비교 — 상담심리학: 비임상군 중심(~임상군), 일상 적응과 성장 / 임상심리학: 임상군, 정신장애 평가·진단·심리치료 / 정신건강의학: 임상군, 의학적 진단·약물치료 / 사회복지학: 비임상군~임상군, 환경적·제도적 지원 연계"
→ 노트:
| 분야 | 대상 | 핵심 역할 |
|---|---|---|
| 상담심리 | 비임상군 (~임상군) | 일상 적응과 성장 |
| 임상심리 | 임상군 | 정신 장애 평가, 진단, 심리 치료 |
| 정신건강의학 | 임상군 | 의학적 진단, 약물 치료 |
| 사회복지학 | 비임상군~임상군 | 환경적, 제도적 지원 연계 |`,
    rulesSection:
`[작성 규칙]
- 키워드 중심 압축체로 작성 — 장문 서술/문단 금지
- 조사·서술어 최소화, 체언(명사/키워드) 중심으로 압축 — "타인의 행동을 관찰하여 학습 가능" ✗ → "타인 행동 관찰로도 학습 가능" ✓
- 한 불릿 = 한 줄 (최대 2줄)
- 정의는 "용어 : 정의" 또는 "용어 = 정의" 형태
- 부연은 들여쓰기 서브불릿으로 계층화
- 예시는 ex) 접두사로 짧게, 단 예시가 왜 해당 개념의 사례인지 한 줄 설명 포함 — "ex) 카스텔로 비앙코 포장 문제" ✗ → "ex) 카스텔로 비앙코 — 흰색 치즈인데 포장 색이 이를 예측하게 하지 못해 소비자 혼란" ✓
- 비교 항목 2개 이상이면 반드시 표
- 종결어미: ~함, ~임, ~됨 (명사형/메모체)
- 화살표(→)로 인과/흐름 표현
- ⭐는 교수님이 명시적으로 강조한 경우만
- PPT에 없는 교수님 구두 설명은 서브불릿으로 반드시 포함
- 쉬운 설명 블록 사용하지 말 것
- ❓ 질문 블록 사용하지 말 것
- 불필요한 반복, 접속사, 부연 최소화
- 이전 청크 노트가 제공된 경우: 이미 작성된 동일 정의·용어 설명을 그대로 반복하지 않는다. 단, 해당 개념이 새로운 맥락·추가 예시·비교표·심화 설명·다른 개념과의 비교/대조 맥락에서 재등장하는 경우, 해당 새로운 내용은 반드시 포함한다.`,
  };
}

/* ═══════════════════════════════════════════════
   Agent 1 helpers — transcript chunking (DISABLED — kept for fallback)
═══════════════════════════════════════════════ */
/* DISABLED: replaced by single-pass Sonnet call in agent1_writeNotes
function chunkTranscript(text, maxChars = 4000, overlapChars = 200, minChars = 500) {
  if (text.length <= maxChars) return [{ text: text.trim(), overlap: '' }];

  function splitAtSentence(str, start, end) {
    const window   = str.slice(start, end);
    const dot      = window.lastIndexOf('. ');
    const dotNl    = window.lastIndexOf('.\n');
    const boundary = Math.max(dot, dotNl);
    return boundary > 0 ? start + boundary + 1 : end;
  }

  const rawChunks = [];
  let start = 0;
  while (start < text.length) {
    const end = start + maxChars >= text.length
      ? text.length
      : splitAtSentence(text, start, start + maxChars);
    const chunk = text.slice(start, end).trim();
    if (chunk) rawChunks.push(chunk);
    start = end;
  }

  const merged = [];
  for (const chunk of rawChunks) {
    if (merged.length > 0 && chunk.length < minChars) {
      merged[merged.length - 1] += ' ' + chunk;
    } else {
      merged.push(chunk);
    }
  }

  if (!merged.length) return [{ text: text.trim(), overlap: '' }];

  debugLog('CHUNK', `Input ${text.length} chars → ${merged.length} chunks (max=${maxChars})`);
  return merged.map((chunkText, i) => ({
    text: chunkText,
    overlap: i === 0 ? '' : merged[i - 1].slice(-overlapChars).trim()
  }));
}
*/

const PPT_STRUCTURE_CLAUSE =
`[PPT 구조 준수]
# 헤더는 PPT 섹션 제목 그대로 — 임의 생성 금지, # 아래 --- 수평선 필수
## 헤더는 PPT 슬라이드 제목 그대로 — 뒤에 볼드 키워드 + p.번호
PPT 슬라이드 순서를 따르되, 문맥의 연결성이 매우 강한 슬라이드들은 하나의 ## 소주제로 합쳐도 됨 (예: 같은 개념의 정의와 예시가 연속 슬라이드에 있는 경우). 단, p.번호는 범위로 표기할 것 (예: p.5-6)
PPT의 표·차트·다이어그램은 핵심 수치와 결론만 요약하여 포함

[슬라이드 참조]
## 소주제 뒤에 p.슬라이드번호를 표기하여 원본 참조 가능하게 할 것

[누락 방지 규칙]
PPT의 모든 슬라이드 내용이 노트에 반영되어야 함 — 슬라이드를 건너뛸 수 없으나, 연속된 슬라이드의 내용을 하나의 소주제로 합치는 것은 허용
녹취록에서 교수님이 설명한 핵심 내용이 빠지지 않도록 할 것
압축은 허용하되 개념 자체를 생략하지 말 것

[출력 종료 규칙]
마지막 내용 항목 이후 마무리 문장·요약 문장·메타 코멘트 추가 금지
노트는 마지막 콘텐츠 항목에서 바로 종료할 것`;

/* DISABLED: replaced by single-pass Sonnet call in agent1_writeNotes
async function extractChunkConcepts(apiKey, pptText, chunkText, overlapText, chunkIndex, totalChunks, cachePrefix = null) {
  const systemPrompt = getAgent1SystemPrompt();
  const overlapSection = overlapText
    ? `\n[이전 구간 연결 내용 — 맥락 참고용, 이 구간에서 중복 추출 금지]\n${overlapText}\n`
    : '';
  const userPrompt = `다음은 강의 녹취록의 ${chunkIndex + 1}번째 구간(전체 ${totalChunks}개 구간 중)입니다.
이 구간에서 다루는 핵심 개념들을 아래 형식으로 추출하세요.
${overlapSection}[녹취록 구간 ${chunkIndex + 1}/${totalChunks}]
${chunkText}`;

  return await callClaudeOnce(apiKey, userPrompt, systemPrompt, 4096, 'claude-sonnet-4-6', cachePrefix);
}
*/

/* ═══════════════════════════════════════════════
   Transcript highlighter
═══════════════════════════════════════════════ */
async function highlightTranscript(apiKey, transcript, notes) {
  agentLog(0, '녹취록 하이라이트 생성 중…');
  debugLog('PIPE', 'highlightTranscript start');
  const systemPrompt = '당신은 강의 녹취록 하이라이트 전문가입니다. 학습 노트의 핵심 개념에 대응하는 녹취록 속 중요 문장을 식별합니다.';
  const userPrompt =
`아래 학습 노트의 핵심 개념에 해당하는 녹취록 속 중요 문장/구절을 20~40개 찾아주세요.

각 줄에 녹취록에서 그대로 복사한 원문 구절을 하나씩 적으세요. 다른 설명 없이 구절만 출력하세요.
구절은 녹취록 원문과 정확히 일치해야 합니다 (10자 이상, 80자 이하).

[학습 노트 요약]
${notes.slice(0, 3000)}

[녹취록]
${transcript}`;

  try {
    const result = await callClaudeOnce(apiKey, userPrompt, systemPrompt, 4096, 'claude-haiku-4-5-20251001', null, { feature: 'noteAnalysis' });
    debugLog('PIPE', `highlightTranscript done, ${result.length}chars`);
    agentLog(0, '녹취록 하이라이트 완료');
    const phrases = result.split('\n').map(l => l.trim()).filter(l => l.length >= 10 && l.length <= 200);
    return applyHighlights(transcript, phrases);
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    debugLog('PIPE', `highlightTranscript error: ${e.message}`);
    return '';
  }
}

function applyHighlights(transcript, phrases) {
  if (!phrases.length) return escHtml(transcript);
  let html = escHtml(transcript);
  // Sort longest first so shorter substrings don't collide with already-marked longer phrases
  const sorted = [...phrases].sort((a, b) => b.length - a.length);
  for (const phrase of sorted) {
    const escaped = escHtml(phrase);
    const idx = html.indexOf(escaped);
    if (idx === -1) continue;
    // Skip if the match position is already inside a <mark>…</mark> span
    const before = html.slice(0, idx);
    const openMarks  = (before.match(/<mark>/g)  || []).length;
    const closeMarks = (before.match(/<\/mark>/g) || []).length;
    if (openMarks > closeMarks) continue;
    html = html.slice(0, idx) + '<mark>' + escaped + '</mark>' + html.slice(idx + escaped.length);
  }
  return html;
}

/* ═══════════════════════════════════════════════
   R2 — Dedicated summary synthesis + critic verification
   요약을 노트 파이프라인에서 떼어 1급 산출물로: 전체 노트(곁다리 아님)에서
   전용 프롬프트로 생성 → critic이 정확성·누락을 따로 검증 → FAIL이면 1회 재생성.
   모든 노트 경로(청크/단일/PPT)가 이 함수를 거친다. 실패해도 호출부 try/catch로 노트 생존.
═══════════════════════════════════════════════ */
async function synthesizeSummary(apiKey, fullNotes) {
  const sys = '당신은 대학 강의 학습노트 요약 전문가입니다. 한국어로 작성하세요.';
  // R4: 1콜로 4층(한줄/핵심/문단/챕터)을 고정 마커로 뽑아낸다 — 문단층은 기존 2~3문장 요약과 동일 성격.
  const genPrompt = (extra = '') => `다음은 한 강의의 전체 학습 노트입니다. 강의 전체를 포괄하는 핵심 요약을 아래 5개 층으로 나눠 작성하세요. 앞부분만이 아니라 노트 전체 범위를 반영해야 합니다. 각 마커는 정확히 그대로 쓰고, 마커 외의 머리말·설명은 출력하지 마세요.${extra}

[한줄]
(강의 전체를 관통하는 TL;DR 1문장)
[핵심]
- (핵심 포인트 5개 불릿)
[문단]
(2~3문장 요약)
[챕터]
- (노트의 주요 섹션/챕터별 1줄 요약, "섹션명: 내용" 형식)
[시험]
- (시험 출제 가능성 높은 포인트 5개 불릿 — 교수가 강조·반복한 부분, 개념 정의, 비교/구분 포인트, 계산·적용 문제가 될 만한 것 위주. "~가 출제될 수 있음" 같은 사족 없이 포인트 자체만)

[전체 학습 노트]
${fullNotes}`;
  const clean = s => (s || '').trim().replace(/^\**\s*요약\s*[:：]?\s*/, '').trim();

  // R4: 마커([한줄]/[핵심]/[문단]/[챕터]) 기준으로 순서대로 잘라낸다. R5: [시험] 층 추가.
  // 마커가 하나도 없으면(파싱 실패) 응답 전체를 문단층으로 취급하고 나머지 층은 빈 값.
  const MARKERS = ['[한줄]', '[핵심]', '[문단]', '[챕터]', '[시험]'];
  const toList = s => (s || '').split('\n').map(l => l.replace(/^[-•*]\s*/, '').trim()).filter(Boolean);
  function parseLayers(raw) {
    const text = (raw || '').trim();
    const idx = MARKERS.map(m => text.indexOf(m));
    if (idx.every(i => i === -1)) {
      return { tldr: '', bullets: [], paragraph: clean(text), chapters: [], exam: [] };
    }
    const section = i => {
      if (idx[i] === -1) return '';
      const start = idx[i] + MARKERS[i].length;
      const rest = idx.slice(i + 1).filter(x => x !== -1);
      const end = rest.length ? Math.min(...rest) : text.length;
      return text.slice(start, end).trim();
    };
    return {
      tldr: section(0),
      bullets: toList(section(1)),
      paragraph: clean(section(2)),
      chapters: toList(section(3)),
      exam: toList(section(4)),  // R5: 시험 관점 포인트
    };
  }

  let raw = (await callClaudeOnce(apiKey, genPrompt(), sys, 2048, 'claude-sonnet-4-6', null, { feature: 'noteAnalysis' }) || '').trim();
  if (!raw) return { tldr: '', bullets: [], paragraph: '', chapters: [], exam: [] };
  let layers = parseLayers(raw);

  /* critic: 요약이 노트 전체를 날조 없이·누락 없이 대표하는지 검증. Haiku, FAIL이면 1회 재생성. */
  try {
    const verdict = (await callClaudeOnce(apiKey,
      `아래 [요약]이 [학습 노트]를 정확히 대표하는지 검증하세요. 노트에 없는 내용을 지어냈거나(날조) 노트의 주요 주제 상당수를 누락했으면 FAIL, 정확하고 포괄적이면 PASS. 출력은 PASS 또는 FAIL 한 단어만.\n\n[요약]\n${raw}\n\n[학습 노트]\n${fullNotes}`,
      '당신은 요약 검증자입니다.', 16, 'claude-haiku-4-5-20251001', null, { feature: 'noteAnalysis' })).trim();
    debugLog('PIPE', `Summary critic verdict: ${verdict}`);
    if (/FAIL/i.test(verdict)) {
      const retryRaw = (await callClaudeOnce(apiKey, genPrompt(' 노트에 없는 내용은 절대 추가하지 말고, 노트 전체 범위를 빠짐없이 반영하세요.'), sys, 2048, 'claude-sonnet-4-6', null, { feature: 'noteAnalysis' }) || '').trim();
      if (retryRaw) layers = parseLayers(retryRaw);
    }
  } catch (e) {
    debugLog('PIPE', `Summary critic failed: ${e.message} — keeping initial summary`);
  }
  return layers;
}

// remove Agent1's inline "**요약**: …" opening paragraph so the verified one replaces it
function stripLeadingSummary(notes) {
  return notes.replace(/^\s*\*\*요약\*\*\s*[:：][^\n]*\n+/, '');
}

/* R4: tab chips over the 4 summary layers. Order = default display order,
   first non-empty layer is the default tab. */
const SUMMARY_HERO_TABS = [
  { key: 'tldr',      label: '한줄' },
  { key: 'bullets',   label: '핵심' },
  { key: 'paragraph', label: '문단' },
  { key: 'chapters',  label: '챕터' },
  { key: 'exam',      label: '시험' },  // R5: 시험 관점 요약 탭
];

function renderSummaryHeroLayer(bodyEl, layers, key) {
  bodyEl.innerHTML = '';
  const val = layers[key];
  if (Array.isArray(val)) {  // R5: generalized from bullets/chapters-only so exam reuses the same <ul> render
    const ul = document.createElement('ul');
    ul.className = 'summary-hero-list';
    (val || []).forEach(item => {
      const li = document.createElement('li');
      li.textContent = item;  // textContent — never insert raw model output as HTML
      ul.appendChild(li);
    });
    bodyEl.appendChild(ul);
  } else {
    bodyEl.textContent = val || '';
  }
}

/* R3: surface the 요약 as a standalone hero so it's scannable without expanding the note.
   R4: if currentSummaryLayers is populated, render as tab chips (한줄/핵심/문단/챕터).
   Falls back to the legacy single-line "**요약**:" extraction for old notes without layers. */
function renderSummaryHero(notesText) {
  const hero = document.getElementById('summaryHero');
  const body = document.getElementById('summaryHeroBody');
  const chips = document.getElementById('summaryHeroChips');
  if (!hero || !body) return;

  const layers = currentSummaryLayers;
  const available = layers ? SUMMARY_HERO_TABS.filter(t => {
    const v = layers[t.key];
    return Array.isArray(v) ? v.length > 0 : !!v;
  }) : [];

  if (available.length > 0 && chips) {
    chips.innerHTML = '';
    available.forEach((t, i) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'summary-hero-chip' + (i === 0 ? ' active' : '');
      btn.textContent = t.label;
      btn.addEventListener('click', () => {
        chips.querySelectorAll('.summary-hero-chip').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        renderSummaryHeroLayer(body, layers, t.key);
      });
      chips.appendChild(btn);
    });
    chips.hidden = false;
    renderSummaryHeroLayer(body, layers, available[0].key);
    hero.hidden = false;
    return;
  }

  // Fallback: old note without summaryLayers — regex-extract the inline "**요약**:" line.
  if (chips) chips.hidden = true;
  const m = (notesText || '').match(/^\s*\*\*요약\*\*\s*[:：]\s*([^\n]+)/);
  const summary = m ? m[1].trim() : '';
  if (!summary) { hero.hidden = true; return; }
  body.textContent = summary;
  hero.hidden = false;
}

/* R6: regenerate the summary layers for the note currently open in the single-note view
   (finalNotesBody + currentNoteId), without re-running the full note pipeline. Not wired
   for the batch card path (targetBodyEl) — batch cards have no single currentNoteId to save against. */
async function regenerateSummary() {
  const btn = document.getElementById('summaryRegenBtn');
  if (!btn || !storedNotesText || btn.disabled) return;  // no note loaded, or already running (reentry guard)

  const prevLayers = currentSummaryLayers;
  const prevLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = '⏳ 재생성 중…';
  try {
    const stripped = stripLeadingSummary(storedNotesText);
    const newLayers = await synthesizeSummary('server-proxied', stripped);
    const hasContent = newLayers.tldr || newLayers.bullets.length || newLayers.paragraph
      || newLayers.chapters.length || newLayers.exam.length;
    if (!hasContent) {
      // synthesizeSummary failed silently (all layers blank) — keep the existing summary, don't overwrite with empty
      showToast('❌ 요약 재생성 실패: 빈 결과');
      return;
    }
    currentSummaryLayers = newLayers;
    if (newLayers.paragraph) {
      storedNotesText = `**요약**: ${newLayers.paragraph}\n\n${stripped}`;
      document.getElementById('finalNotesBody').innerHTML = renderMarkdown(storedNotesText);
    }
    renderSummaryHero(storedNotesText);
    renderStudyTools();  // R8+R9: keep 학습 도구 카드 in sync (storedNotesText may have changed)
    // R6: quiet in-place save — autoSaveNote() would pop the note-name modal on every regen.
    // Same Object.assign-over-existing pattern as viewers.js. Unsaved note (no id) → skip;
    // it gets persisted by the normal post-pipeline autoSaveNote anyway.
    try {
      if (currentNoteId) {
        const existing = await getNoteFS(currentNoteId);
        if (existing) await saveNoteFS(Object.assign({}, existing, {
          notesText: storedNotesText,
          notesHtml: document.getElementById('finalNotesBody')?.innerHTML || '',
          summaryLayers: currentSummaryLayers || null,
        }));
      }
    } catch (e) {
      showToast(`❌ 요약 저장 실패: ${e.message}`);
    }
  } catch (e) {
    currentSummaryLayers = prevLayers;  // keep prior layers on failure
    showToast(`❌ 요약 재생성 실패: ${e.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = prevLabel;
  }
}

/* ═══════════════════════════════════════════════
   R8+R9 — 학습 도구: 마인드맵 / 암기 / 개념
   3개 도구를 하나의 카드에서 탭으로 전환. 각 도구는 on-demand로 생성하고
   currentStudyTools에 저장, R6과 동일한 quiet in-place save 패턴으로 저장.
   싱글노트 뷰 전제(batch/targetBodyEl 경로는 대상 밖 — summaryHero와 동일 범위).
═══════════════════════════════════════════════ */
let currentStudyToolsTab = 'mindmap';  // UI-only, not persisted
let _studyToolsBusy = false;  // reentry guard — a DOM-button guard alone breaks when a tab switch re-renders a fresh enabled button mid-generation

// 카드 자체의 표시 여부 — storedNotesText가 있을 때(싱글노트 뷰)만 보인다.
function renderStudyTools() {
  const card = document.getElementById('studyToolsCard');
  if (!card) return;
  if (!storedNotesText) { card.hidden = true; return; }
  card.hidden = false;
  renderStudyToolsBody();
}

function renderStudyToolsBody() {
  const body = document.getElementById('studyToolsBody');
  if (!body) return;
  document.querySelectorAll('.study-tools-chip').forEach(c => c.classList.toggle('active', c.dataset.tool === currentStudyToolsTab));

  const tool = currentStudyToolsTab;
  const data = currentStudyTools ? currentStudyTools[tool] : null;
  const hasData = Array.isArray(data) ? data.length > 0 : !!data;
  body.innerHTML = '';

  if (!hasData) {
    const wrap = document.createElement('div');
    wrap.className = 'study-tools-empty';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'studyToolsGenBtn';
    btn.className = 'study-tools-gen-btn';
    btn.textContent = _studyToolsBusy ? '⏳ 생성 중…' : (tool === 'mindmap' ? '✨ 마인드맵 생성' : '✨ 암기·개념 생성');
    btn.disabled = _studyToolsBusy;
    btn.addEventListener('click', () => (tool === 'mindmap' ? generateMindmap() : generateStudyAids()));
    wrap.appendChild(btn);
    body.appendChild(wrap);
    return;
  }

  const regenRow = document.createElement('div');
  regenRow.className = 'study-tools-regen-row';
  const regenBtn = document.createElement('button');
  regenBtn.type = 'button';
  regenBtn.id = 'studyToolsRegenBtn';
  regenBtn.className = 'study-tools-regen-btn';
  regenBtn.textContent = _studyToolsBusy ? '⏳ 생성 중…' : '↻ 재생성';
  regenBtn.disabled = _studyToolsBusy;
  regenBtn.addEventListener('click', () => (tool === 'mindmap' ? generateMindmap() : generateStudyAids()));
  regenRow.appendChild(regenBtn);
  body.appendChild(regenRow);

  const content = document.createElement('div');
  content.className = 'study-tools-content';
  body.appendChild(content);

  if (tool === 'mindmap') renderMindmap(content, data);
  else if (tool === 'memorize') renderMemorize(content, data);
  else renderConcepts(content, data);
}

// R6과 동일한 quiet in-place save — autoSaveNote()의 이름 입력 모달을 매번 띄우지 않는다.
async function saveStudyToolsQuiet() {
  if (!currentNoteId) return;  // unsaved note — normal post-pipeline autoSaveNote persists it
  try {
    const existing = await getNoteFS(currentNoteId);
    if (existing) await saveNoteFS(Object.assign({}, existing, { studyTools: currentStudyTools || null }));
  } catch (e) {
    showToast(`❌ 학습 도구 저장 실패: ${e.message}`);
  }
}

/* ── R8: 마인드맵 — 계층형 아웃라인을 파싱해 <details> 트리로 렌더 ── */
async function generateMindmap() {
  if (!storedNotesText || _studyToolsBusy) return;  // no note loaded, or already running
  _studyToolsBusy = true;
  renderStudyToolsBody();  // repaint current tab with disabled ⏳ button
  try {
    const sys = '당신은 대학 강의 학습노트를 마인드맵 아웃라인으로 정리하는 전문가입니다. 한국어로 작성하세요.';
    const stripped = stripLeadingSummary(storedNotesText);
    const prompt = `다음은 한 강의의 전체 학습 노트입니다. 이 강의 전체 주제를 한눈에 파악할 수 있는 마인드맵 아웃라인을 작성하세요.

형식 규칙(정확히 지킬 것):
- 첫 줄은 강의 전체를 관통하는 주제(루트) — 불릿 없이 텍스트만
- 이후 줄은 계층형 불릿, 들여쓰기는 깊이 레벨당 정확히 공백 2칸 + "- " 마커
- 최대 깊이 3단계, 메인 브랜치(1단계) 3~7개
- 각 노드는 40자 이내
- 노트에서 출처 슬라이드가 분명한 노드는 끝에 (p.3) 또는 (p.3-5) 형식으로 표시
- 마커·머리말·설명 없이 아웃라인만 출력

[전체 학습 노트]
${stripped}`;
    const raw = (await callClaudeOnce('server-proxied', prompt, sys, 2048, 'claude-sonnet-4-6', null, { feature: 'noteAnalysis' }) || '').trim();
    const nonBlankLines = raw.split('\n').filter(l => l.trim() !== '');
    if (nonBlankLines.length < 2) {
      showToast('❌ 마인드맵 생성 실패');
      return;
    }
    currentStudyTools = Object.assign({ mindmap: null, memorize: null, concepts: null }, currentStudyTools, { mindmap: raw });
    await saveStudyToolsQuiet();
    showSuccessToast('🧭 마인드맵 생성 완료');
  } catch (e) {
    showToast(`❌ 마인드맵 생성 실패: ${e.message}`);
  } finally {
    _studyToolsBusy = false;
    renderStudyToolsBody();  // fresh un-disabled button reflecting current state either way
  }
}

// 들여쓰기(2칸=1레벨, 탭은 2칸 취급) 기준으로 outline 문자열을 트리로 파싱. 매번 렌더 시 재파싱(저장은 원본 문자열만).
function parseMindmapOutline(raw) {
  const lines = (raw || '').split('\n').map(l => l.replace(/\t/g, '  ')).filter(l => l.trim() !== '');
  if (lines.length < 1) return null;
  const root = { text: lines[0].replace(/^[-*•]\s*/, '').trim(), children: [] };
  const stack = [{ node: root, depth: -1 }];
  for (let i = 1; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)[-*•]\s*(.+)$/);
    if (!m) continue;  // malformed line — skip
    const depth = Math.floor(m[1].length / 2);
    const node = { text: m[2].trim(), children: [] };
    while (stack.length && stack[stack.length - 1].depth >= depth) stack.pop();
    (stack.length ? stack[stack.length - 1].node : root).children.push(node);
    stack.push({ node, depth });
  }
  return root;
}

function renderMindmap(container, outline) {
  const root = parseMindmapOutline(outline);
  container.innerHTML = '';
  if (!root) return;

  const controls = document.createElement('div');
  controls.className = 'mindmap-controls';
  const expandBtn = Object.assign(document.createElement('button'), { type: 'button', className: 'mindmap-ctrl-btn', textContent: '모두 펼치기' });
  const collapseBtn = Object.assign(document.createElement('button'), { type: 'button', className: 'mindmap-ctrl-btn', textContent: '모두 접기' });
  const copyBtn = Object.assign(document.createElement('button'), { type: 'button', className: 'mindmap-ctrl-btn', textContent: '📋 복사' });
  controls.append(expandBtn, collapseBtn, copyBtn);
  container.appendChild(controls);

  const tree = document.createElement('div');
  tree.className = 'mindmap-tree';
  const rootRow = document.createElement('div');
  rootRow.className = 'mindmap-root';
  rootRow.innerHTML = citeChip(escHtml(root.text));  // escape THEN chip-ify, same order as renderMarkdown
  tree.appendChild(rootRow);

  function buildNode(node) {
    if (!node.children.length) {
      const row = document.createElement('div');
      row.className = 'mindmap-leaf';
      row.innerHTML = citeChip(escHtml(node.text));
      return row;
    }
    const details = document.createElement('details');
    details.open = true;
    details.className = 'mindmap-branch';
    const summary = document.createElement('summary');
    summary.innerHTML = citeChip(escHtml(node.text));
    details.appendChild(summary);
    const childWrap = document.createElement('div');
    childWrap.className = 'mindmap-children';
    node.children.forEach(c => childWrap.appendChild(buildNode(c)));
    details.appendChild(childWrap);
    return details;
  }
  root.children.forEach(c => tree.appendChild(buildNode(c)));
  container.appendChild(tree);

  expandBtn.addEventListener('click', () => tree.querySelectorAll('details').forEach(d => { d.open = true; }));
  collapseBtn.addEventListener('click', () => tree.querySelectorAll('details').forEach(d => { d.open = false; }));
  copyBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(outline).then(() => showSuccessToast('📋 복사 완료'));
  });
}

/* ── R9: 암기(cloze) + 개념(용어집) — 한 번의 호출로 둘 다 생성 ── */
async function generateStudyAids() {
  if (!storedNotesText || _studyToolsBusy) return;  // no note loaded, or already running
  _studyToolsBusy = true;
  renderStudyToolsBody();  // repaint current tab with disabled ⏳ button
  try {
    const sys = '당신은 대학 강의 학습노트에서 암기 포인트와 핵심 개념을 뽑아내는 전문가입니다. 한국어로 작성하세요.';
    const stripped = stripLeadingSummary(storedNotesText);
    const prompt = `다음은 한 강의의 전체 학습 노트입니다. 아래 2개 섹션을 정확한 마커로 작성하세요. 마커 외의 머리말·설명은 출력하지 마세요.

[암기]
- (외울 핵심 문장. 핵심 단어·수치를 {{이렇게}} 이중 중괄호로 감싸고, 필요하면 문장 끝에 (p.N) 표시. 8~15개)
[개념]
- (용어 :: 한두 문장 정의. 필요하면 (p.N) 표시. 8~15개)

[전체 학습 노트]
${stripped}`;
    const raw = (await callClaudeOnce('server-proxied', prompt, sys, 2048, 'claude-sonnet-4-6', null, { feature: 'noteAnalysis' }) || '').trim();

    const MARKERS = ['[암기]', '[개념]'];
    const idx = MARKERS.map(m => raw.indexOf(m));
    const section = i => {
      if (idx[i] === -1) return '';
      const start = idx[i] + MARKERS[i].length;
      const rest = idx.slice(i + 1).filter(x => x !== -1);
      const end = rest.length ? Math.min(...rest) : raw.length;
      return raw.slice(start, end).trim();
    };
    const toLines = s => (s || '').split('\n').map(l => l.replace(/^[-•*]\s*/, '').trim()).filter(Boolean);
    const memorize = toLines(section(0));
    const concepts = toLines(section(1)).map(l => {
      const parts = l.split('::');
      if (parts.length < 2) return null;  // malformed line — skip
      return { term: parts[0].trim(), def: parts.slice(1).join('::').trim() };
    }).filter(Boolean);

    if (memorize.length === 0 && concepts.length === 0) {
      showToast('❌ 암기·개념 생성 실패');
      return;
    }
    currentStudyTools = Object.assign({ mindmap: null, memorize: null, concepts: null }, currentStudyTools, {
      memorize: memorize.length ? memorize : null,
      concepts: concepts.length ? concepts : null,
    });
    await saveStudyToolsQuiet();
    showSuccessToast('📌 암기·개념 생성 완료');
  } catch (e) {
    showToast(`❌ 암기·개념 생성 실패: ${e.message}`);
  } finally {
    _studyToolsBusy = false;
    renderStudyToolsBody();
  }
}

function renderMemorize(container, items) {
  container.innerHTML = '';
  const controls = document.createElement('div');
  controls.className = 'study-aids-controls';
  const showBtn = Object.assign(document.createElement('button'), { type: 'button', className: 'mindmap-ctrl-btn', textContent: '모두 보기' });
  const hideBtn = Object.assign(document.createElement('button'), { type: 'button', className: 'mindmap-ctrl-btn', textContent: '모두 가리기' });
  controls.append(showBtn, hideBtn);
  container.appendChild(controls);

  const list = document.createElement('div');
  list.className = 'memorize-list';
  items.forEach(text => {
    const row = document.createElement('div');
    row.className = 'memorize-row';
    // escHtml FIRST, then wrap {{cloze}} spans, then citeChip — same layering order as renderMarkdown.
    const withCloze = escHtml(text).replace(/\{\{(.+?)\}\}/g, '<span class="cloze" data-revealed="0">$1</span>');
    row.innerHTML = citeChip(withCloze);
    list.appendChild(row);
  });
  container.appendChild(list);

  // one delegated listener on the list, not one per span
  list.addEventListener('click', e => {
    const span = e.target.closest('.cloze');
    if (!span) return;
    span.dataset.revealed = span.dataset.revealed === '1' ? '0' : '1';
  });
  showBtn.addEventListener('click', () => list.querySelectorAll('.cloze').forEach(s => { s.dataset.revealed = '1'; }));
  hideBtn.addEventListener('click', () => list.querySelectorAll('.cloze').forEach(s => { s.dataset.revealed = '0'; }));
}

function renderConcepts(container, items) {
  container.innerHTML = '';
  const list = document.createElement('div');
  list.className = 'concepts-list';
  items.forEach(({ term, def }) => {
    const row = document.createElement('div');
    row.className = 'concept-row';
    const termEl = document.createElement('div');
    termEl.className = 'concept-term';
    termEl.innerHTML = citeChip(escHtml(term));
    const defEl = document.createElement('div');
    defEl.className = 'concept-def';
    defEl.innerHTML = citeChip(escHtml(def));
    row.append(termEl, defEl);
    list.appendChild(row);
  });
  container.appendChild(list);
}

/* ═══════════════════════════════════════════════
   Agent 1 — Note Writer / Reviser (streams to hero card)
═══════════════════════════════════════════════ */
async function agent1_writeNotes(apiKey, pptText, recText, critiqueText = '', targetBodyEl = null, meta = {}) {
  let needsSummarySynth = false;  // R2: set by single-pass / PPT-only paths
  setAgentNode(1, 'loading', critiqueText ? '노트 수정 중…' : '노트 작성 중…');

  const { formatSection, rulesSection } = getNoteFormatBlocks();
  const hasTxt   = recText && recText.trim().length > 0;
  const srcLabel = hasTxt ? 'PPT 내용과 강의 녹취록을' : 'PPT 내용을';

  const targetEl = targetBodyEl || document.getElementById('finalNotesBody');
  const dot      = makeAgentDot(1);
  let notesText;

  const systemPrompt = getAgent1SystemPrompt();
  const cachePrefix = `${systemPrompt}

[형식]
${formatSection}

[규칙]
${rulesSection}

${PPT_STRUCTURE_CLAUSE}

[PPT 참고 자료]
${pptText}`;
  agentLog(1, `형식: ${getFormatDisplayName()}`);

  if (critiqueText) {
    /* ── Revision mode: single call with critique feedback ── */
    agentLog(1, '비평 피드백을 반영하여 노트 수정 시작…');

    const revisionClause = `

[수정 지시 — 반드시 준수]
아래 비평 피드백에서 지적된 모든 항목을 빠짐없이 수정하세요.
각 지적 사항에 대해 원본 자료를 다시 확인하고 정확하게 반영하세요.

[비평 피드백]
${critiqueText}`;

    const recSection = hasTxt ? `\n\n[강의 녹취록]\n${recText}` : '';
    // cachePrefix already contains formatSection, rulesSection, PPT_STRUCTURE_CLAUSE, and pptText —
    // repeat only the revision-specific instruction and transcript here to avoid ~3 KB of redundancy.
    const userPrompt = `위 형식·규칙·PPT 자료를 참고하여 학습 노트를 수정하세요.${revisionClause}${recSection}`;

    agentLog(1, 'Claude AI 응답 스트리밍 수신 중…');
    notesText = await callClaudeStream(apiKey, userPrompt, targetEl, dot, systemPrompt, MAX_TOKENS_NOTES, cachePrefix, 'claude-sonnet-4-6', { isFirstCall: false, feature: 'noteAnalysis' });

  } else if (!hasTxt) {
    /* ── PPT-only mode: single Sonnet call ── */
    needsSummarySynth = true;  // R2: replace Agent1 inline 요약 with verified summary
    agentLog(1, 'PPT 전용 모드 — Sonnet으로 노트 작성 시작…');

    const userPrompt = `위 PPT 자료를 바탕으로 학습 가이드를 작성하세요.
녹취록이 없으므로 슬라이드 내용만을 기반으로 핵심 개념을 충실히 정리하세요.`;

    agentLog(1, 'Claude Sonnet 응답 스트리밍 수신 중…');
    notesText = await callClaudeStream(apiKey, userPrompt, targetEl, dot, systemPrompt, MAX_TOKENS_NOTES, cachePrefix, 'claude-sonnet-4-6', meta);

  } else {
    /* ── First write: single or chunked Sonnet call with full transcript ── */
    const slideMatches = [...pptText.matchAll(/\[(?:슬라이드|페이지) (\d+)\]([\s\S]*?)(?=\[(?:슬라이드|페이지) \d+\]|$)/g)];
    const totalSlides = slideMatches.length;

    if (totalSlides > 12) {
      /* ── Chunked mode: dynamic chunking ── */
      const SLIDES_PER_CHUNK = 12;
      const numChunks = Math.ceil(totalSlides / SLIDES_PER_CHUNK);

      const chunks = [];
      for (let c = 0; c < numChunks; c++) {
        const start = c * SLIDES_PER_CHUNK;
        const end = Math.min(start + SLIDES_PER_CHUNK, totalSlides);
        chunks.push(slideMatches.slice(start, end));
      }

      let combinedNotes = '';
      let accumulatedNotes = '';
      for (let c = 0; c < chunks.length; c++) {
        const chunkSlides = chunks[c];
        const slideStart = parseInt(chunkSlides[0][1], 10);
        const slideEnd = parseInt(chunkSlides[chunkSlides.length - 1][1], 10);
        const pptChunk = chunkSlides.map(m => m[0]).join('');

        debugLog('PIPE', `Chunk ${c+1}/${numChunks} — slides ${slideStart}-${slideEnd}`);
        agentLog(1, `청크 ${c+1}/${numChunks} 스트리밍 중 (슬라이드 ${slideStart}-${slideEnd})…`);

        const chunkCache = `${systemPrompt}\n\n[형식]\n${formatSection}\n\n[규칙]\n${rulesSection}\n\n${PPT_STRUCTURE_CLAUSE}\n\n[PPT 참고 자료]\n${pptChunk}`;

        let chunkInstruction;
        if (c === 0) {
          chunkInstruction = `Write notes for slides ${slideStart}-${slideEnd} only. More slides follow in separate calls. Do NOT write a **요약** paragraph — start directly with the first # heading. The summary will be synthesized separately after all slides are processed.`;
        } else {
          chunkInstruction = `Write notes for slides ${slideStart}-${slideEnd} only. Continue from previous notes. Match the same format. Do NOT write a **요약** paragraph or any introduction — start directly with the first # heading for these slides.`;
        }

        const prevNotesBlock = c > 0
          ? `[이전 청크에서 작성된 노트 — 동일 개념 반복 금지, 새 맥락/예시/심화는 포함]\n${accumulatedNotes}\n---\n`
          : '';

        const chunkPrompt = `${prevNotesBlock}위 PPT 자료와 아래 강의 녹취록을 바탕으로 학습 가이드를 작성하세요. ${chunkInstruction}\n\n[강의 녹취록]\n${recText}`;

        const chunkText = await callClaudeStream(apiKey, chunkPrompt, targetEl, dot, systemPrompt, MAX_TOKENS_NOTES, chunkCache, 'claude-sonnet-4-6', c === 0 ? meta : { isFirstCall: false, feature: 'noteAnalysis' });

        combinedNotes += (c > 0 ? '\n\n' : '') + chunkText;
        accumulatedNotes += chunkText + '\n';
      }

      agentLog(1, `${numChunks}개 청크 완료 — 전체 노트 기반 요약 합성 중…`);

      /* ── R1 map-reduce + R2 verify: synthesize 요약 from the FULL note (all chunks),
         then a dedicated critic verifies coverage/accuracy. Chunk 0 writes no 요약,
         so it would otherwise be missing. Failure → note survives without 요약. */
      try {
        currentSummaryLayers = await synthesizeSummary(apiKey, combinedNotes);  // R4: multilayer object
        if (currentSummaryLayers.paragraph) combinedNotes = `**요약**: ${currentSummaryLayers.paragraph}\n\n${combinedNotes}`;
      } catch (e) {
        debugLog('PIPE', `Summary synth failed: ${e.message} — proceeding without 요약`);
      }

      notesText = combinedNotes;
      targetEl.innerHTML = renderMarkdown(notesText);

    } else {
      /* ── Single-pass mode ── */
      needsSummarySynth = true;  // R2: replace Agent1 inline 요약 with verified summary
      agentLog(1, `PPT + 녹취록 단일 패스 — Sonnet으로 학습 가이드 작성 시작… (녹취록 ${recText.length.toLocaleString()}자)`);

      const userPrompt = `위 PPT 자료와 아래 강의 녹취록을 바탕으로 학습 가이드를 작성하세요.

[강의 녹취록]
${recText}`;

      agentLog(1, 'Claude Sonnet 응답 스트리밍 수신 중…');
      debugLog('PIPE', `Agent1 single-pass: transcript=${recText.length}chars`);
      notesText = await callClaudeStream(apiKey, userPrompt, targetEl, dot, systemPrompt, MAX_TOKENS_NOTES, cachePrefix, 'claude-sonnet-4-6', meta);
    }
  }

  /* ── R2: single-pass / PPT-only 경로도 요약을 전용 합성·검증으로 교체.
     Agent1 곁다리 요약을 떼고 verified 요약 prepend. 실패 시 인라인 요약 유지. ── */
  if (needsSummarySynth) {
    agentLog(1, '요약 전용 합성·검증 중…');
    try {
      const stripped = stripLeadingSummary(notesText);
      currentSummaryLayers = await synthesizeSummary(apiKey, stripped);  // R4: multilayer object
      if (currentSummaryLayers.paragraph) {
        notesText = `**요약**: ${currentSummaryLayers.paragraph}\n\n${stripped}`;
        targetEl.innerHTML = renderMarkdown(notesText);
      }
    } catch (e) {
      debugLog('PIPE', `Summary synth failed: ${e.message} — keeping inline summary`);
    }
  }

  storedNotesText = notesText;

  /* enable download buttons — single mode only */
  if (!targetBodyEl) {
    [quizBtn, classifyBtn, notionCopyBtn, dlNotionFileBtn, copyNotesBtn, dlTxtBtn, dlMdBtn, dlPdfBtn, splitViewBtn].forEach(b => { b.disabled = false; });
    document.getElementById('shareGroupBtn')?.removeAttribute('disabled');
    const dbgBtn = document.getElementById('splitDebugBtn');
    if (dbgBtn) dbgBtn.style.display = '';
    document.getElementById('notesActions').classList.add('visible');
    document.getElementById('collapseBtn').classList.add('visible');
    document.getElementById('dotNotes').className = 'status-dot done';
    renderSummaryHero(notesText);  // R3: surface 요약 as standalone hero
    renderStudyTools();  // R8+R9: show 학습 도구 카드 (single-note mode only)
  }

  agentLog(1, `노트 ${critiqueText ? '수정' : '작성'} 완료 — ${notesText.length.toLocaleString()}자`);
  setAgentNode(1, 'done', '완료');
  return notesText;
}

/* ═══════════════════════════════════════════════
   Agent 1b — Haiku Patch (Iter 2: apply critical fixes only)
═══════════════════════════════════════════════ */
async function agent1_patchNotes(apiKey, notesText, critiqueText, targetBodyEl = null) {
  setAgentNode(1, 'loading', 'Haiku 패치 중…');

  const targetEl = targetBodyEl || document.getElementById('finalNotesBody');

  const systemPrompt = 'You are a precise text patch assistant. Return ONLY valid JSON, no markdown fences, no explanation.';
  const userPrompt =
`You are given a note and a critique. Return ONLY the fixes as a JSON array.
Each fix: {"old": "exact text to find", "new": "replacement text"}
Return NOTHING else, no markdown fences, just the JSON array.

[NOTE]
${notesText}

[CRITIQUE]
${critiqueText}`;

  agentLog(1, 'Haiku — JSON 패치 목록 생성 중…');
  targetEl.innerHTML = '<div class="loading-row"><div class="spinner"></div><span>Haiku 패치 적용 중…</span></div>';

  const raw = await callClaudeOnce(apiKey, userPrompt, systemPrompt, 4096, 'claude-haiku-4-5-20251001', null, { feature: 'noteAnalysis' });

  let patched = notesText;
  let fixCount = 0;
  try {
    const cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
    const fixes = JSON.parse(cleaned);
    fixes.forEach(f => {
      if (f.old && f.new !== undefined && patched.includes(f.old)) {
        patched = patched.replaceAll(f.old, f.new);
        fixCount++;
      }
    });
    agentLog(1, `Haiku 패치 적용 — ${fixes.length}개 항목 중 ${fixCount}개 매칭`);
  } catch (_) {
    // JSON parse failed — keep original note unchanged
    agentLog(1, 'JSON 파싱 실패 — 원본 노트 유지 (폴백)');
  }

  if (fixCount === 0 && critiqueText.includes('[CRITICAL]')) {
    console.log('JSON patch matched 0 fixes — falling back to full Haiku rewrite');
    agentLog(1, 'JSON 패치 0개 매칭 — Haiku 전체 재작성으로 폴백');
    const rewriteSystem = '당신은 전문 학습 노트 작성가입니다. 모든 답변은 한국어로 작성하세요.';
    const rewritePrompt =
`Apply ONLY the [CRITICAL] fixes from the critique below to the note, then return the full corrected note.

[NOTE]
${notesText}

[CRITIQUE]
${critiqueText}`;
    const fallbackDot = targetBodyEl ? makeAgentDot(1) : document.getElementById('dotNotes');
    patched = await callClaudeStream(
      apiKey, rewritePrompt, targetEl, fallbackDot,
      rewriteSystem, 16000, null, 'claude-haiku-4-5-20251001',
      { feature: 'noteAnalysis' }
    );
    storedNotesText = patched;
    setAgentNode(1, 'done', '완료');
    agentLog(1, `Haiku 전체 재작성 완료 — 최종 노트 ${patched.length.toLocaleString()}자`);
    return patched;
  }

  targetEl.innerHTML = renderMarkdown(patched);
  storedNotesText = patched;

  if (!targetBodyEl) {
    [quizBtn, classifyBtn, notionCopyBtn, dlNotionFileBtn, copyNotesBtn, dlTxtBtn, dlMdBtn, dlPdfBtn, splitViewBtn].forEach(b => { b.disabled = false; });
    document.getElementById('shareGroupBtn')?.removeAttribute('disabled');
    const dbgBtn = document.getElementById('splitDebugBtn');
    if (dbgBtn) dbgBtn.style.display = '';
    document.getElementById('notesActions').classList.add('visible');
    document.getElementById('collapseBtn').classList.add('visible');
    document.getElementById('dotNotes').className = 'status-dot done';
    renderSummaryHero(patched);  // R3: keep hero in sync after patch
    renderStudyTools();  // R8+R9: keep 학습 도구 카드 in sync after patch
  }

  agentLog(1, `Haiku 패치 완료 — 최종 노트 ${patched.length.toLocaleString()}자`);
  setAgentNode(1, 'done', '완료');
  return patched;
}

/* ═══════════════════════════════════════════════
   Agent 2 — Academic Critic
═══════════════════════════════════════════════ */
async function agent2_critiqueNotes(apiKey, notesText, pptText, recText, iter) {
  setAgentNode(2, 'loading', '검토 중…');
  agentLog(2, `${iter}차 노트를 원본 자료와 비교 검토 중…`);

  const systemPrompt = '당신은 엄격한 학문적 검토자입니다. 모든 출력은 한국어로 작성하세요.';
  const cachePrefix = systemPrompt + `

당신은 엄격한 학문적 비평가입니다. 아래 3단계 절차를 순서대로 실행하세요.

━━━ 1단계: 전체 문제 탐색 ━━━
학습 노트를 원본 자료(PPT + 녹취록)와 비교하여 아래 여섯 유형의 모든 불일치를 빠짐없이 찾아내세요.
• 누락된 개념 — PPT 슬라이드를 하나씩 확인하여 해당 슬라이드의 핵심 내용이 노트에 반영되었는지 검증할 것. 슬라이드 제목뿐 아니라 슬라이드 본문의 주요 개념, 정의, 분류가 노트에서 빠졌으면 누락으로 판정. 예: PPT에 6가지 분류가 있는데 노트에 3가지만 있으면 누락임.
  검증 방법: PPT 텍스트에서 [슬라이드 N] 태그를 하나씩 순회하면서, 해당 슬라이드의 제목과 본문 핵심 내용이 노트에 존재하는지 확인할 것. "모든 슬라이드 반영됨"이라고 쓰려면 반드시 슬라이드 번호별로 확인 결과를 명시할 것 (예: "슬라이드 1~18 확인 완료"). 단순히 "누락 없음"이라고만 쓰지 말 것.
• 부정확한 설명 — 원본과 다르거나 왜곡된 내용
• 교수님 강조 미반영 — "이게 중요해", "시험에 나와", "꼭 기억해", "반드시", "핵심은" 등 강조 표현 근처 내용이 노트에 ⭐ 없이 누락된 것
• 정의·공식·예시 오류 — 원본과 정확히 일치하지 않는 것
• 표·차트 핵심 수치 누락 — PPT 표·차트의 핵심 수치나 결론이 노트에서 완전히 빠진 것 (단, 표 전체 전사가 아닌 요약이 올바른 형태임)
• 맞춤법·표현 오류 — 녹취록 음성인식(STT) 오류가 노트에 그대로 전사된 것, 어색한 표현, 오탈자 (예: "부식부식" → "부지불식", "나발이고" → "나발이고" 등)

━━━ 2단계: 우선순위 분류 ━━━
1단계에서 찾은 각 문제에 아래 태그를 붙이세요.
[CRITICAL] 다음 중 하나라도 해당하면 CRITICAL: (1) PPT 슬라이드의 핵심 개념이 노트에서 완전히 누락, (2) PPT에 있는 분류·목록·비교가 노트에서 일부만 포함되고 나머지 생략, (3) STT 오류로 잘못된 용어가 노트에 전사된 경우 — ⭐ 표시 누락, 강조 표현 미반영, 설명 깊이 부족은 NORMAL로 분류할 것
⭐ 표시 누락이나 강조 표현 미반영은 절대 [CRITICAL]이 아님 — 이는 [NORMAL]로 분류
STT 오류로 인한 잘못된 단어는 [CRITICAL]로 분류 — 학습자가 틀린 용어를 외울 위험이 있음
[NORMAL]   유용하지만 강조되지 않은 Level 2 내용
[MINOR]    배경 맥락에만 해당하는 Level 1 내용 — [CRITICAL]로 절대 분류하지 말 것

━━━ 3단계: Agent 1 수정 지시 ━━━
[CRITICAL] 항목만 번호를 붙여 구체적으로 나열하세요. 각 항목에 원본 근거를 포함하세요:
  1. [CRITICAL] 구체적 문제 설명 — 원본 근거: "..."
  2. ...
[NORMAL] / [MINOR] 항목은 요약 통계만 출력하세요 (예: "NORMAL 3건, MINOR 2건 — 이번 수정에서 제외").
Agent 1에게: [CRITICAL] 항목만 수정하고, [NORMAL]·[MINOR]는 공간이 허용될 때만 반영할 것.

모든 항목이 정확하다면 다음 문장만 정확히 출력하세요 (다른 내용 추가 금지):
  검토 완료 — 수정 필요 없음

[원본 PPT]
${pptText}

[원본 녹취록]
${recText}`;
  const userPrompt = `[검토 대상 학습 노트]
${notesText}`;

  // R2-A: critic moved to Haiku 4.5 — verification step doesn't need Sonnet
  // (Haiku reads a fully-cached prefix anyway, so quality drop is minimal
  // and cost falls ~3x). If [CRITICAL] miss rate climbs post-launch, revert
  // this single string back to 'claude-sonnet-4-6'.
  const raw     = await callClaudeOnce(apiKey, userPrompt, systemPrompt, MAX_TOKENS_CRITIQUE, 'claude-haiku-4-5-20251001', cachePrefix, { feature: 'noteAnalysis' });
  const cleaned = raw.trim();

  /* render critique into tab */
  const panel = document.getElementById('tab-critique');
  if (cleaned.startsWith(DONE_SIGNAL)) {
    panel.innerHTML = `
      <div style="padding:0.85rem 1rem;background:var(--success-dim);border:1px solid rgba(74,222,128,0.25);border-radius:var(--radius-sm);display:flex;align-items:center;gap:0.6rem">
        <span style="font-size:1.2rem">✅</span>
        <span style="color:var(--success);font-weight:600">${iter}차 검토 완료 — 수정 필요 없음. 학습 노트가 원본 자료와 일치합니다.</span>
      </div>`;
    agentLog(2, '검토 완료 — 수정 필요 없음');
  } else {
    /* prepend iteration header to critique panel */
    const prevHtml = iter > 1 ? panel.innerHTML : '';
    const iterHeader = `<div style="font-size:0.75rem;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em;margin:${iter > 1 ? '1.2rem' : '0'} 0 0.5rem">${iter}차 비평</div>`;
    panel.innerHTML = prevHtml + iterHeader + renderMarkdown(cleaned);
    agentLog(2, `수정 필요 항목 발견 — 피드백 생성 완료`);
  }

  setAgentNode(2, 'done', cleaned.startsWith(DONE_SIGNAL) ? '통과 ✅' : '수정 필요');
  return cleaned;
}
