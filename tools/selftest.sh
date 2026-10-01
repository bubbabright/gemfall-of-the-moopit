#!/usr/bin/env bash
# Run the Phaser-free engine self-test (src/core/selftest.ts) in headless Chromium.
#
# The suite imports from /src, so it needs the Vite dev server, not a build.
# It reports its verdict in document.title as selftest-PASS-<n> / selftest-FAIL-<n>.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${SELFTEST_PORT:-4772}"
URL="http://127.0.0.1:${PORT}/selftest.html"
CHROME="${CHROME:-/usr/bin/chromium}"
# How Chromium draws: the same choice as tools/gpu-flags.mjs (keep the two in step).
GPU="${GEMFALL_GPU:-$([ -e /dev/dri ] && echo vulkan || echo off)}"
case "$GPU" in
  vulkan) GPU_FLAGS=(--use-gl=angle --use-angle=vulkan --enable-features=Vulkan) ;;
  swiftshader) GPU_FLAGS=(--use-angle=swiftshader --enable-unsafe-swiftshader) ;;
  off) GPU_FLAGS=(--disable-gpu) ;;
  *) echo "GEMFALL_GPU=$GPU: use vulkan, swiftshader or off" >&2; exit 2 ;;
esac

cd "$ROOT"

started_server=""
cleanup() {
  if [ -n "$started_server" ]; then
    kill "$started_server" 2>/dev/null
  fi
}
trap cleanup EXIT

if ! ss -ltn | grep -q ":${PORT} "; then
  echo "starting vite dev on ${PORT}…"
  # Run vite itself, not `npx vite`: $! must be the server, or the cleanup trap only kills
  # npx and every run leaves an orphaned dev server holding the port.
  "$ROOT/node_modules/.bin/vite" dev --host 127.0.0.1 --port "$PORT" >/tmp/gemfall-selftest-dev.log 2>&1 &
  started_server=$!
  for _ in $(seq 1 30); do
    ss -ltn | grep -q ":${PORT} " && break
    sleep 1
  done
elif ! curl -fsS "$URL" 2>/dev/null | grep -q 'core self-test'; then
  # Something else already owns the port (another project, or a stale server from a moved
  # folder). Reusing it would report "no verdict" and look like a broken engine. Match the
  # page's title, not the status: Vite answers 200 with its own index for any .html path.
  echo "FAIL: port ${PORT} is held by a server that doesn't serve this repo (set SELFTEST_PORT)" >&2
  exit 2
fi

if ! ss -ltn | grep -q ":${PORT} "; then
  echo "FAIL: dev server never came up on ${PORT}" >&2
  exit 2
fi

html="$("$CHROME" --headless --no-sandbox "${GPU_FLAGS[@]}" --disable-dev-shm-usage \
  --virtual-time-budget=20000 --dump-dom "$URL" 2>/dev/null)"

title="$(printf '%s' "$html" | grep -oE 'selftest-(PASS|FAIL)-[0-9]+' | head -1)"
if [ -z "$title" ]; then
  echo "FAIL: self-test page produced no verdict (is chromium at ${CHROME}?)" >&2
  exit 2
fi

printf '%s' "$html" \
  | sed -e 's/<[^>]*>//g' \
  | grep -E '^(ALL PASS|FAILURES|FAIL |#)' | tail -20

case "$title" in
  selftest-PASS-*) echo "SELFTEST $title"; exit 0 ;;
  *)               echo "SELFTEST $title"; exit 1 ;;
esac
