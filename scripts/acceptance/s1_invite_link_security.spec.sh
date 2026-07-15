# 회귀 가드 — S1 공유 링크 보안 (2026-07-15)
# ① 초대 토큰을 URL 쿼리(?join=)에서 프래그먼트(#join=)로 이동 — 프래그먼트는
#    서버로 전송되지 않으므로 서버/CDN 로그·Referer 헤더 유출 경로 차단.
#    구 ?join= 링크는 파서 폴백으로 하위호환 유지.
# ② 방장 전용 초대 링크 재발급(/api/invite-regen) — 유출 시 킬스위치.

# ── fragment-based link generation (4 sites) ─────────────────────────────
assert_contains public/js/groups.js '/#join=${encodeURIComponent(data.inviteToken)}' "S1-1a: 그룹 생성 결과 링크가 프래그먼트(#join=) 사용"
assert_contains public/js/groups.js '/#join=${encodeURIComponent(groupData.inviteToken)}' "S1-1b: 그룹 페이지 초대 링크가 프래그먼트 사용"
assert_contains public/js/study_rooms.js '/#roomJoin=${encodeURIComponent(data.inviteToken)}' "S1-1c: 룸 생성 결과 링크가 프래그먼트(#roomJoin=) 사용"
assert_contains public/js/study_rooms.js '/#roomJoin=${encodeURIComponent(roomData.inviteToken)}' "S1-1d: 룸 페이지 초대 링크가 프래그먼트 사용"
# no query-param token generation remains anywhere in served code
assert_repo_absent '/?join=${encodeURIComponent' "S1-1e: 쿼리스트링 ?join= 링크 생성 잔존 없음"
assert_repo_absent '/?roomJoin=${encodeURIComponent' "S1-1f: 쿼리스트링 ?roomJoin= 링크 생성 잔존 없음"

# ── fragment-first parsing + legacy query fallback ───────────────────────
assert_contains public/js/main.js "function readInviteParam" "S1-2a: 프래그먼트 우선 초대 파라미터 파서 존재"
assert_contains public/js/main.js "readInviteParam('join')" "S1-2b: 그룹 join 콜백이 파서 사용"
assert_contains public/js/main.js "readInviteParam('roomJoin')" "S1-2c: 룸 join 콜백이 파서 사용"
assert_contains public/js/main.js "window.location.hash.replace" "S1-2d: 해시 파싱 경로 존재"
assert_contains public/js/main.js "return new URLSearchParams(window.location.search).get(name);" "S1-2e: 구 ?join= 링크 하위호환 폴백 유지"
assert_contains public/js/main.js "function stripInviteParam" "S1-2f: 해시+쿼리 양쪽 클린업 헬퍼 존재"
assert_contains public/js/main.js "stripInviteParam('join')" "S1-2g: join 콜백 클린업 배선"
assert_contains public/js/main.js "stripInviteParam('roomJoin')" "S1-2h: roomJoin 콜백 클린업 배선"

# ── invite-regen endpoint (creator-only kill switch) ─────────────────────
assert_file api/invite-regen.js "S1-3a: /api/invite-regen 엔드포인트 파일 존재"
assert_contains api/invite-regen.js "data[target.creatorField] !== user.uid" "S1-3b: 방장(creator) 검증 존재"
assert_contains api/invite-regen.js "data.status !== 'active'" "S1-3c: 보관된 그룹/룸 재발급 차단"
assert_contains api/invite-regen.js "generateInviteToken" "S1-3d: 공용 토큰 생성기 재사용 (동일 엔트로피)"
assert_contains api/invite-regen.js "verifyUser(req)" "S1-3e: Firebase ID 토큰 인증 필수"

# ── regen buttons wired in both UIs ──────────────────────────────────────
assert_contains public/js/groups.js "/api/invite-regen" "S1-4a: 그룹 페이지 재발급 버튼 배선"
assert_contains public/js/study_rooms.js "/api/invite-regen" "S1-4b: 룸 페이지 재발급 버튼 배선"
assert_contains public/js/groups.js "type: 'group', id: groupData.id" "S1-4c: 그룹 재발급 payload 정확"
assert_contains public/js/study_rooms.js "type: 'room', id: roomData.id" "S1-4d: 룸 재발급 payload 정확"

# live: endpoint deployed (405 on GET still serves the function; marker via OPTIONS/POST is
# awkward with curl body-less — reuse the standard 'deployed js' check on index instead)
assert_live "/api/invite-regen" "error" "S1-5: invite-regen 라이브 응답 (JSON error 필드)"
