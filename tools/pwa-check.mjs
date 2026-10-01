#!/usr/bin/env node
/**
 * PWA gate: is the built game installable, does it open offline, and does nothing leave the
 * device?
 *
 *   node tools/pwa-check.mjs [url]     (default: the dev preview, http://127.0.0.1:4771)
 *
 * Needs the *built* game (tools/poc.sh start): the dev server never registers the service
 * worker. Checks, in headless Chromium over the DevTools Protocol:
 *   - Chrome parses the manifest with no errors and reports no installability errors;
 *   - the manifest has a name, standalone display, and 192, 512 and maskable icons;
 *   - the service worker registers and controls the page after a reload;
 *   - every request the page and worker make goes to the game's own origin;
 *   - with the network switched off, a reload still boots the game to its menu;
 *   - a plain local preview (no ?sw) registers no service worker, so it never serves a saved
 *     old build;
 *   - starting a game asks to keep the screen on (the Wake Lock call is stubbed and counted,
 *     so this proves the game asked, not that a phone's screen stayed on).
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { gpuFlags } from './gpu-flags.mjs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:4771';
const PORT = 4788;
const ORIGIN = new URL(BASE).origin;
// A real (throwaway) profile: without one headless Chromium is incognito, and Chrome never
// offers to install from incognito.
const PROFILE = mkdtempSync(join(tmpdir(), 'gemfall-pwa-'));

const chrome = spawn(
  'chromium',
  [
    '--headless=new',
    '--no-sandbox',
    ...gpuFlags(),
    '--disable-dev-shm-usage',
    '--mute-audio',
    '--window-size=412,915',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
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
  rmSync(PROFILE, { recursive: true, force: true });
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
const requested = new Set();
ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(`${message.error.message} (${JSON.stringify(message.error)})`));
    else resolve(message.result);
    return;
  }
  if (message.method === 'Network.requestWillBeSent') requested.add(message.params.request.url);
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
    if (await evaluate(expression).catch(() => false)) return true;
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${label}`);
};
const reload = async () => {
  await send('Page.reload', { ignoreCache: false });
  await sleep(500);
};
const booted = `!!(window.gemfall && window.gemfall.scene.isActive('menu'))`;

const problems = [];
const check = (ok, message) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${message}`);
  if (!ok) problems.push(message);
};

await send('Page.enable');
await send('Runtime.enable');
await send('Network.enable');
// The worker's own fetches (the precache) are its own target: attach to it so they're seen too.
await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });

// Count screen wake lock requests (headless has no real screen to keep on).
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `
    window.__wakeLocks = 0;
    Object.defineProperty(navigator, 'wakeLock', {
      configurable: true,
      value: {
        request: () => {
          window.__wakeLocks += 1;
          const lock = new EventTarget();
          lock.release = () => Promise.resolve();
          return Promise.resolve(lock);
        },
      },
    });
  `,
});

// ── a plain local preview stays worker-free ───────────────────────────────────
await send('Page.navigate', { url: BASE });
await waitFor(booted, 'the game to boot');
await sleep(1500);
const plainRegs = await evaluate(`navigator.serviceWorker.getRegistrations().then((r) => r.length)`);
check(plainRegs === 0, `plain local preview registers no service worker (found ${plainRegs})`);

// ── wake lock ─────────────────────────────────────────────────────────────────
await waitFor(`!!document.querySelector('#front.menu')`, 'the menu to appear');
await evaluate(`document.querySelector('#front .play').click()`);
await waitFor(`window.gemfall.scene.isActive('game')`, 'the game scene to start');
await sleep(300);
check((await evaluate('window.__wakeLocks')) > 0, 'starting a game asks to keep the screen on');

// From here on, ?sw opts this local preview into the service worker, as a real host would be.
const SW_URL = `${BASE.replace(/\/?$/, '/')}?sw`;
await send('Page.navigate', { url: SW_URL });
await waitFor(booted, 'the game to boot with ?sw');

// ── manifest ──────────────────────────────────────────────────────────────────
const { url: manifestUrl, errors, data } = await send('Page.getAppManifest');
check(!!manifestUrl, `manifest linked (${manifestUrl || 'none'})`);
check(errors.length === 0, `manifest parses cleanly${errors.length ? `: ${JSON.stringify(errors)}` : ''}`);
const manifest = data ? JSON.parse(data) : {};
check(manifest.name === 'GEMFALL' && manifest.display === 'standalone', 'name GEMFALL, display standalone');
const icons = manifest.icons ?? [];
check(
  icons.some((i) => i.sizes === '192x192') &&
    icons.some((i) => i.sizes === '512x512' && (i.purpose ?? 'any').includes('any')) &&
    icons.some((i) => (i.purpose ?? '').includes('maskable')),
  '192, 512 and maskable icons listed',
);
for (const icon of icons) {
  const res = await fetch(new URL(icon.src, manifestUrl));
  check(res.ok && res.headers.get('content-type')?.includes('image/png'), `icon ${icon.src} is served as PNG`);
}

// ── service worker ────────────────────────────────────────────────────────────
const scope = await evaluate(`navigator.serviceWorker.ready.then((r) => r.scope)`);
check(scope === `${BASE.replace(/\/?$/, '/')}`, `service worker active, scope ${scope}`);

await reload();
await waitFor(booted, 'the game to boot after reload');
check(await evaluate('!!navigator.serviceWorker.controller'), 'service worker controls the page after a reload');

const installability = await send('Page.getInstallabilityErrors');
const installErrors = installability.installabilityErrors ?? [];
check(
  installErrors.length === 0,
  `Chrome reports it installable${installErrors.length ? `: ${JSON.stringify(installErrors)}` : ''}`,
);

// ── install button ───────────────────────────────────────────────────────────
// Chrome fires beforeinstallprompt once the page is installable; the menu then shows
// "Install app" (src/ui/install.ts), so players needn't find it in Chrome's own menu.
const offered = await waitFor(`!!document.querySelector('#front .chip.install:not([hidden])')`, 'the Install app button', 10000)
  .then(() => true)
  .catch(() => false);
check(offered, 'the menu offers an Install app button');
const manifestLink = await evaluate(`document.querySelector('link[rel=manifest]')?.getAttribute('crossorigin')`);
check(manifestLink === 'use-credentials', `manifest link sends credentials (crossorigin=${manifestLink}), for password-protected previews`);

// ── offline ───────────────────────────────────────────────────────────────────
await send('Network.emulateNetworkConditions', {
  offline: true,
  latency: 0,
  downloadThroughput: -1,
  uploadThroughput: -1,
});
await reload();
const offlineOk = await waitFor(booted, 'the game to boot offline').catch(() => false);
check(offlineOk, 'boots to the menu with the network off');
await send('Network.emulateNetworkConditions', {
  offline: false,
  latency: 0,
  downloadThroughput: -1,
  uploadThroughput: -1,
});

// ── nothing leaves the device ─────────────────────────────────────────────────
const foreign = [...requested].filter((u) => !u.startsWith(ORIGIN) && !/^(data|blob):/.test(u));
check(foreign.length === 0, `all ${requested.size} requests stay on ${ORIGIN}${foreign.length ? `: ${foreign.join(', ')}` : ''}`);

console.log();
if (problems.length) {
  console.log('PWA FAIL');
  for (const p of problems) console.log(` - ${p}`);
  process.exit(1);
}
console.log('PWA PASS');
process.exit(0);
