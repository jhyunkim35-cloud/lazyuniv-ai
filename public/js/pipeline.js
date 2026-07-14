// Agent pipeline orchestration, note writers, critic.
// Depends on: constants.js (analyzeBtn, storedPptText, storedFilteredText, storedNotesText, storedHighlightedTranscript, currentNoteId, currentSummaryLayers, currentStudyTools, DONE_SIGNAL, MAX_ITERATIONS, MAX_TOKENS_NOTES, MAX_TOKENS_CRITIQUE, iterChipData, debugLog), markdown.js (renderMarkdown, escHtml, citeChip), api.js (callClaudeOnce, callClaudeStream), ui.js (agentLog, setProgress, setAgentNode, resetAgentNodes, makeAgentDot, updateIterCounter, addIterChip, updateETA, startElapsedTimer, stopElapsedTimer, showToast, showSuccessToast), firestore_sync.js (getNoteFS, saveNoteFS).

// Fix 6 (Q3): agent1's full instructions live inside its cached user-content
// block; every agent1 call passes this minimal string as `system` instead.
// U12: module-scoped (was local to agent1_writeNotes) — the cached-critic path
// must send a byte-identical system or agent1's cache entry never matches.
const MINIMAL_SYSTEM = '위 사용자 메시지에 포함된 지시사항을 정확히 따르세요. 모든 답변은 한국어로 작성하세요.';
// U12: agent1 stashes its exact cachePrefix here each run so agent2 can reuse
// the (already-written, still-warm) cache entry instead of resending the full
// source at list price. Reset per run.
let _agent1CachePrefix = null;
let storedDeixisAnnotations = [];   // U17: high-conf annotations from the current run
let storedDeixisRan = false;        // U17: true iff the deixis stage produced a (possibly empty)
                                    // result this run — gates the stale-annotation overwrite.

