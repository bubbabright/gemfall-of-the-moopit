# Developing GEMFALL

How to run it, where things live, and how to check a change before it ships. The approved
game design is in [`bejeweled-spec.md`](../bejeweled-spec.md). The live URL is
`gemfall.moopit.fun`; the spec still says `bejeweled.moopit.fun` from before the rename.

## Run it

Requires Node 20+ (developed on Node 24). `netlify.toml` pins Node 20 for the Netlify build.
The engine is Phaser 4.

In a Claude Code on the web session, `.claude/hooks/session-start.sh` sets the container up
first: `npm install`, a `chromium` command, Pillow and `ss`. It does nothing on a normal PC.

```bash
npm install
npm run dev          # vite dev server on http://localhost:4770
npm run typecheck    # tsc --noEmit
npm run build        # production bundle into dist/
npm run preview      # serve dist/ locally on :4771 (no rebuild)
npm run gates        # rebuild, start the dev preview, run every gate (see "Check a change")
npm run ship         # gates → push → wait until live → stop dev servers (see DEPLOYING.md)
```

### Ports

This PC runs dev servers for other projects too, so GEMFALL keeps to its own range,
**4770–4789**, instead of the tool defaults (Vite's 5173/4173). Vite runs with `strictPort`:
if a port is taken it fails instead of wandering onto someone else's. The scripts only ever
stop servers whose working directory is this repo.

| Port | Used by |
|---|---|
| 4770 | `npm run dev` |
| 4771 | dev preview: `tools/poc.sh`, `npm run preview`, `npm run gates` |
| 4772 | the dev server `selftest` starts and stops for itself |
| 4780–4788 | headless-Chromium debug ports: playtest 4780, probe-input 4781, probe-pointer 4782, probe-hittest 4783, probe-sweep 4784, probe-hittest2 4785, probe-layout 4786, probe-scale 4787, pwa-check 4788 |

### Try it on a phone on the same Wi-Fi

```bash
tools/poc.sh start     # builds dist/, then serves it on 0.0.0.0:4771
tools/poc.sh status    # prints the localhost and LAN URLs to open
tools/poc.sh stop
```

`start` always rebuilds first. `vite preview` serves whatever is in `dist/`, so skipping the
build silently serves stale code — which is how a fixed bug can still look broken.

## Where things live

```
src/
  config.ts          every tunable: grid sizes, gem counts, scoring, cascade multipliers,
                     level targets, hint delays, animation timings, menu layout
  layout.ts          screen-dependent layout: game size, gem size, HUD and button positions,
                     render zoom for sharp text; portrait and landscape (see "Screen layout")
  main.ts            Phaser bootstrap; rebuilds the layout when the phone turns; exposes
                     window.gemfall and window.gemfallLayout for the test tools
  version.ts         build stamp shown on the menu, plus the internal stamp with codename and
                     build time (see DEPLOYING.md)
  sw.template.js     the service worker; vite.config.ts fills in the file list at build time
                     and writes dist/sw.js (see "Installable app")
  haptics.ts         phone vibration (see "Haptics" below)
  wakeLock.ts        keeps the screen on while a run is being played (see "Installable app")
  messages.ts        every player-facing line, in the default voice and the private one
                     (see "Wording and the private voice" below)
  core/              Phaser-free engine: board, specials, score, storage, types
  core/selftest.ts   engine test suite (dev only)
  scenes/            BootScene (texture generation), MenuScene, GameScene
  ui/pill.ts         the rounded button used everywhere (read the hit-area note in it)
  gfx/gems.ts        procedural gem and power-gem textures
  audio/sfx.ts       procedural WebAudio sound effects
public/
  manifest.webmanifest   name, colours and icons for "Add to Home screen"
  icons/             home-screen icons, drawn by tools/make-icons.py
tools/
  selftest.sh        headless engine test runner
  playtest.mjs       browser integration test over the Chrome DevTools Protocol
  analyze-shots.py   offline screenshot checks (Pillow)
  probe-scale.mjs    screen-fit, sharpness, tap and phone-turning test
  pwa-check.mjs      installable, offline, and every request stays on the game's own site
  make-icons.py      draws public/icons/ (Pillow); re-run only when the icon changes
  poc.sh             build and serve on the LAN (the dev preview, :4771)
  gates.sh           npm run gates: fresh build + preview, then all six gates, one verdict
  ship.sh            npm run ship: gates, push, wait until live, stop dev servers
  probe-*.mjs        one-off diagnostics kept for reference; not part of any gate
```

| I want to… | Go to |
|---|---|
| Tweak scoring, speed, board sizes | `src/config.ts` |
| Change match / cascade / special-gem rules | `src/core/` (then `npm run selftest`) |
| Change what's on screen or how it animates | `src/scenes/GameScene.ts` |
| Change the menu | `src/scenes/MenuScene.ts` |
| Change a button's look or hit area | `src/ui/pill.ts` |
| Change what the game says | `src/messages.ts` |

Browser storage keys: `bejeweled.highscores.v1`, `bejeweled.savedrun.v1` and
`bejeweled.settings.v1`. A corrupt or mismatched value is ignored, never a crash.

## Check a change

A change is done when all of these pass. **`npm run gates` runs them all for you** against a
fresh build on the dev preview (`:4771`), keeps going past a failure, prints one table, and
leaves the preview up to try. Logs go to `/tmp/gemfall-gates/`. The individual gates:

```bash
npm run typecheck    # must be clean
npm run selftest     # engine correctness (headless Chromium)
npm run playtest     # integration: real clicks on a real build
npm run visual       # offline pixel checks on the playtest screenshots
npm run scaling      # the board fits every viewport, including phones
npm run pwa          # installable, opens offline, no requests off-site (built game only)
```

`selftest` starts its own dev server on `:4772` and stops it afterwards; if that port is held by
anything that isn't this repo's self-test page, it fails with a message saying so rather than
using it. `playtest` needs a server already running: with no URL it uses the dev server on
`:4770`, so run `npm run dev` in another terminal or pass a URL. `scaling` tests the **live
site** unless you give it a URL.

```bash
npm run playtest -- http://127.0.0.1:4771   # the built game (tools/poc.sh start)
npm run playtest -- http://127.0.0.1:4770   # the dev server (default)
npm run scaling  -- http://127.0.0.1:4771   # scaling against your build, not the live site
```

The dev server and the built game can behave differently, so test the build before shipping.

**`selftest`** runs `selftest.html`, which imports the engine in `src/core/`, in headless
Chromium and reads the verdict out of `document.title`. It covers board generation across 60
seeds, match detection, special-gem creation, detonation chains, gravity and refill, deadlock
detection (cross-checked against brute force), shuffling, storage round-trips and bad input,
scoring, and a 40-turn cascade simulation. It does not touch rendering.

**`playtest`** checks what unit tests can't see:

- menu buttons don't overlap, and no sub-label spills out of its button;
- tapping a button's centre selects *that* button (regression test for a bug where the right
  half of every button was dead and clicks landed one button over);
