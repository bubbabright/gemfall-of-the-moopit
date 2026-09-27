/**
 * Headless playtest driver.
 *
 * Headless Chromium barely ticks requestAnimationFrame, so this script drives Phaser's
 * loop manually (`game.loop.step(t)`) over the Chrome DevTools Protocol, dispatches real
 * mouse input, verifies the game state actually changes, and saves screenshots.
 *
 * It is the integration gate: it checks menu geometry, that a tap on a button's centre
 * hits that button, and that a full move actually resolves on the board.
 *
 * Usage: node tools/playtest.mjs [baseUrl]
 */

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const BASE = process.argv[2] ?? 'http://127.0.0.1:4770';
const PORT = 4780;
const OUT_DIR = 'poc';

mkdirSync(OUT_DIR, { recursive: true });

// ── launch chromium ───────────────────────────────────────────────────────────

const chrome = spawn(
  'chromium',
  [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--hide-scrollbars',
    '--mute-audio',
    '--window-size=760,940',
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
// A killed run (Ctrl-C, `timeout`) skips 'exit', which would leave headless Chromium
// running and burning CPU. Close it on those signals too.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    cleanup();
    process.exit(1);
  });
}

/** Wait for the devtools endpoint, then return the first page target's websocket URL. */
async function findTarget() {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const targets = await res.json();
      const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  throw new Error('devtools endpoint never came up');
}

const wsUrl = await findTarget();
const ws = new WebSocket(wsUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});

let messageId = 0;
const pending = new Map();
const consoleErrors = [];

ws.onmessage = (event) => {
  const message = JSON.parse(event.data);

  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(`${message.error.message} (${JSON.stringify(message.error)})`));
    else resolve(message.result);
    return;
  }

  if (message.method === 'Runtime.exceptionThrown') {
    const details = message.params.exceptionDetails;
    consoleErrors.push(`EXCEPTION: ${details.exception?.description ?? details.text}`);
  }
  if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
    consoleErrors.push(`CONSOLE.ERROR: ${message.params.args.map((a) => a.value ?? a.description).join(' ')}`);
  }
};

