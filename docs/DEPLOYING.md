# Deploying GEMFALL

Live at **<https://gemfall.moopit.fun>**, hosted on Netlify (project `moopit-bejeweled`,
free tier). It's a static site: `npm run build` produces `dist/`, and that's the whole thing.

## Ship a change

**Push to `main`.** Netlify builds and publishes it within a few minutes. `npm run ship`
(`tools/ship.sh`) does the whole thing and checks it worked:

1. Refuses unless you're on `main`, the working tree is clean, and HEAD is ahead of
   `origin/main` (and not behind it).
2. Runs `npm run gates` on the committed code; stops without pushing if any gate fails.
3. `git push origin main`.
4. Every 15 s for up to 10 min, fetches the live `index.html` and its JS bundle and looks for
   HEAD's short hash in it. That hash is stamped in from Netlify's `COMMIT_REF`, so a match
   means the new build is what players get.
5. Stops the dev preview and any GEMFALL dev server (only ones whose working directory is this
   repo), then prints `LIVE: … · v<version> · <hash>`.

If the hash never shows up it exits 1 and leaves the dev servers running. Check
`netlify watch` or the Netlify dashboard.

A commit that only touches docs can skip the Netlify build: put `[skip netlify]` anywhere in the
message of the **last** commit in the push. The next push without it deploys everything,
including the skipped commits.

To ship without a commit, or from a dirty tree:

```bash
npm run build
netlify deploy --prod --dir=dist
```

## Check what's live

Every build is stamped with the version from `package.json` and the commit it came from, e.g.
`v0.2.0 · 7d40db0`. `vite.config.ts` reads `COMMIT_REF` (set by Netlify) or `GIT_COMMIT`, and
local builds say `local`. The full stamp adds the release codename and the build time in US
Eastern, to the minute: `v0.2.0 · 42b5b38 · "tulip" · 2026-09-26 03:47 EDT` (EST in winter;
converted when the bundle is built, so everyone sees the same text). It shows at the bottom of
the menu, `window.gemfallVersion` holds it in devtools, and `npm run playtest` and
`npm run gates` print it. The codename is the `codename` field in `package.json`; Daniel picks
it, so change it only when he says. Left empty, it's just omitted.

If a phone still shows the old stamp after a deploy, it's a cached page. Reload it, or close the
tab and reopen it.

Caching (`netlify.toml`): hashed files under `/assets/` are cached forever (`immutable`), and
`index.html`, `sw.js` and `manifest.webmanifest` are `must-revalidate`, so a reload always
picks up a new build.

Installed on a home screen, the game runs through its service worker (see DEVELOPING.md,
"Installable app"). The page itself is fetched network-first, so a new deploy shows up the next
time the game opens with a connection; offline it uses the copy saved with the last build.

## How it's wired

- **Auto-deploy.** Set up with `netlify init --manual`, which skips GitHub OAuth and has you add
  two things to the repo yourself: a read-only SSH **deploy key**, and a **push webhook** to
  `https://api.netlify.com/hooks/github`. Both were added with the `gh` CLI. `--manual` is the
  only scriptable route: Netlify's API can't link a repo, and the GitHub App route needs a
  browser. `netlify init` also needs a real terminal (PTY); piping answers into it fails.
- **DNS.** `gemfall.moopit.fun` is a **DNS-only** (grey cloud) record in Cloudflare. With the
  Cloudflare proxy on, Netlify couldn't issue its TLS certificate, so leave it grey.
- **Dashboard tile.** The game is listed in the **Fun** section of the Dashy dashboard at
  `moopit.fun`. The tile is configured in Dashy, not in this repo:

  ```yaml
  - title: Gemfall
    description: Game
    url: https://gemfall.moopit.fun/
    icon: fas fa-gem
    color: '#c7d2fe'
  ```

  Dashy's `conf.yml` must stay world-readable (`644`). At `600`, the container can't read it
  and Cloudflare shows a 520.
- **Opening it.** Open the game as its own page. Inside another site's frame (an embed, or a
  dashboard modal), Chrome blocks vibration.
