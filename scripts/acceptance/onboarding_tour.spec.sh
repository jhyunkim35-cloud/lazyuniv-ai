# R4 — 신규 유저 첫방문 가이드 투어
assert_file public/js/onboarding_tour.js "투어 파일 존재"
assert_contains public/js/onboarding_tour.js "window.startNotyxTour" "재실행 진입점 노출"
assert_contains public/js/onboarding_tour.js "notyx_tour_v1_seen" "1회 표시 플래그"
assert_matches public/index.html "onboarding_tour\.js\?v=" "index.html이 투어 스크립트 로드"
assert_live "/js/onboarding_tour.js" "startNotyxTour" "투어 라이브 배포됨"
