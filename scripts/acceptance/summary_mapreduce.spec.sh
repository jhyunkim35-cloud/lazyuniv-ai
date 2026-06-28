# 회귀 가드 — R1 긴 강의 요약 map-reduce (2026-06-28)
# 청크 모드 요약이 "첫 청크 only"가 아니라 전체 노트 기반으로 마지막에 합성되는 배선 잠금.
assert_contains public/js/pipeline.js "R1 map-reduce" "R1: 전체 노트 기반 요약 합성(reduce) 배선 유지"
assert_contains public/js/pipeline.js "전체 노트 기반 요약 합성 중" "R1: reduce 진행 로그 유지"
assert_contains public/js/pipeline.js "강의 전체를 포괄하는 핵심 요약" "R1: 전체범위 요약 프롬프트 유지"
assert_contains public/js/pipeline.js "synthesized separately after all slides" "R1: 청크0도 요약 미작성(별도 합성) 유지"
