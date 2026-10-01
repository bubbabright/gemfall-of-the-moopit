#!/usr/bin/env node
/**
 * Power-up gate: plays set-up boards on a phone-sized screen and checks every match shape and
 * power gem does what the README says.
 *
 *   node tools/powerups.mjs [url]     (default: the dev preview, http://127.0.0.1:4771)
 *
 * Each scenario lays out an exact board (plain filler gems that can't match, plus the gems the
 * scenario needs), makes its move with real touch input (a tap on each gem, or a swipe), then
 * checks what the game cleared and which power gem it made:
 *
 *   match 3            clears those 3, makes nothing
 *   match 4 across     makes a line blaster (lineH) where the gem landed
 *   match 4 down       makes a line blaster (lineV)
 *   match 5            makes a hypercube
 *   L and T shapes     make a bomb
 *   line blasters      clear their whole row / column
 *   bomb               clears the 3×3 around it
 *   chain              a line blast that reaches a bomb sets the bomb off too
 *   hypercube + gem    clears every gem of that colour
 *   hypercube × 2      clears the whole board
 *   no match           the swap bounces back; nothing changes
 *
 * After each one: the board is full again, with one sprite per gem. Screenshots of the new power
 * gems go to poc/powerups-*.png. Only the first clear of a move is checked; whatever the refill
 * cascades into afterwards is random and not part of the test.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { GPU_MODE, gpuFlags } from './gpu-flags.mjs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:4771';
const PORT = 4789;
const OUT_DIR = 'poc';
// Daniel's phone in Chrome: 1080×2400 at ~409 ppi is 411×751 CSS px at DPR 2.625.
const PHONE = { width: 411, height: 751, deviceScaleFactor: 2.625, mobile: true };
const ROWS = 8;
const COLS = 8;
const X = 4; // the colour each scenario matches
const Y = 5; // a second colour, for the bomb in the chain and the hypercube's pick
console.log(`browser GPU: ${GPU_MODE} (GEMFALL_GPU; see tools/gpu-flags.mjs)`);
mkdirSync(OUT_DIR, { recursive: true });

// ── boards ────────────────────────────────────────────────────────────────────

/** Filler that can never line up three: colours 0–3 in a 2×2 checker. */
const filler = (row, col) => (col % 2) + 2 * (row % 2);

function board(gems) {
  const grid = [];
  for (let row = 0; row < ROWS; row++) {
    grid.push([]);
    for (let col = 0; col < COLS; col++) grid[row].push({ t: filler(row, col), s: 'none' });
  }
  for (const [row, col, t, s = 'none'] of gems) grid[row][col] = { t, s };
  return grid;
}

/** Runs of 3+ of one colour (hypercubes never match), like the game's findRuns. */
function runs(grid) {
  const found = [];
  const scan = (cells) => {
    let start = 0;
    for (let i = 1; i <= cells.length; i++) {
      const same = i < cells.length && cells[i].t >= 0 && cells[i].t === cells[start].t;
      if (same) continue;
      if (i - start >= 3 && cells[start].t >= 0) found.push(cells.slice(start, i));
      start = i;
    }
  };
  for (let row = 0; row < ROWS; row++) scan(grid[row].map((c, col) => ({ ...c, row, col })));
  for (let col = 0; col < COLS; col++) scan(grid.map((r, row) => ({ ...r[col], row, col })));
  return found;
}

const swapped = (grid, [a, b]) => {
  const g = grid.map((r) => r.map((c) => ({ ...c })));
  [g[a[0]][a[1]], g[b[0]][b[1]]] = [g[b[0]][b[1]], g[a[0]][a[1]]];
  return g;
};

const key = (row, col) => `${row},${col}`;
const rowCells = (row) => Array.from({ length: COLS }, (_, col) => key(row, col));
const colCells = (col) => Array.from({ length: ROWS }, (_, row) => key(row, col));
const around = (row, col) => {
  const cells = [];
  for (let r = row - 1; r <= row + 1; r++) for (let c = col - 1; c <= col + 1; c++) {
    if (r >= 0 && r < ROWS && c >= 0 && c < COLS) cells.push(key(r, c));
  }
  return cells;
};

