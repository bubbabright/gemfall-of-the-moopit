# What's new in GEMFALL

Newest first. The version stamp at the bottom of the menu tells you which one you have.

## Not live yet

- New loading screen: the colorful GEMFALL logo with gems raining behind it.
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
| `MIN_GAP_MS`, a 45 ms guard that dropped any buzz close to the last one | It silently swallowed the heavier power-gem buzz, so detonations never buzzed | A busy window in `src/haptics.ts`: heavier patterns replace, lighter ones yield |
| 18 ms match buzz, 1 ms `haptics.unlock()` | Too short for any phone motor to feel | `MIN_ON_MS` (40 ms) floor; `haptics.confirm()` (50 ms) |
| Two buzz calls per cascade step (match + detonation) | The second call was always dropped | One `haptics.explosion(depth, heavy)` per step |
| Sizing `#game` by its content | The canvas inflated its own parent, so the board never scaled down | `#game` pinned to the viewport |
