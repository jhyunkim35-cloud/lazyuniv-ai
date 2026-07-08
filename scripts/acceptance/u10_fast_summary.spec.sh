# 회귀 가드 — U10 빠른 초안 요약 (2026-07-09)
# univ.ai는 ~10초 안에 문서 요약을 보여주는데 Notyx는 검증된(더 정확한) 요약을
# 전체 노트 파이프라인(~77초) 끝나야 보임. Agent1과 병렬로 Haiku 초안 요약을
# fire-and-forget으로 띄워 히어로가 <10초에 뜨고, 검증 요약이 오면 교체되는지 잠금.

# ── 상태: 초안 요약 + 검증완료 가드 (currentSummaryLayers와 분리 저장) ──
assert_contains public/js/constants.js "let _draftSummary              = null;" "U10-1a: _draftSummary 전역 상태 존재 (currentSummaryLayers와 별도)"
assert_contains public/js/constants.js "let _verifiedSummaryDone       = false;" "U10-1b: _verifiedSummaryDone 가드 플래그 존재"

# ── 함수 존재 + Haiku 모델 + 마커 파싱 ──
assert_contains public/js/pipeline.js "async function generateQuickSummary(apiKey, pptText, recText)" "U10-2a: generateQuickSummary 함수 존재"
assert_contains public/js/pipeline.js "700, 'claude-sonnet-4-6', null, { feature: 'noteAnalysis', isFirstCall: false })" "U10-2b: 드래프트 Sonnet(준현 지시)·max_tokens~700·cachePrefix 없음·isFirstCall false"
# ── U11: 요약 병렬화 + critic 캐시 ──
assert_contains public/js/pipeline.js "_summarySynthNeeded" "U11-1a: 합성 이연 플래그 존재"
assert_contains public/js/pipeline.js "summaryPromise," "U11-1b: 요약 합성이 critique∥highlight Promise.all에 합류"
assert_absent public/js/pipeline.js "currentSummaryLayers = await synthesizeSummary" "U11-1c: agent1 내부 직렬 synth 잔존 없음"
assert_contains public/js/pipeline.js "16, 'claude-sonnet-4-6', cachePrefix" "U11-2: 요약 critic이 Sonnet+공유 캐시 prefix 사용 (Haiku 정가 재전송 제거)"
assert_contains public/js/pipeline.js "slice(0, 30000)" "U10-2c: 원본 소스를 30,000자로 절단 (비용·지연 상한)"
assert_contains public/js/pipeline.js "const idxT = raw.indexOf('[한줄]');" "U10-2d: [한줄] 마커 파싱"
assert_contains public/js/pipeline.js "const idxB = raw.indexOf('[핵심]');" "U10-2e: [핵심] 마커 파싱"

# ── 비차단 fire-and-forget: 메인 흐름에서 await 없이 호출 ──
assert_contains public/js/pipeline.js "if (!targetBodyEl) generateQuickSummary(apiKey, storedPptText, storedFilteredText);" "U10-3a: runAgentPipeline이 await 없이 fire-and-forget으로 호출 (싱글노트 뷰 한정)"
assert_absent public/js/pipeline.js "await generateQuickSummary" "U10-3b: 메인 흐름 어디서도 generateQuickSummary를 await하지 않음"

# ── 리셋: 새 분석 시작 시 초안·가드 초기화 (currentSummaryLayers 리셋과 나란히) ──
assert_contains public/js/pipeline.js "_draftSummary = null;  // U10: reset fast-draft summary alongside the verified one" "U10-4a: 파이프라인 시작 시 _draftSummary 리셋"
assert_contains public/js/pipeline.js "_verifiedSummaryDone = false;  // U10: new analysis" "U10-4b: 파이프라인 시작 시 _verifiedSummaryDone 리셋"

