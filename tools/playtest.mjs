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
//
// The menu is HTML over the canvas (src/ui/front.ts). The boot splash stays up for 1.5 s and
// then the menu grows out of it; judge it once the entrance has finished (#front.settled).

await waitFor(`!!document.querySelector('#front.menu.settled')`, 'the menu to settle after the splash');
const menuVisible = await evaluate(`window.gemfall.scene.isActive('menu')`);
console.log('menu active:', menuVisible);
if (!menuVisible) problems.push('menu scene never became active');
await screenshot('menu');

/** Page-space boxes of the menu's buttons, grouped by row, plus the text each one needs. */
const menuRows = await evaluate(`
  (() => {
    const box = (b) => {
      const r = b.getBoundingClientRect();
      return {
        left: r.left, right: r.right, top: r.top, bottom: r.bottom,
        cx: r.left + r.width / 2, cy: r.top + r.height / 2,
        // Overflow: the text itself spilling past the button. (Not scrollWidth: the chips'
        // bigger invisible tap area would count as overflow.)
        overflow: (() => {
          const range = document.createRange();
          range.selectNodeContents(b);
          const t = range.getBoundingClientRect();
          return t.left < r.left - 1 || t.right > r.right + 1;
        })(),
        name: b.dataset.mode || b.dataset.difficulty || b.textContent.trim(),
        selected: b.getAttribute('aria-pressed') === 'true',
      };
    };
    const rows = {};
    const groups = { mode: '#front .modes .mode', difficulty: '#front .chips.difficulty .chip' };
    for (const [group, sel] of Object.entries(groups)) {
      const boxes = [...document.querySelectorAll(sel)].map(box);
      const gaps = [];
      for (let i = 0; i < boxes.length - 1; i++) gaps.push(+(boxes[i + 1].left - boxes[i].right).toFixed(1));
      rows[group] = { boxes, gaps };
    }
    const play = document.querySelector('#front .play');
    rows.play = play ? { boxes: [box(play)], gaps: [] } : null;
    return rows;
  })()
`);

const viewportW = (await evaluate('innerWidth')) ?? 0;
for (const [group, row] of Object.entries(menuRows)) {
  if (!row || !row.boxes.length) {
    problems.push(`menu ${group} buttons not found`);
    continue;
  }
  console.log(`${group}: ${row.boxes.map((b) => `${b.name}[${Math.round(b.left)},${Math.round(b.right)}]`).join(' ')} gaps=${JSON.stringify(row.gaps)}`);
  // Rows may wrap on a narrow phone, so only neighbours on the same line can overlap.
  row.boxes.forEach((b, i) => {
    const next = row.boxes[i + 1];
    if (next && Math.abs(next.cy - b.cy) < 4 && next.left - b.right < 2) {
      problems.push(`${group} buttons '${b.name}' and '${next.name}' overlap`);
    }
    if (b.overflow) problems.push(`${group} button '${b.name}' text overflows`);
    if (b.left < 0 || b.right > viewportW) problems.push(`${group} button '${b.name}' runs off screen`);
  });
}

// ── readability on the phone (AMOLED, ~409 ppi) ──────────────────────────────
//
// Every piece of menu text must be at least 12 CSS px and reach 4.5:1 contrast (WCAG AA)
// against what is really behind it: the element's own and its ancestors' background colours,
// composited over the page's true black. PLAY NOW's label sits on a gradient, so it is judged
// against the gradient's lightest stop instead.
const readabilityOf = (rootSelector) => evaluate(`
  (() => {
    const parse = (c) => {
      const m = c.match(/rgba?\\(([^)]+)\\)/);
      if (!m) return null;
      const [r, g, b, a = 1] = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
      return { r, g, b, a };
    };
    const over = (top, under) => ({
      r: top.r * top.a + under.r * (1 - top.a),
      g: top.g * top.a + under.g * (1 - top.a),
      b: top.b * top.a + under.b * (1 - top.a),
      a: 1,
    });
    const lum = ({ r, g, b }) => {
      const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
    const out = [];
    const front = document.querySelector('${rootSelector}');
    const walker = document.createTreeWalker(front, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent.trim();
      const el = node.parentElement;
      if (!text || !el || !el.getClientRects().length) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none') continue;
      // Background: stack the ancestors' colours over black, innermost last.
      const chain = [];
      for (let e = el; e && e !== front.parentElement; e = e.parentElement) chain.push(e);
      let bg = { r: 0, g: 0, b: 0, a: 1 };
      for (const e of chain.reverse()) {
        const c = parse(getComputedStyle(e).backgroundColor);
        if (c && c.a > 0) bg = over(c, bg);
      }
      if (el.closest('.play')) bg = { r: 136, g: 34, b: 255, a: 1 };
      let fg = parse(cs.color);
      let opacity = 1;
      for (let e = el; e && e !== front.parentElement; e = e.parentElement) opacity *= Number(getComputedStyle(e).opacity);
      fg = over({ ...fg, a: fg.a * opacity }, bg);
      out.push({ text: text.slice(0, 28), px: parseFloat(cs.fontSize), contrast: +ratio(fg, bg).toFixed(2) });
    }
    return out;
  })()
`);
const readability = await readabilityOf('#front');
const unreadable = readability.filter((t) => t.px < 12 || t.contrast < 4.5);
console.log(`menu text: ${readability.length} pieces, smallest ${Math.min(...readability.map((t) => t.px))}px, lowest contrast ${Math.min(...readability.map((t) => t.contrast))}:1`);
for (const t of unreadable) {
  problems.push(`menu text '${t.text}' is hard to read on a phone (${t.px}px, ${t.contrast}:1; needs >= 12px and >= 4.5:1)`);
}

