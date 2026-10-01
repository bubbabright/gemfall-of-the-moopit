/**
 * Diagnostic: sweep the cursor across the difficulty row and record which pill receives
 * pointerover, giving each pill's effective hit range as the engine sees it.
 * Usage: node tools/probe-sweep.mjs [baseUrl]
 */

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { gpuFlags } from './gpu-flags.mjs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:4770';
const PORT = 4784;

const chrome = spawn('chromium', [
  '--headless=new', '--no-sandbox', ...gpuFlags(), '--disable-dev-shm-usage',
  '--hide-scrollbars', '--mute-audio', '--window-size=760,940',
  `--remote-debugging-port=${PORT}`, 'about:blank',
], { stdio: 'ignore' });
process.on('exit', () => { try { chrome.kill('SIGKILL'); } catch { /* gone */ } });

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
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const n = ++id; pending.set(n, { resolve, reject });
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

await evaluate(`
  window.__over = [];
  const m = window.gemfall.scene.getScene('menu');
  for (const [name, pill] of m.difficultyPills) {
    pill.on('pointerover', () => window.__over.push({ name, x: m.input.activePointer.x }));
  }
  'ok'
`);

// Get the true on-screen bounds of each pill per Phaser itself.
const bounds = await evaluate(`
  (() => {
    const m = window.gemfall.scene.getScene('menu');
    const out = {};
    for (const [name, pill] of m.difficultyPills) {
      const b = pill.getBounds();
      out[name] = { left: b.left, right: b.right, top: b.top, bottom: b.bottom, cx: b.centerX, cy: b.centerY };
    }
    return out;
  })()
`);
console.log('pill getBounds():', JSON.stringify(bounds, null, 2));

const rect = await evaluate(`(() => { const r = document.querySelector('canvas').getBoundingClientRect();
  return { w: r.width, h: r.height, left: r.left, top: r.top }; })()`);

const moveTo = async (gx, gy) => {
  const x = rect.left + (gx * rect.w) / 720;
  const y = rect.top + (gy * rect.h) / 900;
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', clickCount: 0 });
};

// Sweep and record transitions.
let last = null;
const transitions = [];
for (let gx = 0; gx <= 720; gx += 6) {
  await evaluate('window.__over = []');
  await moveTo(gx, 452);
  await evaluate('window.__pump(2)');
  const over = await evaluate('window.__over');
  const name = over.length ? over[over.length - 1].name : 'none';
  if (name !== last) {
    transitions.push({ from: gx, name, reportedPtrX: over.length ? over[over.length - 1].x : null });
    last = name;
  }
}
console.log('\ndifficulty row y=452 pointerover transitions:');
for (const t of transitions) console.log(`  x>=${t.from} -> ${t.name} (phaser ptr.x=${t.reportedPtrX})`);

// Same sweep on the mode row.
last = null;
const modeTransitions = [];
for (let gx = 0; gx <= 720; gx += 6) {
  await evaluate('window.__over = []');
  await moveTo(gx, 312);
  await evaluate('window.__pump(2)');
  const over = await evaluate('window.__over');
  const name = over.length ? over[over.length - 1].name : 'none';
  if (name !== last) { modeTransitions.push({ from: gx, name }); last = name; }
}
console.log('\nMODE row y=312 transitions (difficulty pills still listening, plus mode pills):');
const modeBounds = await evaluate(`
  (() => {
    const m = window.gemfall.scene.getScene('menu');
    const out = {};
    for (const [name, pill] of m.modePills) {
      const b = pill.getBounds();
      out[name] = { left: b.left, right: b.right, cx: b.centerX };
    }
    return out;
  })()
`);
console.log('mode pill getBounds():', JSON.stringify(modeBounds));

ws.close();
chrome.kill('SIGKILL');
process.exit(0);