# ── 초안은 절대 저장되지 않음: currentSummaryLayers를 절대 대입받지 않는다 ──
assert_absent public/js/pipeline.js "currentSummaryLayers = _draftSummary" "U10-5a: _draftSummary가 currentSummaryLayers에 대입되는 경로 없음 (저장 격리)"
assert_absent public/js/pipeline.js "_draftSummary = await synthesizeSummary" "U10-5b: 검증 요약 결과가 _draftSummary로 들어가는 경로 없음"
assert_contains public/js/notes_crud.js "summaryLayers:        currentSummaryLayers || null,  // R4: multilayer summary (한줄/핵심/문단/챕터)" "U10-5c: autoSaveNote는 여전히 currentSummaryLayers만 저장 (draft 미관여, 변경 없음 확인)"

# ── 검증 요약 도착 시 초안 교체: 두 경로(청크/needsSummarySynth) 모두 가드 세팅 ──
assert_contains public/js/pipeline.js "_summarySynthNeeded = true;" "U10-6a: 청크 경로가 합성 이연 플래그 설정 (U11 구조)"
assert_contains public/js/pipeline.js "if (needsSummarySynth) _summarySynthNeeded = true;" "U10-6b: 단일패스 경로도 이연 플래그 (U11 구조)"
assert_contains public/js/pipeline.js "_verifiedSummaryDone = true;  // U10: verified attempt finished (success or fail) — stop the quick-draft repaint" "U10-6c: 검증 시도 완료 시 가드 세팅 (성공·실패 모두 — try/catch 밖에서 실행)"

# ── renderSummaryHero: 초안 렌더 분기 + 검증 완료 시 정상 경로로 폴백 ──
assert_contains public/js/pipeline.js "if (!currentSummaryLayers && _draftSummary && !_verifiedSummaryDone) {" "U10-7a: currentSummaryLayers가 없고 초안이 있고 검증 미완료일 때만 초안 렌더"
assert_contains public/js/pipeline.js "function renderSummaryHeroTabs(body, chips, layers, tabs)" "U10-7b: 탭칩 렌더가 검증/초안 공용 헬퍼로 통합"
assert_contains public/js/pipeline.js "renderSummaryHeroTabs(body, chips, _draftSummary, draftTabs);" "U10-7c: 초안 탭은 _draftSummary만 사용 (한줄/핵심 두 탭만 노출 가능)"
assert_contains public/js/pipeline.js "t.key === 'tldr' || t.key === 'bullets'" "U10-7d: 초안 탭 후보는 한줄/핵심만 (문단/챕터/시험/쉬운은 초안에 없음)"

# ── 재생성 버튼은 초안 상태에서 숨김 ──
assert_contains public/js/pipeline.js "if (regenBtn) regenBtn.hidden = true;  // U10-6: no regen against an unverified draft" "U10-8a: 초안 렌더 시 ↻ 재생성 버튼 숨김"
assert_contains public/js/pipeline.js "if (regenBtn) regenBtn.hidden = false;" "U10-8b: 검증 요약 렌더 시 재생성 버튼 복귀"

# ── 배지 마크업 + 스타일 ──
assert_contains public/index.html 'id="summaryHeroDraftBadge" hidden>⚡ 빠른 요약 · 전체 검증 요약 생성 중…' "U10-9a: 초안 배지 마크업 (기본 hidden)"
assert_contains public/index.html ".summary-hero-draft-badge {" "U10-9b: 초안 배지 CSS 존재"
assert_contains public/js/pipeline.js "if (badge) badge.hidden = false;" "U10-9c: 초안 렌더 시 배지 표시"
assert_contains public/js/pipeline.js "if (badge) badge.hidden = true;" "U10-9d: 검증 요약 렌더 시 배지 숨김"

# ── 캐시버스트 (버전 문자열 무관 — 존재만 확인) ──
assert_matches public/index.html "pipeline\.js\?v=" "U10-10a: pipeline.js 버전 마커 존재"
assert_matches public/index.html "constants\.js\?v=" "U10-10b: constants.js 버전 마커 존재"

assert_contains public/js/pipeline.js "if (full.length < 15000) return;" "U10b: 드래프트는 긴 소스(청크급)에서만 발동 — 짧은 노트는 스트리밍+검증요약으로 충분"
