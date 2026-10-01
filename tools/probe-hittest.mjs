/**
 * Diagnostic: which pill receives pointerdown/pointerup, and what does Phaser's hit test return?
 * Usage: node tools/probe-hittest.mjs [baseUrl]
 */

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { gpuFlags } from './gpu-flags.mjs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:4770';
const PORT = 4783;

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
  window.__log = [];
  const m = window.gemfall.scene.getScene('menu');
  for (const [name, pill] of m.difficultyPills) {
    pill.__tag = name;
    for (const ev of ['pointerover', 'pointerout', 'pointerdown', 'pointerup']) {
      pill.on(ev, (p) => window.__log.push({ ev, tag: name, px: p && p.x, py: p && p.y }));
    }
  }
  window.__hits = () => {
    const mm = window.gemfall.scene.getScene('menu');
    const list = mm.input.hitTestPointer(mm.input.activePointer) || [];
    return list.map((o) => o.__tag ?? o.type ?? 'anon');
  };
  'ok'
`);

// Also report each pill's raw transform + computed hit rect in world space.
const rects = await evaluate(`
  (() => {
    const m = window.gemfall.scene.getScene('menu');
    const out = {};
    for (const [name, pill] of m.difficultyPills) {
      const ha = pill.input.hitArea;
      out[name] = {
        x: pill.x, y: pill.y, scale: pill.scaleX,
        hitLocal: { x: ha.x, y: ha.y, w: ha.width, h: ha.height },
        worldCentre: pill.getBounds ? null : null,
        displayW: pill.displayWidth, displayH: pill.displayHeight,
      };
    }
    return out;
  })()
`);
console.log('pills:', JSON.stringify(rects, null, 2));

const rect = await evaluate(`(() => { const r = document.querySelector('canvas').getBoundingClientRect();
  return { w: r.width, h: r.height, left: r.left, top: r.top }; })()`);

const click = async (gx, gy) => {
  const x = rect.left + (gx * rect.w) / 720;
  const y = rect.top + (gy * rect.h) / 900;
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', clickCount: 0 });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  return { x, y };
};

for (const gx of [180, 360, 540]) {
  await evaluate('window.__log = []');
  const page = await click(gx, 452);
  await evaluate('window.__pump(20)');
  const log = await evaluate('window.__log');
  const hits = await evaluate('window.__hits()');
  const sel = await evaluate(`window.gemfall.scene.getScene('menu').difficulty`);
  console.log(`\nclick game(${gx},452) page(${page.x},${page.y}) hits=${JSON.stringify(hits)} selected='${sel}'`);
  console.log('  log:', JSON.stringify(log));
}

ws.close();
chrome.kill('SIGKILL');
process.exit(0);
