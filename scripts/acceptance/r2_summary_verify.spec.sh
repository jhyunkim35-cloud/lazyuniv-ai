# 회귀 가드 — R2 요약 전용 생성 + critic 검증 (2026-06-28)
# 요약이 노트 파이프라인에서 분리돼 전용 합성 + 정확성/누락 검증을 거치는 배선 잠금.
assert_contains public/js/pipeline.js "async function synthesizeSummary" "R2: 전용 요약 합성 함수 존재"
assert_contains public/js/pipeline.js "PASS 또는 FAIL 한 단어만" "R2: 요약 정확성·누락 critic 검증 프롬프트 유지"
assert_contains public/js/pipeline.js "synthesizeSummary(apiKey, combinedNotes)" "R2: 청크 경로가 전용 합성 함수 사용"
assert_contains public/js/pipeline.js "needsSummarySynth" "R2: 단일/PPT 경로 요약 전용 합성 배선"
