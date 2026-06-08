# 하네스 자체 (회귀로 잃지 않게)
assert_file scripts/verify.sh "verify.sh 존재"
assert_file scripts/acceptance.sh "acceptance.sh 존재"
assert_file .githooks/pre-commit "프리커밋 훅 존재"
assert_file .github/workflows/verify.yml "GitHub Actions CI 워크플로 존재"
assert_contains CLAUDE.md "행동 규약" "CLAUDE.md 행동 규약 섹션 유지"
