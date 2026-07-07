# 회귀 가드 — Q1 노트 파이프라인 안전망 (2026-07-08)
# max_tokens 잘림 감지·이어쓰기, 청크 실패 살리기, 5xx/네트워크 재시도,
# Haiku 전체재작성 가드, 패치 적용 가드, 요약 마커 재시도가 코드에 남아있는지 잠금.
assert_contains public/js/api.js "getLastStopReason" "Q1: stop_reason 조회 함수 존재"
assert_contains public/js/api.js "json.type === 'error'" "Q1: SSE 스트림 error 이벤트가 throw로 처리됨"
assert_contains public/js/api.js "res.status >= 500 && attempt < MAX_RETRIES" "Q1: callClaudeOnce 5xx 재시도"
assert_contains public/js/api.js "response.status >= 500 && attempt < MAX_RETRIES" "Q1: callClaudeStream 5xx 재시도"
assert_contains public/js/api.js "e instanceof TypeError" "Q1: 네트워크 오류(TypeError) 재시도"
assert_contains public/js/pipeline.js "이어쓰기 1회 시도" "Q1: max_tokens 잘림 시 이어쓰기 시도"
assert_contains public/js/pipeline.js "일부 구간 누락" "Q1: 청크 실패 시 살리기(salvage) 마커"
assert_contains public/js/pipeline.js "rewritten.length < notesText.length * 0.8" "Q1: Haiku 전체 재작성 결과 거부 가드(80%)"
assert_contains public/js/pipeline.js "f.old.length < 15" "Q1: 패치 적용 시 짧은 old 텍스트 스킵 가드"
assert_contains public/js/pipeline.js "마커([한줄][핵심][문단][챕터][시험][쉬운])를 반드시 정확히 그대로 출력하세요" "Q1: 요약 마커 파싱 실패 시 재시도"
assert_contains public/js/constants.js "MAX_TOKENS_CRITIQUE   = 8192" "Q1: 비평 토큰 한도 8192로 상향"
