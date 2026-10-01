# SPEC — moopit-bejeweled (Bejeweled-like match-3, Phaser 3)

- **Status:** approved (interview complete) · POC in progress on laptop
- **Date:** 2026-09-24
- **Project dir:** `moopit-fun-dashboard/moopit-bejeweled`
- **Parent context:** `moopit-fun-dashboard` (Dashy at `https://moopit.fun`, see `../PLAN-dashy-public-deploy.md`)
- **Source material:** `duck.ai_2026-09-24_03-11-46.txt` (two AI-generated prototypes, used as reference only)

## 1. Goal

Build an original, polished, browser-based match-3 game ("Bejeweled-like") from scratch and
deploy it as a public static site, reachable at **`https://bejeweled.moopit.fun`** and listed in
the **Fun** section of the `moopit.fun` Dashy dashboard next to Thriller / Tetris / Snake.

**No PopCap code or assets.** Game mechanics are not copyrightable; all art, audio and code here
are original (procedurally generated or CC0).

Immediate milestone (this task): **a playable, good-looking POC served on the laptop.**
Deployment to Netlify is the follow-on step (spec'd in §9, not executed yet).

## 2. Decisions from interview

| # | Topic | Decision |
|---|---|---|
| 1 | Hosting | **Netlify** (free tier: 100 GB bandwidth, 300 build min; git-push auto-deploy) |
| 2 | Public URL | **`bejeweled.moopit.fun`** + add a tile to Dashy's **Fun** section |
| 3 | Engine | **Phaser 3** (npm, bundled); reference CDN prototype noted but not used verbatim |
| 4 | Deploy flow | **Git-push auto-deploy** (Netlify Git integration). *POC runs locally for now.* |
| 5 | Game modes | **Multiple selectable modes** (Endless + Timed + Moves) |
| 6 | Special gems | **Full Bejeweled set**: line blaster (4), bomb (L/T), hypercube (5) |
| 7 | Board | **Configurable difficulty presets** (grid size + gem count) |
| 8 | Gem art | **Spec'd for art supplied later** → sprite-sheet contract (§7); procedural art now |
| 9 | Scoring | **Tunable config** — cascade multiplier + speed bonus + level targets (§5.5) |
| 10 | Audio | **Procedural WebAudio SFX** (no audio files; pitch rises on cascades) |
| 11 | Controls | **All three**: tap-tap, drag/swipe, keyboard (arrows + Enter) |
| 12 | Scores | **localStorage**: high scores per mode/difficulty **+ resume in-progress run** |
| 13 | Deadlocks | **Auto-shuffle + hint system + reject invalid swaps** (no move consumed) |
| 14 | A11y | **Reduced-motion support**; UI must be **big on screen** (large, legible, touch-friendly) |
| 15 | POC host | **Laptop** (local server), later Netlify |

Deliberate non-decisions / judgement calls recorded in §11.

## 3. Scope

### In scope (POC + shipment)
- 8×8 (and preset) match-3 board, swap adjacent gems, gravity, refill, cascades.
- Special gems: **line blaster**, **bomb**, **hypercube** — creation *and* detonation chains.
- Three modes: **Endless**, **Timed (60s)**, **Moves (30)**.
- Three difficulty presets: **Easy 6×6/5**, **Normal 8×8/6**, **Hard 8×8/7**.
- Cascading combo multiplier, score popups, level/score targets (Endless/Moves).
- Hint button + auto-hint after idle; auto-shuffle on deadlock with "no more moves" notice.
- Invalid swap: shake + revert, no move consumed.
- HUD: score, moves/time, combo meter, pause, hint, mute, restart.
- Menus: mode + difficulty picker, high-score table, resume saved run.
- Persistence: high scores per mode/difficulty + resumable game state (localStorage).
- Procedural SFX (WebAudio) with mute persisted; no autoplay before first interaction.
- Accessibility: reduced motion, unique shape per gem colour, keyboard play, pause on blur.
- Original procedural gem art (crisp at all sizes) + documented sprite-sheet contract.
- Netlify config (`netlify.toml`), README with local + deploy instructions.

### Out of scope (explicitly)
- Cloud/shared leaderboard (needs a backend; localStorage only for now). **Deferred.**
- Accounts, login, multiplayer, social sharing.
- Monetisation, ads, IAP.
- Native mobile builds / app stores.
- Custom music track (procedural SFX only).

## 4. Architecture

```
Vite (build) + TypeScript (typecheck) + Phaser 3 (render/input/tween/audio plumbing)
        │
        ├── src/config.ts        ← ALL tunables (difficulty, gems, scoring, timings, palette)
        ├── src/core/            ← pure logic, no Phaser dependency, unit-testable
        │     board.ts           ← grid model, gravity, refill, deadlock detect, shuffle, hint
        │     match.ts           ← run detection, group/cross detection, special creation
        │     specials.ts        ← special activation + detonation graph expansion
        │     cascade.ts         ← clear → score → drop → refill loop
        │     score.ts           ← scoring model (per-gem, multiplier, speed bonus)
        │     storage.ts         ← localStorage: high scores, saved run, settings
        │     types.ts
        ├── src/gfx/gems.ts      ← procedural gem/special textures + sprite-sheet-compatible layout
        ├── src/audio/sfx.ts     ← procedural WebAudio SFX engine
        └── src/scenes/          ← BootScene, MenuScene, GameScene, GameOverScene (+ HUD in Game)
```

**Why this shape:** logic lives in `src/core/` with zero Phaser imports, so cascade/special
rules can be unit-tested headlessly and re-skinned without touching the renderer. Scenes own only
input, tweens and presentation.

### Build / tooling
- `vite` + `typescript`, `phaser` from npm (bundled output, no CDN at runtime).
- Scripts: `npm run dev` (local POC), `npm run build`, `npm run preview`, `npm run typecheck`.
- Output: `dist/` (static, ~1.4 MB total incl. Phaser).

### Rendering approach
- Fixed logical canvas, `Phaser.Scale.FIT` + `CENTER_BOTH` → scales to any screen (large, per a11y
  decision #14). Transparent canvas over a CSS gradient background.
- Each cell is a `Phaser.GameObjects.Sprite` (not a redrawn `Graphics`), so fall/swap/spawn
  tweens are natural and cheap.
- Board sits on a rounded, glassy panel with cell slots, frame glow, and a vignette.

## 5. Game design

### 5.1 Modes
| Mode | Loop | End condition |
|---|---|---|
| **Endless** | Score chase, level targets increase | No moves left (after auto-shuffle fails) |
| **Timed** | 60-second sprint | Timer reaches 0 |
| **Moves** | 30 moves | Moves reach 0 |

Mode + difficulty are chosen on the menu and are independent (e.g. Timed × Hard is valid).
High scores are tracked per (mode, difficulty) pair — 9 buckets.

### 5.2 Difficulty presets (config-driven)
| Preset | Grid | Gem colours | Notes |
|---|---|---|---|
| Easy | 6×6 | 5 | Forgiving, quick cascades |
| Normal | 8×8 | 6 | Default; matches prototype proportions |
| Hard | 8×8 | 7 | Fewer accidental matches, more deadlocks |

Board is always centred on a fixed 72 px tile grid, so a 6×6 board is a smaller, centred board.

### 5.3 Match rules
- A match is **3+ same-colour gems** in an orthogonal line (horizontal or vertical).
- Runs may overlap; overlapping runs form a **group** (union of connected cells).
- Board generation and refill must never create a pre-existing match at rest (initial board is
  match-free; post-cascade resolution handles anything refill creates).
- Minimum viable swap: exactly one orthogonal neighbour; diagonal swaps ignored.

### 5.4 Special gems (full Bejeweled set)
| Created by | Gem | Effect when detonated |
|---|---|---|
| Straight run of **4** | **Line blaster** (horizontal run → clears its row; vertical run → clears its column) | Clears the entire row or column |
| **L / T shape** (cell in both a horizontal and vertical run ≥3, group ≥5) | **Bomb** | Clears the 3×3 neighbourhood |
| Straight run of **5+** | **Hypercube** (colourless) | When swapped with a gem: clears every gem of that colour. When caught in a blast: clears the most common colour |
| Two specials swapped together | Combo | Both detonate, chained (§5.6) |

- Specials are created **at the swap origin cell** when possible (feels causal), otherwise at the
  run intersection / middle of the run.
- A special that is part of a cleared match **detonates** rather than simply vanishing.
- Hypercube is created colourless (rendered as a prismatic multi-colour gem).

### 5.5 Scoring (all values in `src/config.ts`)
```
gemBase            = 10        // per gem cleared
cascadeMultiplier  = 1 + 0.5·(cascadeDepth − 1)   capped at config.maxMultiplier (8)
specialBonus       = { line: 60, bomb: 100, hyper: 150 }
speedBonus         = clamp(round((gemBase·gemsCleared)/timeSinceLastMove), 0, speedBonusCap)
levelTarget(n)     = baseTarget · growth^(n−1)     // Endless / Moves progression
```
- `score = ceil(gemsCleared · gemBase · cascadeMultiplierBasis) + specialBonus + speedBonus`
- Popups show `+N` and `×M` per cascade step, colour-coded by multiplier tier.
- Timed mode still shows level targets (progression feedback) but does not end on them.

### 5.6 Cascade resolution
1. Player swaps → validate (must produce a match or involve a hypercube).
2. Input locks (`busy`), swap tween plays.
3. Loop while matches exist:
   a. detect runs → groups → determine specials to create;
   b. collect cleared cells, expand detonations via specials (BFS/queue, deduped);
   c. score this step with the current multiplier, emit popups + particles + SFX (pitch up per step);
   d. remove, apply gravity, refill from above the board;
   e. increment cascade depth, repeat.
4. Unlock input; check level target, deadlock, and mode end condition.

### 5.7 Deadlock, hints, invalid swaps
- **Invalid swap:** if the swap yields no match and neither gem is a hypercube → tween back,
  shake both gems, play a "nope" SFX, show a brief toast. **No move consumed.**
- **Hint:** hint button pulses a valid move; auto-hint after `hintDelayMs` (10 s) of inactivity.
  Hint validity is computed by `findValidMove()` (brute-force neighbour-swap simulation).
- **Deadlock:** after the board settles, if `findValidMove()` returns null → banner "No more
  moves — shuffling", auto-shuffle (existing gems only, no new matches, must produce a valid
  move) with a shuffle animation. If shuffling repeatedly fails, regenerate the board.
  Shuffles are free (do not consume a move) and are counted in the run state.

### 5.8 Persistence (localStorage keys)
| Key | Contents |
|---|---|
| `bejeweled.highscores.v1` | map of `mode:difficulty` → `{ score, level, date }` |
| `bejeweled.savedrun.v1` | full serialised board + mode + difficulty + score + moves/time + cascade stats |
| `bejeweled.settings.v1` | `{ muted, reducedMotion, highContrast }` |

- Menu shows "Resume run" when a saved run exists (with mode/difficulty/score summary).
- Saved run is written after every settled move and cleared on game over / new game.
- Corrupt/mismatched schema version → ignore and start fresh (never crash).

### 5.9 Audio (procedural WebAudio)
| Event | Sound |
|---|---|
| Swap | short blip (sine, quick decay) |
| Invalid swap | low buzz (square, detuned) |
| Match step | bright pluck; **pitch rises with cascade depth** |
| Special detonation | noise burst + downward sweep (bomb), zap (line), shimmer chord (hyper) |
| Level up / game over | ascending arpeggio / descending triad |

- Lazily initialised on first pointer/key input (no autoplay).
- Mute toggle in HUD + menu, persisted; respects `prefers-reduced-motion` for visual-only juice.

### 5.10 Accessibility
- **Reduced motion:** honours `prefers-reduced-motion` automatically and can be toggled in
  settings — shortens/removes tweens, disables screen shake and particle bursts, keeps
  colour/flash feedback.
- **Unique shape per colour** (diamond, hexagon, rounded square, pentagon, circle, octagon,
  4-point star) so colour is never the only signal; optional high-contrast palette.
- **Keyboard:** arrows to move a cursor, Enter/Space to select + swap, `H` hint, `P`/`Esc` pause,
  `M` mute, `R` restart.
- **Big on screen:** fixed 72 px tiles scaled to viewport, large HUD text (≥28 px at base
  resolution), min 44 px touch targets, high-contrast focus ring on the selected cell.
- Pause automatically on `blur`/`visibilitychange`.

## 6. Interaction model

| Input | Behaviour |
|---|---|
| Tap/click gem A then adjacent gem B | Swap |
| Tap same gem twice | Deselect |
| Tap non-adjacent gem | Move selection to it (no move consumed) |
| Drag/swipe from gem A toward a neighbour | Swap on release past a distance threshold (~25 % of tile) |
| Arrow keys | Move keyboard cursor; Enter/Space selects and swaps |
| Hold/drag cursor | Cursor is always visible in keyboard mode |

## 7. Art contract (for art supplied later)

Procedural art ships in the POC; the loader prefers real assets when present, so art can be
dropped in **without code changes**.

- `assets/gems.png` — sprite sheet, **64×64 px cells**, 1 px transparent padding, columns:
  `col 0..6` = gem colours 0..6 (7 colours max), rows: `0` normal, `1` line blaster,
  `2` bomb, `3` hypercube. Total 7 cols × 4 rows = 1792×256.
- Frame naming: `gem_<colour>`, `special_line_<colour>`, `special_bomb_<colour>`,
  `special_hyper` (hyper uses one frame, tinted prismatically).
- Optional `assets/gems@2x.png` (128×128 cells) for retina; loader picks by `devicePixelRatio`.
- Empty-slot/board background PNGs optional (`assets/board.png`), otherwise procedural.
- Audio: if real audio is later wanted, `assets/sfx/*.ogg` overrides the procedural engine per
  event name (same event table as §5.9).
- Placeholder procedural generator must produce **the same frame names and layout**, so the
  swap is a pure asset drop-in.

## 8. Content & data model

```ts
type Special = 'none' | 'lineH' | 'lineV' | 'bomb' | 'hyper';
interface Cell { type: number; special: Special }   // type -1 for hypercube
type Grid = (Cell | null)[][];

interface RunState {
  mode: 'endless' | 'timed' | 'moves';
  difficulty: 'easy' | 'normal' | 'hard';
  grid: Grid; score: number; level: number;
  movesLeft: number; timeLeftMs: number;
  cascadeDepth: number; shuffles: number; lastMoveAt: number;
}
```

## 9. Deployment (follow-on, spec'd now)

1. `vite build` → `dist/`.
2. `netlify.toml`: build command `npm run build`, publish `dist`, Node 20+.
3. Netlify site + Git integration on the repo → **auto-deploy on push** (decision #4).
4. DNS: add `bejeweled` CNAME → Netlify subdomain, **proxied? No** — see §11 note about
   Cloudflare; tetris/snake are direct public URLs, so mirror that (no CF Access gate).
   Let's Encrypt cert is provisioned by Netlify automatically.
5. Dashy integration: append a **Fun**-section item to Dashy's `conf.yml`
   (`title: Bejeweled`, `url: https://bejeweled.moopit.fun/`, `target: newtab`, free FontAwesome
   icon e.g. `fa-gem`, `statusCheck: false`), then restart the Dashy container. Take a
   `conf.yml.bak-*-pre-bejeweled` backup first (convention from the deploy plan).
6. Caching headers: hashed assets `immutable`, `index.html` `no-cache`.

## 10. Acceptance criteria

**POC (this task)**
1. `npm run build` succeeds; `npm run typecheck` clean.
2. Game serves locally and loads with no console errors.
3. All three modes and all three difficulty presets are selectable and playable.
4. Swapping adjacent gems that match clears them, gems fall, board refills, cascades resolve.
5. Invalid swap reverts, does not consume a move, and shows feedback.
6. Specials can be created and detonated: line blaster, bomb, hypercube.
7. Combo multiplier increases across cascade steps and resets when the cascade ends.
8. Hint highlights a valid move; deadlock triggers auto-shuffle.
9. Score/moves/timer update live; high score persists across reload; run resumes after reload.
10. Sound plays on match/swap with mute toggle; no autoplay before interaction.
11. Keyboard-only playthrough possible; reduced-motion respected.
12. Visual check by screenshot at desktop and mobile widths — looks intentional and polished.

**Ship**
13. Public `https://bejeweled.moopit.fun` returns 200 with valid TLS.
14. Tile appears in Dashy Fun section and opens the game in a new tab.
15. Pushing to the repo publishes automatically.

## 11. Risks, judgement calls, open questions

**Judgement calls made where the interview was ambiguous**
- Gem art: interview chose "spec for art later"; POC uses **procedural gems with unique shapes**
  because shipping flat rounded squares would fail acceptance criterion 12 and the a11y
  colourblind requirement.
- Scoring: interview chose "tunable config", so a **full Bejeweled-style model** (multiplier +
  speed bonus + level targets) is implemented but every constant is in `config.ts`.
- Special activation rules for overlapping runs are a design choice (documented in §5.4); real
  Bejeweled has subtle priority rules we approximate with clear precedence:
  L/T bomb > 5-run hypercube > 4-run line blaster.
- Keyboard/pointer both available at all times (no separate "keyboard mode" toggle).

**Risks**
- Special/cascade interaction rules are the bug-prone core → mitigated by keeping `src/core/`
  Phaser-free and unit-testing it.
- 7-colour Hard board can deadlock more often → auto-shuffle handles it; shuffle count surfaced.
- Netlify DNS + Dashy edit touch live infra → do it as a separate, backed-up, verified step.

**Open questions**
- Should the POC also be reachable from other LAN devices (e.g. phone) during playtest? (Assumed yes.)
- Do we want a small `tests/` suite with Vitest for `src/core/*` in this pass, or after the POC?
- Should the Shuffle count appear on the game-over summary / high score table?
- Any preference for a specific FontAwesome icon for the Dashy tile (`fa-gem` assumed)?
