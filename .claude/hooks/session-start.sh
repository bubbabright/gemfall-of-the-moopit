#!/bin/bash
# Claude Code on the web only: set up a fresh cloud container so `npm run gates` runs.
# Does nothing on Daniel's own PC, which already has all of this.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

# Node packages (install, not ci, so the cached container keeps node_modules between sessions).
npm install --no-audit --no-fund

# The test tools launch `chromium`; the container ships Playwright's copy under another name.
if ! command -v chromium >/dev/null 2>&1; then
  chrome="$(ls -d /opt/pw-browsers/chromium-*/chrome-linux/chrome 2>/dev/null | sort -V | tail -1 || true)"
  if [ -n "$chrome" ]; then
    ln -sf "$chrome" /usr/local/bin/chromium
  fi
fi
# tools/selftest.sh looks for /usr/bin/chromium unless CHROME is set.
if [ ! -e /usr/bin/chromium ] && command -v chromium >/dev/null 2>&1; then
  echo "export CHROME=\"$(command -v chromium)\"" >>"${CLAUDE_ENV_FILE:-/dev/null}"
fi

# Pillow for `npm run visual` and tools/make-icons.py.
python3 -c 'import PIL' 2>/dev/null || pip install -q pillow

# `ss` (iproute2): tools/poc.sh and tools/selftest.sh use it to find their own servers.
if ! command -v ss >/dev/null 2>&1; then
  (apt-get install -y -q iproute2 || (apt-get update -q && apt-get install -y -q iproute2)) >/dev/null 2>&1 ||
    echo "session-start: could not install iproute2 (ss); the dev preview checks will fail" >&2
fi
