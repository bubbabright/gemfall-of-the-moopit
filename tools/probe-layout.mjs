/**
 * Layout audit: report pill boxes and their text widths so overflow/overlap is measurable.
 * Usage: node tools/probe-layout.mjs [baseUrl]
 */

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { gpuFlags } from './gpu-flags.mjs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:4770';
const PORT = 4786;

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

const audit = await evaluate(`
  (() => {
    const m = window.gemfall.scene.getScene('menu');
    const rows = [];
    const describe = (group, pills) => {
      const boxes = [];
      for (const [name, pill] of pills) {
        const kids = pill.list;
        const label = kids.find((k) => k.type === 'Text');
        const texts = kids.filter((k) => k.type === 'Text');
        boxes.push({
          name,
          cx: pill.x,
          w: pill.opts.w,
          h: pill.opts.h,
          left: pill.x - pill.opts.w / 2,
          right: pill.x + pill.opts.w / 2,
          textWidths: texts.map((t) => Math.round(t.width)),
          widestText: Math.round(Math.max(...texts.map((t) => t.displayWidth))),
        });
      }
      // gaps between adjacent boxes
      const gaps = [];
      for (let i = 0; i < boxes.length - 1; i++) {
        gaps.push(+(boxes[i + 1].left - boxes[i].right).toFixed(1));
      }
      rows.push({ group, boxes, gaps });
    };
    describe('mode', m.modePills);
    describe('difficulty', m.difficultyPills);
    return rows;
  })()
`);

for (const row of audit) {
  console.log(`\n${row.group.toUpperCase()} row (pill w x h, text width, gap to next):`);
  for (const b of row.boxes) {
    console.log(
      `  ${b.name.padEnd(9)} cx=${b.cx} box=[${b.left},${b.right}] w=${b.w} h=${b.h} texts=${JSON.stringify(b.textWidths)} widest=${b.widestText} ${
        b.widestText > b.w - 16 ? '<<< TEXT OVERFLOWS' : 'ok'
      }`,
    );
  }
  console.log(`  gaps: ${JSON.stringify(row.gaps)} ${row.gaps.some((g) => g < 8) ? '<<< PILLS TOUCH/OVERLAP' : 'ok'}`);
}

ws.close();
chrome.kill('SIGKILL');
process.exit(0);