async function runAgentPipeline(apiKey, targetBodyEl = null) {
  resetAgentNodes();
  const _heroEl = document.getElementById('summaryHero');  // R3: hide stale summary hero on new run
  if (_heroEl) _heroEl.hidden = true;
  currentSummaryLayers = null;  // R4: reset multilayer summary so a failed synth doesn't leak the previous note's layers
  _draftSummary = null;  // U10: reset fast-draft summary alongside the verified one
  _verifiedSummaryDone = false;  // U10: new analysis — draft is allowed to render again until verified lands
  _summarySynthNeeded = false;   // U11: stale flag from an aborted run must not trigger a spurious synth
  _agent1CachePrefix = null;     // U12: stale prefix from a previous run must not leak into this run's critic
  currentStudyTools = null;  // R8+R9: reset study tools so a new analysis doesn't leak the previous note's mindmap/memorize/concepts
  _studyToolsRangeInput = '';  // U3: reset stale page-range text from the previous note
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

  // U10: fast draft summary (한줄+핵심 via Haiku) fired in parallel with Agent1 so the
  // summary hero shows in ~5-10s instead of waiting for the full verified synthesizeSummary
  // (~77s). Fire-and-forget — never awaited here, single-note view only (same scope as
  // renderSummaryHero's other callers below; batch cards have no shared #summaryHero).
  if (!targetBodyEl) generateQuickSummary(apiKey, storedPptText, storedFilteredText);

  const iterTimings = [];
  let notesText    = '';
  let critiqueText = '';

  try {
    setAgentNode(0, 'done', '스킵 — 원본 전달');

    // U17: deixis-resolution stage — before agent1 so notes are written with resolved
    // referents. Shares agent1's exact cache prefix (writes the entry agent1 reads).
    storedDeixisAnnotations = [];
    storedDeixisRan = false;
    let deixisSection = '';
    if (storedPptText && storedFilteredText && detectDeixisCandidates(storedFilteredText)) {
      try {
        setAgentNode(1, 'loading', '지시어 해석 중…');
        const prefix = buildAgent1CachePrefix(storedPptText, storedFilteredText);
        // 8192: the prompt allows up to 40 annotations (~180 Korean chars of JSON each);
        // 2000 truncated dense lectures mid-array. parseDeixisAnnotations salvages
        // complete objects if truncation still happens.
        const raw = await callClaudeOnce(apiKey, buildDeixisUserPrompt(), MINIMAL_SYSTEM,
          8192, 'claude-sonnet-4-6', prefix, { isFirstCall: false, feature: 'noteAnalysis' });
        storedDeixisAnnotations = parseDeixisAnnotations(raw, storedFilteredText, storedPptText);
        storedDeixisRan = true;  // only after a parsed result — an API failure must NOT wipe stored annotations
        deixisSection = buildDeixisSection(storedDeixisAnnotations);
        agentLog(1, `지시어 해석 ${storedDeixisAnnotations.length}건 (고신뢰만 채택)`);
      } catch (e) {
        console.warn('[deixis] resolution skipped:', e); // fail-open: notes proceed unannotated
      }
    }

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
        notesText = await agent1_writeNotes(apiKey, storedPptText, storedFilteredText, '', targetBodyEl, { isFirstCall: true, feature: 'noteAnalysis' }, deixisSection);
        debugLog('PIPE', `Iter ${iter} — Agent1 done, notes=${notesText.length}chars`);
        if (!targetBodyEl) document.getElementById('notesCardTitle').textContent = '📚 통합 학습 노트';

        /* ── Iter 1: Sonnet critiques (parallel with transcript highlight) ── */
        analyzeBtn.textContent = `⏳ Agent 2: ${iter}차 검토 중…`;
        setProgress(45, `Agent 2: ${iter}차 검토 중…`);
        // Fix 4 (Q3): agent2_critiqueNotes and highlightTranscript are both read-only
        // over notesText/storedFilteredText and don't depend on each other's output —
        // run them concurrently instead of strictly serial. highlightTranscript used
        // to wait until AFTER the entire iteration loop (including a possible iter2
        // Haiku patch), even though it only ever reads iter1's notes. If iter2 later
        // patches [CRITICAL] fixes, the highlighted transcript stays keyed off the
        // pre-patch notes — acceptable drift since patches are small string fixes
        // (same tradeoff already accepted for summary synthesis inside agent1_writeNotes).
        // U11: verified summary synthesis only needs iter1's notesText — run it
        // concurrently with critique∥highlight instead of serially inside agent1.
        // (요약은 패치 전 노트 기준 — 기존과 동일한 트레이드오프, 위 주석 참조.)
        const summaryPromise = _summarySynthNeeded ? (async () => {
          agentLog(1, '요약 전용 합성·검증 중… (검토와 병렬)');
          try {
            const stripped = stripLeadingSummary(notesText);
            return { layers: await synthesizeSummary(apiKey, stripped), stripped };
          } catch (e) {
            debugLog('PIPE', `Summary synth failed: ${e.message} — keeping inline summary`);
            return null;
          }
        })() : Promise.resolve(null);

        const [critiqued, highlighted, summaryRes] = await Promise.all([
          agent2_critiqueNotes(apiKey, notesText, storedPptText, storedFilteredText, iter),
          storedFilteredText ? highlightTranscript(apiKey, storedFilteredText, notesText) : Promise.resolve(null),
          summaryPromise,
        ]);
        critiqueText = critiqued;
        if (highlighted !== null) storedHighlightedTranscript = highlighted;
        if (_summarySynthNeeded) {
          if (summaryRes && summaryRes.layers) {
            currentSummaryLayers = summaryRes.layers;
            if (summaryRes.layers.paragraph) {
              notesText = `**요약**: ${summaryRes.layers.paragraph}\n\n${summaryRes.stripped}`;
              iterTargetEl.innerHTML = renderMarkdown(notesText);
            }
          }
          storedNotesText = notesText;
          _summarySynthNeeded = false;
          _verifiedSummaryDone = true;  // U10: verified attempt finished (success or fail) — stop the quick-draft repaint
          _draftSummary = null;
        }

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

    // Fix 4 (Q3): transcript highlighting now runs inside the iter1 branch above,
    // concurrently with agent2_critiqueNotes — no separate post-loop call needed.
    debugLog('PIPE', 'Pipeline complete');
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

/* Fix 3 (Q1): after a streamed note call, check whether it hit the
   max_tokens ceiling; if so, do ONE continuation pass via callClaudeOnce
   with an assistantPrefill so the model resumes exactly where it stopped.
   Never throws — worst case keeps the truncated text and logs a warning. */
async function continueIfTruncated(apiKey, text, userPrompt, systemPrompt, cachePrefix, meta, targetEl) {
  if (getLastStopReason() !== 'max_tokens') return text;
  agentLog(1, '⚠️ 길이 제한 도달 — 이어쓰기 1회 시도');
  debugLog('PIPE', `max_tokens truncation — continuation attempt, len=${text.length}`);
  // Anthropic rejects an assistant prefill ending in trailing whitespace — and a
  // max_tokens cutoff can easily land on '\n'. Trim for the call, concat from the
  // trimmed base so the seam stays exact.
  const base = text.replace(/\s+$/, '');
  let full = text;
  try {
    const continuation = await callClaudeOnce(apiKey, userPrompt, systemPrompt, 8192, 'claude-sonnet-4-6', cachePrefix, meta, base);
    full = base + continuation;
    if (getLastStopReason() === 'max_tokens') agentLog(1, '⚠️ 노트가 불완전할 수 있음');
  } catch (e) {
    debugLog('PIPE', `Continuation failed: ${e.message}`);
    agentLog(1, '⚠️ 노트가 불완전할 수 있음');
  }
  if (targetEl) targetEl.innerHTML = renderMarkdown(full);
  return full;
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
// Fix 5 (Q3): shared cache layout for every on-demand Sonnet call that reads the
// full note (summary synth/regen here, plus mindmap/암기/quiz elsewhere) — must be
// byte-identical across all of them so they share one Anthropic prompt cache entry
// (same model=claude-sonnet-4-6) when used back-to-back within the ~5min cache TTL.
// Only the per-tool instruction that follows this prefix differs and stays uncached.
// Anthropic requires >=2048 tokens for a Sonnet cache write — shorter notes just
// won't cache, harmless.
function buildToolsCachePrefix(strippedNotes) {
  return `다음 강의 학습 노트를 바탕으로 작업하세요.\n\n[전체 학습 노트]\n${strippedNotes}`;
}
// Anthropic cache matching covers the ENTIRE prefix — tools, then system, then
// messages — so the three tools must also share ONE system string, or the
// byte-identical cache block above never matches across them.
const TOOLS_SYS = '당신은 대학 강의 학습노트 분석 전문가입니다. 요약·마인드맵·암기·개념 추출을 정확하게 수행합니다. 한국어로 작성하세요.';

async function synthesizeSummary(apiKey, fullNotes) {
  const sys = TOOLS_SYS;
  // Fix 5 (Q3): fullNotes moves into the shared tools cache block instead of being
  // embedded in every genPrompt() call — this function alone calls genPrompt up to
  // 3x (initial + marker-retry + critic-FAIL-retry), so the retries now hit cache
  // too, on top of sharing with mindmap/암기/quiz calls on the same note.
  const cachePrefix = buildToolsCachePrefix(fullNotes);
  // R4: 1콜로 4층(한줄/핵심/문단/챕터)을 고정 마커로 뽑아낸다 — 문단층은 기존 2~3문장 요약과 동일 성격.
  const genPrompt = (extra = '') => `강의 전체를 포괄하는 핵심 요약을 아래 6개 층으로 나눠 작성하세요. 앞부분만이 아니라 노트 전체 범위를 반영해야 합니다. 각 마커는 정확히 그대로 쓰고, 마커 외의 머리말·설명은 출력하지 마세요.${extra}

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
[쉬운]
(이 강의를 처음 듣는 비전공자도 이해할 수 있는 쉬운 말로 핵심을 설명하는 4~6문장 — 전문용어는 일상어로 풀어 쓰고, 일상 비유 또는 실생활 예시를 1개 이상 포함)`;
  const clean = s => (s || '').trim().replace(/^\**\s*요약\s*[:：]?\s*/, '').trim();

  // R4: 마커([한줄]/[핵심]/[문단]/[챕터]) 기준으로 순서대로 잘라낸다. R5: [시험] 층 추가. R10: [쉬운] 층 추가.
  // 마커가 하나도 없으면(파싱 실패) 응답 전체를 문단층으로 취급하고 나머지 층은 빈 값.
  const MARKERS = ['[한줄]', '[핵심]', '[문단]', '[챕터]', '[시험]', '[쉬운]'];
  const toList = s => (s || '').split('\n').map(l => l.replace(/^[-•*]\s*/, '').trim()).filter(Boolean);
  function parseLayers(raw) {
    const text = (raw || '').trim();
    const idx = MARKERS.map(m => text.indexOf(m));
    if (idx.every(i => i === -1)) {
      return { tldr: '', bullets: [], paragraph: clean(text), chapters: [], exam: [], easy: '' };
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
      easy: section(5),          // R10: 쉬운 설명 (비유·실생활 예시 포함)
    };
  }

  let raw = (await callClaudeOnce(apiKey, genPrompt(), sys, 3072, 'claude-sonnet-4-6', cachePrefix, { feature: 'noteAnalysis' }) || '').trim();
  if (!raw) return { tldr: '', bullets: [], paragraph: '', chapters: [], exam: [], easy: '' };
  let layers = parseLayers(raw);

  // Fix 7 (Q1): 마커 파싱 실패 감지 — 6개 중 4개 미만이면 critic 이전에 1회 재시도.
  // 재시도해도 못 늘리면 더 많이 찾은 쪽을 그대로 유지.
  const countMarkers = t => MARKERS.filter(m => (t || '').includes(m)).length;
  if (countMarkers(raw) < 4) {
    debugLog('PIPE', `Summary markers found=${countMarkers(raw)}/6 — retrying with explicit marker instruction`);
    const retryRaw = (await callClaudeOnce(apiKey, genPrompt(' 6개 마커([한줄][핵심][문단][챕터][시험][쉬운])를 반드시 정확히 그대로 출력하세요.'), sys, 3072, 'claude-sonnet-4-6', cachePrefix, { feature: 'noteAnalysis' }) || '').trim();
    if (retryRaw && countMarkers(retryRaw) > countMarkers(raw)) {
      raw = retryRaw;
      layers = parseLayers(retryRaw);
    }
  }

  /* critic: 요약이 노트 전체를 날조 없이·누락 없이 대표하는지 검증. FAIL이면 1회 재생성.
     U11: Haiku 정가로 노트 전문을 재전송하던 것을 → Sonnet + 공유 캐시 prefix로 교체.
     캐시는 모델별이라 Haiku는 방금 합성이 써둔 Sonnet 캐시를 못 읽지만, Sonnet critic은
     노트 전문을 0.1×로 읽는다(출력은 PASS/FAIL 16토큰이라 출력단가 차이 무의미).
     system도 TOOLS_SYS로 바이트 동일해야 캐시가 매칭된다. */
  try {
    const verdict = (await callClaudeOnce(apiKey,
      `위 [전체 학습 노트]를 아래 [요약]이 정확히 대표하는지 검증하세요. 노트에 없는 내용을 지어냈거나(날조) 노트의 주요 주제 상당수를 누락했으면 FAIL, 정확하고 포괄적이면 PASS. 출력은 PASS 또는 FAIL 한 단어만.\n\n[요약]\n${raw}`,
      sys, 16, 'claude-sonnet-4-6', cachePrefix, { feature: 'noteAnalysis' })).trim();
    debugLog('PIPE', `Summary critic verdict: ${verdict}`);
    if (/FAIL/i.test(verdict)) {
      const retryRaw = (await callClaudeOnce(apiKey, genPrompt(' 노트에 없는 내용은 절대 추가하지 말고, 노트 전체 범위를 빠짐없이 반영하세요.'), sys, 3072, 'claude-sonnet-4-6', cachePrefix, { feature: 'noteAnalysis' }) || '').trim();
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
  { key: 'easy',      label: '쉬운' },  // R10: 쉬운 설명 (univ '쉬운 설명' 토글 대응 — 비유·실생활 예시 포함)
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

/* ═══════════════════════════════════════════════
   U10 — fast draft summary, in parallel with Agent1
   Haiku pass over the raw source (no note text exists yet) producing only
   [한줄]/[핵심] so the hero can show something in ~5-10s. Never touches
   currentSummaryLayers (that's reserved for the verified synthesizeSummary
   result, which is what autoSaveNote persists) — lives in _draftSummary and
   gets discarded the moment the verified attempt finishes, success or fail.
═══════════════════════════════════════════════ */
async function generateQuickSummary(apiKey, pptText, recText) {
  if (_verifiedSummaryDone) return;  // shouldn't fire this early, but cheap guard
  const full = `${pptText || ''}\n${recText || ''}`.trim();
  // U10b(준현): 노트 본문은 어차피 ~3초부터 실시간 스트리밍되므로, 드래프트 요약은
  // 완성까지 수 분 걸리는 긴 소스(청크 모드급)에서만 가치가 있다. 짧은 노트는
  // 검증 요약이 금방 도착 — 드래프트 콜(₩20~40) 생략.
  if (full.length < 15000) return;
  const src = full.slice(0, 30000);
  if (!src) return;
  try {
    const raw = (await callClaudeOnce(apiKey,
      `아래 강의 자료를 훑어보고 정확히 2개 마커로만 답하세요. 마커 외의 머리말·설명은 출력하지 마세요.

[한줄]
(강의 전체를 관통하는 TL;DR 1문장)
[핵심]
- (핵심 포인트 3~5개 불릿)

[자료]
${src}`,
      TOOLS_SYS, 700, 'claude-sonnet-4-6', null, { feature: 'noteAnalysis', isFirstCall: false }) || '').trim();

    if (_verifiedSummaryDone || !raw) return;  // verified landed while we waited, or empty response

    const idxT = raw.indexOf('[한줄]');
    const idxB = raw.indexOf('[핵심]');
    if (idxT === -1 && idxB === -1) return;  // parse failure — verified summary lands later anyway
    const tldr = idxT === -1 ? '' : raw.slice(idxT + 4, idxB === -1 ? raw.length : idxB).trim();
    const bulletsRaw = idxB === -1 ? '' : raw.slice(idxB + 4).trim();
    const bullets = bulletsRaw.split('\n').map(l => l.replace(/^[-•*]\s*/, '').trim()).filter(Boolean);
    if (!tldr && !bullets.length) return;

    _draftSummary = { tldr, bullets };
    debugLog('PIPE', `Quick draft summary landed — tldr=${!!tldr}, bullets=${bullets.length}`);
    renderSummaryHero(storedNotesText);  // repaint — no-op via the draft guard if verified already landed
  } catch (e) {
    debugLog('PIPE', `Quick draft summary failed: ${e.message}`);
  }
}

// shared chip-row builder for both the verified layers and the U10 draft — tabs' click
// handlers close over whichever `layers` object (currentSummaryLayers or _draftSummary) is passed.
function renderSummaryHeroTabs(body, chips, layers, tabs) {
  chips.innerHTML = '';
  tabs.forEach((t, i) => {
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
  renderSummaryHeroLayer(body, layers, tabs[0].key);
}

/* R3: surface the 요약 as a standalone hero so it's scannable without expanding the note.
   R4: if currentSummaryLayers is populated, render as tab chips (한줄/핵심/문단/챕터).
   U10: if the verified summary hasn't landed yet but a fast draft (한줄/핵심) has, render
   that instead with a "생성 중" badge — never reads/writes currentSummaryLayers, so a
   draft can never leak into autoSaveNote's saved summaryLayers.
   Falls back to the legacy single-line "**요약**:" extraction for old notes without layers. */
function renderSummaryHero(notesText) {
  const hero = document.getElementById('summaryHero');
  const body = document.getElementById('summaryHeroBody');
  const chips = document.getElementById('summaryHeroChips');
  const badge = document.getElementById('summaryHeroDraftBadge');
  const regenBtn = document.getElementById('summaryRegenBtn');
  if (!hero || !body) return;

  if (!currentSummaryLayers && _draftSummary && !_verifiedSummaryDone) {
    const draftTabs = SUMMARY_HERO_TABS.filter(t => (t.key === 'tldr' || t.key === 'bullets') && (
      Array.isArray(_draftSummary[t.key]) ? _draftSummary[t.key].length > 0 : !!_draftSummary[t.key]
    ));
    if (draftTabs.length > 0 && chips) {
      if (badge) badge.hidden = false;
      if (regenBtn) regenBtn.hidden = true;  // U10-6: no regen against an unverified draft
      renderSummaryHeroTabs(body, chips, _draftSummary, draftTabs);
      hero.hidden = false;
      return;
    }
  }
  if (badge) badge.hidden = true;
  if (regenBtn) regenBtn.hidden = false;

  const layers = currentSummaryLayers;
  const available = layers ? SUMMARY_HERO_TABS.filter(t => {
    const v = layers[t.key];
    return Array.isArray(v) ? v.length > 0 : !!v;
  }) : [];

  if (available.length > 0 && chips) {
    renderSummaryHeroTabs(body, chips, layers, available);
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
      || newLayers.chapters.length || newLayers.exam.length || newLayers.easy;
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
// U3: raw text typed into the optional 암기/개념 page-range control. Kept in a module
// var (not just the DOM) because clicking 생성/재생성 synchronously re-renders the body
// (disabled ⏳ button) before the async call returns, which would otherwise wipe the input.
let _studyToolsRangeInput = '';

// U3: page-range filtering only makes sense when the note actually has page cites
// (PPT/PDF-sourced notes) — docx/transcript-only notes never have "p.N" so hide the control.
function notesHasPageCites() {
  return /(^|[^\w])p\.\d+/.test(storedNotesText || '');
}

function buildPageRangeControl() {
  const wrap = document.createElement('div');
  wrap.className = 'study-tools-range';
  wrap.innerHTML = `<label for="studyToolsRangeInput">📄 p.</label><input type="text" id="studyToolsRangeInput" class="study-tools-range-input" placeholder="전체 (예: 3-10)">`;
  const input = wrap.querySelector('input');
  input.value = _studyToolsRangeInput;
  input.addEventListener('input', () => { _studyToolsRangeInput = input.value; });
  return wrap;
}

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

  const showRange = tool !== 'mindmap' && notesHasPageCites();  // U3: 마인드맵은 범위 선택 대상 밖

  if (!hasData) {
    const wrap = document.createElement('div');
    wrap.className = 'study-tools-empty';
    if (showRange) wrap.appendChild(buildPageRangeControl());
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'studyToolsGenBtn';
    btn.className = 'study-tools-gen-btn';
    btn.textContent = _studyToolsBusy ? '⏳ 생성 중…' : (tool === 'mindmap' ? '✨ 마인드맵 생성' : '✨ 암기·개념 생성');
    btn.disabled = _studyToolsBusy;
    btn.addEventListener('click', () => (tool === 'mindmap' ? generateMindmap() : generateStudyAids(_studyToolsRangeInput)));
    wrap.appendChild(btn);
    body.appendChild(wrap);
    return;
  }

  const regenRow = document.createElement('div');
  regenRow.className = 'study-tools-regen-row';
  if (showRange) regenRow.appendChild(buildPageRangeControl());
  const regenBtn = document.createElement('button');
  regenBtn.type = 'button';
  regenBtn.id = 'studyToolsRegenBtn';
  regenBtn.className = 'study-tools-regen-btn';
  regenBtn.textContent = _studyToolsBusy ? '⏳ 생성 중…' : '↻ 재생성';
  regenBtn.disabled = _studyToolsBusy;
  regenBtn.addEventListener('click', () => (tool === 'mindmap' ? generateMindmap() : generateStudyAids(_studyToolsRangeInput)));
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
    const sys = TOOLS_SYS;  // shared with summary/암기 so the note cache actually matches cross-tool
    const stripped = stripLeadingSummary(storedNotesText);
    const cachePrefix = buildToolsCachePrefix(stripped);  // Fix 5 (Q3): shared with summary/암기/quiz on the same note
    const prompt = `이 강의 전체 주제를 한눈에 파악할 수 있는 마인드맵 아웃라인을 작성하세요.

형식 규칙(정확히 지킬 것):
- 첫 줄은 강의 전체를 관통하는 주제(루트) — 불릿 없이 텍스트만
- 이후 줄은 계층형 불릿, 들여쓰기는 깊이 레벨당 정확히 공백 2칸 + "- " 마커
- 최대 깊이 3단계, 메인 브랜치(1단계) 3~7개
- 각 노드는 40자 이내
- 노트에서 출처 슬라이드가 분명한 노드는 끝에 (p.3) 또는 (p.3-5) 형식으로 표시
- 마커·머리말·설명 없이 아웃라인만 출력`;
    const raw = (await callClaudeOnce('server-proxied', prompt, sys, 2048, 'claude-sonnet-4-6', cachePrefix, { feature: 'noteAnalysis' }) || '').trim();
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
  const pngBtn = Object.assign(document.createElement('button'), { type: 'button', className: 'mindmap-ctrl-btn', textContent: '🖼 이미지 저장' });  // U4
  controls.append(expandBtn, collapseBtn, copyBtn, pngBtn);
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
  pngBtn.addEventListener('click', () => downloadMindmapPng(root, root.text));  // U4: reuse the already-parsed tree, no re-parse
}

// U4: truncate a label to fit maxWidth in the current ctx font, appending … when trimmed.
function truncateCanvasText(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(t + '…').width > maxWidth) t = t.slice(0, -1);
  return t + '…';
}

/* U4: render the mindmap tree to an offscreen canvas and download as PNG.
   Horizontal layout — root at left, children stacked vertically to the right,
   straight connector lines. Reuses the tree renderMindmap already parsed. */
function downloadMindmapPng(tree, title) {
  const NODE_W = 200, NODE_H = 34, ROW_H = 44, COL_GAP = 50, PAD = 24;
  let maxDepth = 0;
  function layout(node, depth) {
    maxDepth = Math.max(maxDepth, depth);
    node._depth = depth;
    if (!node.children.length) { node._slots = 1; return 1; }
    let slots = 0;
    node.children.forEach(c => { slots += layout(c, depth + 1); });
    node._slots = slots;
    return slots;
  }
  function assignRow(node, rowStart) {
    if (!node.children.length) { node._row = rowStart; return; }
    let r = rowStart;
    node.children.forEach(c => { assignRow(c, r); r += c._slots; });
    node._row = (node.children[0]._row + node.children[node.children.length - 1]._row) / 2;
  }
  const totalSlots = layout(tree, 0);
  assignRow(tree, 0);

  const width = PAD * 2 + NODE_W + maxDepth * (NODE_W + COL_GAP);
  const height = PAD * 2 + totalSlots * ROW_H;

  const isLight = document.documentElement.classList.contains('light');
  const palette = isLight
    ? { bg: '#ffffff', node: '#eef2ff', text: '#1e293b', line: '#94a3b8' }
    : { bg: '#1a1a24', node: '#2a2a3a', text: '#e8e8f0', line: '#4a4a5a' };

  const canvas = document.createElement('canvas');
  canvas.width = width * 2;
  canvas.height = height * 2;
  const ctx = canvas.getContext('2d');
  ctx.scale(2, 2);  // retina
  ctx.fillStyle = palette.bg;
  ctx.fillRect(0, 0, width, height);

  const box = node => {
    const x = PAD + node._depth * (NODE_W + COL_GAP);
    const y = PAD + node._row * ROW_H + (ROW_H - NODE_H) / 2;
    return { x, y, cx: x + NODE_W / 2, cy: y + NODE_H / 2, left: x, right: x + NODE_W };
  };

  ctx.strokeStyle = palette.line;
  ctx.lineWidth = 1.5;
  (function drawLines(node) {
    const b = box(node);
    node.children.forEach(c => {
      const cb = box(c);
      const midX = (b.right + cb.left) / 2;
      ctx.beginPath();
      ctx.moveTo(b.right, b.cy);
      ctx.lineTo(midX, b.cy);
      ctx.lineTo(midX, cb.cy);
      ctx.lineTo(cb.left, cb.cy);
      ctx.stroke();
      drawLines(c);
    });
  })(tree);

  ctx.textBaseline = 'middle';
  (function drawNodes(node) {
    const b = box(node);
    ctx.beginPath();
    ctx.roundRect(b.x, b.y, NODE_W, NODE_H, 6);
    ctx.fillStyle = palette.node;
    ctx.fill();
    ctx.font = node === tree ? 'bold 14px sans-serif' : '13px sans-serif';
    ctx.fillStyle = palette.text;
    ctx.fillText(truncateCanvasText(ctx, node.text, NODE_W - 16), b.x + 8, b.cy);
    node.children.forEach(drawNodes);
  })(tree);

  canvas.toBlob(blob => {
    if (!blob) { showToast('❌ 이미지 생성 실패'); return; }
    const safeTitle = (title || '마인드맵').replace(/[\\/:*?"<>|]/g, '').trim() || '마인드맵';
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `마인드맵-${safeTitle}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });
}

/* ── R9: 암기(cloze) + 개념(용어집) — 한 번의 호출로 둘 다 생성 ──
   U3: rangeText는 studyToolsRangeInput의 raw 텍스트("N-M" 또는 빈 문자열=전체).
   유효하면 캐시 prefix가 아니라 UNCACHED 프롬프트 뒤쪽에만 이어붙인다 — cachePrefix는
   summary/mindmap/quiz와 바이트 단위로 동일해야 캐시가 공유되므로 절대 건드리지 않는다. */
async function generateStudyAids(rangeText = '') {
  if (!storedNotesText || _studyToolsBusy) return;  // no note loaded, or already running

  let pageRange = null;
  const rt = (rangeText || '').trim();
  if (rt) {
    // "N-M" 또는 단일 페이지 "N" (N = N-N) 허용
    const m = rt.match(/^(\d+)\s*(?:-\s*(\d+))?$/);
    const start = m ? parseInt(m[1], 10) : NaN;
    const end = m ? parseInt(m[2] ?? m[1], 10) : NaN;
    if (!m || !(start >= 1) || !(end >= 1) || start > end) {
      showToast('❌ 페이지 범위 형식이 올바르지 않습니다 (예: 3-10 또는 5)');
      return;
    }
    pageRange = { start, end };
  }

  _studyToolsBusy = true;
  renderStudyToolsBody();  // repaint current tab with disabled ⏳ button
  try {
    const sys = TOOLS_SYS;  // shared with summary/마인드맵 so the note cache actually matches cross-tool
    const stripped = stripLeadingSummary(storedNotesText);
    const cachePrefix = buildToolsCachePrefix(stripped);  // Fix 5 (Q3): shared with summary/mindmap/quiz on the same note
    const rangeClause = pageRange
      ? `\n\n페이지 인용이 p.${pageRange.start} ~ p.${pageRange.end} 범위에 속하는 내용만 다루세요. 다른 페이지 내용은 제외하세요.`
      : '';  // U3: uncached — kept out of cachePrefix so the shared cache block stays byte-identical
    const prompt = `아래 2개 섹션을 정확한 마커로 작성하세요. 마커 외의 머리말·설명은 출력하지 마세요.

[암기]
- (외울 핵심 문장. 핵심 단어·수치를 {{이렇게}} 이중 중괄호로 감싸고, 필요하면 문장 끝에 (p.N) 표시. 8~15개)
[개념]
- (용어 :: 한두 문장 정의. 필요하면 (p.N) 표시. 8~15개)${rangeClause}`;
    const raw = (await callClaudeOnce('server-proxied', prompt, sys, 2048, 'claude-sonnet-4-6', cachePrefix, { feature: 'noteAnalysis' }) || '').trim();

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
      pageRange: pageRange,  // U3: range this generation used (null = 전체) — overwritten each regen, restored on reopen via notes_crud.js
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

// U3: small "📄 p.N–M" badge showing the page range this generation used, if any.
function renderPageRangeBadge(container) {
  const range = currentStudyTools && currentStudyTools.pageRange;
  if (!range) return;
  const badge = document.createElement('div');
  badge.className = 'study-tools-range-badge';
  badge.textContent = `📄 p.${range.start}–${range.end}`;
  container.appendChild(badge);
}

function renderMemorize(container, items) {
  container.innerHTML = '';
  renderPageRangeBadge(container);
  const controls = document.createElement('div');
  controls.className = 'study-aids-controls';
  const showBtn = Object.assign(document.createElement('button'), { type: 'button', className: 'mindmap-ctrl-btn', textContent: '모두 보기' });
  const hideBtn = Object.assign(document.createElement('button'), { type: 'button', className: 'mindmap-ctrl-btn', textContent: '모두 가리기' });
  const srsBtn  = Object.assign(document.createElement('button'), { type: 'button', id: 'memorizeSrsBtn', className: 'mindmap-ctrl-btn', textContent: '🔁 복습 카드로 추가' });
  srsBtn.addEventListener('click', pushMemorizeToSrs);
  controls.append(showBtn, hideBtn, srsBtn);
  container.appendChild(controls);

  const list = document.createElement('div');
  list.className = 'memorize-list';
  items.forEach(text => {
    const row = document.createElement('div');
    row.className = 'memorize-row';
    // Q4: escHtml FIRST, then split on {{cloze}} markers so citeChip only
    // ever touches the surrounding text — the answer goes ONLY into
    // data-answer (never rendered as text until revealed), so it can't be
    // selected/copied/Ctrl+F'd, and it never gets re-parsed as HTML (no
    // leaked <button> chip markup inside the attribute).
    const parts = escHtml(text).split(/\{\{(.+?)\}\}/);
    row.innerHTML = parts.map((part, i) => {
      if (i % 2 === 1) {
        return `<span class="cloze" role="button" tabindex="0" aria-label="정답 보기" data-answer="${part}" data-revealed="0"></span>`;
      }
      return citeChip(part);
    }).join('');
    list.appendChild(row);
  });
  container.appendChild(list);

  function toggleCloze(span) {
    const revealed = span.dataset.revealed === '1';
    span.dataset.revealed = revealed ? '0' : '1';
    span.textContent = revealed ? '' : (span.dataset.answer || '');
  }

  // one delegated listener on the list, not one per span
  list.addEventListener('click', e => {
    const span = e.target.closest('.cloze');
    if (span) toggleCloze(span);
  });
  // Q4: keyboard access — Enter/Space toggle reveal (tabindex=0 + role=button above)
  list.addEventListener('keydown', e => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const span = e.target.closest('.cloze');
    if (!span) return;
    e.preventDefault();
    toggleCloze(span);
  });
  showBtn.addEventListener('click', () => list.querySelectorAll('.cloze').forEach(s => { s.dataset.revealed = '1'; s.textContent = s.dataset.answer || ''; }));
  hideBtn.addEventListener('click', () => list.querySelectorAll('.cloze').forEach(s => { s.dataset.revealed = '0'; s.textContent = ''; }));
}

// U6: {{cloze}} 문장 → SRS front/back. front는 정답을 ＿＿＿로 가림, back은 괄호 벗긴 원문 그대로.
function _clozeFrontBack(text) {
  return {
    front: text.replace(/\{\{(.+?)\}\}/g, '＿＿＿'),
    back:  text.replace(/\{\{(.+?)\}\}/g, '$1'),
  };
}

let _srsPushBusy = false;  // reentry guard while pushing cloze cards into the SRS queue

// U6: 현재 암기(cloze) 항목들을 SRS 복습 큐에 opt-in으로 밀어넣는다. 재생성 후 다시 누르면
// 같은 index의 카드 id를 재사용해 front/back만 갱신하고 기존 SM-2 스케줄(interval 등)은 보존한다.
async function pushMemorizeToSrs() {
  if (_srsPushBusy) return;
  const items = currentStudyTools && currentStudyTools.memorize;
  if (!items || !items.length) return;
  if (typeof cardIdFor !== 'function' || typeof saveSrsCard !== 'function' || typeof getSrsCard !== 'function') return;

  _srsPushBusy = true;
  const btn = document.getElementById('memorizeSrsBtn');
  const prevLabel = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = '⏳ 추가 중…'; }
  try {
    if (!currentNoteId) {
      await autoSaveNote();  // 다른 학습 도구와 동일한 저장 경로 — 이름 프롬프트 뜸
      if (!currentNoteId) { showToast('먼저 노트를 저장하세요'); return; }
    }
    const note = await getNoteFS(currentNoteId).catch(() => null);
    const folderId = note?.folderId || '';
    const today = _accSrsToday();

    let added = 0, updated = 0;
    for (let i = 0; i < items.length; i++) {
      const { front, back } = _clozeFrontBack(items[i]);
      const id = cardIdFor(folderId, currentNoteId, 'cloze-' + i);
      const existing = await getSrsCard(id).catch(() => null);
      if (existing) {
        await saveSrsCard(Object.assign({}, existing, { type: 'cloze', folderId, noteId: currentNoteId, front, back }));
        updated++;
      } else {
        await saveSrsCard({
          id, type: 'cloze', folderId, noteId: currentNoteId, front, back,
          nextReviewDate: today, interval: 0, repetitions: 0, easeFactor: 2.5,
        });
        added++;
      }
    }
    showToast(added > 0 ? `🔁 복습 큐에 ${added + updated}개 추가됨` : `🔁 복습 큐에 ${updated}개 갱신됨`);
  } catch (e) {
    showToast(`❌ 복습 카드 추가 실패: ${e.message}`);
  } finally {
    _srsPushBusy = false;
    const btnAfter = document.getElementById('memorizeSrsBtn');
    if (btnAfter) { btnAfter.disabled = false; btnAfter.textContent = prevLabel || '🔁 복습 카드로 추가'; }
  }
}

function renderConcepts(container, items) {
  container.innerHTML = '';
  renderPageRangeBadge(container);
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

/* Fix 3 (Q3): compact "already covered" digest for the chunk loop — extracts only
   heading lines (#/##) and unique **bold** terms from the notes written so far,
   instead of embedding the full accumulated notes. Keeps the per-chunk UNCACHED
   prompt roughly constant-size instead of growing every chunk (O(N) chunks x
   full accumulated-notes size = O(N^2) total prompt tokens sent over the loop). */
function buildPrevNotesDigest(notes, maxChars = 4000) {
  const headings = notes.match(/^#{1,2}\s.+$/gm) || [];
  const boldTerms = [...new Set(notes.match(/\*\*([^*]+)\*\*/g) || [])];
  let digest = [...headings, ...boldTerms].join('\n');
  if (digest.length > maxChars) digest = digest.slice(digest.length - maxChars);  // drop oldest first, keep the tail
  return digest;
}

/* ═══════════════════════════════════════════════
   Agent 1 — Note Writer / Reviser (streams to hero card)
═══════════════════════════════════════════════ */
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

async function agent1_writeNotes(apiKey, pptText, recText, critiqueText = '', targetBodyEl = null, meta = {}, deixisSection = '') {
  let needsSummarySynth = false;  // R2: set by single-pass / PPT-only paths
  setAgentNode(1, 'loading', critiqueText ? '노트 수정 중…' : '노트 작성 중…');

  const hasTxt   = recText && recText.trim().length > 0;
  const hasPpt   = pptText && pptText.trim().length > 0;
  const srcLabel = hasTxt && hasPpt ? 'PPT 내용과 강의 녹취록을'
                 : hasPpt           ? 'PPT 내용을'
                 :                    '강의 녹취록을';

  const targetEl = targetBodyEl || document.getElementById('finalNotesBody');
  const dot      = makeAgentDot(1);
  let notesText;

  let cachePrefix = buildAgent1CachePrefix(pptText, recText);
  _agent1CachePrefix = cachePrefix;  // U12: expose for agent2's cached-critic path (byte-identical reuse)
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

    // cachePrefix already contains formatSection, rulesSection, PPT_STRUCTURE_CLAUSE, pptText,
    // and (Fix 1, Q3) the full recText when hasTxt — repeat only the revision-specific
    // instruction here to avoid resending the transcript a second time uncached.
    const refLabel = hasPpt ? 'PPT 자료' : '녹취록 자료';
    const userPrompt = deixisSection + `위 형식·규칙·${refLabel}를 참고하여 학습 노트를 수정하세요.${revisionClause}`;

    agentLog(1, 'Claude AI 응답 스트리밍 수신 중…');
    const revisionMeta = { isFirstCall: false, feature: 'noteAnalysis' };
    notesText = await callClaudeStream(apiKey, userPrompt, targetEl, dot, MINIMAL_SYSTEM, MAX_TOKENS_NOTES, cachePrefix, 'claude-sonnet-4-6', revisionMeta);
    notesText = await continueIfTruncated(apiKey, notesText, userPrompt, MINIMAL_SYSTEM, cachePrefix, revisionMeta, targetEl);

  } else if (!hasTxt) {
    /* ── PPT-only mode: single Sonnet call ── */
    needsSummarySynth = true;  // R2: replace Agent1 inline 요약 with verified summary
    agentLog(1, 'PPT 전용 모드 — Sonnet으로 노트 작성 시작…');

    const userPrompt = `위 PPT 자료를 바탕으로 학습 가이드를 작성하세요.
녹취록이 없으므로 슬라이드 내용만을 기반으로 핵심 개념을 충실히 정리하세요.`;

    agentLog(1, 'Claude Sonnet 응답 스트리밍 수신 중…');
    notesText = await callClaudeStream(apiKey, userPrompt, targetEl, dot, MINIMAL_SYSTEM, MAX_TOKENS_NOTES, cachePrefix, 'claude-sonnet-4-6', meta);
    notesText = await continueIfTruncated(apiKey, notesText, userPrompt, MINIMAL_SYSTEM, cachePrefix, meta, targetEl);

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

      // Fix 1 (Q3): cachePrefix above already carries the FULL ppt + FULL transcript
      // (via `if (hasTxt) cachePrefix += ...`) and is built once per agent1_writeNotes
      // call — reuse it as-is so every chunk's cache block is byte-identical. Chunk 1
      // pays the 1.25x cache write, chunks 2..N read at 0.1x. Previously each chunk
      // rebuilt its own cache scoped to only that chunk's slides (pptChunk), which
      // never matched between calls and so never hit.
      const chunkCache = cachePrefix;

      let combinedNotes = '';
      let accumulatedNotes = '';
      for (let c = 0; c < chunks.length; c++) {
        const chunkSlides = chunks[c];
        const slideStart = parseInt(chunkSlides[0][1], 10);
        const slideEnd = parseInt(chunkSlides[chunkSlides.length - 1][1], 10);

        debugLog('PIPE', `Chunk ${c+1}/${numChunks} — slides ${slideStart}-${slideEnd}`);
        agentLog(1, `청크 ${c+1}/${numChunks} 스트리밍 중 (슬라이드 ${slideStart}-${slideEnd})…`);

        // Fix 1 (Q3): the model now sees ALL slides via the shared chunkCache above,
        // so the per-chunk instruction must explicitly restrict output to this
        // chunk's own slide range — the chunkCache no longer scopes that for it.
        let chunkInstruction;
        if (c === 0) {
          chunkInstruction = `Write notes for slides ${slideStart}-${slideEnd} ONLY — the PPT and transcript above cover ALL slides, but do not write content for any other slide range in this call; later calls handle those. Do NOT write a **요약** paragraph — start directly with the first # heading. The summary will be synthesized separately after all slides are processed.`;
        } else {
          chunkInstruction = `Write notes for slides ${slideStart}-${slideEnd} ONLY — the PPT and transcript above cover ALL slides, but do not write content for any other slide range in this call; later calls handle those. Continue from the previous chunk's notes below. Match the same format. Do NOT write a **요약** paragraph or any introduction — start directly with the first # heading for these slides.`;
        }

        // Fix 3 (Q3): compact digest (headings + bold terms) instead of the full
        // accumulated notes — keeps this uncached block from growing every chunk.
        const prevNotesBlock = c > 0
          ? `\n\n[이미 작성된 섹션·용어 (중복 금지)]\n${buildPrevNotesDigest(accumulatedNotes)}`
          : '';

        const chunkPrompt = deixisSection + `위 PPT 자료와 강의 녹취록을 바탕으로 학습 가이드를 작성하세요. ${chunkInstruction}${prevNotesBlock}`;
        const chunkMeta = c === 0 ? meta : { isFirstCall: false, feature: 'noteAnalysis' };

        // Fix 4 (Q1): one retry with backoff on chunk failure. If the FIRST
        // chunk still fails, there's nothing to salvage — rethrow. Otherwise
        // keep the notes generated so far and mark the gap, don't abort the
        // whole pipeline over one flaky chunk. User cancels always rethrow.
        let chunkText;
        try {
          chunkText = await callClaudeStream(apiKey, chunkPrompt, targetEl, dot, MINIMAL_SYSTEM, MAX_TOKENS_NOTES, chunkCache, 'claude-sonnet-4-6', chunkMeta);
        } catch (e) {
          if (e.name === 'AbortError') throw e;
          debugLog('PIPE', `Chunk ${c+1} failed: ${e.message} — retrying once`);
          agentLog(1, `⚠️ 청크 ${c+1} 생성 실패 — 재시도 중…`);
          await new Promise(r => setTimeout(r, 3000));
          try {
            chunkText = await callClaudeStream(apiKey, chunkPrompt, targetEl, dot, MINIMAL_SYSTEM, MAX_TOKENS_NOTES, chunkCache, 'claude-sonnet-4-6', chunkMeta);
          } catch (e2) {
            if (e2.name === 'AbortError') throw e2;
            if (c === 0 || !combinedNotes) throw e2;  // nothing to salvage from
            debugLog('PIPE', `Chunk ${c+1} retry failed: ${e2.message} — salvaging with notes so far`);
            agentLog(1, `⚠️ 청크 ${c+1} 재시도 실패 — 일부 구간 누락으로 계속 진행`);
            combinedNotes += `\n\n# ⚠️ 일부 구간 누락\n- 슬라이드 ${slideStart}~${slideEnd} 구간 생성 실패 (네트워크 오류). 재분석 시 복구됩니다.\n`;
            showToast('일부 구간 생성 실패 — 나머지 노트로 계속 진행합니다');
            continue;
          }
        }

        chunkText = await continueIfTruncated(apiKey, chunkText, chunkPrompt, MINIMAL_SYSTEM, chunkCache, chunkMeta, targetEl);
        combinedNotes += (c > 0 ? '\n\n' : '') + chunkText;
        accumulatedNotes += chunkText + '\n';
      }

      agentLog(1, `${numChunks}개 청크 완료`);

      /* ── R1 map-reduce + R2 verify: 요약 합성은 U11에서 runAgentPipeline로 이동 —
         critique∥highlight와 병렬로 돈다(요약은 notesText만 필요). 여기선 플래그만. ── */
      _summarySynthNeeded = true;

      notesText = combinedNotes;
      targetEl.innerHTML = renderMarkdown(notesText);

    } else {
      /* ── Single-pass mode ── */
      // ponytail: transcript-only long lectures also land here (slideMatches=0
      // since there's no [슬라이드 N]/[페이지 N] pptText to match against, so
      // totalSlides=0 never exceeds the chunk threshold above) — no transcript
      // chunking exists, continueIfTruncated() below handles output truncation
      // instead. Add real transcript chunking if long recording-only notes
      // start getting cut off in practice.
      needsSummarySynth = true;  // R2: replace Agent1 inline 요약 with verified summary
      agentLog(1, hasPpt
        ? `PPT + 녹취록 단일 패스 — Sonnet으로 학습 가이드 작성 시작… (녹취록 ${recText.length.toLocaleString()}자)`
        : `녹취록 전용 단일 패스 — Sonnet으로 학습 가이드 작성 시작… (녹취록 ${recText.length.toLocaleString()}자)`);

      // Fix 1 (Q3): recText already lives in cachePrefix (see `if (hasTxt)` above) —
      // don't resend it uncached here too.
      const userPrompt = deixisSection + (hasPpt
        ? `위 PPT 자료와 강의 녹취록을 바탕으로 학습 가이드를 작성하세요.`
        : `위 강의 녹취록을 바탕으로 학습 가이드를 작성하세요. PPT 자료가 없으므로 녹취록 내용만으로 핵심 개념을 충실히 정리하세요.`);

      agentLog(1, 'Claude Sonnet 응답 스트리밍 수신 중…');
      debugLog('PIPE', `Agent1 single-pass: transcript=${recText.length}chars`);
      notesText = await callClaudeStream(apiKey, userPrompt, targetEl, dot, MINIMAL_SYSTEM, MAX_TOKENS_NOTES, cachePrefix, 'claude-sonnet-4-6', meta);
      notesText = await continueIfTruncated(apiKey, notesText, userPrompt, MINIMAL_SYSTEM, cachePrefix, meta, targetEl);
    }
  }

  /* ── R2: single-pass / PPT-only 경로도 요약을 전용 합성·검증으로 교체.
     U11: 합성 자체는 runAgentPipeline에서 critique∥highlight와 병렬 실행 — 여기선 플래그만. ── */
  if (needsSummarySynth) _summarySynthNeeded = true;

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
      // Fix 7 (Q1): skip fixes too vague to apply safely — a short `old`
      // snippet or one that matches many spots risks patching the wrong text.
      if (!f.old || f.old.length < 15) {
        debugLog('PIPE', `Patch fix skipped — old text too short: ${JSON.stringify(f.old)}`);
        return;
      }
      if (patched.split(f.old).length - 1 > 3) {
        debugLog('PIPE', `Patch fix skipped — "${f.old.slice(0, 30)}…" matches too many spots`);
        return;
      }
      if (f.new !== undefined && patched.includes(f.old)) {
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
    // Fix 5 (Q1): include the same format/rules blocks Agent1 uses — without
    // them the rewrite drifts from the house style — and give it the full
    // MAX_TOKENS_NOTES budget instead of a fixed 16000.
    const { formatSection, rulesSection } = getNoteFormatBlocks();
    const rewriteSystem = '당신은 전문 학습 노트 작성가입니다. 모든 답변은 한국어로 작성하세요.';
    const rewritePrompt =
`Apply ONLY the [CRITICAL] fixes from the critique below to the note, then return the full corrected note.

[형식]
${formatSection}

[규칙]
${rulesSection}

[NOTE]
${notesText}

[CRITIQUE]
${critiqueText}`;
    const fallbackDot = targetBodyEl ? makeAgentDot(1) : document.getElementById('dotNotes');
    const rewritten = await callClaudeStream(
      apiKey, rewritePrompt, targetEl, fallbackDot,
      rewriteSystem, MAX_TOKENS_NOTES, null, 'claude-haiku-4-5-20251001',
      { feature: 'noteAnalysis' }
    );

    // Fix 5 (Q1): reject a rewrite that collapsed in length or lost all
    // structure — keep the pre-rewrite (JSON-patched-nothing) notes instead.
    if (rewritten.length < notesText.length * 0.8 || !rewritten.includes('## ')) {
      debugLog('PIPE', `Haiku rewrite rejected — len=${rewritten.length} vs pre-rewrite=${notesText.length}, hasHeading=${rewritten.includes('## ')}`);
      agentLog(1, '⚠️ Haiku 재작성 결과가 불완전하여 이전 노트 유지');
      targetEl.innerHTML = renderMarkdown(notesText);
      storedNotesText = notesText;
      setAgentNode(1, 'done', '완료');
      agentLog(1, `이전 노트 유지 — ${notesText.length.toLocaleString()}자`);
      return notesText;
    }

    patched = rewritten;
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
  const hasPpt2 = pptText && pptText.trim().length > 0;  // U1: transcript-only mode has no PPT block
  // Fix 2 (Q3): agent2 runs exactly once per analysis (no re-critique loop), so a
  // cache_control block here pays the 1.25x write premium and is never read back —
  // pure surcharge on ~57k Haiku tokens. It also can't be shared with agent1's cache
  // even in principle (Anthropic caches are model-scoped; agent1 is Sonnet, agent2 is
  // Haiku). Build the same content as a plain (uncached) string instead — see the
  // null cachePrefix in the callClaudeOnce call below.
  // U12: core(지시문만) / full(+원본 임베드) 분리 — 캐시 경로는 core만 쓰고
  // 원본은 agent1 캐시 블록을 참조, 비캐시 경로는 기존처럼 원본을 임베드.
  const criticInstructionsCore = systemPrompt + `

당신은 엄격한 학문적 비평가입니다. 아래 3단계 절차를 순서대로 실행하세요.

━━━ 1단계: 전체 문제 탐색 ━━━
학습 노트를 원본 자료(PPT + 녹취록)와 비교하여 아래 여섯 유형의 모든 불일치를 빠짐없이 찾아내세요.
• 누락된 개념 — PPT 슬라이드를 하나씩 확인하여 해당 슬라이드의 핵심 내용이 노트에 반영되었는지 검증할 것. 슬라이드 제목뿐 아니라 슬라이드 본문의 주요 개념, 정의, 분류가 노트에서 빠졌으면 누락으로 판정. 예: PPT에 6가지 분류가 있는데 노트에 3가지만 있으면 누락임.
  검증 방법: PPT 텍스트에서 [슬라이드 N] 태그를 하나씩 순회하면서, 해당 슬라이드의 제목과 본문 핵심 내용이 노트에 존재하는지 확인할 것. 문제가 있는 슬라이드만 보고하고, 문제 없는 슬라이드는 언급하지 말 것 (확인 나열 금지).
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
`;
  const criticInstructions = criticInstructionsCore + (hasPpt2 ? `
[원본 PPT]
${pptText}

[원본 녹취록]
${recText}` : `
[원본 녹취록]
${recText}`);
  const userPrompt = `[검토 대상 학습 노트]
${notesText}`;

  /* U12: 소스가 크면(≥50k자) agent1이 방금 써둔 Sonnet 캐시를 재사용.
     경제성: Haiku 정가 입력 $1/MTok vs Sonnet 캐시 읽기 $0.3/MTok — 입력은 3.3×
     싸지지만 출력($5 vs $15)이 3× 비싸져서, 비평 출력 ~1-2k토큰 기준 손익분기가
     소스 ~33k토큰(≈50k자). 캐시는 모델별이라 Haiku로는 Sonnet 캐시를 못 읽음.
     짧은 소스는 기존 Haiku 정가 경로가 그대로 더 싸다. 부수 효과: 긴 강의의
     비평 모델이 Sonnet으로 올라가 [CRITICAL] 검출 품질도 상승. */
  const srcLen = (pptText || '').length + (recText || '').length;
  const useCachedCritic = srcLen >= 50000 && !!_agent1CachePrefix;
  debugLog('PIPE', `U12 critic path: ${useCachedCritic ? 'sonnet-cached' : 'haiku'} srcLen=${srcLen}`);
  let raw;
  if (useCachedCritic) {
    // criticInstructionsCore(원본 미포함) + 노트가 uncached 블록, 원본은 위
    // 캐시 블록의 [PPT 참고 자료]/[강의 녹취록]을 그대로 참조. system은
    // agent1과 바이트 동일해야 캐시가 매칭된다(MINIMAL_SYSTEM).
    const cachedPrompt = `${criticInstructionsCore}

[원본 자료 안내]
원본 자료는 위에 이미 제공된 ${hasPpt2 ? '[PPT 참고 자료]와 [강의 녹취록]' : '[강의 녹취록]'} 블록입니다. 그것을 원본으로 삼아 검토하세요.

${userPrompt}`;
    raw = await callClaudeOnce(apiKey, cachedPrompt, MINIMAL_SYSTEM, MAX_TOKENS_CRITIQUE, 'claude-sonnet-4-6', _agent1CachePrefix, { feature: 'noteAnalysis' });
  } else {
    // R2-A: critic on Haiku 4.5 — verification step doesn't need Sonnet
    // (this call is uncached, so quality drop is minimal and cost falls ~3x).
    // Fix 2 (Q3): pass null cachePrefix — see criticInstructions comment above.
    // combinedPrompt keeps the exact same content/order the model saw before
    // (criticInstructions then userPrompt), just as one uncached string.
    const combinedPrompt = `${criticInstructions}\n\n${userPrompt}`;
    raw = await callClaudeOnce(apiKey, combinedPrompt, systemPrompt, MAX_TOKENS_CRITIQUE, 'claude-haiku-4-5-20251001', null, { feature: 'noteAnalysis' });
  }
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
