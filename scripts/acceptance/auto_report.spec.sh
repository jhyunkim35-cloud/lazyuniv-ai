# 자동 버그 리포트 (Phase C)
assert_file public/js/error_autoreport.js "error_autoreport.js 존재"
assert_contains public/js/error_autoreport.js "window.reportAutoError" "reportAutoError 노출"
assert_contains public/js/error_autoreport.js "unhandledrejection" "전역 promise 거부 핸들러"
assert_contains public/js/api.js "window.reportAutoError?.('api'" "api.js가 백엔드 에러 자동리포트 훅"
assert_contains public/js/bug_report.js "source: 'manual'" "수동 리포트 source 태그"
assert_matches public/index.html "error_autoreport\.js\?v=" "index.html이 자동리포트 로드"
