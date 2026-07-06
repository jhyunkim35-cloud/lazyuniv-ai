# 회귀 가드 — R7 페이지 인용 칩 (2026-07-04)
# renderMarkdown이 p.N/p.N-M 참조를 클릭 가능한 칩으로 치환하고, 클릭 시
# 원본 슬라이드(이미지 우선, 텍스트 폴백)를 오버레이로 보여주는지 잠금.
assert_contains public/js/markdown.js "page-cite-chip" "R7: renderMarkdown이 p.N 참조를 page-cite-chip으로 치환"
assert_contains public/js/ui.js "function openSlideCite" "R7: openSlideCite 함수 존재"
assert_contains public/index.html "id=\"slideCiteOverlay\"" "R7: 슬라이드 인용 오버레이 엘리먼트 존재"
assert_contains public/js/ui.js "e.target.closest('.page-cite-chip')" "R7: page-cite-chip 클릭 위임 리스너 존재"
assert_contains public/js/ui.js "storedPptText.match" "R7: 이미지 없을 때 PPT 텍스트 폴백 경로 존재"
