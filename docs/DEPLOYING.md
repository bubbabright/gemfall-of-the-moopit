# Deploying GEMFALL

Live at **<https://gemfall.moopit.fun>**, hosted on Vercel (project `gemfall-of-the-moopit`,
free tier). It's a static site: `npm run build` produces `dist/`, and that's the whole thing.
Netlify hosted it until 2026-09-27 and is retired; it no longer builds.

## Ship a change

**Push to `main`.** Vercel builds and publishes it as the production deployment within a few
minutes. `npm run ship` (`tools/ship.sh`) does the whole thing and checks it worked:

1. Refuses unless you're on `main`, the working tree is clean, and HEAD is ahead of
   `origin/main` (and not behind it).
2. Runs `npm run gates` on the committed code; stops without pushing if any gate fails.
3. `git push origin main`.
4. Every 15 s for up to 10 min, fetches the live `index.html` and its JS bundle and looks for
   HEAD's short hash in it. That hash is stamped in from Vercel's `VERCEL_GIT_COMMIT_SHA`, so a
   match means the new build is what players get.
5. Stops the dev preview and any GEMFALL dev server (only ones whose working directory is this
   repo), then prints `LIVE: … · v<version> · <hash>`.

If the hash never shows up it exits 1 and leaves the dev servers running. Check the deployment
in the Vercel dashboard.

A commit that only touches docs can skip the build: put `[skip deploy]` in the **first line**
of the message of the **last** commit in the push. Only the first line counts, so a commit body
that merely mentions the tag still deploys. `vercel.json`'s `ignoreCommand` sees it and Vercel cancels
that build. The next push without it deploys everything, including the skipped commits.

To ship without a commit, or from a dirty tree (needs the Vercel CLI, logged in):

```bash
npx vercel deploy --prod
```

## Check what's live

Every build is stamped with the version from `package.json` and the commit it came from, e.g.
`v0.2.0 · 7d40db0`. `vite.config.ts` reads `VERCEL_GIT_COMMIT_SHA` (set by Vercel), `COMMIT_REF`
(Netlify's, from before the move) or `GIT_COMMIT`, and
local builds say `local`. The full stamp adds the release codename and the build time in US
Eastern, to the minute: `v0.2.0 · 42b5b38 · "tulip" · 2026-09-26 03:47 EDT` (EST in winter;
converted when the bundle is built, so everyone sees the same text). It shows at the bottom of
the menu, `window.gemfallVersion` holds it in devtools, and `npm run playtest` and
`npm run gates` print it. The codename is the `codename` field in `package.json`; Daniel picks
it, so change it only when he says. Left empty, it's just omitted.

If a phone still shows the old stamp after a deploy, it's a cached page. Reload it, or close the
tab and reopen it.

Caching (`vercel.json`): hashed files under `/assets/` are cached forever (`immutable`), and
`index.html`, `sw.js` and `manifest.webmanifest` are `must-revalidate`, so a reload always
picks up a new build.

Installed on a home screen, the game runs through its service worker (see DEVELOPING.md,
"Installable app"). The page itself is fetched network-first, so a new deploy shows up the next
time the game opens with a connection; offline it uses the copy saved with the last build.

## How it's wired

- **Auto-deploy.** Vercel's GitHub integration: the project imports
  `bubbabright/gemfall-of-the-moopit`, `main` is the production branch, and every other pushed
  branch gets its own preview. `vercel.json` sets the build (`npm ci`, `npm run build` into
  `dist/`), the caching headers and the `[skip deploy]` check.
- **DNS.** `gemfall.moopit.fun` points at Vercel (Settings → Domains in the project). It's a
  **DNS-only** (grey cloud) record in Cloudflare: with the Cloudflare proxy on, the host can't
  issue its TLS certificate, so leave it grey.
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

## Test builds on Vercel

Every branch other than `main` gets a preview URL, over https, so the installable app and
offline play work there (they don't on the plain-http LAN preview). Use one to try a branch on
real phones before it ships.

- **Each push** to a branch gets a preview URL in the Vercel dashboard (and on the branch's
  commits on GitHub). Open it on the phones, add it to the home screen to test the app.
- **A preview is its own site:** its saved games, settings and "What's new seen" are separate
  from `gemfall.moopit.fun`'s, and from every other preview's.
- **From a Claude Code on the web session**, deploying needs `api.vercel.com` and `vercel.com`
  in the environment's allowed domains and a token in `VERCEL_TOKEN`; then
  `npx vercel deploy --token "$VERCEL_TOKEN"` from the repo root.

**Previews are password-protected by default** (Deployment Protection → Vercel Authentication).
Phones then need to be signed in to Vercel to open the link at all. For testing on family
phones, turn it off for previews (project Settings → Deployment Protection). The manifest link
sends credentials, so installing also works on a protected preview when signed in. The live
domain isn't protected.
