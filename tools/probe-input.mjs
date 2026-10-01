/**
 * Diagnostic: is the playtest's coordinate mapping the same as Phaser's?
 * Clicks the difficulty pills by their real scene coordinates and reports what got selected.
 *
 * Usage: node tools/probe-input.mjs [baseUrl]
 */

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { gpuFlags } from './gpu-flags.mjs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:4770';
const PORT = 4781;

const chrome = spawn(
  'chromium',
  [
    '--headless=new',
    '--no-sandbox',
    ...gpuFlags(),
    '--disable-dev-shm-usage',
    '--hide-scrollbars',
    '--mute-audio',
    '--window-size=760,940',
    `--remote-debugging-port=${PORT}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);
process.on('exit', () => {
  try { chrome.kill('SIGKILL'); } catch { /* gone */ }
});

async function findTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const page = (await res.json()).find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* not up */ }
    await sleep(250);
  }
  throw new Error('no devtools');
}

const ws = new WebSocket(await findTarget());
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let id = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? reject(new Error(m.error.message)) : resolve(m.result);
  }
};
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const n = ++id;
    pending.set(n, { resolve, reject });
    ws.send(JSON.stringify({ id: n, method, params }));
  });

const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};

await send('Page.enable');
await send('Runtime.enable');
await send('Page.navigate', { url: BASE });
await sleep(1500);

await evaluate(`
  window.__t = performance.now();
  window.__pump = (n, dt = 16.7) => {
    const g = window.gemfall;
    if (!g) return 0;
    for (let i = 0; i < n; i++) { window.__t += dt; g.loop.step(window.__t); }
    return g.loop.frame;
  };
  'ok'
`);

for (let i = 0; i < 60 && !(await evaluate('!!window.gemfall')); i++) await sleep(200);
await evaluate('window.__pump(80)');

// What does Phaser think the geometry is?
const geom = await evaluate(`
  (() => {
    const g = window.gemfall;
    const s = g.scale;
    const c = g.canvas;
    const r = c.getBoundingClientRect();
    return {
      canvasCss: { w: r.width, h: r.height, left: r.left, top: r.top },
      canvasAttr: { w: c.width, h: c.height },
      displaySize: { w: s.displaySize.width, h: s.displaySize.height },
      canvasBounds: { x: s.canvasBounds.x, y: s.canvasBounds.y, w: s.canvasBounds.width, h: s.canvasBounds.height },
      innerWindow: { w: window.innerWidth, h: window.innerHeight },
      zoom: s.zoom,
      displayScale: { x: s.displayScale.x, y: s.displayScale.y },
    };
  })()
`);
console.log('Phaser geometry:', JSON.stringify(geom, null, 2));

// Read the real pill positions from the scene.
const pills = await evaluate(`
  (() => {
    const m = window.gemfall.scene.getScene('menu');
    const out = {};
    for (const [k, p] of m.difficultyPills) out[k] = { x: p.x, y: p.y };
    return out;
  })()
`);
console.log('difficulty pill centres:', JSON.stringify(pills));

const rect = geom.canvasCss;
const toPage = (gx, gy) => ({
  x: rect.left + (gx * rect.w) / 720,
  y: rect.top + (gy * rect.h) / 900,
});

const click = async (gx, gy) => {
  const { x, y } = toPage(gx, gy);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', clickCount: 0 });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
};

const selected = () => evaluate(`window.gemfall.scene.getScene('menu').difficulty`);

for (const [name, pos] of Object.entries(pills)) {
  await click(pos.x, pos.y);
  await evaluate('window.__pump(20)');
  const got = await selected();
  console.log(`clicked centre of '${name}' at (${pos.x},${pos.y}) -> selected '${got}' ${got === name ? 'OK' : '<<< MISMATCH'}`);
}

// Also check what Phaser itself computes for a known page point.
const transform = await evaluate(`
  (() => {
    const g = window.gemfall;
    const p = new (window.Phaser ? window.Phaser.Geom.Point : Object)();
    return 'n/a';
  })()
`);

ws.close();
chrome.kill('SIGKILL');
process.exit(0);