- the HUD row is evenly spaced;
- a real run of 10 hint-driven moves: score goes up, the move counter goes down, the board stays
  full with one sprite per gem, and there are no console errors;
- at least one move spends 600 ms or more animating (matches and falls are meant to be seen);
- no power gem is stuck half-transparent after falling;
- the explosion asks the phone to vibrate, and every pulse is at least 40 ms long.

It writes `poc/menu.png`, `poc/game-start.png`, `poc/game-played.png` and `poc/geometry.json`
(git-ignored) and prints the build stamp it tested.

**`visual`** reads those screenshots with Pillow and checks what numbers can't: the menu
really draws three separate buttons lined up with their hit boxes, and the board really shows
every cell filled with the right number of gem colours.

**`scaling`** loads the game at seven viewports (tall Androids with and without browser bars,
an iPhone, a small Android, a phone in landscape, a tablet, a short desktop window). At each it
checks the layout `src/layout.ts` picked, that the canvas fits and, where it should, fills the
screen, and the render zoom. On phones and tablets it taps a gem and checks that gem gets
selected. Last, it turns a phone portrait → landscape → portrait mid-run and checks the canvas
fills the screen each time, the run (score and board) carries over and taps still land.
It also guards against an older bug where `#game` sized itself by its own content, so the canvas
inflated its parent and Phaser never scaled down on phones.

