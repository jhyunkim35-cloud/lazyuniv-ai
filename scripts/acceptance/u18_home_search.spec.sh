# 회귀 가드 — U18 홈·검색·테마 폴리시 (2026-07-15)
# Fable 재검 goal 라운드 산출물: ①최근 노트 = 전 폴더 최근 4개 ②전역 검색이
# 폴더 스코프를 무시(플랫 결과, 폴더 노트 누락 버그 수정) ③검색 스니펫 하이라이트
# ④검색에 녹취록 포함 ⑤CSS 변수명 미스매치(--surface-2/-3) 금지
# ⑥스플릿 뷰 빈 슬라이드 플레이스홀더.
#
# acceptance.sh 전체 실행과 단독 실행(bash scripts/acceptance/u18_home_search.spec.sh) 지원.

if ! declare -f _pass >/dev/null 2>&1; then
  _u18_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  cd "$_u18_dir/../.." || exit 2
  . scripts/acceptance/_assert.sh
fi

# ── 1) 최근 노트: 전 폴더 최근 4개 (unfiled-only 필터 재유입 금지) ─
assert_contains public/js/home_view.js "notes.slice(0, 4).forEach(note =>" "U18-1a: 최근 노트가 폴더 무관 최근 4개"
assert_absent  public/js/home_view.js "notes.filter(n => !n.folderId).slice(0, 4)" "U18-1b: unfiled-only 최근 필터 제거 유지"

# ── 2) 전역 검색: 폴더 스코프 무시 + 전용 렌더 ─────────────
assert_contains public/js/home_view.js "const isSearch     = !!activeQuery;" "U18-2a: 검색 모드 플래그 존재"
assert_contains public/js/home_view.js "if (isHomeView && !isSearch) {" "U18-2b: 검색 중 폴더 카드 미표시"
assert_contains public/js/home_view.js "검색 결과</span>" "U18-2c: 검색 타이틀 표시"

# ── 3) 매치 스니펫+하이라이트 ───────────────────────────────
assert_contains public/js/home_view.js "function buildSearchSnippet(note, query)" "U18-3a: 스니펫 빌더 존재"
assert_contains public/js/home_view.js "mark class=\"search-hit\"" "U18-3b: 검색어 mark 하이라이트"
assert_contains public/index.html "mark.search-hit" "U18-3c: 하이라이트 CSS 존재"

# ── 4) 검색에 녹취록 포함 ───────────────────────────────────
assert_contains public/js/transcripts_store.js "async function searchTranscriptsFS" "U18-4a: 녹취록 검색 API 존재"
assert_contains public/js/transcripts_store.js "window.searchTranscriptsFS" "U18-4b: searchTranscriptsFS 전역 노출"
assert_contains public/js/home_view.js "function buildTranscriptResultCard" "U18-4c: 녹취록 결과 카드 빌더 존재"
assert_contains public/js/home_view.js "openTranscriptPreview?.(t.id)" "U18-4d: 녹취록 카드 클릭 → 미리보기"

# ── 5) CSS 변수명 미스매치 금지 (다크 모드 흰 카드 사고 재발 방지) ─
_u18_bad=$(grep -l -- "--surface-2\|--surface-3" public/js/*.js 2>/dev/null || true)
if [ -n "$_u18_bad" ]; then
  _fail "U18-5: 미정의 CSS 변수 --surface-2/-3 사용 금지 (앱 정의는 --surface2/3)  (잔존: $(echo "$_u18_bad" | tr '\n' ' '))"
else
  _pass "U18-5: 미정의 CSS 변수 --surface-2/-3 사용 없음"
fi
assert_contains public/index.html "--surface2-rgb:" "U18-5b: --surface2-rgb 정의 존재 (rgba 소비자용)"

# ── 6) 스플릿 뷰 빈 슬라이드 플레이스홀더 ───────────────────
assert_contains public/js/main_inline.js "split-no-slides" "U18-6a: 빈 슬라이드 플레이스홀더 주입"
assert_contains public/index.html ".split-no-slides" "U18-6b: 플레이스홀더 CSS 존재"

# ── 7) Esc 검색 클리어 ──────────────────────────────────────
assert_contains public/js/main_inline.js "if (e.key === 'Escape' && this.value) {" "U18-7: Esc로 검색 클리어"

# ── 7b) 녹취록↔노트 링크 (usedInNoteIds 배선 + 미리보기 칩) ─
assert_contains public/js/note_creation.js "markTranscriptUsedInNote(s.file._transcriptId, currentNoteId)" "U18-7b1: 노트 저장 시 소스 녹취록에 usedInNoteIds 기록"
assert_contains public/js/transcripts_view.js "transcriptPreviewUsedIn" "U18-7b2: 미리보기에 '만든 노트' 칩 컨테이너"
assert_contains public/js/transcripts_view.js "openSavedNote(btn.dataset.noteId)" "U18-7b3: 칩 클릭 → 노트 열기"
assert_contains public/index.html ".usedin-chip" "U18-7b4: 칩 CSS 존재"

# ── 7c) 새 노트 슬롯 '내 녹취록에서 선택' ───────────────────
assert_contains public/js/transcripts_view.js "function buildTranscriptAnalysisFile(t)" "U18-7c1: 공용 분석 파일 빌더 (id/raw 스레딩 단일 출처)"
assert_contains public/js/transcripts_view.js "window.pickSavedTranscriptForSlot = pickSavedTranscriptForSlot;" "U18-7c2: 슬롯 픽커 전역 노출"
assert_contains public/js/pptx_parser.js "window.pickSavedTranscriptForSlot(item.id)" "U18-7c3: 빈 슬롯 버튼 → 픽커 호출"
assert_contains public/index.html ".rec-pick-saved-btn" "U18-7c4: 슬롯 버튼 CSS 존재"

# ── 8) node --check ─────────────────────────────────────────
for _u18_f in public/js/home_view.js public/js/transcripts_store.js public/js/main_inline.js; do
  if node --check "$_u18_f" >/dev/null 2>&1; then
    _pass "U18-8: node --check 통과 ($_u18_f)"
  else
    _fail "U18-8: node --check 실패 ($_u18_f)"
  fi
done

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  echo
  if [ "$AFAIL" -eq 0 ]; then
    echo "✅ u18_home_search ALL GREEN"
    exit 0
  else
    echo "❌ u18_home_search 실패 ${AFAIL}건"
    exit 1
  fi
fi
