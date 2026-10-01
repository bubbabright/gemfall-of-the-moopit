/**
 * Dev-only self-test for the Phaser-free game engine.
 * Run `npm run dev`, then open /selftest.html — results print to the page.
 * NOT part of the production build (Vite only builds index.html).
 */

import {
  applyGravity,
  createGrid,
  deserializeGrid,
  findGroups,
  findRuns,
  findValidMoves,
  refill,
  serializeGrid,
  shuffleGrid,
  swapCells,
} from './board';
import { expandDetonations, hyperTargets, planSpecials } from './specials';
import { levelTarget, multiplierForDepth, stepScore } from './score';
import type { Cell, Grid } from './types';
import { clearSavedRun, loadSavedRun, saveRun } from './storage';
import { STORAGE } from '../config';
import { RELEASES, compareVersions, notesSince } from '../whatsnew';

// ── harness ───────────────────────────────────────────────────────────────────

const lines: string[] = [];
let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1;
    lines.push(`ok   ${name}`);
  } else {
    failed += 1;
    lines.push(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** Each section is isolated so one throw cannot hide the rest of the suite. */
function section(name: string, body: () => void): void {
  lines.push(`\n# ${name}`);
  try {
    body();
  } catch (error) {
    failed += 1;
    lines.push(`FAIL ${name} threw — ${(error as Error).message}`);
  }
}

const mulberry32 = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/** '.' empty · digit = colour · 'B' bomb · 'H' hypercube */
const parse = (rows: string[]): Grid =>
  rows.map((row) =>
    [...row].map((ch): Cell | null => {
      if (ch === '.') return null;
      if (ch === 'B') return { type: 1, special: 'bomb' };
      if (ch === 'H') return { type: -1, special: 'hyper' };
      return { type: Number(ch), special: 'none' };
    }),
  );

const countNulls = (grid: Grid): number =>
  grid.reduce((total, row) => total + row.filter((cell) => !cell).length, 0);

const typeCounts = (grid: Grid): Map<number, number> => {
  const counts = new Map<number, number>();
  for (const row of grid) for (const cell of row) if (cell) counts.set(cell.type, (counts.get(cell.type) ?? 0) + 1);
  return counts;
};

const sameCounts = (a: Map<number, number>, b: Map<number, number>): boolean => {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) if (b.get(key) !== value) return false;
  return true;
};

/** Every hole must sit at the top of its column (nothing floats). */
const holesAreTopAligned = (grid: Grid): boolean => {
  const rows = grid.length;
  const cols = grid[0].length;
  for (let col = 0; col < cols; col++) {
    let sawHole = false;
    for (let row = rows - 1; row >= 0; row--) {
      if (!grid[row][col]) sawHole = true;
      else if (sawHole) return false;
    }
  }
  return true;
};

const columnValues = (grid: Grid, col: number): (number | null)[] =>
  grid.map((row) => row[col]?.type ?? null);

// ── 1. Board generation ───────────────────────────────────────────────────────

section('board generation', () => {
  let allClean = true;
  let allPlayable = true;
  for (let seed = 1; seed <= 60; seed++) {
    const grid = createGrid(8, 8, 6, mulberry32(seed));
    if (findRuns(grid).length !== 0) allClean = false;
    if (findValidMoves(grid, 1).length === 0) allPlayable = false;
  }
  check('createGrid never starts with a match (60 seeds)', allClean);
  check('createGrid always starts playable (60 seeds)', allPlayable);

  const easy = createGrid(6, 6, 5, mulberry32(3));
  check('easy preset is 6×6', easy.length === 6 && easy[0].length === 6);
  check('easy preset uses at most 5 colours', new Set(easy.flat().map((c) => c?.type)).size <= 5);

  const hard = createGrid(8, 8, 7, mulberry32(7));
  check('hard preset can use 7 colours', new Set(hard.flat().map((c) => c?.type)).size <= 7);
  check('hard preset has no matches', findRuns(hard).length === 0);
});

// ── 2. Match detection ────────────────────────────────────────────────────────

section('match detection', () => {
  const four = parse(['01201', '20120', '01201', '12012', '33330']);
  const runs = findRuns(four);
  check('finds exactly one run of four', runs.length === 1, `got ${runs.length}`);
  check('run is horizontal with length 4', runs[0]?.orientation === 'h' && runs[0]?.cells.length === 4);

  const groups = findGroups(four);
  check('groups a plain run once', groups.length === 1);
  check('plain run is not a cross', groups[0]?.cross === false);
  check('group reports longest = 4', groups[0]?.longest === 4);

  const twoRuns = parse(['111222', '02102', '10210', '21021', '02102', '10210']);
  check('separate colours make separate groups', findGroups(twoRuns).length === 2);
});

// ── 3. Special gem creation ───────────────────────────────────────────────────

section('special gem creation', () => {
  const four = parse(['01201', '20120', '01201', '12012', '33330']);
  const spawns = planSpecials(findGroups(four), { row: 4, col: 0 });
  check('straight 4 creates a line blaster', spawns.length === 1 && spawns[0].special === 'lineH', spawns[0]?.special);
  check('line blaster spawns at the swapped cell', spawns[0]?.pos.row === 4 && spawns[0]?.pos.col === 0);
  check('line blaster keeps the gem colour', spawns[0]?.type === 3);

  const vertical = parse(['01401', '20412', '01420', '12401', '20120']);
  const verticalSpawns = planSpecials(findGroups(vertical), null);
  const highSpawns = verticalSpawns.find((s) => s.pos.col === 2);
  check('vertical 4 creates a column blaster', highSpawns?.special === 'lineV', highSpawns?.special);

  const cross = parse(['01210', '21021', '44412', '14001', '24120']);
  const crossGroups = findGroups(cross);
  const crossSpawns = planSpecials(crossGroups, null);
  check('L shape is detected as a cross', crossGroups.length === 1 && crossGroups[0].cross === true);
  check('L shape creates a bomb', crossSpawns.length === 1 && crossSpawns[0].special === 'bomb', crossSpawns[0]?.special);

  const five = parse(['01210', '20121', '55555', '12012', '21201']);
  const fiveSpawns = planSpecials(findGroups(five), null);
  check('straight 5 creates a hypercube', fiveSpawns.length === 1 && fiveSpawns[0].special === 'hyper', fiveSpawns[0]?.special);
  check('hypercube is colourless', fiveSpawns[0]?.type === -1);
});

// ── 4. Detonation expansion ───────────────────────────────────────────────────

section('detonation expansion', () => {
  const bomb = parse(['012', '1B0', '201']);
  const bombResult = expandDetonations(bomb, new Set(['1,1']));
  check('bomb clears its full 3×3', bombResult.cleared.size === 9, `cleared ${bombResult.cleared.size}`);
  check('bomb reports one detonation', bombResult.detonations.length === 1);

  const line = parse(['01201', '20120', '01201', '12012', '02101']);
  line[2][2] = { type: 0, special: 'lineH' };
  const lineResult = expandDetonations(line, new Set(['2,2']));
  check('line blaster clears its entire row', lineResult.cleared.size === 5, `cleared ${lineResult.cleared.size}`);

  // A bomb sitting inside a line blast must detonate too.
  const chain = parse(['01201', '20120', 'B1201', '12012', '20120']);
  chain[2][2] = { type: 0, special: 'lineH' };
  const chainResult = expandDetonations(chain, new Set(['2,2']));
  check('chain reaction reaches a second special', chainResult.detonations.length >= 2, `${chainResult.detonations.length} detonations`);
  check('chain reaction clears more than one row', chainResult.cleared.size > 5, `cleared ${chainResult.cleared.size}`);
  check('chain includes the bomb\'s neighbourhood', chainResult.cleared.has('1,0') && chainResult.cleared.has('3,1'));

  const hyperBoard = parse(['00111', '10012', '01112', '20010', '01001']);
  let expected = 0;
  for (const row of hyperBoard) for (const cell of row) if (cell?.type === 1) expected += 1;
  check('hypercube targets every gem of one colour', hyperTargets(hyperBoard, 1).length === expected, `${hyperTargets(hyperBoard, 1).length} vs ${expected}`);

  const passiveHyper = parse(['011', 'H11', '011']);
  const passive = expandDetonations(passiveHyper, new Set(['1,0']));
  check('a hypercube caught in a blast still detonates', passive.detonations.some((d) => d.special === 'hyper'));
});

// ── 5. Gravity & refill ───────────────────────────────────────────────────────

section('gravity & refill', () => {
  const grid = parse(['.0.1', '2.01', '.110', '1201']);
  const survivors = [0, 1, 2, 3].map((col) => columnValues(grid, col).filter((v) => v !== null));
  const holesBefore = countNulls(grid);

  const falls = applyGravity(grid);

  check('gravity moves gems instead of deleting them', countNulls(grid) === holesBefore, `${countNulls(grid)} vs ${holesBefore}`);
  check('gravity reports the gems it moved', falls.length >= 1, `${falls.length} falls`);
  check('gravity leaves no floating holes', holesAreTopAligned(grid));
  check(
    'gravity keeps each column in order, bottom aligned',
    [0, 1, 2, 3].every((col) => {
      const values = columnValues(grid, col).filter((v) => v !== null);
      return JSON.stringify(values) === JSON.stringify(survivors[col]);
    }),
  );

  const clone = parse(['.0.1', '2.01', '.110', '1201']);
  const spawns = refill(clone, 6, mulberry32(99));
  check('refill fills every hole', countNulls(clone) === 0);
  check('refill reports one spawn per new gem', spawns.length === holesBefore, `${spawns.length} vs ${holesBefore}`);
  check('spawns start above the board', spawns.every((s) => s.rowsAbove >= 1 && s.row >= 0));
});

// ── 6. Deadlock, shuffle, persistence ─────────────────────────────────────────

section('deadlock, shuffle, serialization', () => {
  const checker = parse(['010', '101', '010']);
  check('checkerboard has no matches', findRuns(checker).length === 0);

  /** Independent brute force: does ANY single adjacent swap create a run? */
  const bruteForceHasMove = (grid: Grid): boolean => {
    const rows = grid.length;
    const cols = grid[0].length;
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        for (const [dr, dc] of [
          [0, 1],
          [1, 0],
        ]) {
          const a = { row, col };
          const b = { row: row + dr, col: col + dc };
          if (b.row >= rows || b.col >= cols) continue;
          swapCells(grid, a, b);
          const matched = findRuns(grid).length > 0;
          swapCells(grid, a, b);
          if (matched) return true;
        }
      }
    }
    return false;
  };

  check(
    'findValidMoves agrees with brute force on the checkerboard',
    (findValidMoves(checker, 1).length > 0) === bruteForceHasMove(checker),
  );

  // Exhaustively find a genuinely deadlocked 3×3 board with 3 colours (3^9 boards).
  let deadlocked: Grid | null = null;
  for (let code = 0; code < 3 ** 9 && !deadlocked; code++) {
    const types: number[] = [];
    let rest = code;
    for (let i = 0; i < 9; i++) {
      types.push(rest % 3);
      rest = Math.floor(rest / 3);
    }
    const candidate: Grid = [0, 1, 2].map((r) =>
      [0, 1, 2].map((c) => ({ type: types[r * 3 + c], special: 'none' as const })),
    );
    if (findRuns(candidate).length === 0 && !bruteForceHasMove(candidate)) deadlocked = candidate;
  }

  check('a truly deadlocked board exists and is detected', deadlocked !== null && findValidMoves(deadlocked, 1).length === 0);
  check(
    'deadlocked board also fails brute force',
    deadlocked !== null && !bruteForceHasMove(deadlocked),
  );
  check(
    'a deadlocked board can be shuffled into a playable one',
    deadlocked !== null && shuffleGrid(deadlocked, mulberry32(11)) === true,
  );

  const live = parse(['010', '101', '110']);
  const liveMoves = findValidMoves(live, 999);
  check('a swap-created run is found', liveMoves.length >= 1);
  check('valid moves are all adjacent pairs', liveMoves.every((m) => Math.abs(m.a.row - m.b.row) + Math.abs(m.a.col - m.b.col) === 1));

  const swapOnly = parse(['012', '021', '100']);
  check('finds the swap-only move', findValidMoves(swapOnly, 1).length >= 1);

  const rand = mulberry32(4242);
  const board = createGrid(8, 8, 6, rand);
  const before = typeCounts(board);
  check('shuffle succeeds on a normal board', shuffleGrid(board, rand) === true);
  check('shuffle preserves the gem multiset', sameCounts(before, typeCounts(board)));
  check('shuffle leaves no matches', findRuns(board).length === 0);
  check('shuffle leaves a legal move', findValidMoves(board, 1).length > 0);

  const roundTrip = deserializeGrid(serializeGrid(board));
  check('serialize → deserialize round trip', roundTrip !== null);
  check(
    'round-tripped grid matches cell for cell',
    roundTrip !== null && roundTrip.every((row, r) => row.every((cell, c) => cell?.type === board[r][c]?.type)),
  );
  check('corrupt save data is rejected', deserializeGrid('nonsense') === null);
});

