/**
 * Every line the game says out loud, in two voices.
 *
 * - `plain` — the default. This is the wording the game has always used, and it stays put:
 *   the screenshots and the playtest are checked against this build.
 * - `moopit` — a private pack of in-jokes. Off unless a player unlocks it, and the choice is
 *   remembered in settings. See `MOOPIT_TAPS` and `MenuScene.wireMoopitTitle`.
 *
 * House rule for the personal voice: it does not belong in README.md or on the game page.
 * The game is public; this half of it is between two people, and the surprise only lands once.
 *
 * One name from the source list is deliberately absent here. It was marked off-limits, and
 * this repo is public, so it is not written down anywhere — including in this comment.
 */

export interface Voice {
  /**
   * Second line under the GEMFALL title on the menu. The title art itself never changes —
   * this is the only part of the heading the personal voice touches.
   */
  menuTagline: string;
  /**
   * Words under the `×N.N` combo popup, indexed by `multiplierTier` (0–4). Tier 0 never
   * shows, because the popup itself is skipped below ×1.5. An empty list means no words.
   */
  comboTiers: readonly (readonly string[])[];
  toast: {
    endlessStart: (shuffles: number) => string;
    /** Endless levelled up and earned shuffles; `left` is the new total. */
    shuffleEarned: (earned: number, left: number) => string;
    /** A swap that matched nothing. */
    noMatch: readonly string[];
    /** No move left on the board, so it shuffles itself. */
    shuffling: readonly string[];
    /** Asked for a hint and there was nothing to point at. */
    noMoves: string;
    /** The board nudged the player toward a move after sitting still. */
    hint: readonly string[];
  };
  level: {
    title: (level: number) => string;
    /** A line above the LEVEL banner. */
    notes: readonly string[];
  };
  paused: {
    title: string;
    /** Extra lines in the pause panel, under the score. */
    extra: readonly string[];
  };
  gameOver: {
    title: string;
    /** Extra lines in the game-over panel, under the level. */
    extra: readonly string[];
    /** Replaces "★ NEW PERSONAL BEST ★" when this run beat the stored score. */
    best: string;
  };
}

/** The wording every player sees. Byte-for-byte what the game shipped with. */
const plain: Voice = {
  menuTagline: 'Match · Chain · Explode',
  comboTiers: [[], [], [], [], []],
  toast: {
    endlessStart: (shuffles) => `Endless · ${shuffles} shuffles`,
    shuffleEarned: (earned, left) => `+${earned} shuffle${earned > 1 ? 's' : ''} · ${left} left`,
    noMatch: ['No match there'],
    shuffling: ['No moves left — shuffling'],
    noMoves: 'No moves — shuffling',
    hint: ['Try a highlighted swap'],
  },
  level: {
    title: (level) => `LEVEL ${level}`,
    notes: [],
  },
  paused: {
    title: 'PAUSED',
    extra: [],
  },
  gameOver: {
    title: 'GAME OVER',
    extra: [],
    best: '★ NEW PERSONAL BEST ★',
  },
};

/**
 * The private voice. Every name and phrase in it was picked out of a real conversation:
 * the things they call each other, the running jokes, and one line that is not a joke.
 * Kay said the little messages on another game make her feel less scared, so the ones on
 * a big chain stay short and warm — the combos are meant to keep her calm, not hype her up.
 *
 * Lines are kept short on purpose: the overlay panel is 520px wide and does not wrap.
 */
const moopit: Voice = {
  menuTagline: 'the full moopit',

  comboTiers: [
    [],
    ['per usual', 'deal', 'right on schedule', 'sounds like a plan'],
    ['nice, hun', 'good one, Ted bear', 'per usual, sweetie', 'steady, boo bear'],
    ['look at you, sweetheart', 'that’s my moopit', 'home slice, look at that', 'honey bunny, tidy'],
    ['the full moopit', 'moopit & ted bear forever', 'long after the lights go out in space…'],
  ],

  toast: {
    endlessStart: (shuffles) => `endless, Ted bear · ${shuffles} shuffles`,
    shuffleEarned: (earned, left) => `+${earned} shuffle${earned > 1 ? 's' : ''}, Ted bear · ${left} left`,
    noMatch: [
      'wires crossed',
      'dropped the ball',
      'per usual, chucklehead',
      'wrong way, goober',
      'dummy bear, not quite',
    ],
    // Kept to one line: the toast is 32px over a 660px wrap width.
    shuffling: [
      'no moves — shuffling, monkey butt',
      'no moves — shuffling, sweetie',
      'wires crossed — shuffling, toots',
    ],
    noMoves: 'no moves — shuffling, Ted bear',
    // All of these fit one 32px line; see the toast measurements in the probe notes.
    hint: [
      'try the glowing ones, moopit',
      'try the swap, Puddles',
      'there, toots — try that one',
      'explain it to me like I’m 5',
    ],
  },

  level: {
    title: (level) => `LEVEL ${level}`,
    notes: [
      'nice work, Ted bear',
      'you look kosher to me, babe',
      'per usual, hun',
      'right on schedule, sweetheart',
      'that’s my moopit',
      'boo boo, you’re getting good at this',
    ],
  },

  paused: {
    title: 'PAUSED, HUN',
    extra: ['take your time, Ted bear', 'no rush — this is the calm one'],
  },

  gameOver: {
    title: 'GOOD RUN, HUN',
    extra: [
      'you look kosher to me, babe.',
      'long after my bones turn to dust',
      'and the lights go out in space, I’ll love you.',
    ],
    best: '★ BEST YET, TED BEAR ★',
  },
};

/** How many taps on the menu title unlock the personal voice. */
export const MOOPIT_TAPS = 7;

/**
 * Taps have to land this close together. A player who taps seven times over a minute is
 * just fidgeting, and one stray tap in a queue should not tip it over.
 */
export const MOOPIT_TAP_WINDOW_MS = 1200;

/** Indigo, because it is her favourite colour. Used for everything the personal voice adds. */
export const MOOPIT_ACCENT = '#a5b4fc';

export const voiceFor = (moopitOn: boolean): Voice => (moopitOn ? moopit : plain);

/** Pick one line at random, so repeated toasts and combos do not read like a loop. */
export function pick<T>(list: readonly T[], fallback: T, rand: () => number = Math.random): T {
  if (list.length === 0) return fallback;
  return list[Math.min(list.length - 1, Math.floor(rand() * list.length))];
}
