# 회귀 가드 — Q5 노트 저장 생존성 (2026-07-10)
# 파이프라인 완료 직후 이름/폴더 모달 뜨기 전 즉시 드래프트 저장, 확인 시
# 같은 id로 업데이트(신규 생성 아님), 저장 중 beforeunload 가드가 코드에
# 남아있는지 잠금.

# draft-save-before-prompt ordering: draftSaveNote() awaited BEFORE
# autoSaveNote() (whose promptNoteName modal fires) in the single-note
# completion path.
assert_contains public/js/note_creation.js "await draftSaveNote()" "Q5-1: 파이프라인 완료 직후 draftSaveNote() await 호출"
# ordering: draftSaveNote() await call must appear on an earlier line than the
# autoSaveNote() call (grep -n line numbers compared numerically — plain
# assert_contains can't check ordering, so this one spec does its own check).
if [ "$(grep -n 'await draftSaveNote()' public/js/note_creation.js | head -1 | cut -d: -f1)" -lt \
     "$(grep -n 'autoSaveNote().catch' public/js/note_creation.js | head -1 | cut -d: -f1)" ] 2>/dev/null; then
  _pass "Q5-1b: draftSaveNote()가 autoSaveNote() 모달 호출보다 먼저 실행됨"
else
  _fail "Q5-1b: draftSaveNote()가 autoSaveNote() 모달 호출보다 먼저 실행됨 (줄 순서 확인)"
fi

# shared record helper — no duplicated big record literal between draft and finalize saves
assert_contains public/js/notes_crud.js "function buildNoteSaveFields" "Q5-2: draftSaveNote/autoSaveNote 공유 레코드 필드 헬퍼 존재"
assert_contains public/js/notes_crud.js "buildNoteSaveFields({ title: computeAutoNoteTitle(), folderId: null })" "Q5-2b: draftSaveNote가 공유 헬퍼로 필드 생성"
assert_contains public/js/notes_crud.js "buildNoteSaveFields({" "Q5-2c: autoSaveNote도 공유 헬퍼 사용"
assert_contains public/js/notes_crud.js "function computeAutoNoteTitle" "Q5-2d: 자동 제목 계산도 공유 헬퍼로 추출됨"

# ghost-note guard still present on the draft path
assert_contains public/js/notes_crud.js "storedNotesText.trim()) return; // ghost-note guard" "Q5-3: draftSaveNote에도 빈 노트 저장 가드 존재"

# update-same-id on confirm — draft finalize reuses currentNoteId, not a fresh id
assert_contains public/js/notes_crud.js "_draftSaveNoteId" "Q5-4: 드래프트 노트 id 추적 플래그 존재"
assert_contains public/js/notes_crud.js "isDraftFinalize = !!currentNoteId && currentNoteId === _draftSaveNoteId" "Q5-4b: 드래프트-확정 판별 로직 존재"
assert_contains public/js/notes_crud.js "id: currentNoteId || undefined" "Q5-4c: 확정 저장이 currentNoteId를 그대로 사용(신규 생성 아님)"

# _noteSaveInFlight flag: declared, set around the draft save, wired into beforeunload
assert_contains public/js/constants.js "let _noteSaveInFlight = false;" "Q5-5a: _noteSaveInFlight 플래그 constants.js에 선언"
assert_contains public/js/notes_crud.js "_noteSaveInFlight = true;" "Q5-5b: draftSaveNote 시작 시 플래그 true"
assert_contains public/js/notes_crud.js "_noteSaveInFlight = false;" "Q5-5c: draftSaveNote 종료(성공/실패 모두) 시 플래그 false"
assert_contains public/js/main_inline.js "_noteSaveInFlight" "Q5-5d: beforeunload 조건에 _noteSaveInFlight 포함"
assert_matches public/js/main_inline.js "isRunning \|\| window\.recorderIsActive\?\.\(\) \|\| _noteSaveInFlight" "Q5-5e: beforeunload 가드가 기존 조건(Q1/Q2)에 이어붙여짐"

# cache-bust bumped, version-agnostic (don't hardcode exact old/new string beyond the retired marker)
assert_matches public/index.html "note_creation\.js\?v=" "Q5-6a: note_creation.js 버전 마커 존재"
assert_matches public/index.html "notes_crud\.js\?v=" "Q5-6b: notes_crud.js 버전 마커 존재"
assert_matches public/index.html "constants\.js\?v=" "Q5-6c: constants.js 버전 마커 존재"
assert_matches public/index.html "main_inline\.js\?v=" "Q5-6d: main_inline.js 버전 마커 존재"
assert_absent public/index.html "v=u14folder" "Q5-6e: 옛 캐시버스트 마커(u14folder) 잔존 없음"