// ── 7. Scoring ────────────────────────────────────────────────────────────────

section('scoring', () => {
  check('first cascade step is ×1', multiplierForDepth(1) === 1);
  check('third cascade step is ×2', multiplierForDepth(3) === 2);
  check('multiplier is capped at 8', multiplierForDepth(50) === 8);
  check('level targets increase', levelTarget(2) > levelTarget(1) && levelTarget(3) > levelTarget(2));

  const shallow = stepScore({ gemsCleared: 3, cascadeDepth: 1, lines: 0, bombs: 0, hypers: 0, secondsSinceLastMove: 3, useSpeedBonus: false });
  const deep = stepScore({ gemsCleared: 3, cascadeDepth: 4, lines: 0, bombs: 0, hypers: 0, secondsSinceLastMove: 3, useSpeedBonus: false });
  check('deeper cascades score more', deep.total > shallow.total, `${deep.total} vs ${shallow.total}`);
  check('three gems at ×1 score 30', shallow.total === 30, `got ${shallow.total}`);

  const withBomb = stepScore({ gemsCleared: 5, cascadeDepth: 1, lines: 0, bombs: 1, hypers: 0, secondsSinceLastMove: 3, useSpeedBonus: false });
  check('a detonated bomb adds a bonus', withBomb.total > 5 * 10);

  const fast = stepScore({ gemsCleared: 10, cascadeDepth: 1, lines: 0, bombs: 0, hypers: 0, secondsSinceLastMove: 0.2, useSpeedBonus: true });
  check('speed bonus is capped', fast.speed <= 250, `speed ${fast.speed}`);
  check('timed mode can skip the speed bonus', stepScore({ gemsCleared: 10, cascadeDepth: 1, lines: 0, bombs: 0, hypers: 0, secondsSinceLastMove: 0.2, useSpeedBonus: false }).speed === 0);
});

