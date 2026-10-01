/**
 * All tunable game values live here (interview decision: "values in a tunable config").
 * Nothing in src/core/ or the scenes should hard-code balance numbers.
 */

// ── View ──────────────────────────────────────────────────────────────────────
/** Logical width. The height and gem size depend on the screen: see src/layout.ts. */
export const GAME_WIDTH = 720;
/** Gem textures are generated at this size and scaled down to the on-screen tile. */
export const TEX_SIZE = 128;
export const BOARD_MAX_COLS = 8;

export const FONT = 'Inter, "Segoe UI", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif';
/**
 * Rounded display face for the little messages over the board (toasts, combo words). Bundled
 * from @fontsource, so it ships with the game and nothing is fetched from anyone else.
 */
export const MESSAGE_FONT = `Fredoka, ${FONT}`;

// ── Gems ──────────────────────────────────────────────────────────────────────
/** One colour per gem type; shape is derived from the index so colour is never the only cue. */
export const GEM_COLORS = [
  0xff4d6d, // ruby   — diamond
  0x4dabff, // sapphire — hexagon
  0x44da82, // emerald — rounded square
  0xffd447, // topaz  — pentagon
  0xb76cff, // amethyst — circle
  0xff9a4d, // amber  — octagon
  0x3ddbd9, // aquamarine — star
];

export type GemShape = 'diamond' | 'hexagon' | 'square' | 'pentagon' | 'circle' | 'octagon' | 'star';

export const GEM_SHAPES: GemShape[] = [
  'diamond',
  'hexagon',
  'square',
  'pentagon',
  'circle',
  'octagon',
  'star',
];

// ── Modes & difficulty ────────────────────────────────────────────────────────
export type Mode = 'endless' | 'timed' | 'moves';
export type Difficulty = 'easy' | 'normal' | 'hard';

export interface ModeSpec {
  label: string;
  /**
   * Second line of the mode pill. Must stay short enough to fit inside a menu pill
   * at the pill's sub-text size — `tools/probe-layout.mjs` measures it against the box.
   */
  sub: string;
  moves: number; // Number.POSITIVE_INFINITY when unused
  timeMs: number; // Number.POSITIVE_INFINITY when unused
}

export const MODES: Record<Mode, ModeSpec> = {
  endless: {
    label: 'Endless',
    sub: 'No limit',
    moves: Number.POSITIVE_INFINITY,
    timeMs: Number.POSITIVE_INFINITY,
  },
  timed: {
    label: 'Timed',
    sub: '60 seconds',
    moves: Number.POSITIVE_INFINITY,
    timeMs: 60_000,
  },
  moves: {
    label: 'Moves',
    sub: '30 moves',
    moves: 30,
    timeMs: Number.POSITIVE_INFINITY,
  },
};

export interface DifficultySpec {
  label: string;
  /** Second line of the difficulty pill; see ModeSpec.sub for the length constraint. */
  sub: string;
  cols: number;
  rows: number;
  types: number;
  /** Hint changes less often on harder boards. */
  hintDelayMs: number;
}

export const DIFFICULTIES: Record<Difficulty, DifficultySpec> = {
  easy: { label: 'Easy', sub: '6×6 · 5 gems', cols: 6, rows: 6, types: 5, hintDelayMs: 7_000 },
  normal: { label: 'Normal', sub: '8×8 · 6 gems', cols: 8, rows: 8, types: 6, hintDelayMs: 9_000 },
  hard: { label: 'Hard', sub: '8×8 · 7 gems', cols: 8, rows: 8, types: 7, hintDelayMs: 11_000 },
};

export const MODE_ORDER: Mode[] = ['endless', 'timed', 'moves'];
export const DIFFICULTY_ORDER: Difficulty[] = ['easy', 'normal', 'hard'];