/** Tap a page point (CSS px) with the mouse. */
const tapPage = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', clickCount: 0 });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  await sleep(60);
};

/** Tap the centre of an element found by selector; false if it isn't on screen. */
const tapSelector = async (selector) => {
  const at = await evaluate(`
    (() => {
      const e = document.querySelector(${JSON.stringify(selector)});
      if (!e || !e.getClientRects().length) return null;
      const r = e.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()
  `);
  if (!at) return false;
  await tapPage(at.x, at.y);
  return true;
};
const storedSettings = () => evaluate(`JSON.parse(localStorage.getItem('bejeweled.settings.v1') || '{}')`);

// ── corner buttons: speaker (mute) and gear (settings) ───────────────────────

if (!(await tapSelector('#corners .speaker'))) problems.push('corner speaker not on the menu');
const mutedOnce = await storedSettings();
const slashShown = await evaluate(`getComputedStyle(document.querySelector('#corners .speaker .slash')).display !== 'none'`);
console.log(`speaker tapped: muted=${mutedOnce.muted} slash=${slashShown}`);
if (mutedOnce.muted !== true || !slashShown) problems.push('the speaker did not mute (or show its red slash)');
await tapSelector('#corners .speaker');
if ((await storedSettings()).muted !== false) problems.push('the speaker did not unmute');

if (!(await tapSelector('#corners .gear'))) problems.push('corner gear not on the menu');
await sleep(400); // the sheet slides up for 260 ms; tap once it has landed
const sheetOpen = await evaluate(`!!document.querySelector('#settings:not([hidden])')`);
if (!sheetOpen) {
  problems.push('the gear did not open settings');
} else {
  const names = await evaluate(`[...document.querySelectorAll('#settings .name')].map((n) => n.textContent)`);
  console.log('settings rows:', JSON.stringify(names));
  for (const want of ['Sound effects', 'Music']) {
    if (!names.includes(want)) problems.push(`settings has no '${want}' switch`);
  }
  // Each switch flips its own setting and nothing else.
  const switches = await evaluate(`[...document.querySelectorAll('#settings .switch')].length`);
  if (switches >= 2) {
    await tapSelector('#settings .row:nth-of-type(1) .switch');
    const afterEffects = await storedSettings();
    await tapSelector('#settings .row:nth-of-type(2) .switch');
    const afterMusic = await storedSettings();
    console.log(`effects switch -> effects=${afterEffects.effects} music=${afterEffects.music}; music switch -> music=${afterMusic.music}`);
    if (afterEffects.effects !== false || afterEffects.music !== true) problems.push('the Sound effects switch changed the wrong setting');
    if (afterMusic.music !== false) problems.push('the Music switch did not turn music off');
    // Put them back for the rest of the run.
    await tapSelector('#settings .row:nth-of-type(1) .switch');
    await tapSelector('#settings .row:nth-of-type(2) .switch');
  }
  const sheetText = await readabilityOf('#settings');
  for (const t of sheetText.filter((x) => x.px < 12 || x.contrast < 4.5)) {
    problems.push(`settings text '${t.text}' is hard to read on a phone (${t.px}px, ${t.contrast}:1)`);
  }
  await tapSelector('#settings .done');
  if (await evaluate(`!!document.querySelector('#settings:not([hidden])')`)) problems.push('Done did not close settings');
}

