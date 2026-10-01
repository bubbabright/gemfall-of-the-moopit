# What's new in GEMFALL

Newest first. The version stamp at the bottom of the menu tells you which one you have.

## 2026-10-01 · 5e19713

- Settings has a **What's new** button, to read this version's changes again any time.
- The game now lives on Vercel instead of Netlify. Same address, nothing to do.

## 2026-10-01 · 8790ba5

- **Endless:** every level up now earns you an extra shuffle, so a good game lasts longer.
- The level's progress (like "1,200 / 2,500 pts") now sits right next to **LEVEL**, so it no
  longer looks like part of the shuffles count.
- After an update, the first time you open the game it shows a short **What's new** list.
  Brand-new players don't get it, since everything is new to them.
- The GitHub link under the version line now opens the full list of changes.
- The version line at the bottom of the menu is bigger and easier to read, with a link to the
  game's code on GitHub under it.
- The menu says **No best yet** instead of "No score yet" before you've finished a game in
  that mode, so it no longer seems to argue with a paused game's points.
- Fixed: going back to the menu, picking another mode and tapping **RESUME RUN** brought back
  the old game with its points. Each mode and difficulty now keeps its own unfinished game, and
  RESUME only shows for the one you've picked. **PLAY NOW** always starts from zero.
- New opening screen: the colorful GEMFALL logo with gems raining behind it. After a moment
  the logo slides up and the menu appears under it: a card with its own gem for each mode,
  small buttons for the difficulty, and a big **PLAY NOW**. The gems keep falling behind.
- Two buttons in the top corners, on the menu and in a game. The **speaker** mutes everything
  (a red slash shows it's muted). The **gear** opens settings: sound effects and music, each on
  or off, phone buzz and a test buzz, and how long messages stay up.
- New: quiet background music, made by the game like the sound effects. Turn it off in
  settings.
- Made for phone screens that show true black: darker backgrounds, no haze, and every bit of
  text bigger and easier to read.
- You can add GEMFALL to your phone's home screen. It gets its own gem icon, opens full screen
  without the browser bar, and works with no signal once you've played it. An **Install app**
  button shows on the menu when your phone can install it. The screen stays on
  while you play. How-to is in the
  [README](README.md#put-it-on-your-home-screen).
- Under the hood, the game now runs on Phaser 4, a newer version of the engine it's built on.
  It should look and play the same.
- The version line at the bottom of the menu now also shows the release name and when it was
  built (Eastern time).
- On a phone held upright, the game now fills the whole screen instead of sitting in a box in
  the middle. The gems are bigger and the buttons at the bottom are easier to hit.
- Text and gems are sharper on phones.
- Turn your phone sideways and the score moves to the left, the buttons to the right, and the
  board stays in the middle. Your game carries on where it was.
- Fixed: turning the phone sideways and back could leave the game tiny in the middle of the
  screen.

## 2026-09-26 · `42b5b38`

- **HOLD TO TEST** button on the menu: hold it to check whether your phone can buzz. The line at
  the bottom of the menu shows what your browser said.
- New docs: a friendlier README, plus [developing](docs/DEVELOPING.md) and
  [deploying](docs/DEPLOYING.md) guides.
- There's a hidden surprise on the menu. If you know where to tap, the game starts speaking a
  language meant for one particular player. (The how is in
  [developing](docs/DEVELOPING.md), not here.)
- The little messages over the board are easier to read: a rounder, bolder font, a dark outline,
  and a bubble behind them. They pop in and stay up long enough to read.
- New **MSG** button on the menu sets how long messages stay on screen, level-up included:
  1.5, 3, 5 or 8 seconds. Tap it to step through them. The game remembers your pick.

## 2026-09-24 · `7d40db0`

- Phone buzz is stronger. The old buzz was too short (18 ms) for most phone motors to feel.
- Turning **BUZZ** on now gives a short buzz so you know it's on.
- Found out Firefox on Android can't vibrate at all. It pretends to, but nothing happens.

## 2026-09-24 · `2227d8f`

- Your phone buzzes when gems explode, harder for power gems and longer chains. There's a
  **BUZZ** on/off button next to **SOUND**.
- Fixed power gems sometimes getting stuck big and see-through after falling.

## 2026-09-24 · `aaec265`

- Fixed the board not fitting on phones and in short browser windows.
- The menu shows which version you're running.

## 2026-09-24 · `d07b4a8` and `78c27df`

- GEMFALL moved online at **gemfall.moopit.fun**, with a tile on the moopit.fun dashboard.

## 2026-09-24 · `2a1bd2f`

- Matches actually explode now: the gems wind up, flash, and burst with sparks. Falling gems
  drop with gravity and squash when they land.

## 2026-09-24 · `125e9eb`

- First playable version: three modes (Endless, Timed, Moves), three difficulties, chain
  reactions, and all three power gems. All art and sound made in code.

---

## Removed on purpose

Don't bring these back without a good reason.

| What | Why it went | Replaced by |
|---|---|---|
| Netlify hosting and `netlify.toml` | Daniel moved the site to Vercel | Vercel, set up by `vercel.json` (docs/DEPLOYING.md) |
| `MIN_GAP_MS`, a 45 ms guard that dropped any buzz close to the last one | It silently swallowed the heavier power-gem buzz, so detonations never buzzed | A busy window in `src/haptics.ts`: heavier patterns replace, lighter ones yield |
| 18 ms match buzz, 1 ms `haptics.unlock()` | Too short for any phone motor to feel | `MIN_ON_MS` (40 ms) floor; `haptics.confirm()` (50 ms) |
| Two buzz calls per cascade step (match + detonation) | The second call was always dropped | One `haptics.explosion(depth, heavy)` per step |
| Sizing `#game` by its content | The canvas inflated its own parent, so the board never scaled down | `#game` pinned to the viewport |
| The Phaser-drawn menu (`MenuScene` buttons, the plain GEMFALL title) | Couldn't match the splash design, or grow out of the splash | The HTML front screen, `src/ui/front.ts` |
| MSG, HOLD TO TEST, BUZZ and SOUND on the menu; SOUND in the game's button row | Too many buttons on both screens (issue #3) | The speaker and gear in the top corners, `src/ui/corners.ts` and `src/ui/settings.ts` |
| The keyboard hint lines under the menu | Not in the splash design | The keys still work; README lists them |
| The violet page gradient, the aurora glow and blurred gem glows | Read as muddy haze on an AMOLED phone | True black with one soft glow (see DEVELOPING, "Readability on the phone") |