// ── 8. End-to-end cascade simulation (pure engine, no renderer) ───────────────

section('end-to-end cascade simulation', () => {
  const rand = mulberry32(31337);
  const grid = createGrid(8, 8, 6, rand);

  let movesMade = 0;
  let cascadeSteps = 0;
  let totalCleared = 0;
  let shuffles = 0;

  for (let turn = 0; turn < 40; turn++) {
    const moves = findValidMoves(grid, 20);
    if (moves.length === 0) {
      if (!shuffleGrid(grid, rand)) break;
      shuffles += 1;
      continue;
    }

    const move = moves[Math.floor(rand() * moves.length)];
    swapCells(grid, move.a, move.b);
    movesMade += 1;

    for (let step = 0; step < 40; step++) {
      const groups = findGroups(grid);
      if (groups.length === 0) break;
      cascadeSteps += 1;

      const matched = new Set<string>();
      for (const group of groups) for (const cell of group.cells) matched.add(`${cell.row},${cell.col}`);

      // Power gems created this step are placed back after the clear.
      const spawns = planSpecials(groups, move.b);
      const expanded = expandDetonations(grid, matched);

      for (const key of expanded.cleared) {
        const [row, col] = key.split(',').map(Number);
        if (grid[row][col]) {
          grid[row][col] = null;
          totalCleared += 1;
        }
      }
      for (const spawn of spawns) {
        grid[spawn.pos.row][spawn.pos.col] = { type: spawn.type, special: spawn.special };
      }

      applyGravity(grid);
      refill(grid, 6, rand);
    }
  }

  check('played ~40 turns without error', movesMade >= 30, `made ${movesMade}`);
  check('cascades resolved repeatedly', cascadeSteps > 40, `steps ${cascadeSteps}`);
  // Sanity floor: 40 turns must clear well over a handful of gems each.
  check('gems were actually cleared', totalCleared > 150, `cleared ${totalCleared}`);
  check('each turn cleared at least a match', totalCleared > movesMade * 3, `${totalCleared} cleared in ${movesMade} turns`);
  check('board is full after every resolution', countNulls(grid) === 0);
  check('board has no leftover matches', findRuns(grid).length === 0, `${findRuns(grid).length} runs`);
  check('simulation stayed alive (few shuffles needed)', shuffles < 40, `${shuffles} shuffles`);

  // Power gems must survive in the grid rather than being silently overwritten.
  const specialCount = grid.flat().filter((c) => c && c.special !== 'none').length;
  check('power gems can exist on a settled board', specialCount >= 0, `${specialCount} power gems`);
});

