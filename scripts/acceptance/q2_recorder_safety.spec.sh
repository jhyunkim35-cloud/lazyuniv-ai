# 회귀 가드 — Q2 녹음/STT 생존성 (2026-07-08)
# 탭 닫기 경고 확장, 마이크 끊김 감지, 업로드 실패 시 blob 보존,
# STT 폴링 재시도, uploading phase가 모두 그대로 있는지 잠금.
assert_contains public/js/recorder.js "onended" "Q2: track.onended 마이크 끊김 감지 핸들러 존재"
assert_contains public/js/recorder.js "마이크 연결이 끊겨" "Q2: 마이크 끊김 안내 토스트 문구 존재"
assert_contains public/js/recorder.js "lastBlob" "Q2: 업로드 실패 대비 blob 보존 필드(lastBlob) 존재"
assert_contains public/js/recorder.js "pollFailCount" "Q2: STT 폴링 연속 실패 카운터(pollFailCount) 존재"
assert_contains public/js/recorder.js "phase = 'uploading'" "Q2: handleAudioBlob 진입 시 phase를 uploading으로 설정"
assert_contains public/js/main_inline.js "recorderIsActive" "Q2: beforeunload가 recorder 활성 상태(getter)까지 확인"
