# 결제 웹훅 폴백 + 공유 grant 모듈 (charged-but-no-plan 방지)
assert_file api/_grant.js "_grant 공유 fulfillment 모듈 존재"
assert_file api/toss-webhook.js "Toss 웹훅 핸들러 존재"
assert_contains api/_grant.js "paymentLog" "grant 멱등성 paymentLog 가드"
assert_contains api/toss.js "grantEntitlement" "confirm 플로우가 공유 grant 사용"
assert_contains api/toss-webhook.js "customerKey" "웹훅이 uid를 customerKey에서 복원"
assert_contains api/toss-webhook.js "api.tosspayments.com/v1/payments" "웹훅이 Toss 재조회로 권위 검증"
assert_contains api/toss-webhook.js "status !== 'DONE'" "웹훅은 DONE 상태만 지급"
