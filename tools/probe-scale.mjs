/**
 * Viewport-scaling gate.
 *
 * Phaser.Scale.FIT should size the canvas to the parent element, so the board fits
 * any window. This measures what actually happens at several viewport sizes and
 * fails if the canvas overflows the window or has the wrong shape.
 *
 * The shape depends on the screen (src/layout.ts): a portrait phone gets a taller
 * game that fills the screen top to bottom; anything squarer keeps the original
 * 720x900. On high-density screens the canvas is also rendered at up to 2x, and on
 * portrait phones a tap on a gem must still select that gem.
 *
 * It exists because the container was once sized by its own content: the 720x900
 * canvas inflated #game to 720x900, Phaser read that as the parent size, computed
 * scale 1.0, and the board never shrank on a phone.
 *
 * Usage: node tools/probe-scale.mjs [baseUrl]
 */

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const BASE = process.argv[2] ?? 'https://gemfall.moopit.fun';
const PORT = 4787;

const VIEWPORTS = [
  // Daniel's phone: 1080 x 2400, 20:9, ~409 ppi. In Chrome and installed (no URL bar).
  { label: '1080x2400 Android in Chrome', width: 411, height: 751, dpr: 2.625, mobile: true },
  { label: '1080x2400 Android installed', width: 411, height: 866, dpr: 2.625, mobile: true },
  { label: 'tall Android (no browser bars)', width: 412, height: 915, dpr: 2.625, mobile: true },
  { label: 'tall Android (with browser bars)', width: 412, height: 780, dpr: 2.625, mobile: true },
  { label: 'iPhone 14 portrait', width: 390, height: 844, dpr: 3, mobile: true },
  { label: 'small Android', width: 360, height: 640, dpr: 2, mobile: true },
  { label: 'phone landscape', width: 844, height: 390, dpr: 3, mobile: true },
  { label: 'iPad-ish', width: 820, height: 1180, dpr: 2, mobile: true },
  { label: 'short desktop', width: 760, height: 797, dpr: 1, mobile: false },
];

const chrome = spawn(
  'chromium',
  [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
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
// A killed run (Ctrl-C, `timeout`) skips 'exit', which would leave headless Chromium
// running and burning CPU. Close it on those signals too.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    cleanup();
    process.exit(1);
  });
}

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

const ws = new WebSocket(await findTarget());
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});

let messageId = 0;
const pending = new Map();

ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
  }
};

/** A DevTools call that never answers fails the gate instead of hanging it. */
const CALL_TIMEOUT_MS = 45_000;
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++messageId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} got no answer in ${CALL_TIMEOUT_MS / 1000}s`));
    }, CALL_TIMEOUT_MS);
    pending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    ws.send(JSON.stringify({ id, method, params }));
  });

const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  }
  return result.result.value;
};

await send('Page.enable');
await send('Runtime.enable');

const pump = `
  window.__t = performance.now();
  window.__pump = (frames, dt = 16.7) => {
    const game = window.gemfall;
    if (!game) return 0;
    for (let i = 0; i < frames; i++) { window.__t += dt; game.loop.step(window.__t); }
    return game.loop.frame;
  };
  'ok'
