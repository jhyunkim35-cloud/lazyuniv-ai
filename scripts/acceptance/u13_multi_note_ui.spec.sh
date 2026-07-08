# 회귀 가드 — U13 다중 노트 UI (2026-07-09)
# '배치 모드' 개발자 용어를 학생이 바로 이해하는 '다중 노트'로 리브랜딩.
# 모드 토글·스테이징 라벨·큐 안내문·시작 버튼을 한 번에 이해되게, 로직은 그대로.

# ── 모드 토글: '다중 노트'로 리네이밍 (기능 자체 id/class는 유지) ──
assert_contains public/index.html 'id="modeBatch"><i data-lucide="layers" class="icon-sm"></i> 다중 노트' "U13-1a: 다중 노트 모드 버튼 (layers 아이콘)"
assert_contains public/index.html 'id="modeSingle"><i data-lucide="target" class="icon-sm"></i> 노트 1개' "U13-1b: 단일 모드 → 노트 1개"

# ── 개발자 용어(배치 모드/쌍 추가) 사용자 노출 문구 잔존 없음 ──
assert_absent public/index.html "배치 모드" "U13-2a: index.html에 '배치 모드' 문구 없음"
assert_absent public/index.html "쌍 추가하기" "U13-2b: index.html에 '쌍 추가하기' 문구 없음"
assert_absent public/index.html "아직 추가된 쌍이 없습니다" "U13-2c: 옛 큐 empty 문구 없음"
assert_absent public/js/batch.js "아직 추가된 쌍이 없습니다" "U13-2d: batch.js 렌더 문구도 교체됨"
assert_repo_absent "배치 처리 시작" "U13-2e: '배치 처리 시작' 전체 저장소에서 제거"

# ── 단계 번호 라벨 (위→아래로 읽히는 흐름) ──
assert_contains public/index.html "① 강의 자료" "U13-3a: 1단계 강의 자료 라벨"
assert_contains public/index.html "② 녹취록 (선택사항)" "U13-3b: 2단계 녹취록 라벨"
assert_contains public/index.html "③ ＋ 목록에 추가" "U13-3c: 3단계 목록 추가 버튼"

# ── 큐 헤더 + 안내문 ──
assert_contains public/index.html "만들 노트 목록" "U13-4a: 큐 헤더 라벨"
assert_contains public/index.html "위에서 자료를 고르고" "U13-4b: 큐 empty 안내문 (index.html 초기 마크업)"
assert_contains public/js/batch.js "위에서 자료를 고르고" "U13-4c: 큐 empty 안내문 (renderBatchQueue 동적 렌더)"

# ── 시작 버튼: 동적 라벨 (N=0 기본값 + N>0 카운트) ──
assert_contains public/index.html "🚀 한번에 만들기" "U13-5a: 시작 버튼 기본(N=0) 라벨"
assert_contains public/js/batch.js "노트 \${waiting}개 한번에 만들기" "U13-5b: checkBatchReady가 큐 길이로 동적 라벨 갱신"
assert_contains public/js/batch.js "btn.textContent = waiting > 0" "U13-5c: 동적 라벨 분기 로직 존재"

# ── 취소 버튼 단순화 ──
assert_contains public/index.html 'id="batchCancelBtn"><i data-lucide="x" class="icon-xs"></i> 취소' "U13-6: 배치 취소 → 취소"

# ── 다중 노트 리브랜딩: 토스트/로그 문구 ──
assert_contains public/js/batch.js "다중 노트 완료 — \${total - failed}개 노트 생성됨" "U13-7a: 완료 토스트"
assert_contains public/js/main_inline.js "다중 노트를 취소했습니다" "U13-7b: 취소 agentLog"
assert_contains public/js/main_inline.js "다중 노트를 중단합니다" "U13-7c: 한도초과 중단 토스트"
assert_contains public/js/main_inline.js "다중 노트가 취소되었습니다" "U13-7d: abort 취소 토스트"

# ── 섹션 서브타이틀 ──
assert_contains public/index.html "다중 노트 — 여러 자료를 한 번에 노트로" "U13-8: batchSection 상단 안내 서브타이틀"

# ── 큐 플래시 하이라이트 (추가 시 어디로 갔는지 시각적으로 보여줌) ──
assert_contains public/index.html ".batch-queue.flash-highlight { animation: batch-queue-flash" "U13-9a: 큐 flash CSS 애니메이션"
assert_contains public/js/main_inline.js "queueEl.classList.add('flash-highlight')" "U13-9b: 목록 추가 시 flash 클래스 트리거"

# ── 캐시버스트 (버전 문자열 무관 — 존재만 확인) ──
assert_matches public/index.html "batch\.js\?v=" "U13-10a: batch.js 버전 마커 존재"
assert_matches public/index.html "main_inline\.js\?v=" "U13-10b: main_inline.js 버전 마커 존재"
assert_absent public/index.html "v=u10bgate" "U13-10c: 옛 캐시버스트 마커(u10bgate) 잔존 없음"