// Most scenarios move an X down from (3,2) into (4,2), finishing a shape in row 4.
const DOWN_INTO_ROW4 = [[3, 2], [4, 2]];

const SCENARIOS = [
  {
    name: 'match 3',
    gems: [[4, 0, X], [4, 1, X], [3, 2, X]],
    move: DOWN_INTO_ROW4,
    input: 'tap',
    expect: { cleared: [key(4, 0), key(4, 1), key(4, 2)], exact: true, makes: null },
  },
  {
    name: 'match 4 across',
    gems: [[4, 0, X], [4, 1, X], [4, 3, X], [3, 2, X]],
    move: DOWN_INTO_ROW4,
    input: 'swipe',
    expect: { cleared: [key(4, 0), key(4, 1), key(4, 2), key(4, 3)], exact: true, makes: ['lineH', 4, 2] },
  },
  {
    name: 'match 4 down',
    gems: [[0, 4, X], [1, 4, X], [3, 4, X], [2, 3, X]],
    move: [[2, 3], [2, 4]],
    input: 'tap',
    expect: { cleared: [key(0, 4), key(1, 4), key(2, 4), key(3, 4)], exact: true, makes: ['lineV', 2, 4] },
  },
  {
    name: 'match 5',
    gems: [[4, 0, X], [4, 1, X], [4, 3, X], [4, 4, X], [3, 2, X]],
    move: DOWN_INTO_ROW4,
    input: 'swipe',
    expect: { cleared: [0, 1, 2, 3, 4].map((c) => key(4, c)), exact: true, makes: ['hyper', 4, 2] },
  },
  {
    name: 'L shape',
    gems: [[4, 0, X], [4, 1, X], [5, 2, X], [6, 2, X], [3, 2, X]],
    move: DOWN_INTO_ROW4,
    input: 'swipe',
    expect: { cleared: [key(4, 0), key(4, 1), key(4, 2), key(5, 2), key(6, 2)], exact: true, makes: ['bomb', 4, 2] },
  },
  {
    name: 'T shape',
    gems: [[4, 1, X], [4, 3, X], [5, 2, X], [6, 2, X], [3, 2, X]],
    move: DOWN_INTO_ROW4,
    input: 'tap',
    expect: { cleared: [key(4, 1), key(4, 2), key(4, 3), key(5, 2), key(6, 2)], exact: true, makes: ['bomb', 4, 2] },
  },
  {
    name: 'line blaster across',
    gems: [[4, 0, X, 'lineH'], [4, 1, X], [3, 2, X]],
    move: DOWN_INTO_ROW4,
    input: 'tap',
    expect: { cleared: rowCells(4), exact: true },
  },
  {
    name: 'line blaster down',
    gems: [[4, 0, X, 'lineV'], [4, 1, X], [3, 2, X]],
    move: DOWN_INTO_ROW4,
    input: 'swipe',
    expect: { cleared: [...colCells(0), key(4, 1), key(4, 2)], exact: true },
  },
  {
    name: 'bomb',
    gems: [[4, 0, X], [4, 1, X, 'bomb'], [3, 2, X]],
    move: DOWN_INTO_ROW4,
    input: 'tap',
    expect: { cleared: [...around(4, 1), key(4, 2)], exact: true },
  },
  {
    name: 'chain: line blast sets off a bomb',
    gems: [[4, 0, X, 'lineH'], [4, 1, X], [3, 2, X], [4, 6, Y, 'bomb']],
    move: DOWN_INTO_ROW4,
    input: 'swipe',
    expect: { cleared: [...rowCells(4), ...around(4, 6)], exact: true },
  },
  {
    name: 'hypercube + gem',
    gems: [[4, 4, -1, 'hyper']],
    move: [[4, 4], [4, 5]],
    input: 'tap',
    // Every gem of the colour it was swapped with, and both swapped cells.
    expect: { clearedColourOf: [4, 5], exact: true },
  },
  {
    name: 'hypercube × 2',
    gems: [[4, 3, -1, 'hyper'], [4, 4, -1, 'hyper']],
    move: [[4, 3], [4, 4]],
    input: 'swipe',
    expect: { cleared: Array.from({ length: ROWS }, (_, r) => rowCells(r)).flat(), exact: true },
  },
  {
    name: 'no match bounces back',
    gems: [],
    move: [[0, 0], [0, 1]],
    input: 'tap',
    expect: { rejected: true },
  },
];

