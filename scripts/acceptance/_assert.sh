# acceptance assertion helpers — sourced by scripts/acceptance.sh and specs.
#
# Specs are flat lists of assert_* calls (no logic), so they read like a
# checklist. Each helper prints ✅/❌ and bumps $AFAIL on failure. These are
# STRUCTURAL/STATIC checks (does the wiring exist) + optional live markers —
# NOT behavioral E2E. They catch the failure classes we've actually hit:
# a renamed function with a stale caller, a missing CSS rule, a script
# referenced in index.html but not deployed.
#
# Vars (set by the runner): AFAIL, PROD, ALIVE (1 when --live).

: "${AFAIL:=0}"
: "${PROD:=https://notyx.co.kr}"
: "${ALIVE:=0}"

_pass() { printf '  ✅ %s\n' "$1"; }
_fail() { AFAIL=$((AFAIL + 1)); printf '  ❌ %s\n' "$1"; }

# file contains a LITERAL string
assert_contains() { # FILE STR MSG
  if grep -Fq -- "$2" "$1" 2>/dev/null; then _pass "$3"; else _fail "$3  (없음: '$2' in $1)"; fi
}

# file matches an ERE regex
assert_matches() { # FILE REGEX MSG
  if grep -Eq -- "$2" "$1" 2>/dev/null; then _pass "$3"; else _fail "$3  (매치 없음: /$2/ in $1)"; fi
}

# file does NOT contain a literal string
assert_absent() { # FILE STR MSG
  if grep -Fq -- "$2" "$1" 2>/dev/null; then _fail "$3  (발견됨: '$2' in $1)"; else _pass "$3"; fi
}

# NO ACTIVE source contains the literal string (removed/renamed symbol).
# Scoped to served code (public/js, live index.html, api) so dead snapshots
# like index_backup_*.html cannot cause false positives.
assert_repo_absent() { # STR MSG
  local hits
  hits=$(LC_ALL=C git grep -lF -e "$1" -- public/js public/index.html api 2>/dev/null || true)
  if [ -n "$hits" ]; then _fail "$2  (잔존: $(echo "$hits" | tr '\n' ' '))"; else _pass "$2"; fi
}

# a file exists
assert_file() { # PATH MSG
  if [ -f "$1" ]; then _pass "$2"; else _fail "$2  (파일 없음: $1)"; fi
}

# live: URL (or PROD-relative path) returns a body containing the marker.
# Skipped unless ALIVE=1, so CI (structural-only) ignores deploy timing.
assert_live() { # PATH_OR_URL MARKER MSG
  [ "$ALIVE" = "1" ] || return 0
  local url="$1"
  case "$1" in http*) ;; *) url="$PROD$1" ;; esac
  local body
  body=$(curl -s "$url?cb=$RANDOM" 2>/dev/null)
  if printf '%s' "$body" | grep -Fq -- "$2"; then _pass "$3  (live)"; else _fail "$3  (live: '$2' 없음 @ $url)"; fi
}
