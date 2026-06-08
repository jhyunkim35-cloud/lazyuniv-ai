# R3 — 홈 폴더카드 이름변경 인라인
assert_contains public/js/home_view.js "function enterFolderNameEdit" "enterFolderNameEdit 정의됨"
assert_contains public/js/home_view.js "enterFolderNameEdit(card, folder)" "폴더카드 연필이 인라인 호출"
assert_contains public/js/home_view.js "renameFolderFS(folder.id, newName)" "이름만 rename (색·코드 보존)"