const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++messageId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) {
    throw new Error(`eval failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
  }
  return result.result.value;
};

// ── page plumbing ─────────────────────────────────────────────────────────────

await send('Page.enable');
await send('Runtime.enable');

// Count vibration requests. This has to be installed before the page loads, because
// src/haptics.ts decides whether the platform supports vibration when it initialises.
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `
    window.__vibes = [];
    const record = (pattern) => { window.__vibes.push(pattern); return true; };
    if (navigator.vibrate) {
      navigator.vibrate = record;
    } else {
      Object.defineProperty(navigator, 'vibrate', { configurable: true, value: record });
    }
    'ok';
  `,
});

await send('Page.navigate', { url: BASE });
await sleep(1500);

/** Install a monotonic frame pump, since rAF is throttled in headless. */
const installPump = `
  window.__t = performance.now();
  window.__pump = (frames, dt = 16.7) => {
    const game = window.gemfall;
    if (!game) return 0;
    for (let i = 0; i < frames; i++) { window.__t += dt; game.loop.step(window.__t); }
    return game.loop.frame;
  };
  'ok'
`;

const pump = (frames) => evaluate(`window.__pump(${frames})`);

const waitFor = async (expression, label, timeoutMs = 15000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return true;
    await sleep(120);
  }
  throw new Error(`timed out waiting for ${label}`);
};

await waitFor('!!window.gemfall', 'phaser to boot');
await evaluate(installPump);
await pump(80);
await evaluate('true');

// Phaser input needs the canvas to have bounds and the scale manager to be ready.
const canvasInfo = await evaluate(`
  (() => {
    const c = document.querySelector('canvas');
    const r = c.getBoundingClientRect();
    return {
      w: r.width,
      h: r.height,
      left: r.left,
      top: r.top,
      dpr: window.devicePixelRatio,
      viewport: { w: window.innerWidth, h: window.innerHeight },
      // Logical size the scenes lay out in (720 wide; height follows the screen).
      game: window.gemfallLayout ?? { width: 720, height: 900, zoom: 1, tile: 72 },
    };
  })()
`);
const build = await evaluate(
  `({ version: window.gemfallVersion ?? null, phaser: window.gemfallPhaser ?? null })`,
);
console.log(`build: ${build.version ?? 'unknown'}  (phaser ${build.phaser ?? '?'})`);

console.log('canvas rect:', canvasInfo);

/** Game coordinates → viewport coordinates. */
const toPage = (gx, gy) => ({
  x: canvasInfo.left + (gx * canvasInfo.w) / canvasInfo.game.width,
  y: canvasInfo.top + (gy * canvasInfo.h) / canvasInfo.game.height,
});

const click = async (gx, gy) => {
  const { x, y } = toPage(gx, gy);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', clickCount: 0 });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
};

const screenshot = async (name) => {
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  const path = `${OUT_DIR}/${name}.png`;
  writeFileSync(path, Buffer.from(data, 'base64'));
  console.log(`saved ${path}`);
  return path;
};

const problems = [];

const sceneState = () =>
  evaluate(`
    (() => {
      const s = window.gemfall.scene.getScene('game');
      if (!s || !s.grid) return { active: false };
      const cells = s.grid.flat().filter(Boolean).length;
      return {
        active: true,
        mode: s.mode,
        difficulty: s.difficulty,
        score: s.score,
        level: s.level,
        movesLeft: Number.isFinite(s.movesLeft) ? s.movesLeft : null,
        busy: s.busy,
        over: s.over,
        paused: s.paused,
        gems: cells,
        sprites: s.spriteOf.size,
        shufflesLeft: Number.isFinite(s.shufflesLeft) ? s.shufflesLeft : null,
      };
    })()
  `);

/**
 * Geometry + hit-area audit for a picker row.
 *
 * `gaps` catches pills that are wide enough to overlap and render as one blob.
 * `widest` catches sub-labels that spill outside their pill.
 * The centre click catches the hit area not being centred on the drawn pill, which made
 * taps land on the neighbouring button.
 */
const pillAudit = (sceneKey) =>
  evaluate(`
    (() => {
      const sc = window.gemfall.scene.getScene('${sceneKey}');
      const rows = {};
      const groups = {
        mode: sc.modePills,
        difficulty: sc.difficultyPills,
        hud: sc.hudPills,
      };
      for (const [group, source] of Object.entries(groups)) {
        if (!source) continue;
        const list = source instanceof Map
          ? [...source.entries()]
          : source.map((pill, i) => [String(i), pill]);
        const boxes = list.map(([name, pill]) => {
          const w = pill.opts.w;
          const texts = pill.list.filter((k) => k.type === 'Text').map((t) => Math.round(t.displayWidth));
          return {
            name,
            cx: pill.x,
            cy: pill.y,
            left: pill.x - w / 2,
            right: pill.x + w / 2,
            w,
            widestText: texts.length ? Math.max(...texts) : 0,
          };
        });
        const gaps = [];
        for (let i = 0; i < boxes.length - 1; i++) gaps.push(+(boxes[i + 1].left - boxes[i].right).toFixed(1));
        rows[group] = { boxes, gaps };
      }
      return rows;
    })()
  `);

// ── menu ──────────────────────────────────────────────────────────────────────

await pump(60);
const menuVisible = await evaluate(`window.gemfall.scene.isActive('menu')`);
console.log('menu active:', menuVisible);
if (!menuVisible) problems.push('menu scene never became active');
await screenshot('menu');

const menuRows = await pillAudit('menu');
for (const [group, row] of Object.entries(menuRows)) {
  const overlapping = row.gaps.filter((g) => g < 8);
  const overflowing = row.boxes.filter((b) => b.widestText > b.w - 16);
  console.log(
    `${group}: boxes=${row.boxes.map((b) => `[${Math.round(b.left)},${Math.round(b.right)}]`).join(' ')} gaps=${JSON.stringify(row.gaps)}`,
  );
  if (overlapping.length) problems.push(`${group} pills overlap (gaps ${JSON.stringify(row.gaps)})`);
  for (const b of overflowing) {
    problems.push(`${group} pill '${b.name}' text overflows (${b.widestText}px in ${b.w}px)`);
  }
}

// The sound and haptics toggles share one row and are not part of the picker maps, so
// audit them here for overlap and label overflow.
const toggles = await evaluate(`
  (() => {
    const sc = window.gemfall.scene.getScene('menu');
    const out = {};
    for (const [name, pill] of [['buzz', sc.hapticPill], ['sound', sc.mutePill]]) {
      if (!pill) { out[name] = null; continue; }
      const texts = pill.list.filter((k) => k.type === 'Text').map((t) => Math.round(t.displayWidth));
      out[name] = {
        left: pill.x - pill.opts.w / 2,
        right: pill.x + pill.opts.w / 2,
        w: pill.opts.w,
        widestText: texts.length ? Math.max(...texts) : 0,
      };
    }
    return out;
  })()
`);
if (toggles.buzz && toggles.sound) {
  const gap = toggles.sound.left - toggles.buzz.right;
  console.log(
    `toggles: buzz=[${Math.round(toggles.buzz.left)},${Math.round(toggles.buzz.right)}] ` +
      `sound=[${Math.round(toggles.sound.left)},${Math.round(toggles.sound.right)}] gap=${gap.toFixed(1)}`,
  );
  if (gap < 8) problems.push(`sound/haptics toggles overlap (gap ${gap.toFixed(1)}px)`);
  for (const [name, t] of Object.entries(toggles)) {
    if (t.left < 18) problems.push(`${name} toggle runs off the left edge (${Math.round(t.left)})`);
    if (t.widestText > t.w - 16) {
      problems.push(`${name} toggle label overflows (${t.widestText}px in ${t.w}px)`);
    }
  }
} else {
  problems.push('sound/haptics toggle pills not found');
}

/** Click a pill by its own declared centre and report what got selected. */
const clickPillAndRead = async (sceneKey, group, name, readExpr) => {
  const centre = await evaluate(`
    (() => {
      const sc = window.gemfall.scene.getScene('${sceneKey}');
      const pill = sc.${group}.get('${name}');
      return pill ? { x: pill.x, y: pill.y } : null;
    })()
  `);
  if (!centre) {
    problems.push(`${group} pill '${name}' not found`);
    return null;
  }
  await click(centre.x, centre.y);
  await pump(20);
  return evaluate(readExpr);
};

const modeRead = `window.gemfall.scene.getScene('menu').mode`;
const difficultyRead = `window.gemfall.scene.getScene('menu').difficulty`;

const chosenMode = await clickPillAndRead('menu', 'modePills', 'moves', modeRead);
console.log(`tapped the centre of 'moves' -> mode='${chosenMode}'`);
if (chosenMode !== 'moves') problems.push(`tapping the centre of the 'moves' pill selected '${chosenMode}'`);

const chosenDifficulty = await clickPillAndRead('menu', 'difficultyPills', 'normal', difficultyRead);
console.log(`tapped the centre of 'normal' -> difficulty='${chosenDifficulty}'`);
if (chosenDifficulty !== 'normal') problems.push(`tapping the centre of the 'normal' pill selected '${chosenDifficulty}'`);

// Also verify the first pill in each row, since the bug made the *right* half of a pill dead.
const chosenFirstMode = await clickPillAndRead('menu', 'modePills', 'endless', modeRead);
if (chosenFirstMode !== 'endless') problems.push(`tapping 'endless' selected '${chosenFirstMode}'`);
const chosenFirstDifficulty = await clickPillAndRead('menu', 'difficultyPills', 'easy', difficultyRead);
if (chosenFirstDifficulty !== 'easy') problems.push(`tapping 'easy' selected '${chosenFirstDifficulty}'`);

// Settle back on the run we actually want to play.
await clickPillAndRead('menu', 'modePills', 'moves', modeRead);
await clickPillAndRead('menu', 'difficultyPills', 'normal', difficultyRead);
console.log('playing: mode=moves difficulty=normal');

// ── start the run ─────────────────────────────────────────────────────────────

const playCentre = await evaluate(`
  (() => {
    const sc = window.gemfall.scene.getScene('menu');
    const pill = sc.children.list.find((o) => o.opts && o.opts.label === 'PLAY');
    return pill ? { x: pill.x, y: pill.y } : { x: 360, y: 576 };
  })()
`);
await click(playCentre.x, playCentre.y);
await pump(120);

await waitFor(`window.gemfall.scene.isActive('game')`, 'game scene to start');
console.log('game started:', await sceneState());
await pump(60);
await screenshot('game-start');

const hudRows = await pillAudit('game');
if (hudRows.hud) {
  console.log(`hud gaps: ${JSON.stringify(hudRows.hud.gaps)}`);
  if (hudRows.hud.gaps.some((g) => g < 8)) problems.push(`hud pills overlap (gaps ${JSON.stringify(hudRows.hud.gaps)})`);
}

// ── play real moves ───────────────────────────────────────────────────────────

let movesPlayed = 0;
/** Game-time (ms) each move spent animating, for the "clears are readable" check. */
const moveAnimMs = [];
for (let attempt = 0; attempt < 10; attempt++) {
  // Ask the game itself for a legal move, then click both of its cells.
  const hint = await evaluate(`
    (() => {
      const s = window.gemfall.scene.getScene('game');
      s.showHint(false);
      return {
        ax: s.hintRingA.x, ay: s.hintRingA.y,
        bx: s.hintRingB.x, by: s.hintRingB.y,
        visible: s.hintRingA.visible,
      };
    })()
  `);

  if (!hint.visible) {
    await pump(30);
    continue;
  }

  await click(hint.ax, hint.ay);
  await pump(6);
  await click(hint.bx, hint.by);

  // Let the cascade play out. A single clear animation is TIMING.clearMs (900ms)
  // and a chain stacks several of them plus falls, so allow a generous window.
  // The loop exits as soon as the scene reports idle.
  let busyFrames = 0;
  for (let i = 0; i < 120; i++) {
    await pump(6);
    // Tweens run on the wall clock (TweenManager uses Date.now()), not on pumped frames, so
    // let about 6 frames' worth of real time pass too. Without it a fast machine pumps
    // faster than the tweens can move and a move never finishes.
    await sleep(100);
    busyFrames += 6;
    const state = await sceneState();
    if (!state.busy) break;
  }
  moveAnimMs.push(busyFrames * 16.7);

  movesPlayed += 1;
  const state = await sceneState();
  console.log(
    `move ${movesPlayed}: score=${state.score} movesLeft=${state.movesLeft} gems=${state.gems} sprites=${state.sprites} anim=${Math.round(busyFrames * 16.7)}ms`,
  );

  if (state.over) break;
}

await pump(40);
const finalState = await sceneState();
console.log('final state:', finalState);

const screenshotPath = await screenshot('game-played');

// Persist the ground-truth geometry so the offline PIL checker (analyze-shots.py)
// does not have to guess the canvas mapping back out of pixel data.
const gameGeometry = await evaluate(`
  (() => {
    const s = window.gemfall.scene.getScene('game');
    return { boardX: s.boardX, boardY: s.boardY, cols: s.spec.cols, rows: s.spec.rows, tile: window.gemfallLayout?.tile ?? 72 };
  })()
`);
writeFileSync(
  `${OUT_DIR}/geometry.json`,
  JSON.stringify({ canvas: canvasInfo, menu: menuRows, game: gameGeometry }, null, 2),
);
console.log(`saved ${OUT_DIR}/geometry.json`);

// ── sprite audit ─────────────────────────────────────────────────────────────
//
// Every gem sprite must be owned by exactly one grid cell, fully opaque, and not
// tint-filled once the board has settled. A gem sprite that survived a clear would
// linger on the board as a translucent ghost, so this is a correctness check, not
// just tidiness.
const spriteAudit = await evaluate(`
  (() => {
    const s = window.gemfall.scene.getScene('game');
    const owned = new Set(s.spriteOf.values());
    const gems = s.children.list.filter(
      (o) => o.texture && /^(gem_|special_)/.test(o.texture.key),
    );
    const describe = (o) => ({
      key: o.texture.key,
      alpha: +o.alpha.toFixed(2),
      scale: +(o.scaleX).toFixed(2),
      at: [Math.round(o.x), Math.round(o.y)],
      visible: o.visible,
    });
    const orphans = gems.filter((o) => !owned.has(o));
    const faded = gems.filter((o) => owned.has(o) && o.alpha < 0.99);
    // Phaser 3 flagged a white-flashed sprite with tintFill; Phaser 4 uses tintMode (1 = FILL).
    const tinted = gems.filter((o) => o.tintFill || o.tintMode === 1);
    return {
      tracked: owned.size,
      gems: gems.length,
      orphans: orphans.map(describe),
      faded: faded.map(describe),
      tinted: tinted.map(describe),
    };
  })()
`);
console.log('sprite audit:', JSON.stringify({
  tracked: spriteAudit.tracked,
  gems: spriteAudit.gems,
  orphans: spriteAudit.orphans.length,
  faded: spriteAudit.faded.length,
  tinted: spriteAudit.tinted.length,
}));
if (spriteAudit.orphans.length) console.log('  orphaned:', JSON.stringify(spriteAudit.orphans));
if (spriteAudit.faded.length) console.log('  faded:', JSON.stringify(spriteAudit.faded));
if (spriteAudit.tinted.length) console.log('  tint-filled:', JSON.stringify(spriteAudit.tinted));

if (spriteAudit.orphans.length > 0) {
  problems.push(`board has ${spriteAudit.orphans.length} orphaned gem sprite(s)`);
}

// Power gems are the only sprites created with a pop-in (they start at alpha 0.15 and
// scale 1.7), and they are created immediately before gravity runs. If the movement
// tween kills the pop-in, the gem stays oversized and translucent on the board — which
// is the "power-ups look see-through" bug. Reproduce the interaction directly.
const popInCheck = await evaluate(`
  (async () => {
    const s = window.gemfall.scene.getScene('game');
    // Must reuse a cell that is actually in the grid: syncPositions skips any cell it
    // has no board position for, so a synthetic cell would pass this test vacuously.
    const pos = { row: 0, col: 0 };
    const cell = s.grid[pos.row][pos.col];
    if (!cell) return { error: 'no cell at origin' };
    s.spriteOf.get(cell)?.destroy();
    const sprite = s.createSprite(cell, pos, 0, true);   // enters its pop-in
    const startAlpha = sprite.alpha;
    const startScale = sprite.scaleX;
    sprite.x += 200;                                     // force a movement, as a fall would
    await s.syncPositions();
    return {
      startAlpha: +startAlpha.toFixed(2),
      startScale: +startScale.toFixed(3),
      endAlpha: +sprite.alpha.toFixed(2),
      endScale: +sprite.scaleX.toFixed(3),
    };
  })()
`);
console.log(
  `power-gem pop-in: starts alpha=${popInCheck.startAlpha}/scale=${popInCheck.startScale} -> ` +
    `after a move alpha=${popInCheck.endAlpha}/scale=${popInCheck.endScale}`,
);
if (popInCheck.error) problems.push(`pop-in check could not run: ${popInCheck.error}`);
if (popInCheck.endAlpha < 0.99) {
  problems.push(
    `power gem frozen mid pop-in (alpha ${popInCheck.endAlpha} after falling) — it will render see-through`,
  );
}
if (spriteAudit.faded.length > 0) {
  problems.push(`board has ${spriteAudit.faded.length} translucent gem sprite(s)`);
}
if (spriteAudit.tinted.length > 0) {
  problems.push(`board has ${spriteAudit.tinted.length} tint-filled gem sprite(s)`);
}

// ── haptics ───────────────────────────────────────────────────────────────────
//
// The explosion should buzz. navigator.vibrate was stubbed before load, so this
// proves the game actually requested a vibration while matches were clearing.
const vibes = await evaluate('window.__vibes');
const vibeCounts = Array.isArray(vibes) ? vibes.length : 0;
console.log(`haptics: ${vibeCounts} vibration request(s) during play`);
// Print every pattern, not a sample, so a missing heavy (power-gem) pattern is visible.
if (vibeCounts > 0) console.log(`  patterns: ${JSON.stringify(vibes)}`);
if (vibeCounts === 0) problems.push('no vibration requested on match explosions');
// Every "on" segment must be long enough for an Android motor to actually spin up. The stub
// accepts anything, so this is the only thing here that catches a pulse too short to feel
// (the old 18 ms tap and 1 ms "unlock" both passed while buzzing nothing on a real phone).
const MIN_ON_MS = 40;
const tooShort = (Array.isArray(vibes) ? vibes : []).filter((p) =>
  (Array.isArray(p) ? p : [p]).some((ms, i) => i % 2 === 0 && ms < MIN_ON_MS),
);
if (tooShort.length > 0) {
  problems.push(`${tooShort.length} vibration pattern(s) with an on-pulse under ${MIN_ON_MS} ms: ${JSON.stringify(tooShort.slice(0, 4))}`);
}

// ── verdict ───────────────────────────────────────────────────────────────────

if (!finalState.active) problems.push('game scene never became active');
if (!finalState.score || finalState.score <= 0) problems.push(`score did not increase (${finalState.score})`);
if (movesPlayed < 3) problems.push(`only ${movesPlayed} moves could be played`);
if (finalState.mode !== 'moves') problems.push(`wrong mode: ${finalState.mode}`);
if (finalState.difficulty !== 'normal') problems.push(`wrong difficulty: ${finalState.difficulty}`);
if (finalState.movesLeft === null || finalState.movesLeft > 30 - movesPlayed) {
  problems.push(`move counter did not decrement (${finalState.movesLeft})`);
}
if (finalState.gems !== 64) problems.push(`board is not full (${finalState.gems} gems)`);
if (finalState.sprites !== finalState.gems) problems.push(`sprite/grid mismatch (${finalState.sprites} vs ${finalState.gems})`);
if (consoleErrors.length > 0) problems.push(`browser errors: ${consoleErrors.join(' | ')}`);

// Feedback regression guard: matches must be visibly destroyed, not blinked away.
// A clear runs TIMING.clearMs plus the fall and settle that follow it, so a real
// move can never resolve in a couple of frames.
const slowestMoveMs = moveAnimMs.length > 0 ? Math.max(...moveAnimMs) : 0;
console.log(`animation time per move (ms): ${moveAnimMs.map((v) => Math.round(v)).join(', ')}`);
if (slowestMoveMs < 600) {
  problems.push(
    `clears resolve too fast to read (slowest move ${Math.round(slowestMoveMs)}ms, expected >= 600ms)`,
  );
}

console.log('\n--- playtest report ---');
console.log(`screenshots: ${OUT_DIR}/menu.png, ${OUT_DIR}/game-start.png, ${screenshotPath}`);
console.log(`moves played: ${movesPlayed}, score: ${finalState.score}, movesLeft: ${finalState.movesLeft}`);
console.log(`slowest move animation: ${Math.round(slowestMoveMs)}ms`);
if (problems.length === 0) {
  console.log('PLAYTEST PASS');
} else {
  console.log('PLAYTEST FAIL');
  for (const problem of problems) console.log(' -', problem);
}

ws.close();
cleanup();
process.exit(problems.length === 0 ? 0 : 1);