`;

/** Reads the DOM box plus Phaser's own idea of the canvas size. */
const MEASURE = `
  (() => {
    const game = window.gemfall;
    if (!game) return { error: 'no game' };
    const canvas = document.querySelector('canvas');
    const gameDiv = document.getElementById('game');
    const cr = canvas ? canvas.getBoundingClientRect() : null;
    const gr = gameDiv ? gameDiv.getBoundingClientRect() : null;
    const s = game.scale;
    const MODES = { 0: 'NONE', 1: 'WIDTH_CONTROLS_HEIGHT', 2: 'HEIGHT_CONTROLS_WIDTH',
                    3: 'FIT', 4: 'ENVELOP', 5: 'RESIZE', 6: 'EXPAND' };
    return {
      appVersion: window.gemfallVersion ?? null,
      phaserVersion: window.gemfallPhaser ?? null,
      inner: { w: window.innerWidth, h: window.innerHeight },
      visual: window.visualViewport
        ? { w: Math.round(window.visualViewport.width), h: Math.round(window.visualViewport.height) }
        : null,
      gameDiv: gr ? { w: Math.round(gr.width), h: Math.round(gr.height) } : null,
      canvasBox: cr ? { w: Math.round(cr.width), h: Math.round(cr.height),
                        left: Math.round(cr.left), top: Math.round(cr.top) } : null,
      canvasAttr: canvas ? { w: canvas.width, h: canvas.height } : null,
      canvasStyle: canvas ? { w: canvas.style.width, h: canvas.style.height, margin: canvas.style.margin } : null,
      scaleMode: MODES[s.scaleMode] ?? String(s.scaleMode),
      displaySize: { w: Math.round(s.displaySize.width), h: Math.round(s.displaySize.height) },
      parentSize: { w: s.parentSize.width, h: s.parentSize.height },
      baseSize: { w: s.baseSize.width, h: s.baseSize.height },
      autoCenter: s.autoCenter,
      layout: window.gemfallLayout ?? null,
      dpr: window.devicePixelRatio,
    };
  })()
`;

/**
 * Starts a run, taps the centre of gem (row 2, col 3) with a touch event, and reports
 * which cell the game selected. Proves pointer -> board mapping under the render zoom.
 */
const TAP_ROW = 2;
const TAP_COL = 3;
const BOARD_PROBE = `
  (() => {
    const s = window.gemfall.scene.getScene('game');
    if (!s || !s.sys.isActive() || !s.ready) return null;
    const L = window.gemfallLayout;
    const r = document.querySelector('canvas').getBoundingClientRect();
    const gx = s.boardX + ${TAP_COL} * L.tile + L.tile / 2;
    const gy = s.boardY + ${TAP_ROW} * L.tile + L.tile / 2;
    return {
      x: r.left + (gx * r.width) / L.width,
      y: r.top + (gy * r.height) / L.height,
      selected: s.selected,
    };
  })()
