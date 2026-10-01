/**
 * Deterministic hit-area measurement.
 * Bypasses DOM event queuing entirely: sets the pointer position and asks Phaser
 * which objects it considers hit, then finds the exact boundaries.
 * Usage: node tools/probe-hittest2.mjs [baseUrl]
 */

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { gpuFlags } from './gpu-flags.mjs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:4770';
const PORT = 4785;

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

// Deterministic: place the pointer and ask the input plugin what it hits.
const sweep = await evaluate(`
  (() => {
    const m = window.gemfall.scene.getScene('menu');
    const input = m.input;

    const tags = new Map();
    for (const [name, pill] of m.modePills) tags.set(pill, 'mode:' + name);
    for (const [name, pill] of m.difficultyPills) tags.set(pill, 'diff:' + name);

    const hitAt = (x, y) => {
      const p = input.activePointer;
      p.x = x; p.y = y; p.worldX = x; p.worldY = y;
      p.updateWorldPoint(m.cameras.main);
      const list = input.hitTestPointer(p) || [];
      return list.map((o) => tags.get(o) ?? '?');
    };

    // 1) Point hit test at each pill's declared centre.
    const centres = {};
    for (const [name, pill] of m.difficultyPills) centres['diff:' + name] = hitAt(pill.x, pill.y);
    for (const [name, pill] of m.modePills) centres['mode:' + name] = hitAt(pill.x, pill.y);

    // 2) Exact boundaries of the difficulty row.
    const edges = [];
    let prev = null;
    for (let x = 0; x <= 720; x += 1) {
      const key = hitAt(x, 452).join('+') || 'none';
      if (key !== prev) { edges.push({ x, hit: key }); prev = key; }
    }

    // 3) Same for the mode row.
    const modeEdges = [];
    prev = null;
    for (let x = 0; x <= 720; x += 1) {
      const key = hitAt(x, 312).join('+') || 'none';
      if (key !== prev) { modeEdges.push({ x, hit: key }); prev = key; }
    }

    // 4) Vertical extent of the 'normal' difficulty pill at its centre x=360.
    const vertEdges = [];
    prev = null;
    for (let y = 380; y <= 540; y += 1) {
      const key = hitAt(360, y).join('+') || 'none';
      if (key !== prev) { vertEdges.push({ y, hit: key }); prev = key; }
    }

    return { centres, edges, modeEdges, vertEdges };
  })()
`);

console.log('hit test at each declared pill centre:');
for (const [k, v] of Object.entries(sweep.centres)) console.log(`  ${k} -> ${JSON.stringify(v)}`);
console.log('\ndifficulty row y=452 hit boundaries:');
for (const e of sweep.edges) console.log(`  x=${e.x} -> ${e.hit}`);
console.log('\nmode row y=312 hit boundaries:');
for (const e of sweep.modeEdges) console.log(`  x=${e.x} -> ${e.hit}`);
console.log('\nvertical extent at x=360:');
for (const e of sweep.vertEdges) console.log(`  y=${e.y} -> ${e.hit}`);

ws.close();
chrome.kill('SIGKILL');
process.exit(0);
