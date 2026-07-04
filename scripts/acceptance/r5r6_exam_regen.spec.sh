# 회귀 가드 — R5 시험 관점 요약 + R6 요약 재생성 버튼 (2026-07-04)
# R5: 5번째 마커([시험])가 생성 프롬프트/파싱/hero 탭에 배선됐는지.
# R6: 재생성 버튼이 재진입 가드 + 조용한 저장(이름 모달 없는 saveNoteFS 갱신) + 실패 시 기존 layers 유지로 배선됐는지.
assert_contains public/js/pipeline.js "[시험]" "R5: 다층 생성 프롬프트에 [시험] 마커 존재"
assert_contains public/js/pipeline.js "exam: toList(section(4))" "R5: parseLayers가 exam 층 파싱"
assert_contains public/js/pipeline.js "key: 'exam'" "R5: hero 탭 목록에 시험 탭 존재"
assert_contains public/js/pipeline.js "async function regenerateSummary" "R6: 요약 재생성 함수 존재"
assert_contains public/js/pipeline.js "btn.disabled) return" "R6: 재생성 버튼 재진입 가드"
assert_contains public/js/pipeline.js "if (currentNoteId)" "R6: 재생성 후 조용한 in-place 저장 (이름 모달 없음)"
assert_contains public/js/pipeline.js "currentSummaryLayers = prevLayers" "R6: 실패 시 기존 summaryLayers 유지"
assert_contains public/index.html "id=\"summaryRegenBtn\"" "R6: hero 카드에 재생성 버튼 엘리먼트 존재"
assert_contains public/js/main_inline.js "regenerateSummary" "R6: 재생성 버튼 클릭 바인딩 존재"