`;

const MAX_HEIGHT = 1600;
const MAX_WIDTH = 1600;
const MIN_LANDSCAPE_ASPECT = 1.67;
const MAX_ZOOM = 2;
const failures = [];

/** What src/layout.ts should pick for a parent box of w x h. */
function expectedLayout(w, h, coarse) {
  if (coarse && w / h >= MIN_LANDSCAPE_ASPECT) {
    const width = Math.min(MAX_WIDTH, Math.round((720 * w) / h));
    return { orientation: 'landscape', width, height: 720, fills: width < MAX_WIDTH };
  }
  const raw = Math.round((720 * h) / w);
  const height = Math.min(MAX_HEIGHT, Math.max(900, raw));
  return { orientation: 'portrait', width: 720, height, fills: raw > 900 && raw < MAX_HEIGHT };
}

const GRID = `JSON.stringify(window.gemfall.scene.getScene('game').grid.map((r) => r.map((c) => c && [c.type, c.special])))`;
const SCORE = `window.gemfall.scene.getScene('game').score`;

/** Pumps the game loop until the game scene is ready (after a start or a rebuild). */
async function waitForBoard() {
  for (let i = 0; i < 40; i++) {
    try {
      await evaluate(pump);
      await evaluate('window.__pump(20)');
      const t = await evaluate(BOARD_PROBE);
      if (t) return t;
    } catch {
      /* not ready yet */
    }
    await sleep(150);
  }
  return null;
}

/** Taps gem (TAP_ROW, TAP_COL) and returns what the game selected. */
async function tapGem() {
  const target = await waitForBoard();
  if (!target) return { error: 'game scene never became ready' };
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: target.x, y: target.y }] });
  await evaluate('window.__pump(2)');
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await evaluate('window.__pump(4)');
  const sel = (await evaluate(BOARD_PROBE))?.selected;
  // Tap again to clear the selection, so later checks start clean.
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: target.x, y: target.y }] });
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await evaluate('window.__pump(4)');
  return { sel, ok: Boolean(sel && sel.row === TAP_ROW && sel.col === TAP_COL) };
}

/** Checks the measured page against the expected layout; returns failure strings. */
function checkLayout(label, m, coarse) {
  const out = [];
  const L = m.layout;
  if (!L) return [`${label}: window.gemfallLayout missing (old build?)`];
  const want = expectedLayout(m.gameDiv.w, m.gameDiv.h, coarse);
  const fitsW = m.canvasBox.w <= m.inner.w + 1;
  const fitsH = m.canvasBox.h <= m.inner.h + 1;
  const aspect = m.canvasBox.w / m.canvasBox.h;
  const wantAspect = want.width / want.height;
  const fills = !want.fills ||
    (Math.abs(m.canvasBox.w - m.gameDiv.w) <= 2 && Math.abs(m.canvasBox.h - m.gameDiv.h) <= 2);
  const wantZoom = Math.min(MAX_ZOOM, Math.max(1, (m.canvasBox.w * m.dpr) / want.width));
  const zoomOk = Math.abs(L.zoom - wantZoom) < 0.02 && Math.abs(m.canvasAttr.w - want.width * L.zoom) <= 1;

  console.log(`   layout        ${L.orientation} ${L.width}x${L.height} tile=${L.tile}` +
    ` (want ${want.orientation} ${want.width}x${want.height})`);
  console.log(`   canvas        ${m.canvasBox.w}x${m.canvasBox.h} in ${m.gameDiv.w}x${m.gameDiv.h}` +
    `  fits=${fitsW && fitsH ? 'yes' : 'NO'}  fills=${fills ? 'yes' : 'NO'}  aspect ${aspect.toFixed(3)}/${wantAspect.toFixed(3)}`);
  console.log(`   render zoom   ${L.zoom.toFixed(3)} (want ${wantZoom.toFixed(3)}) canvas ${m.canvasAttr.w}x${m.canvasAttr.h}`);

  if (m.scaleMode !== 'FIT') out.push(`${label}: scale mode is ${m.scaleMode}, expected FIT`);
  if (!fitsW || !fitsH) out.push(`${label}: canvas ${m.canvasBox.w}x${m.canvasBox.h} overflows ${m.inner.w}x${m.inner.h}`);
  if (L.orientation !== want.orientation || L.width !== want.width || L.height !== want.height) {
    out.push(`${label}: layout ${L.orientation} ${L.width}x${L.height}, want ${want.orientation} ${want.width}x${want.height}`);
  }
  if (Math.abs(aspect - wantAspect) > 0.01) out.push(`${label}: aspect ${aspect.toFixed(3)} != ${wantAspect.toFixed(3)}`);
  if (!fills) out.push(`${label}: canvas ${m.canvasBox.w}x${m.canvasBox.h} doesn't fill ${m.gameDiv.w}x${m.gameDiv.h}`);
  if (!zoomOk) out.push(`${label}: render zoom ${L.zoom} / canvas ${m.canvasAttr.w}px, want zoom ${wantZoom.toFixed(3)}`);
  return out;
}

const setViewport = async (vp, angle = 0) => {
  await send('Emulation.setDeviceMetricsOverride', {
    width: vp.width,
    height: vp.height,
    deviceScaleFactor: vp.dpr,
    mobile: vp.mobile,
    screenOrientation: { type: angle ? 'landscapePrimary' : 'portraitPrimary', angle },
  });
  // Touch emulation is what makes (pointer: coarse) match, like a real phone.
  await send('Emulation.setTouchEmulationEnabled', vp.mobile ? { enabled: true, maxTouchPoints: 1 } : { enabled: false });
};

const runUrl = `${BASE}${BASE.includes('?') ? '&' : '?'}auto=1&mode=endless&difficulty=normal`;

console.log(`probing ${BASE}\n`);

