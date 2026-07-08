# 회귀 가드 — U6 암기(cloze) → SRS 복습 큐 연동 (2026-07-08)
# R9 암기 카드(currentStudyTools.memorize)를 opt-in으로 SRS 큐(srs.js)에 밀어넣고,
# 재생성 후 재푸시해도 SM-2 스케줄은 보존한 채 front/back만 갱신되는지, 리뷰 UI가
# cloze 타입을 섹션 카드와 분리 렌더하는지 잠금.

assert_contains public/js/pipeline.js "id: 'memorizeSrsBtn'" "U6-1: renderMemorize 컨트롤 행에 복습 카드로 추가 버튼 존재"
assert_contains public/js/pipeline.js "🔁 복습 카드로 추가" "U6-1: 버튼 라벨 존재"
assert_contains public/js/pipeline.js "function pushMemorizeToSrs" "U6-2: pushMemorizeToSrs 함수 존재"
assert_contains public/js/pipeline.js "_srsPushBusy" "U6-2: 재진입 가드 존재"

assert_contains public/js/pipeline.js "function _clozeFrontBack" "U6-3: cloze → front/back 변환 함수 존재"
assert_contains public/js/pipeline.js "replace(/\{\{(.+?)\}\}/g, '＿＿＿')" "U6-3: front가 {{answer}}를 ＿＿＿로 가림"
assert_contains public/js/pipeline.js "replace(/\{\{(.+?)\}\}/g, '\$1')" "U6-3: back이 중괄호만 벗기고 정답을 노출"

assert_contains public/js/pipeline.js "cardIdFor(folderId, currentNoteId, 'cloze-' + i)" "U6-4: cloze 카드 id가 cardIdFor(...,'cloze-N') 재사용 (재푸시 시 동일 id)"
assert_contains public/js/pipeline.js "await getSrsCard(id)" "U6-4: 기존 카드 존재 여부를 먼저 조회"
assert_contains public/js/pipeline.js "Object.assign({}, existing, { type: 'cloze', folderId, noteId: currentNoteId, front, back })" "U6-4: 기존 카드 발견 시 SM-2 스케줄 필드 보존, front/back만 덮어씀"
assert_contains public/js/pipeline.js "easeFactor: 2.5" "U6-4: 신규 카드는 기존 섹션 카드와 동일한 기본 SM-2 값으로 생성"

assert_contains public/js/pipeline.js "await autoSaveNote();" "U6-5: currentNoteId 없으면 기존 저장 경로(autoSaveNote) 트리거"
assert_contains public/js/pipeline.js "먼저 노트를 저장하세요" "U6-5: 저장 후에도 id가 없으면 저장 요청 토스트"

assert_contains public/js/srs_review.js "card.type === 'cloze'" "U6-6: 리뷰 UI가 카드 타입으로 분기"
assert_contains public/js/srs_review.js "'암기 카드'" "U6-6: cloze 카드 전용 라벨 존재"
assert_contains public/js/srs_review.js "escHtml(card.back)" "U6-6: cloze 뒷면이 escHtml로 이스케이프됨 (모델 생성 텍스트)"

assert_contains public/index.html "?v=u6srs" "U6-7: 캐시버스트 버전 갱신"
assert_absent public/index.html "?v=u34tools" "U6-7: 이전 캐시버스트 버전 잔존 없음"
