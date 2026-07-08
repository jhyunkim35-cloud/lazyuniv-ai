# 회귀 가드 — U3+U4 학습 도구 확장: 암기/개념 페이지 범위 선택 + 마인드맵 PNG 저장 (2026-07-08)
# univ.ai 갭 대응: 암기/개념 생성에 선택적 페이지 범위(N-M), 마인드맵 이미지 다운로드.

# U3: gating — 범위 컨트롤은 p.인용이 있는 노트에서만
assert_contains public/js/pipeline.js "function notesHasPageCites" "U3-1a: notesHasPageCites 게이팅 함수 존재"
assert_contains public/js/pipeline.js '/(^|[^\w])p\.\d+/.test(storedNotesText' "U3-1b: 게이팅 정규식이 스펙대로 p.N 인용 존재 여부를 검사"
assert_contains public/js/pipeline.js "function buildPageRangeControl" "U3-1c: 범위 입력 컨트롤 빌더 존재"
assert_contains public/js/pipeline.js "tool !== 'mindmap' && notesHasPageCites()" "U3-1d: 마인드맵 탭은 범위 컨트롤 대상 제외"

# U3: uncached 프롬프트 쪽에만 범위 절이 붙고, 캐시 prefix는 그대로
assert_contains public/js/pipeline.js "페이지 인용이 p.\${pageRange.start} ~ p.\${pageRange.end} 범위에 속하는 내용만 다루세요" "U3-2a: 범위 지시문 한국어 문구 존재"
assert_contains public/js/pipeline.js "\`아래 2개 섹션을 정확한 마커로 작성하세요" "U3-2b: 범위 절이 prompt(uncached) 템플릿 리터럴 안에 있음"
assert_contains public/js/pipeline.js "const cachePrefix = buildToolsCachePrefix(stripped);  // Fix 5 (Q3): shared with summary/mindmap/quiz on the same note" "U3-2c: generateStudyAids의 cachePrefix 라인이 U3 이전과 바이트 단위로 동일 (범위 절 미포함)"
assert_absent public/js/pipeline.js "buildToolsCachePrefix(stripped, pageRange" "U3-2d: pageRange가 cachePrefix 빌더로 새지 않음"

# U3: 검증 (start<=end, 양의 정수) — 실패 시 toast 후 중단
assert_contains public/js/pipeline.js "!(start >= 1) || !(end >= 1) || start > end" "U3-3a: 범위 유효성 검증(양의 정수·start<=end)"
assert_contains public/js/pipeline.js "❌ 페이지 범위 형식이 올바르지 않습니다" "U3-3b: 잘못된 범위 입력 시 토스트"

# U3: pageRange 영속화 + 배지
assert_contains public/js/pipeline.js "pageRange: pageRange,  // U3:" "U3-4a: currentStudyTools에 pageRange 필드 저장"
assert_contains public/js/pipeline.js "function renderPageRangeBadge" "U3-4b: 범위 배지 렌더 함수 존재"
assert_contains public/js/pipeline.js "study-tools-range-badge" "U3-4c: 배지 렌더가 renderMemorize/renderConcepts에서 호출"
assert_contains public/index.html ".study-tools-range-badge" "U3-4d: 배지 스타일 정의"
assert_contains public/index.html ".study-tools-range-input" "U3-4e: 범위 입력창 스타일 정의"

# U4: 마인드맵 PNG 다운로드
assert_contains public/js/pipeline.js "🖼 이미지 저장" "U4-1a: 이미지 저장 버튼 라벨 존재"
assert_contains public/js/pipeline.js "function downloadMindmapPng" "U4-1b: downloadMindmapPng 함수 존재"
assert_contains public/js/pipeline.js "downloadMindmapPng(root, root.text)" "U4-1c: renderMindmap이 이미 파싱된 root 트리를 그대로 재사용 (재파싱 없음)"
assert_contains public/js/pipeline.js "canvas.toBlob(blob" "U4-1d: canvas.toBlob으로 PNG blob 생성"
assert_contains public/js/pipeline.js "a.download = \`마인드맵-\${safeTitle}.png\`" "U4-1e: 다운로드 파일명 마커 존재"
assert_contains public/js/pipeline.js "replace(/[\\\\/:*?\"<>|]/g, '')" "U4-1f: 윈도우 금지 문자 제거로 파일명 sanitize"
assert_contains public/js/pipeline.js "URL.revokeObjectURL(url)" "U4-1g: object URL 해제"
assert_contains public/js/pipeline.js "canvas.width = width * 2" "U4-1h: 2x 레티나 스케일 적용"
assert_contains public/js/pipeline.js "documentElement.classList.contains('light')" "U4-1i: 라이트/다크 팔레트 분기가 스펙과 동일한 클래스 체크 사용"

# 캐시버스트 (버전 무관 — 매 라운드 공유 마커가 갱신되므로 특정 리터럴 대신 존재 여부만 확인. U6에서 u34tools → u6srs로 교체됨)
assert_matches public/index.html "pipeline\.js\?v=" "cache-bust: pipeline.js 버전 마커 존재"
assert_absent public/index.html "?v=u2quiz" "cache-bust: 구버전 잔존 없음"