for (const vp of VIEWPORTS) {
  await setViewport(vp, vp.width > vp.height ? 90 : 0);
  await send('Page.navigate', { url: BASE });
  await sleep(1800);
  try {
    await evaluate(pump);
    await evaluate('window.__pump(40)');
  } catch {
    /* pump is best-effort; measurement is what matters */
  }

  const m = await evaluate(MEASURE);
  console.log(`── ${vp.label}  (${vp.width}x${vp.height} @${vp.dpr}x, mobile=${vp.mobile})`);
  if (m.appVersion) console.log(`   build         ${m.appVersion}  (phaser ${m.phaserVersion ?? '?'})`);
  if (m.error) {
    failures.push(`${vp.label}: ${m.error}`);
    console.log(`   ${m.error}\n`);
    continue;
  }
  failures.push(...checkLayout(vp.label, m, vp.mobile));

  // Tap a gem on phones and tablets: the render zoom and layout must not break board input.
  if (vp.mobile) {
    await send('Page.navigate', { url: runUrl });
    await sleep(1800);
    const tap = await tapGem();
    const shown = tap.sel ? `(${tap.sel.row},${tap.sel.col})` : 'nothing';
    console.log(`   tap gem       (${TAP_ROW},${TAP_COL}) -> ${tap.error ?? shown} ${tap.ok ? 'ok' : 'WRONG'}`);
    if (!tap.ok) failures.push(`${vp.label}: tapping gem (${TAP_ROW},${TAP_COL}) -> ${tap.error ?? shown}`);
  }
  console.log();
}

// ── Turning the phone mid-run ────────────────────────────────────────────────
// Portrait -> landscape -> portrait. Each time the canvas must fill the screen in the new
// layout, taps must still hit the right gem, and the run (score and board) must carry over.
{
  const upright = { width: 412, height: 780, dpr: 2.625, mobile: true };
  const sideways = { width: 780, height: 330, dpr: 2.625, mobile: true };
  console.log('── turning a phone mid-run (412x780 <-> 780x330 @2.625x)');
  await setViewport(upright, 0);
  await send('Page.navigate', { url: runUrl });
  await sleep(1800);
  await waitForBoard();
  const grid0 = await evaluate(GRID);
  const score0 = await evaluate(SCORE);

  const steps = [
    ['landscape', sideways, 90],
    ['portrait again', upright, 0],
  ];
  for (const [name, vp, angle] of steps) {
    await setViewport(vp, angle);
    // The game re-measures 200 ms after the page settles, then rebuilds the scene.
    for (let i = 0; i < 8; i++) {
      await sleep(150);
      await evaluate('window.__pump(10)');
    }
    await waitForBoard();
    const m = await evaluate(MEASURE);
    console.log(`   ${name}:`);
    failures.push(...checkLayout(`turned to ${name}`, m, true));
    const grid = await evaluate(GRID);
    const score = await evaluate(SCORE);
    const kept = grid === grid0 && score === score0;
    console.log(`   run kept      ${kept ? 'yes' : 'NO'} (score ${score0} -> ${score})`);
    if (!kept) failures.push(`turned to ${name}: run changed (score ${score0} -> ${score}, board ${grid === grid0 ? 'same' : 'different'})`);
    const tap = await tapGem();
    const shown = tap.sel ? `(${tap.sel.row},${tap.sel.col})` : 'nothing';
    console.log(`   tap gem       (${TAP_ROW},${TAP_COL}) -> ${tap.error ?? shown} ${tap.ok ? 'ok' : 'WRONG'}`);
    if (!tap.ok) failures.push(`turned to ${name}: tapping gem (${TAP_ROW},${TAP_COL}) -> ${tap.error ?? shown}`);
  }
  console.log();
}

ws.close();
cleanup();

if (failures.length === 0) {
  console.log('SCALING PASS');
  process.exit(0);
}
console.log('SCALING FAIL');
for (const f of failures) console.log(' -', f);
process.exit(1);
