#!/usr/bin/env bash
# Ship the committed change: gates → push → wait until it is live → tear down the dev servers.
#
#   npm run ship
#
# Only run this after Daniel has said to ship (AGENTS.md). It refuses unless on main, the
# working tree is clean, and HEAD is ahead of origin/main — so it can only ever push commits
# someone chose to make. "Live" means the bundle at the public URL contains HEAD's short hash
# (vite.config.ts stamps VERCEL_GIT_COMMIT_SHA into it), checked with curl alone.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIVE="https://gemfall.moopit.fun"
WAIT_TRIES=40   # × 15 s = 10 min
# GEMFALL's own dev ports (docs/DEVELOPING.md): npm run dev, selftest's server.
DEV_PORTS=(4770 4772)

cd "$ROOT"

refuse() {
  echo "SHIP REFUSED: $*" >&2
  exit 2
}

[ "$(git branch --show-current)" = "main" ] || refuse "not on main"
[ -z "$(git status --porcelain)" ] ||
  refuse "working tree is not clean — commit only what Daniel accepted, and ask him about the rest"
git fetch -q origin main || refuse "git fetch failed"
behind="$(git rev-list --count HEAD..origin/main)"
ahead="$(git rev-list --count origin/main..HEAD)"
[ "$behind" -eq 0 ] || refuse "origin/main has ${behind} commit(s) this branch doesn't; pull first"
[ "$ahead" -gt 0 ] || refuse "nothing to ship: HEAD is already on origin/main"

hash="$(git rev-parse HEAD | cut -c1-7)"
echo "shipping ${ahead} commit(s), HEAD ${hash}"

if ! tools/gates.sh; then
  echo "SHIP STOPPED: gates failed, nothing pushed" >&2
  exit 1
fi

git push origin main || { echo "FAIL: git push failed" >&2; exit 1; }

live_has_hash() {
  local asset
  asset="$(curl -fsS "${LIVE}/?ship=$(date +%s)" | grep -oE 'assets/[^"]+\.js' | head -1)"
  [ -n "$asset" ] && curl -fsS "${LIVE}/${asset}" | grep -q "\"${hash}\""
}

echo "pushed; waiting for Vercel to publish ${hash} at ${LIVE} (up to 10 min)…"
live=0
for _ in $(seq 1 "$WAIT_TRIES"); do
  if live_has_hash; then
    live=1
    break
  fi
  sleep 15
done
if [ "$live" -ne 1 ]; then
  echo "FAIL: ${hash} still not live after 10 min. Dev servers left up. Check the deployment" >&2
  echo "      in the Vercel dashboard (project gemfall-of-the-moopit)." >&2
  exit 1
fi

# Tear down dev: the preview, plus any dev server this repo started. Other projects' servers
# on this PC are never touched — a listener only goes if its cwd is this repo.
tools/poc.sh stop
for port in "${DEV_PORTS[@]}"; do
  pid="$(ss -ltnp 2>/dev/null | grep ":${port} " | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2)"
  if [ -n "$pid" ] && [ "$(readlink "/proc/${pid}/cwd" 2>/dev/null)" = "$ROOT" ]; then
    kill "$pid" 2>/dev/null && echo "stopped dev server pid ${pid} on port ${port}"
  fi
done

echo "LIVE: ${LIVE}/ · v$(node -p "require('./package.json').version") · ${hash}"
