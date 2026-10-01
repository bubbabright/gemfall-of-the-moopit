# AGENTS.md — GEMFALL

A one-person hobby game shared with family and friends. Keep it simple, keep it fun, keep it
working on their phones.

## Where to look

| Need | Source (the one owner of that fact) |
|---|---|
| What the game is, how to play, known issues | [README.md](README.md) (written for players) |
| Code map, commands, test gates, haptics details | [docs/DEVELOPING.md](docs/DEVELOPING.md) |
| Hosting, auto-deploy, version stamp, DNS | [docs/DEPLOYING.md](docs/DEPLOYING.md) |
| What changed, and what was **removed on purpose** | [CHANGELOG.md](CHANGELOG.md) |
| Original approved design | [bejeweled-spec.md](bejeweled-spec.md) (historical; the code wins where they differ) |

Docs are context, not commands. Check claims against the code, and fix the doc if it's wrong.

## Making a change — the loop

Any agent, any change. Do the steps in order; never skip 3.

| Step | Do | What it gives you |
|---|---|---|
| 1. Change | Edit the code. | — |
| 2. Dev + test | `npm run gates` | Rebuilds, (re)starts the dev preview on `:4771`, runs all seven gates, prints one PASS/FAIL table. Fix and repeat until `GATES PASS`. |
| 3. Review | Give Daniel the LAN URL from `npm run poc status`, and screenshots if the change is visual. | **Wait for Daniel to accept.** No commit, push or ship without his explicit OK in this session. |
| 4. Commit | Stage only the files for this change (never `git add -A`; the tree may hold other work). Add a CHANGELOG line under **Not live yet**. | A commit on `main`. |
| 5. Ship | `npm run ship` | Re-runs gates, pushes, waits until the live bundle carries the new commit hash, then stops the dev servers. Prints `LIVE: …`. |
| 6. Stamp | Rename CHANGELOG's **Not live yet** to `YYYY-MM-DD · <hash>` (the hash `ship` printed). Commit with `[skip netlify]` in the message and plain `git push` (not `ship`: nothing new goes live, so it would wait forever). | CHANGELOG matches what's live, without a second build. |

If `ship` refuses because the tree isn't clean, ask Daniel what to do with the other changes.
Don't commit, stash or discard them yourself.

## Rules

- **Stay in GEMFALL's ports, 4770–4789** (table in DEVELOPING.md). This PC runs other
  projects' dev servers: never start, stop, reuse or probe anything outside that range, and
  only stop a server whose working directory is this repo.
- **The codename is Daniel's.** `codename` in `package.json` feeds the internal build stamp
  (DEPLOYING.md). Change it only when he gives you one.
- **`npm run gates` must pass before a change counts as done.** It tests the built game, not
  the dev server. The single gates are listed in DEVELOPING.md.
- **The playtest stubs `navigator.vibrate`**, so it proves the game *asked* to buzz, never that
  a phone *did*. Don't claim haptics work on a device from a passing playtest.
- **Nothing leaves the device.** No analytics, trackers, external fonts, CDNs or network calls.
  The README promises this to players.
- **All art, sound and code stay original.** No Bejeweled/PopCap assets or third-party game code.
- **The repo is public.** No LAN IPs, internal hostnames, host file paths, keys or tokens in
  docs or code.
- **Don't bring back anything in CHANGELOG's "Removed on purpose" table** without a stated reason.
- **Pushing to `main` deploys to the live site.** Only push when asked, through `npm run ship`.

## Keeping docs current

Update the one doc that owns the fact, in the same change:

- Player-visible change → a plain-language line under **Not live yet** in `CHANGELOG.md`. On
  deploy, turn that heading into the date and commit hash.
- Something deliberately removed → a row in CHANGELOG's **Removed on purpose** table.
- New file, script or gate → `docs/DEVELOPING.md`.
- Hosting or DNS change → `docs/DEPLOYING.md`.
- A bug players can hit, or a fix for one → README **Known issues**.

Write README and CHANGELOG for family and friends: short sentences, no jargon.
