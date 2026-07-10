# 회귀 가드 — U12 비평 캐시 재사용 (2026-07-11)
# 긴 소스(≥50k자)에서 agent2 비평이 agent1의 Sonnet 캐시 prefix를 재사용.
# 손익분기 ~50k자(입력 3.3×↓ vs 출력 3×↑), 짧은 소스는 기존 Haiku 정가 유지.
assert_contains public/js/pipeline.js "const MINIMAL_SYSTEM = " "U12-1a: MINIMAL_SYSTEM 모듈 스코프 승격"
assert_contains public/js/pipeline.js "let _agent1CachePrefix = null;" "U12-1b: agent1 캐시 prefix 스태시 변수"
assert_contains public/js/pipeline.js "_agent1CachePrefix = null;     // U12" "U12-1c: 파이프라인 시작 시 스태시 리셋"
assert_contains public/js/pipeline.js "_agent1CachePrefix = cachePrefix;" "U12-1d: agent1이 prefix 스태시"
assert_contains public/js/pipeline.js "srcLen >= 50000 && !!_agent1CachePrefix" "U12-2a: 50k자 조건부 캐시 경로"
assert_contains public/js/pipeline.js "MAX_TOKENS_CRITIQUE, 'claude-sonnet-4-6', _agent1CachePrefix" "U12-2b: Sonnet+캐시 prefix 호출 형태"
assert_contains public/js/pipeline.js "'claude-haiku-4-5-20251001', null, { feature: 'noteAnalysis' })" "U12-2c: 짧은 소스 Haiku 폴백 경로 유지"
assert_contains public/js/pipeline.js "criticInstructionsCore" "U12-3a: 지시문 core(원본 미포함) 분리"
assert_contains public/js/pipeline.js "원본 자료는 위에 이미 제공된 " "U12-3b: 캐시 경로가 캐시 블록 원본 참조 안내 포함"
assert_contains public/js/pipeline.js "U12 critic path: " "U12-4: 경로 선택 debugLog"
# DONE_SIGNAL 문장이 core에 있어 양 경로 모두 포함됨
assert_contains public/js/pipeline.js "검토 완료 — 수정 필요 없음" "U12-5: DONE_SIGNAL 계약 유지"
assert_matches public/index.html "pipeline\.js\?v=" "U12-6: pipeline.js 버전 마커 존재"
assert_absent public/index.html "?v=q5saveguard" "U12-7: 이전 캐시버스트 잔존 없음"
