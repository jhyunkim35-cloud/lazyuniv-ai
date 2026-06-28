# 회귀 가드 — R3 요약 1급 독립 뷰(hero) 승격 (2026-06-28)
# 요약을 노트 펼치지 않고 바로 보는 standalone hero 카드 배선 잠금.
assert_contains public/index.html "id=\"summaryHero\"" "R3: 요약 hero 카드 엘리먼트 존재"
assert_contains public/index.html "summary-hero-card" "R3: 요약 hero CSS 클래스 존재"
assert_contains public/js/pipeline.js "function renderSummaryHero" "R3: 요약 hero 렌더 함수 존재"
assert_contains public/js/pipeline.js "renderSummaryHero(notesText)" "R3: 노트 작성 완료 시 hero 렌더 호출"
