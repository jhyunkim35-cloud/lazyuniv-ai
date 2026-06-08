#!/usr/bin/env bash
# acceptance.sh — feature-level "did the task actually land" checks.
#
# Runs every scripts/acceptance/*.spec.sh against the working tree (and live
# markers with --live). Complements scripts/verify.sh: verify = build is
# technically sound; acceptance = each shipped feature is still wired up.
# Together they form the growing regression net the autonomous loop checks
# before committing.
#
# These are STRUCTURAL checks, not behavioral E2E (see _assert.sh header).
#
# 사용:
#   bash scripts/acceptance.sh          # 구조 검증 (CI·커밋 전)
#   bash scripts/acceptance.sh --live   # + 라이브 마커 (배포 후)

set -u
cd "$(dirname "$0")/.." || exit 2

export ALIVE=0
[ "${1:-}" = "--live" ] && export ALIVE=1
[ "${VERIFY_LIVE:-}" = "1" ] && export ALIVE=1
export PROD="${NOTYX_PROD_URL:-https://notyx.co.kr}"
export AFAIL=0

. scripts/acceptance/_assert.sh

shopt -s nullglob
specs=(scripts/acceptance/*.spec.sh)
if [ "${#specs[@]}" -eq 0 ]; then
  echo "스펙 없음 (scripts/acceptance/*.spec.sh)"; exit 0
fi

for s in "${specs[@]}"; do
  printf '\n── %s ──\n' "$(basename "$s" .spec.sh)"
  # shellcheck disable=SC1090
  . "$s"
done

echo
if [ "$AFAIL" -eq 0 ]; then
  printf '✅ acceptance ALL GREEN (%d개 스펙)\n' "${#specs[@]}"
  exit 0
else
  printf '❌ acceptance 실패 %d건 ↑\n' "$AFAIL"
  exit 1
fi
