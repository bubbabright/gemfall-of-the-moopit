/**
 * Diagnostic: what game-space coordinate does Phaser derive from a dispatched click?
 * Usage: node tools/probe-pointer.mjs [baseUrl]
 */

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { gpuFlags } from './gpu-flags.mjs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:4770';
const PORT = 4782;

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

// Record raw DOM events + Phaser pointer state.
await evaluate(`
  window.__log = [];
  document.addEventListener('pointerdown', (e) => {
    window.__log.push({ src: 'dom', clientX: e.clientX, clientY: e.clientY, target: e.target.tagName });
  }, true);
  const scene = window.gemfall.scene.getScene('menu');
  scene.input.on('pointerdown', (p) => {
    window.__log.push({ src: 'phaser', x: p.x, y: p.y, worldX: p.worldX, worldY: p.worldY });
  });
  'ok'
`);

const rect = await evaluate(`(() => { const r = document.querySelector('canvas').getBoundingClientRect();
  return { w: r.width, h: r.height, left: r.left, top: r.top }; })()`);
console.log('canvas css rect:', rect);

const click = async (clientX, clientY) => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: clientX, y: clientY, button: 'none', clickCount: 0 });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: clientX, y: clientY, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: clientX, y: clientY, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: clientX, y: clientY, button: 'none', buttons: 0, clickCount: 0 });
};

for (const gx of [180, 360, 540]) {
  const pageX = rect.left + gx;
  const pageY = rect.top + 452;
  await evaluate('window.__log = []');
  await click(pageX, pageY);
  await evaluate('window.__pump(20)');
  const log = await evaluate('window.__log');
  console.log(`dispatched clientX=${pageX} clientY=${pageY}  ->`, JSON.stringify(log));
}

ws.close();
chrome.kill('SIGKILL');
process.exit(0);
