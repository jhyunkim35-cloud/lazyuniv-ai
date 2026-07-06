# 회귀 가드 — R10 쉬운 설명 요약 층 (2026-07-06)
# synthesizeSummary가 [쉬운] 6번째 층(비전공자용 설명 + 비유·실생활 예시)을 같은 1콜로
# 생성하고, hero 탭칩에 '쉬운' 탭이 노출되는지 잠금. univ.ai '쉬운 설명' 토글 대응.
assert_contains public/js/pipeline.js "[쉬운]" "R10: 프롬프트/마커에 [쉬운] 층 존재"
assert_contains public/js/pipeline.js "easy: section(5)" "R10: parseLayers가 easy 층을 잘라냄"
assert_contains public/js/pipeline.js "key: 'easy'" "R10: hero 탭칩에 '쉬운' 탭 등록"
assert_contains public/js/pipeline.js "newLayers.easy" "R10: 재생성 hasContent 가드에 easy 포함"
