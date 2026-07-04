# 회귀 가드 — R4 다층 요약(한줄/핵심/문단/챕터) (2026-07-04)
# synthesizeSummary가 4층 객체를 반환하고, hero 카드가 탭칩으로 층을 전환하며,
# 저장/복원 경로에 summaryLayers가 배선되고, 구노트 폴백이 살아있는지 잠금.
assert_contains public/js/pipeline.js "[한줄]" "R4: 다층 생성 프롬프트에 [한줄] 마커 존재"
assert_contains public/js/pipeline.js "[챕터]" "R4: 다층 생성 프롬프트에 [챕터] 마커 존재"
assert_contains public/js/constants.js "let currentSummaryLayers" "R4: currentSummaryLayers 전역 선언 존재"
assert_contains public/js/notes_crud.js "summaryLayers:        currentSummaryLayers" "R4: 노트 저장 시 summaryLayers 배선"
assert_contains public/js/notes_crud.js "note.summaryLayers" "R4: 저장노트 열기 시 summaryLayers 복원"
assert_contains public/index.html "id=\"summaryHeroChips\"" "R4: hero 탭칩 컨테이너 존재"
assert_contains public/js/pipeline.js "summary-hero-chip" "R4: hero 탭칩 렌더 로직 존재"
assert_contains public/js/pipeline.js "\*\*요약\*\*\s*[:：]\s*([^\n]+)" "R4: 구노트(레이어 없음) 정규식 폴백 잔존"
