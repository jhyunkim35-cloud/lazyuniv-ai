# 회귀 가드 — U14 노트 생성 시 저장 폴더 선택 (2026-07-09)
# 단일/다중 노트 모두 생성 시점에 저장 폴더를 고를 수 있어야 함 (미분류 저장 후
# 나중에 이동 X). 공용 buildFolderSelectOptions 헬퍼를 양쪽 모드가 재사용.

# ── 공용 헬퍼: folders.js에 정의, 다른 곳에서 재사용 ──
assert_contains public/js/folders.js "function buildFolderSelectOptions(folders, selectedId)" "U14-1a: buildFolderSelectOptions 헬퍼 정의"
assert_contains public/js/folders.js "📂 미분류" "U14-1b: 미분류 기본 옵션"
assert_contains public/js/notes_crud.js "buildFolderSelectOptions(folders, '')" "U14-1c: 단일 모드(promptNoteName)에서 재사용"
assert_contains public/js/batch.js "buildFolderSelectOptions(folders, prevValue)" "U14-1d: 다중 모드 스테이징 select에서 재사용"
assert_contains public/js/batch.js "buildFolderSelectOptions(_batchFoldersCache, item.folderId)" "U14-1e: 다중 모드 큐 카드별 select에서 재사용"

# ── 단일 모드: promptNoteName 모달에 폴더 선택 통합 ──
assert_contains public/js/notes_crud.js "async function promptNoteName(defaultTitle)" "U14-2a: promptNoteName 시그니처 유지"
assert_contains public/js/notes_crud.js "저장 폴더" "U14-2b: 모달에 '저장 폴더' 라벨"
assert_contains public/js/notes_crud.js "resolve({ title, folderId: folderSelect.value || null })" "U14-2c: {title, folderId} 반환"
assert_contains public/js/notes_crud.js "const { title, folderId: chosenFolderId } = await promptNoteName(autoTitle);" "U14-2d: autoSaveNote가 새 반환 형태를 구조분해"

# ── autoSaveNote: 신규 노트는 선택한 폴더로, 기존 노트는 기존 폴더 유지 ──
assert_contains public/js/notes_crud.js "const isNewNote = !currentNoteId;" "U14-3a: 신규/기존 노트 분기"
assert_contains public/js/notes_crud.js "folderId:             isNewNote ? chosenFolderId : (await getNoteFS(currentNoteId))?.folderId ?? null," "U14-3b: 신규=선택폴더, 기존=기존폴더 유지"
assert_contains public/js/notes_crud.js "sortOrder: await getNextSortOrder(chosenFolderId)" "U14-3c: 신규 노트 sortOrder 부여 (moveSavedNote와 동일 방식)"

# ── 다중 모드: 스테이징 폴더 select ──
assert_contains public/index.html 'id="batchFolderSelect"' "U14-4a: 스테이징 영역 저장 폴더 select"
assert_contains public/index.html "저장 폴더" "U14-4b: 스테이징 라벨 '저장 폴더'"
assert_contains public/js/batch.js "async function refreshBatchFolderSelect()" "U14-4c: 스테이징 select 폴더 목록 로드 함수"
assert_contains public/js/batch.js "if (isBatchMode) refreshBatchFolderSelect();" "U14-4d: 다중 모드 진입 시 폴더 목록 갱신"

# ── 다중 모드: 큐 아이템에 folderId 캡처 ──
assert_contains public/js/main_inline.js "folderId: document.getElementById('batchFolderSelect')?.value || null, // U14" "U14-5a: 목록 추가 시 스테이징 select 값을 큐 아이템에 캡처"

# ── 다중 모드: 카드별 select (대기 중일 때만 노출) + 변경 시 아이템 갱신 ──
assert_contains public/js/batch.js "class=\"batch-item-folder-select folder-save-select\" data-item-id=" "U14-6a: 큐 카드별 폴더 select 렌더"
assert_contains public/js/batch.js 'canRemove ? `<div class="batch-item-name-row">' "U14-6b: 이름/폴더 select 모두 canRemove(대기 중)일 때만 렌더"
assert_contains public/js/main_inline.js "if (!e.target.classList.contains('batch-item-folder-select')) return;" "U14-6c: 카드별 select 변경 위임 리스너"
assert_contains public/js/main_inline.js "if (item) item.folderId = e.target.value || null;" "U14-6d: 변경 시 큐 아이템 folderId 갱신"

# ── 다중 모드: 배치 저장 시 item.folderId 사용 (+ sortOrder) ──
assert_contains public/js/main_inline.js "const itemFolderId = item.folderId || null;" "U14-7a: 배치 저장이 null 고정 대신 아이템 folderId 사용"
assert_contains public/js/main_inline.js "folderId: itemFolderId," "U14-7b: saveNoteFS 호출에 folderId 전달"
assert_contains public/js/main_inline.js "sortOrder: await getNextSortOrder(itemFolderId)," "U14-7c: 배치 저장도 sortOrder 부여"

# ── 캐시버스트 (버전 문자열 무관 — 존재만 확인) ──
assert_matches public/index.html "folders\.js\?v=" "U14-8a: folders.js 버전 마커 존재"
assert_matches public/index.html "notes_crud\.js\?v=" "U14-8b: notes_crud.js 버전 마커 존재"
assert_matches public/index.html "batch\.js\?v=" "U14-8c: batch.js 버전 마커 존재"
assert_matches public/index.html "main_inline\.js\?v=" "U14-8d: main_inline.js 버전 마커 존재"
assert_absent public/index.html "v=u13multi" "U14-8e: 옛 캐시버스트 마커(u13multi) 잔존 없음"