/** Tap a menu button at the centre of its box and report what got selected. */
const tapAndRead = async (group, name, read) => {
  const b = menuRows[group]?.boxes.find((x) => x.name === name);
  if (!b) {
    problems.push(`${group} button '${name}' not found`);
    return null;
  }
  await tapPage(b.cx, b.cy);
  return evaluate(`window.gemfallMenu.${read}`);
};

// The centre of every mode card and difficulty chip must pick that one, including the
// first and last, whose neighbours would steal a misplaced tap.
for (const name of ['moves', 'timed', 'endless']) {
  const got = await tapAndRead('mode', name, 'mode');
  if (got !== name) problems.push(`tapping the centre of the '${name}' card selected '${got}'`);
}
for (const name of ['hard', 'easy', 'normal']) {
  const got = await tapAndRead('difficulty', name, 'difficulty');
  if (got !== name) problems.push(`tapping the centre of the '${name}' chip selected '${got}'`);
}
const shown = await evaluate(`[...document.querySelectorAll('#front [aria-pressed="true"]')].map((b) => b.dataset.mode || b.dataset.difficulty)`);
console.log('selected on screen:', JSON.stringify(shown));
if (JSON.stringify(shown) !== JSON.stringify(['endless', 'normal'])) {
  problems.push(`menu highlights ${JSON.stringify(shown)}, expected endless + normal`);
}

// Settle on the run we actually want to play.
await tapAndRead('mode', 'moves', 'mode');
await tapAndRead('difficulty', 'normal', 'difficulty');
console.log('playing: mode=moves difficulty=normal');

// ── start the run ─────────────────────────────────────────────────────────────

const playBox = menuRows.play?.boxes[0];
if (playBox) await tapPage(playBox.cx, playBox.cy);
else problems.push('PLAY NOW not found');
await pump(120);

await waitFor(`window.gemfall.scene.isActive('game')`, 'game scene to start');
console.log('game started:', await sceneState());
await waitFor(`!!document.querySelector('#front.gone')`, 'the menu to fade away');
await pump(60);
await screenshot('game-start');

// In-game text is drawn in the 720-wide game world; on a 411 px-wide phone that world is
// shrunk to 57%, so anything under 21 world px ends up smaller than 12 CSS px.
const smallGameText = await evaluate(`
  (() => {
    const s = window.gemfall.scene.getScene('game');
    const texts = [];
    const visit = (o) => {
      if (o.type === 'Text' && o.visible && o.text.trim()) texts.push({ text: o.text.trim().slice(0, 24), size: parseFloat(o.style.fontSize) * (o.scaleY || 1) });
      if (o.list) o.list.forEach(visit);
    };
    s.children.list.forEach(visit);
    return texts.filter((t) => t.size < 21);
  })()
`);
for (const t of smallGameText) {
  problems.push(`game text '${t.text}' is ${t.size} world px, under 12 px on a phone (needs >= 21)`);
}

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

// ── back to the menu ──────────────────────────────────────────────────────────
//
// The in-game MENU button must bring the HTML menu back over the canvas, still set to the
// run that was just played, and with the saved run offered to resume.
const menuPillAt = await evaluate(`
  (() => {
    const p = window.gemfall.scene.getScene('game').hudPills.get('menu');
    return p ? { x: p.x, y: p.y } : null;
  })()
`);
if (menuPillAt) {
  await click(menuPillAt.x, menuPillAt.y);
  await pump(30);
  const back = await waitFor(`!!document.querySelector('#front.menu:not(.hidden):not(.gone)')`, 'the menu to come back')
    .then(() => true)
    .catch(() => false);
  const picks = await evaluate(`({ mode: window.gemfallMenu.mode, difficulty: window.gemfallMenu.difficulty, resume: !!document.querySelector('#front .resume') })`);
  console.log('back on the menu:', back, JSON.stringify(picks));
  if (!back) problems.push('the MENU button did not bring the menu back');
  else if (picks.mode !== 'moves' || picks.difficulty !== 'normal') {
    problems.push(`menu forgot the run's picks (${picks.mode} / ${picks.difficulty})`);
  }
} else {
  problems.push('in-game MENU button not found');
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