**`pwa`** loads the built game at a phone size in headless Chromium, with a real throwaway
profile (Chrome never offers to install from incognito, which is headless's default). It checks
the manifest parses and lists 192, 512 and maskable icons, the service worker takes control after
a reload, Chrome reports no installability errors, the game boots to its menu with the network
switched off, and every request the page and worker made went to the game's own origin. Like
`playtest`, it needs a URL or the dev preview on `:4771`. It also checks that the plain preview
(no `?sw`) registers no service worker, and that starting a game asks for a screen wake lock.

### Installable app

`index.html` links `public/manifest.webmanifest`, so Chrome on Android offers **Add to Home
screen** / **Install app**: a gem icon, full screen with no browser bar (`display: standalone`),
and a `#120b2e` splash that matches the page. There's no orientation lock, so the landscape
layout still works when installed.

The service worker is `src/sw.template.js`. At build time a small Vite plugin in
`vite.config.ts` lists every file in `dist/`, names the cache after a hash of their contents,
and writes `dist/sw.js`. So:

- **Offline:** everything is saved on install, so after one visit the game opens with no signal.
- **Updates:** the page is fetched network-first, so a new deploy shows up on the next launch
  with a connection. A new build means a new `sw.js`, which saves the new files and deletes the
  old copy.
- **Nothing leaves the device:** the worker only answers requests for the game's own origin,
  and only fetches the files the page would load anyway.
- **Only the built game on a real host registers it.** `npm run dev` never does
  (`__SERVICE_WORKER__`, set in `vite.config.ts`), and neither does a preview on `localhost` or
  `127.0.0.1` unless the URL has `?sw`, so a local preview never serves a saved old build.
  Browsers allow service workers only on https or localhost, so the plain-http LAN preview from
  `tools/poc.sh` skips it too. Test offline on the live site or with `npm run pwa`, which opts in
  with `?sw`.

**Screen stays on.** `src/wakeLock.ts` asks for a screen wake lock while a run is being played,
lets go on pause, game over and leaving the game, and asks again when the game comes back to
the foreground (the browser drops it in the background). Browsers that don't support it or
refuse just dim as normal. The PWA gate stubs the API, so it proves the game *asked*, not that a
phone's screen stayed on.

No iPhone-only tags or icons: the players are on Android.

If a phone seems stuck on an old build: open the game once with a connection, close it, and
open it again.

### Screen layout

The game world is 720 logical px wide in portrait. Its height follows the screen (900 to
1600), so a portrait phone is filled top to bottom and gems grow up to 83 px. Desktop and
anything squarer stay 720×900. A phone in landscape (touch screen, at least 1.67:1) gets a
720-tall world instead: board in the middle, HUD on the left, buttons stacked on the right.
The menu is always a 720-wide column; in landscape its camera shrinks it to fit.

The canvas is rendered at the screen's pixel density (up to 2×) and every scene's camera zooms
by the same factor, so scenes keep working in logical px. Board input uses `pointer.worldX/Y`
for that reason: `pointer.x/y` are canvas pixels. Text gets the matching resolution through
`useRenderZoom`, which every scene calls first in `create()`.

When the phone turns, `src/main.ts` waits for the page to settle, re-measures (Phaser's own
handler measures too early and stays one orientation behind), and, if the phone went between
portrait and landscape, restarts the active scene in the new layout. The game scene saves the
run and resumes it, waiting for any falling gems first. On the game-over screen the new layout
waits until the player leaves.

### Headless gotchas

- `requestAnimationFrame` barely ticks in headless Chromium, so the tools drive Phaser's loop
  by hand (`game.loop.step()`) on a synthetic clock.
- `window.blur` fires on load in headless. Auto-pause only kicks in once the game is ready and
  the player has interacted, so a headless load doesn't pause itself immediately.
- Stepping the loop with **no real time between steps** under-drives it: tweens and timers
  advance too little and a move can look stuck. The tween manager runs on the wall clock
  (`Date.now()`), not on the frames you step, so a fast machine can step faster than a tween
  can move. The playtest mixes in real waits, which is why
  it works. When a probe wedges, suspect the probe before the game, and reproduce the problem in
  `tools/playtest.mjs` before calling it a game bug.
- A WebGL canvas can't be read back with `drawImage` in headless Chromium, so visual checks work
  from `Page.captureScreenshot` output analysed offline.

## Wording and the private voice

Every player-facing line the game says lives in [`src/messages.ts`](../src/messages.ts), in
two voices:

- **`plain`** — the default. Byte-for-byte the wording the game has always used, and the
  screenshots and playtest are checked against this build, so don't change it casually.
- **`moopit`** — a private pack of in-jokes. Off unless a player unlocks it.

**Unlocking it:** tap the title on the menu `MOOPIT_TAPS` (7) times, with no more than
`MOOPIT_TAP_WINDOW_MS` between taps. The line under the title changes to `the full moopit` and
the personal lines turn indigo. The title *art* never changes — only the line beneath it does.
The choice is stored as `moopit` in `bejeweled.settings.v1`, so it survives a reload, and
tapping it 7 more times turns it back off.

The voice covers the word under the combo popup, the toasts, the level banner, and the pause
and game-over panels. Keep new personal lines short: the overlay panel is 520 px wide and does
not wrap, and the combo lines are read on a big chain, where they are meant to reassure rather
than hype.

Two rules for that voice. Keep the wording itself in `src/messages.ts`, and keep it out of
`README.md` and the game page — the game is public and the surprise only lands once.

## Art and sound

All art is generated in code. It already follows the art contract in
[spec §7](../bejeweled-spec.md), so real artwork can be dropped in without code changes:

- `assets/gems.png`: 64×64 cells, 7 columns × 4 rows (normal, line blaster, bomb,
  hypercube), frames named `gem_<colour>`, `special_line_<colour>`, `special_bomb_<colour>`,
  `special_hyper`.
- Optional `assets/gems@2x.png` at 128×128 cells for high-DPI screens.
- Sound overrides go in `assets/sfx/*.ogg`, named after the same events as the procedural
  engine. None ship today.

## Haptics

The match explosion vibrates the phone through `navigator.vibrate`, in
[`src/haptics.ts`](../src/haptics.ts).

- **The buzz lands on the burst.** The gems wind up for about 160 ms before they burst. The buzz
  fires from the same tween `onStart` that flashes the gems white, so the two can't drift apart.
  (The match *sound* still plays at the start of the wind-up.)
- **One buzz per cascade step.** A step is either a plain match or a power-gem detonation, never
  both, so the pattern is picked once and gets stronger with cascade depth.
- **Heavier replaces, lighter yields.** Each `navigator.vibrate` call cancels whatever is still
  playing. While a pattern runs, a lighter or equal one is dropped and a heavier one replaces it.
- **Every pulse is at least `MIN_ON_MS` (40 ms).** Phone motors need tens of milliseconds to
  spin up. 40 is a guess, not a measured floor.
- **Refusals are logged.** If `vibrate()` returns `false` (no tap yet, cross-origin iframe), the
  console logs `haptics: navigator.vibrate() was refused by the browser` once.
- **HOLD TO TEST** on the menu calls `haptics.test()`. It bypasses the BUZZ setting and prints
  what the browser answered, so players can check their own phones without devtools.

Browser support: Chrome-based Android browsers only. iOS Safari and desktop browsers have no
`navigator.vibrate`. Firefox for Android (79+) has it but it's a no-op that returns `true`, so
the game can't even tell (bugzil.la/1653318). Chrome blocks it in cross-origin iframes.
