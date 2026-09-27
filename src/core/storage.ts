import {
  DEFAULT_MESSAGE_HOLD_MS,
  MESSAGE_HOLD_STEPS_MS,
  STORAGE,
  highScoreKey,
  type Difficulty,
  type Mode,
} from '../config';
import { deserializeGrid, serializeGrid } from './board';
import type { Grid, SerializedGrid } from './types';

export interface Settings {
  /** Everything silent: the speaker in the corner. */
  muted: boolean;
  /** Sound effects on, in settings. */
  effects: boolean;
  /** Background music on, in settings. */
  music: boolean;
  reducedMotion: boolean;
  /** Vibration on match explosions, where the platform supports it. */
  haptics: boolean;
  /**
   * The private voice (see `src/messages.ts`), unlocked by tapping the menu title
   * `MOOPIT_TAPS` times. Stored rather than session-only so it survives a reload.
   */
  moopit: boolean;
  /** How long messages stay on screen, one of `MESSAGE_HOLD_STEPS_MS` (in settings). */
  messageHoldMs: number;
}

export interface HighScore {
  score: number;
  level: number;
  date: number;
}

export interface SavedRun {
  version: 1;
  mode: Mode;
  difficulty: Difficulty;
  grid: SerializedGrid;
  score: number;
  level: number;
  levelScore: number;
  movesLeft: number;
  timeLeftMs: number;
  shuffles: number;
  savedAt: number;
}

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

export function systemPrefersReducedMotion(): boolean {
  try {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(REDUCED_MOTION_QUERY).matches
      : false;
  } catch {
    return false;
  }
}

export const defaultSettings = (): Settings => ({
  muted: false,
  effects: true,
  music: true,
  reducedMotion: systemPrefersReducedMotion(),
  haptics: true,
  moopit: false,
  messageHoldMs: DEFAULT_MESSAGE_HOLD_MS,
});

const read = <T>(key: string, fallback: T): T => {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
};

const write = (key: string, value: unknown): void => {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode / quota — persistence is best-effort, never fatal */
  }
};

// ── Settings ──────────────────────────────────────────────────────────────────

export function loadSettings(): Settings {
  const stored = read<Partial<Settings> | null>(STORAGE.settings, null);
  const base = defaultSettings();
  if (!stored || typeof stored !== 'object') return base;
  return {
    muted: typeof stored.muted === 'boolean' ? stored.muted : base.muted,
    effects: typeof stored.effects === 'boolean' ? stored.effects : base.effects,
    music: typeof stored.music === 'boolean' ? stored.music : base.music,
    reducedMotion:
      typeof stored.reducedMotion === 'boolean' ? stored.reducedMotion : base.reducedMotion,
    haptics: typeof stored.haptics === 'boolean' ? stored.haptics : base.haptics,
    moopit: typeof stored.moopit === 'boolean' ? stored.moopit : base.moopit,
    // Only one of the menu's steps is valid: an old or hand-edited value falls back to default.
    messageHoldMs: (MESSAGE_HOLD_STEPS_MS as readonly number[]).includes(stored.messageHoldMs as number)
      ? (stored.messageHoldMs as number)
      : base.messageHoldMs,
  };
}

export const saveSettings = (settings: Settings): void => write(STORAGE.settings, settings);

// ── High scores ───────────────────────────────────────────────────────────────

export function loadHighScores(): Record<string, HighScore> {
  const stored = read<Record<string, HighScore>>(STORAGE.highScores, {});
  const clean: Record<string, HighScore> = {};
  for (const [key, value] of Object.entries(stored ?? {})) {
    if (value && typeof value.score === 'number') {
      clean[key] = {
        score: value.score,
        level: typeof value.level === 'number' ? value.level : 1,
        date: typeof value.date === 'number' ? value.date : Date.now(),
      };
    }
  }
  return clean;
}

export const getHighScore = (mode: Mode, difficulty: Difficulty): HighScore | null =>
  loadHighScores()[highScoreKey(mode, difficulty)] ?? null;

/** Returns true when the score is a new personal best. */
export function submitHighScore(
  mode: Mode,
  difficulty: Difficulty,
  score: number,
  level: number,
): boolean {
  const all = loadHighScores();
  const key = highScoreKey(mode, difficulty);
  const previous = all[key];
  if (previous && previous.score >= score) return false;
  all[key] = { score, level, date: Date.now() };
  write(STORAGE.highScores, all);
  return true;
}

// ── Saved run (resume) ────────────────────────────────────────────────────────

export function saveRun(run: Omit<SavedRun, 'version' | 'savedAt'>): void {
  write(STORAGE.savedRun, { version: 1, savedAt: Date.now(), ...run } satisfies SavedRun);
}

export function loadSavedRun(): (Omit<SavedRun, 'grid' | 'version'> & { grid: Grid }) | null {
  const stored = read<SavedRun | null>(STORAGE.savedRun, null);
  if (!stored || stored.version !== 1) return null;

  const grid = deserializeGrid(stored.grid);
  if (!grid) return null;

  return {
    mode: stored.mode,
    difficulty: stored.difficulty,
    score: typeof stored.score === 'number' ? stored.score : 0,
    level: typeof stored.level === 'number' ? stored.level : 1,
    levelScore: typeof stored.levelScore === 'number' ? stored.levelScore : 0,
    movesLeft: typeof stored.movesLeft === 'number' ? stored.movesLeft : 0,
    timeLeftMs: typeof stored.timeLeftMs === 'number' ? stored.timeLeftMs : 0,
    shuffles: typeof stored.shuffles === 'number' ? stored.shuffles : 0,
    savedAt: stored.savedAt ?? Date.now(),
    grid,
  };
}

export const clearSavedRun = (): void => {
  try {
    window.localStorage.removeItem(STORAGE.savedRun);
  } catch {
    /* ignore */
  }
};

export const gridForSave = (grid: Grid): SerializedGrid => serializeGrid(grid);
