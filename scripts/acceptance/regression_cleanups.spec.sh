# 회귀 가드 — 이미 정리/수정된 것들이 다시 새지 않게 잠금 (감사 2026-06-09)
assert_repo_absent "splitSaveBtn" "A1: splitSaveBtn ghost 잔존 없음"
assert_repo_absent "noteSearchInput" "데드코드 noteSearchInput 잔존 없음"
assert_contains public/js/quiz.js "removeEventListener('keydown'" "E1: examReview keydown 리스너 정리 유지"
assert_contains public/js/quiz.js "_quizRenderCurrentCard(ctx" "M4: runInlineQuiz ctx+헬퍼 위임 유지"