/**
 * Menu picker geometry. Positions are derived from width + gap rather than a fixed stride,
 * so widening a pill can never silently overlap its neighbour (the bug that made the three
 * menu buttons render as one continuous bar).
 */
export const MENU = {
  pillW: 196,
  pillGap: 20,
};

/** Left-to-right centre of each pill in a menu picker row. */
export const menuRowCentres = (count: number, width: number): number[] => {
  const stride = MENU.pillW + MENU.pillGap;
  const first = width / 2 - ((count - 1) / 2) * stride;
  return Array.from({ length: count }, (_, i) => first + i * stride);
};

/** Mode-specific rules that are not just a clock or a counter. */
export const MODE_RULES = {
  /**
   * Endless has no move/clock limit, so the run ends when the player runs out of
   * auto-shuffles (each deadlock consumes one). Keeps the mode score-chase shaped.
   */
  endlessShuffles: 3,
  /** Shuffles an Endless run earns each time it levels up. */
  endlessShufflesPerLevel: 1,
};

// ── Scoring (spec §5.5) ───────────────────────────────────────────────────────
export const SCORE = {
  gemBase: 10,
  /** multiplier = 1 + step * (depth - 1), capped */
  multiplierStep: 0.5,
  maxMultiplier: 8,
  specialBonus: { line: 60, bomb: 100, hyper: 150 },
  /** Speed bonus is (points earned this move) / seconds since the previous move. */
  speedBonusCap: 250,
  speedBonusMinSeconds: 0.4,
  /** Points required to complete level N = levelBase * growth^(N-1). */
  levelBase: 2_500,
  levelGrowth: 1.85,
};

// ── Timing / feel ─────────────────────────────────────────────────────────────
export const TIMING = {
  swapMs: 130,
  /**
   * Match-clear explosion for the first cascade step. Long enough to actually read
   * as a hit: the gems inhale, flash, then burst outward while sparks fly.
   */
  clearMs: 900,
  /** Floor for deep cascades, so a long chain does not drag on for seconds. */
  clearMinMs: 300,
  /** Each cascade step past the first scales the clear by this factor. */
  cascadeRamp: 0.78,
  /** Power-gem spawn pop-in. */
  popMs: 190,
  /**
   * Falling gems. Acceleration is what sells this as gravity rather than a slide,
   * so these are deliberately slow enough to follow with the eye.
   */
  fallMsPerTile: 120,
  fallMinMs: 220,
  /** Landing squash once a falling gem arrives. */
  settleMs: 130,
  spawnMs: 260,
  rejectMs: 140,
  hintPulseMs: 620,
  comboFadeMs: 700,
};

/**
 * How long messages stay on screen — toasts, the word under a combo number, and the level-up
 * banner with its line. The player picks one with the MSG pill on the menu; each tap steps to
 * the next and wraps. The shortest is still readable over the busy board (the old 1100 ms toast
 * was gone before the eye landed on it). Kay said the messages on another game are what make
 * her feel less scared, so the longer steps are there for her.
 */
export const MESSAGE_HOLD_STEPS_MS = [1_500, 3_000, 5_000, 8_000] as const;
export const DEFAULT_MESSAGE_HOLD_MS = 3_000;

// ── Interaction ───────────────────────────────────────────────────────────────
export const SWIPE_THRESHOLD = 0.28; // fraction of TILE before a drag commits a swap

// ── Persistence ───────────────────────────────────────────────────────────────
export const STORAGE = {
  highScores: 'bejeweled.highscores.v1',
  savedRun: 'bejeweled.savedrun.v1',
  settings: 'bejeweled.settings.v1',
  /** The last version whose What's new note this player has seen (src/ui/whatsnew.ts). */
  seenVersion: 'bejeweled.seenversion.v1',
};

export type HighScoreKey = `${Mode}:${Difficulty}`;

export const highScoreKey = (mode: Mode, difficulty: Difficulty): HighScoreKey =>
  `${mode}:${difficulty}`;