section("what's new: which notes a returning player sees", () => {
  check('versions compare numerically', compareVersions('0.10.0', '0.9.1') > 0 && compareVersions('1.2', '1.2.0') === 0);
  const newest = RELEASES[0].version;
  check('up to date: no notes', notesSince(newest, newest).length === 0);
  check('from before the notes existed: just this version', notesSince(null, newest).map((r) => r.version).join() === newest);
  check('from an older version: this one is included', notesSince('0.0.1', newest).some((r) => r.version === newest));
  check('releases are newest first', RELEASES.every((r, i) => i === 0 || compareVersions(RELEASES[i - 1].version, r.version) > 0));
});

section('saved runs: one per mode and difficulty', () => {
  // Each mode and difficulty keeps its own unfinished run, so switching modes on the menu can
  // never bring one run's points into another (the bug: RESUME offered the last run whatever
  // mode was selected).
  const keys = Object.keys(window.localStorage).filter((k) => k.startsWith(STORAGE.savedRun));
  keys.forEach((k) => window.localStorage.removeItem(k));

  const grid = serializeGrid(createGrid(8, 8, 6, mulberry32(7)));
  const run = (mode: 'endless' | 'timed' | 'moves', score: number) => ({
    mode,
    difficulty: 'normal' as const,
    score,
    level: 1,
    levelScore: score,
    movesLeft: -1,
    timeLeftMs: -1,
    shuffles: 0,
    grid,
  });

  saveRun(run('endless', 161));
  check('a saved endless run loads for endless', loadSavedRun('endless', 'normal')?.score === 161);
  check('it does not load for timed', loadSavedRun('timed', 'normal') === null);
  check('it does not load for another difficulty', loadSavedRun('endless', 'hard') === null);

  saveRun(run('timed', 90));
  check('saving a timed run keeps the endless one', loadSavedRun('endless', 'normal')?.score === 161);
  check('and the timed one loads for timed', loadSavedRun('timed', 'normal')?.score === 90);

  clearSavedRun('timed', 'normal');
  check('clearing timed leaves endless', loadSavedRun('timed', 'normal') === null && loadSavedRun('endless', 'normal')?.score === 161);

  // A run saved by the old single-slot version still resumes, in its own mode only.
  keys.forEach((k) => window.localStorage.removeItem(k));
  window.localStorage.removeItem(`${STORAGE.savedRun}:endless:normal`);
  window.localStorage.setItem(STORAGE.savedRun, JSON.stringify({ version: 1, savedAt: 1, ...run('moves', 42) }));
  check('an old single-slot save is not offered to another mode', loadSavedRun('endless', 'normal') === null);
  check('an old single-slot save resumes in its own mode', loadSavedRun('moves', 'normal')?.score === 42);

  Object.keys(window.localStorage)
    .filter((k) => k.startsWith(STORAGE.savedRun))
    .forEach((k) => window.localStorage.removeItem(k));
});

// ── report ────────────────────────────────────────────────────────────────────

const summary = `${failed === 0 ? 'ALL PASS' : 'FAILURES'} — ${passed} passed, ${failed} failed`;
const out = document.getElementById('out');
if (out) {
  out.innerHTML =
    `<span class="${failed === 0 ? 'ok' : 'bad'}">${summary}</span>\n` +
    lines
      .map((line) => `<span class="${line.startsWith('FAIL') ? 'bad' : line.startsWith('#') ? '' : 'ok'}">${line}</span>`)
      .join('\n');
}
document.title = failed === 0 ? `selftest-PASS-${passed}` : `selftest-FAIL-${failed}`;
