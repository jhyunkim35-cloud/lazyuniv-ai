// Agent pipeline orchestration, note writers, critic.
// Depends on: constants.js (analyzeBtn, storedPptText, storedFilteredText, storedNotesText, storedHighlightedTranscript, DONE_SIGNAL, MAX_ITERATIONS, MAX_TOKENS_NOTES, MAX_TOKENS_CRITIQUE, iterChipData, debugLog), markdown.js (renderMarkdown), api.js (callClaudeOnce, callClaudeStream), ui.js (agentLog, setProgress, setAgentNode, resetAgentNodes, makeAgentDot, updateIterCounter, addIterChip, updateETA, startElapsedTimer, stopElapsedTimer).

async function runAgentPipeline(apiKey, targetBodyEl = null) {
  resetAgentNodes();
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
        debugLog('PIPE', `Iter ${iter} — Agent2 done, isDone=${isDone}, critique=${critiqueText.length}chars`);

        const iterDuration = Date.now() - iterStart;
        iterTimings.push(iterDuration);
        updateIterCounter('done', iter);
        addIterChip(iter, isDone);

        if (isDone) {
          updateETA(iterTimings, 0);
          const finalBar = document.getElementById('agentFinalBar');
          finalBar.innerHTML =
            `✅ ${iter}차 검토 완료 — 학습 노트가 원본과 일치합니다 (총 ${Math.round(iterTimings.reduce((a,b)=>a+b,0)/1000)}초 소요)`;
          finalBar.classList.add('visible');
          agentLog(0, `━━━ 완료 (${iter}차에 검토 통과) ━━━`);
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
| 사회복지학 | 비임상군~임상군 | 환경적, 제도적 지원 연계 |

예시5: 대비/비교 변환
PPT 원문: "자문 vs 심리상담 — 공통점: 해결이 필요한 '문제'가 존재 / 자문: 대부분 해답을 모르는 상태에서 자문을 구함, 전문가의 전문적 조언 또는 해결책 제시, 상대적으로 명료한 해답이 도출됨, 감정이 개입될 여지가 적음 / 심리상담: 내담자가 해답을 알고 있기도 함, 전문가는 내담자가 스스로 문제를 해결하도록 도움, 문제의 원인과 해결방법이 복잡하고 모호함, 감정이 개입됨"
→ 노트:
- 공통점 : 해결이 필요한 '문제'가 존재

자문
- 대부분 해답을 모르는 상태에서 자문 구함
- 전문가의 전문적 조언/해결책 제시
- 상대적으로 명료한 해답 도출
- 감정 개입 여지 적음

심리상담
- 내담자가 해답을 알기도 함
- 내담자 스스로 문제 해결하도록 도움
- 문제의 원인과 해결 방법이 복잡, 모호
- 감정 개입

예시6: 목적/단계 구조
PPT 원문: "상담의 구체적 목적 — 1차적 목적: 증상 완화, 문제 해결. 내담자가 호소하는 심리적 불편감, 증상을 경감시키는 것 / 2차적 목적: 성장 촉진적 목표. 내담자의 가능성과 잠재력을 발휘할 수 있도록 돕는 것, 인간적 발달 및 인격적 성숙"
→ 노트:
- 상담의 기본적 목적 = **내담자의 변화**
- 상담의 구체적 목적
    - 1차적 목적 : 증상 완화, 문제 해결
        - 내담자가 호소하는 심리적 불편감, 증상 경감
    - 2차적 목적 : 성장 촉진적 목표
        - 내담자의 가능성과 잠재력 발휘를 돕는 것 (인간적 발달 및 인격적 성숙)

예시7: 개념 + 구성요소 계층
PPT 원문: "작업동맹(Working Alliance) — 치료적 관계를 기반으로 상담자와 내담자가 공동의 목표를 위해 협력하는 관계(Bordin, 1979). 상담이 실제로 함께 문제를 해결하는 협력 작업이라는 측면을 강조. 구성요소: ① 목표합의(Goal): 상담을 통해 무엇을 이룰 것인지에 대한 동의, ② 과제합의(Task): 목표를 달성하기 위한 방법과 활동에 대한 동의, ③ 유대(Bond): 목표와 과제를 수행해나갈 수 있게 해주는 상호 신뢰와 애착, 정서적 연결"
→ 노트:
- **작업 동맹 Working Alliance** : 치료적 관계 기반으로 공동 목표를 위해 협력하는 관계 (Bordin, 1979)
    - 함께 문제를 해결하는 협력 작업이라는 측면 강조
- 구성 요소
    ① 목표 합의(Goal) : 무엇을 이룰 것인지에 대한 동의
    ② 과제 합의(Task) : 목표 달성을 위한 방법/활동에 대한 동의
    ③ 유대(Bond) : 상호 신뢰와 애착, 정서적 연결

예시8: 유형 나열 (짧은 정의 + ex)
PPT 원문: "내담자 문제에 따른 유형 — 성장상담: 특별한 정신 병리가 없더라도 더 나은 상태로 성장하고자 하는 상담 ex) 실존적 문제, 자아실현 / 정신건강상담: 신경증 및 정신증적 문제에 대한 상담 ex) 우울증, 편집증, 조현병 / 위기상담: 외부에서 발생한 위기 사건의 영향에 대한 상담 ex) 자살, 폭력, 이혼, 재난 / 기타: 진로, 학습, 성(性), 물질 남용 및 중독, 가족 상담 등"
→ 노트:
- **성장 상담** : 특별한 정신 병리 x, 더 나은 상태로 성장하고자 하는 상담
    ex) 실존적 문제, 자아실현
- **정신 건강 상담** : 신경증 및 정신증적 문제에 대한 상담
    ex) 우울증, 편집증, 조현병
