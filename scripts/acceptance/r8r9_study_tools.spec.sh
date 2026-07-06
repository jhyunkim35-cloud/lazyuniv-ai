# 회귀 가드 — R8+R9 학습 도구: 마인드맵 / 암기 / 개념 (2026-07-06)
# 학습 도구 카드가 마인드맵(계층 트리)·암기(cloze)·개념(용어집) 3개 도구를
# 탭으로 전환하며 생성·저장·복원하는지 잠금.
assert_contains public/js/pipeline.js "function generateMindmap" "R8: generateMindmap 함수 존재"
assert_contains public/js/pipeline.js "function generateStudyAids" "R9: generateStudyAids 함수 존재 (암기+개념 1회 호출)"
assert_contains public/js/pipeline.js "function renderStudyTools" "R8+R9: renderStudyTools 함수 존재"
assert_contains public/index.html "id=\"studyToolsCard\"" "R8+R9: 학습 도구 카드 엘리먼트 존재"
assert_contains public/index.html "data-tool=\"memorize\"" "R9: 암기 탭 칩 존재"
assert_contains public/js/constants.js "currentStudyTools" "R8+R9: currentStudyTools 상태 변수 존재"
assert_contains public/js/notes_crud.js "studyTools:" "R8+R9: autoSaveNote가 studyTools 저장"
assert_contains public/js/notes_crud.js "note.studyTools" "R8+R9: openSavedNote가 studyTools 복원"
assert_contains public/js/pipeline.js "class=\"cloze\"" "R9: 암기 cloze 렌더 존재"
assert_contains public/js/pipeline.js "escHtml(" "R8+R9: 렌더 시 escHtml로 XSS 방지"
