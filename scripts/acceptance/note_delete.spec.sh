# R2 — 노트 삭제 인라인 2단계
assert_contains public/js/notes_crud.js "async function deleteNoteNow" "deleteNoteNow 정의됨"
assert_contains public/js/home_view.js "deleteNoteNow(note.id)" "노트카드가 deleteNoteNow 호출"
assert_contains public/js/home_view.js "삭제?" "인라인 arm 텍스트 '삭제?'"
assert_repo_absent "confirmDeleteNote(" "옛 confirmDeleteNote() 호출 잔존 없음"
assert_contains public/index.html ".note-card-actions button.confirm-delete" "노트카드 빨강 confirm CSS"
assert_contains public/index.html ".note-card-actions:has(button.confirm-delete)" "armed 동안 :has 가시성 룰"