// ── chromium ──────────────────────────────────────────────────────────────────

const chrome = spawn(
  'chromium',
  [
    '--headless=new',
    '--no-sandbox',
    ...gpuFlags(),
    '--disable-dev-shm-usage',
    '--hide-scrollbars',
    '--mute-audio',
    `--remote-debugging-port=${PORT}`,
    'about:blank',
  ],
  // Own process group, so cleanup can take down the GPU and renderer children too.
  { stdio: 'ignore', detached: true },
);
const cleanup = () => {
  try {
    process.kill(-chrome.pid, 'SIGKILL');
  } catch {
    /* already gone */
  }
};
process.on('exit', cleanup);
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    cleanup();
    process.exit(1);
  });
}

async function findTarget() {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  throw new Error('devtools endpoint never came up');
}

const ws = new WebSocket(await findTarget());
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});
let messageId = 0;
const pending = new Map();
const pageErrors = [];
ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
    return;
  }
  if (message.method === 'Runtime.exceptionThrown') {
    const d = message.params.exceptionDetails;
    pageErrors.push(d.exception?.description ?? d.text);
  }
};
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++messageId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) {
    throw new Error(`eval failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
  }
  return result.result.value;
};
const waitFor = async (expression, label, timeoutMs = 20000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(expression).catch(() => false)) return;
    await sleep(120);
  }
  throw new Error(`timed out waiting for ${label}`);
};

// ── touch ─────────────────────────────────────────────────────────────────────

const touch = (type, x, y) =>
  send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });

/** Page position of a board cell's centre. */
const cellOnPage = (row, col) =>
  evaluate(`(() => {
    const s = window.gemfall.scene.getScene('game');
    const c = s.cellCenter({ row: ${row}, col: ${col} });
    const r = document.querySelector('canvas').getBoundingClientRect();
    const L = window.gemfallLayout;
    return { x: r.left + c.x * r.width / L.width, y: r.top + c.y * r.height / L.height };
  })()`);

async function tap(row, col) {
  const p = await cellOnPage(row, col);
  await touch('touchStart', p.x, p.y);
  await sleep(50);
  await touch('touchEnd', p.x, p.y);
  await sleep(120);
}

async function swipe([ar, ac], [br, bc]) {
  const a = await cellOnPage(ar, ac);
  const b = await cellOnPage(br, bc);
  await touch('touchStart', a.x, a.y);
  for (let i = 1; i <= 6; i++) {
    await sleep(16);
    await touch('touchMove', a.x + ((b.x - a.x) * i) / 6, a.y + ((b.y - a.y) * i) / 6);
  }
  await touch('touchEnd', b.x, b.y);
  await sleep(120);
}

// ── start an Endless game on Normal (8×8, 6 colours) ──────────────────────────

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', PHONE);
await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await send('Page.navigate', { url: BASE });
await waitFor(`!!document.querySelector('#front.menu.settled')`, 'the menu');
const picks = await evaluate(`({ mode: window.gemfallMenu.mode, difficulty: window.gemfallMenu.difficulty })`);
if (picks.mode !== 'endless' || picks.difficulty !== 'normal') {
  throw new Error(`menu should open on Endless · Normal, got ${JSON.stringify(picks)}`);
}
await evaluate(`document.querySelector('#front .play').click(), true`);
await waitFor(`window.gemfall.scene.isActive('game') && !!document.querySelector('#front.gone')`, 'the game');
await waitFor(`!window.gemfall.scene.getScene('game').busy`, 'the board to settle');
await sleep(800);

// Record what each move clears and which power gems it makes. The game's own methods are
// wrapped, not replaced: every move still runs the real code.
await evaluate(`(() => {
  const s = window.gemfall.scene.getScene('game');
  window.__log = { clears: [], spawns: [] };
  const animateClear = s.animateClear;
  s.animateClear = function (cells, ...rest) {
    window.__log.clears.push(cells.map((p) => p.row + ',' + p.col));
    return animateClear.call(this, cells, ...rest);
  };
  const createSprite = s.createSprite;
  s.createSprite = function (cell, pos, rowsAbove, popIn) {
    // Only power gems a match makes pop in; refills and rebuilt boards don't.
    if (popIn) window.__log.spawns.push({ step: window.__log.clears.length, special: cell.special, row: pos.row, col: pos.col });
    return createSprite.call(this, cell, pos, rowsAbove, popIn);
  };
  return true;
})()`);

const state = () =>
  evaluate(`(() => {
    const s = window.gemfall.scene.getScene('game');
    return {
      busy: s.busy,
      over: s.over,
      score: s.score,
      gems: s.grid.flat().filter(Boolean).length,
      sprites: s.spriteOf.size,
      grid: s.grid.map((r) => r.map((c) => (c ? c.type + ':' + c.special : '-')).join(' ')).join('|'),
    };
  })()`);

/** Until the board has been still for a moment (a stuck board reshuffles after a move). */
async function settle() {
  const by = Date.now() + 30000;
  let quiet = 0;
  while (Date.now() < by && quiet < 5) {
    quiet = (await evaluate(`window.gemfall.scene.getScene('game').busy`)) ? 0 : quiet + 1;
    await sleep(150);
  }
}

// ── play each scenario ────────────────────────────────────────────────────────

const problems = [];
const results = [];

for (const scenario of SCENARIOS) {
  const fail = (why) => {
    problems.push(`${scenario.name}: ${why}`);
    results.push(`FAIL  ${scenario.name}: ${why}`);
  };
  const grid = board(scenario.gems);

  // The test's own board must be right before the game is asked anything.
  if (runs(grid).length) {
    fail(`set-up board already has a match ${JSON.stringify(runs(grid)[0].map((c) => [c.row, c.col]))}`);
    continue;
  }
  const after = swapped(grid, scenario.move);
  const hyperMove = scenario.gems.some((g) => g[3] === 'hyper');
  if (!hyperMove && !scenario.expect.rejected && runs(after).some((run) => run[0].t !== X)) {
    fail('set-up move would also match filler gems');
    continue;
  }

  await evaluate(`((grid) => {
    const s = window.gemfall.scene.getScene('game');
    s.clearHint();
    // The filler can't match, so after a move the board is often stuck and reshuffles itself.
    // Endless would run out of shuffles and end the game partway through the test.
    s.shufflesLeft = 99;
    s.grid = grid.map((r) => r.map((c) => ({ type: c.t, special: c.s })));
    s.buildSprites();
    s.lastMoveAt = performance.now();
    window.__log.clears = [];
    window.__log.spawns = [];
    return true;
  })(${JSON.stringify(grid)})`);
  await sleep(300);
  const before = await state();

  const [a, b] = scenario.move;
  if (scenario.input === 'swipe') await swipe(a, b);
  else {
    await tap(a[0], a[1]);
    await tap(b[0], b[1]);
  }

  // Wait for the move to start, then for the board to settle.
  const startBy = Date.now() + 2500;
  let started = false;
  while (Date.now() < startBy) {
    const log = await evaluate('window.__log.clears.length');
    if (log > 0 || (await evaluate(`window.gemfall.scene.getScene('game').busy`))) {
      started = true;
      break;
    }
    await sleep(100);
  }
  if (started) await settle();
  else await sleep(600);
  const log = await evaluate('window.__log');
  const end = await state();

  if (end.gems !== ROWS * COLS) fail(`board not full after the move (${end.gems} gems)`);
  else if (end.sprites !== ROWS * COLS) fail(`${end.sprites} gem sprites for ${ROWS * COLS} gems`);
  if (end.over) fail('the game ended');

  const expect = scenario.expect;
  if (expect.rejected) {
    if (log.clears.length) fail(`a non-matching swap cleared ${log.clears[0].length} gems`);
    else if (end.grid !== before.grid) fail('the board changed after a swap that should bounce back');
    else if (end.score !== before.score) fail('the score changed after a swap that should bounce back');
    else results.push(`ok    ${scenario.name} (${scenario.input})`);
    continue;
  }
  if (!log.clears.length) {
    fail(`nothing cleared after the ${scenario.input}`);
    continue;
  }

  let want = expect.cleared;
  if (expect.clearedColourOf) {
    const [r, c] = expect.clearedColourOf;
    const colour = grid[r][c].t;
    want = [key(...scenario.move[0]), key(...scenario.move[1])];
    after.forEach((cells, row) => cells.forEach((cell, col) => cell.t === colour && want.push(key(row, col))));
  }
  const got = new Set(log.clears[0]);
  const wanted = new Set(want);
  const missing = [...wanted].filter((k) => !got.has(k));
  const extra = [...got].filter((k) => !wanted.has(k));
  if (missing.length) fail(`first clear missed ${missing.join(' ')}`);
  else if (expect.exact && extra.length) fail(`first clear also took ${extra.join(' ')}`);

  const made = log.spawns.filter((s) => s.step === 1);
  if (expect.makes === null && made.length) fail(`made a ${made[0].special} it shouldn't have`);
  if (expect.makes) {
    const [special, row, col] = expect.makes;
    const hit = made.find((s) => s.special === special);
    if (!hit) fail(`no ${special} made (made: ${made.map((s) => s.special).join(', ') || 'nothing'})`);
    else if (hit.row !== row || hit.col !== col) fail(`${special} made at ${hit.row},${hit.col}, not ${row},${col}`);
    else {
      // It should still be on the board for the player to use: made where the gem landed,
      // then dropped by however many cleared cells were under it.
      const landed = row + log.clears[0].filter((k) => k.endsWith(`,${col}`) && +k.split(',')[0] > row).length;
      const cell = await evaluate(`(() => { const c = window.gemfall.scene.getScene('game').grid[${landed}][${col}]; return c && c.special; })()`);
      // A random refill can line up with it and set it off; then a later clear holds it.
      const setOff = log.clears.slice(1).some((cells) => cells.includes(key(landed, col)));
      if (cell !== special && !setOff) fail(`the ${special} isn't at ${landed},${col} after the move (found ${cell})`);
    }
  }
  if (end.score <= before.score) fail(`score didn't go up (${before.score} → ${end.score})`);

  if (!problems.some((p) => p.startsWith(`${scenario.name}:`))) {
    results.push(
      `ok    ${scenario.name} (${scenario.input}): cleared ${got.size}` +
        (expect.makes ? `, made ${expect.makes[0]}` : '') +
        `, +${(end.score - before.score).toLocaleString()} pts`,
    );
  }
  if (expect.makes) {
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    const file = `${OUT_DIR}/powerups-${scenario.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.png`;
    writeFileSync(file, Buffer.from(data, 'base64'));
  }
}

for (const e of pageErrors) problems.push(`page error: ${e}`);

console.log();
for (const line of results) console.log(line);
console.log();
if (problems.length) {
  console.log('POWERUPS FAIL');
  for (const p of problems) console.log(` - ${p}`);
  process.exit(1);
}
console.log(`POWERUPS PASS (${SCENARIOS.length} scenarios)`);
process.exit(0);
