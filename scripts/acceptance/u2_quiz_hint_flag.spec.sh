# 회귀 가드 — U2 퀴즈 힌트·플래그 (2026-07-08)
# MCQ/단답형 힌트 버튼, 전 유형 나중에 복습 플래그, 결과화면 표시 문항 섹션,
# note_creation.js critic 모델 라벨 드리프트(Sonnet→Haiku) 수정.

assert_contains public/js/quiz.js '"hint":"정답을 직접 언급하지 않는 단서 한 문장"' "U2-1a: MC/단답형 스키마에 hint 필드 지시문 존재"
assert_contains public/js/quiz.js '"type":"short"' "U2-1b: 단답형 스키마 상수 존재 (hint 삽입 대상 확인)"

assert_contains public/js/quiz.js "type !== 'essay' && q.hint" "U2-2a: 서술형 제외, hint 있는 문항에만 힌트 버튼 렌더 (구 데이터는 hint 없어 자동 스킵)"
assert_contains public/js/quiz.js "qi-hint-btn" "U2-2b: 힌트 버튼 DOM 클래스 존재"
assert_contains public/js/quiz.js "qi-hint-text" "U2-2c: 힌트 텍스트 reveal 영역 존재"
assert_contains public/index.html ".qi-hint-btn" "U2-2d: 힌트 버튼 스타일 정의"
assert_contains public/index.html ".qi-hint-text" "U2-2e: 힌트 텍스트 스타일 정의"

assert_contains public/js/quiz.js "flagged:           []" "U2-3a: ctx.flagged 상태 배열 초기화 (모든 문항 유형 공용)"
assert_contains public/js/quiz.js "qi-flag-btn" "U2-3b: 플래그 토글 버튼 DOM 클래스 존재"
assert_contains public/js/quiz.js "ctx.flagged[idx] = !ctx.flagged[idx]" "U2-3c: 플래그 클릭 시 boolean 토글"
assert_contains public/index.html ".qi-flag-btn" "U2-3d: 플래그 버튼 스타일 정의"

assert_contains public/js/quiz.js "🚩 표시한 문항" "U2-4a: 결과화면에 표시한 문항 섹션 헤더 존재"
assert_contains public/js/quiz.js "flaggedList" "U2-4b: flagged 문항 목록 집계 로직 존재"
assert_contains public/js/quiz.js "flagged: !!ctx.flagged[i]" "U2-4c: 퀴즈 결과 저장 시 flagged 필드 함께 영속화 (partial+final 공통 패턴)"

assert_contains public/js/note_creation.js "(Sonnet 작성 → Haiku 비평 → Haiku 수정)" "U2-5a: 상태 라벨이 실제 critic 모델(Haiku)과 일치"
assert_absent public/js/note_creation.js "Sonnet 작성 → Sonnet 비평" "U2-5b: 잘못된 구(舊) 라벨 제거됨"
