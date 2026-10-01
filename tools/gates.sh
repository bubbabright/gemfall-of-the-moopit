#!/usr/bin/env bash
# Run every gate against a fresh build — the way the game actually ships.
#
#   npm run gates
#
# Rebuilds dist/ and (re)starts the dev preview (tools/poc.sh, port 4771), then runs
# typecheck, selftest, playtest, visual, scaling, pwa and powerups. All of them run even if one
# fails; one table at the end; exit 1 on any FAIL. The preview stays up so Daniel can try the change.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PREVIEW="http://127.0.0.1:${POC_PORT:-4771}"
LOGDIR="/tmp/gemfall-gates"

cd "$ROOT"
mkdir -p "$LOGDIR"

echo "building + starting the dev preview…"
if ! tools/poc.sh restart >"$LOGDIR/preview.log" 2>&1; then
  echo "FAIL: dev preview did not start (see ${LOGDIR}/preview.log)" >&2
  tail -15 "$LOGDIR/preview.log" >&2
  exit 1
fi

results=()
failed=0
run() {
  local name="$1"
  shift
  printf '  %-10s … ' "$name"
  if "$@" >"$LOGDIR/${name}.log" 2>&1; then
    echo "PASS"
    results+=("PASS  ${name}")
  else
    echo "FAIL"
    results+=("FAIL  ${name}   (log: ${LOGDIR}/${name}.log)")
    failed=1
  fi
}

# Order matters: visual reads the screenshots playtest writes to poc/.
run typecheck npm run typecheck
run selftest npm run selftest
run playtest npm run playtest -- "$PREVIEW"
run visual npm run visual
run scaling npm run scaling -- "$PREVIEW"
run pwa npm run pwa -- "$PREVIEW"
run powerups npm run powerups -- "$PREVIEW"

echo
echo "── gates ─────────────────────────────"
printf '%s\n' "${results[@]}"
grep -m1 '^build:' "$LOGDIR/playtest.log" 2>/dev/null
echo
tools/poc.sh status

if [ "$failed" -ne 0 ]; then
  echo "GATES FAIL"
  exit 1
fi
echo "GATES PASS"