- **위기 상담** : 외부에서 발생한 위기 사건의 영향에 대한 상담
    ex) 자살, 폭력, 이혼, 재난
- **기타** : 진로, 학습, 성, 물질 남용 및 중독, 가족 상담 등`,
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
   Agent 1 — Note Writer / Reviser (streams to hero card)
═══════════════════════════════════════════════ */
async function agent1_writeNotes(apiKey, pptText, recText, critiqueText = '', targetBodyEl = null, meta = {}) {
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
          chunkInstruction = `Write notes for slides ${slideStart}-${slideEnd} only. More slides follow in separate calls.`;
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

      agentLog(1, `${numChunks}개 청크 완료 — 슬라이드 전체 통합`);
      notesText = combinedNotes;
      targetEl.innerHTML = renderMarkdown(notesText);

    } else {
      /* ── Single-pass mode ── */
      agentLog(1, `PPT + 녹취록 단일 패스 — Sonnet으로 학습 가이드 작성 시작… (녹취록 ${recText.length.toLocaleString()}자)`);

      const userPrompt = `위 PPT 자료와 아래 강의 녹취록을 바탕으로 학습 가이드를 작성하세요.

[강의 녹취록]
${recText}`;

      agentLog(1, 'Claude Sonnet 응답 스트리밍 수신 중…');
      debugLog('PIPE', `Agent1 single-pass: transcript=${recText.length}chars`);
      notesText = await callClaudeStream(apiKey, userPrompt, targetEl, dot, systemPrompt, MAX_TOKENS_NOTES, cachePrefix, 'claude-sonnet-4-6', meta);
    }
  }

  storedNotesText = notesText;

  /* enable download buttons — single mode only */
  if (!targetBodyEl) {
    [quizBtn, classifyBtn, notionCopyBtn, dlNotionFileBtn, copyNotesBtn, dlTxtBtn, dlMdBtn, dlPdfBtn, splitViewBtn].forEach(b => { b.disabled = false; });
    const dbgBtn = document.getElementById('splitDebugBtn');
    if (dbgBtn) dbgBtn.style.display = '';
    document.getElementById('notesActions').classList.add('visible');
    document.getElementById('collapseBtn').classList.add('visible');
    document.getElementById('dotNotes').className = 'status-dot done';
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
    const dbgBtn = document.getElementById('splitDebugBtn');
    if (dbgBtn) dbgBtn.style.display = '';
    document.getElementById('notesActions').classList.add('visible');
    document.getElementById('collapseBtn').classList.add('visible');
    document.getElementById('dotNotes').className = 'status-dot done';
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

  const raw     = await callClaudeOnce(apiKey, userPrompt, systemPrompt, MAX_TOKENS_CRITIQUE, 'claude-sonnet-4-6', cachePrefix, { feature: 'noteAnalysis' });
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
