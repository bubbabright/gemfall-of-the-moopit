/// <reference types="node" />
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import { version as pkgVersion, codename } from './package.json';

/**
 * Build time in US Eastern, to the minute, e.g. "2026-09-26 03:47 EDT" (EST in winter).
 * Done here at build time, so every viewer sees the same text whatever their own time zone.
 */
function easternTime(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'short',
  }).formatToParts(date);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')} ${get('timeZoneName')}`;
}

/**
 * Writes dist/sw.js from src/sw.template.js once the build is on disk: the list of every file
 * the game needs, so it can open offline, and a cache name that changes whenever any of them
 * does, so a phone swaps its saved copy for the new build on the next launch.
 */
function serviceWorker(): Plugin {
  let root = '.';
  let outDir = 'dist';
  return {
    name: 'gemfall-service-worker',
    apply: 'build',
    configResolved(config) {
      root = config.root;
      outDir = resolve(root, config.build.outDir);
    },
    closeBundle() {
      const walk = (dir: string): string[] =>
        readdirSync(dir, { withFileTypes: true }).flatMap((entry): string[] =>
          entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
        );
      const files = walk(outDir)
        .map((file) => relative(outDir, file).split(sep).join('/'))
        .filter((file) => file !== 'sw.js' && !file.endsWith('.map'))
        .sort();

      const hash = createHash('sha256');
      for (const file of files) hash.update(file).update(readFileSync(join(outDir, file)));

      // './' is the page as the phone asks for it; index.html is the same file under its own name.
      const precache = ['./', ...files.filter((file) => file !== 'index.html').map((file) => `./${file}`)];
      const source = readFileSync(resolve(root, 'src/sw.template.js'), 'utf8')
        .replace('__CACHE_VERSION__', hash.digest('hex').slice(0, 12))
        .replace('__PRECACHE_FILES__', JSON.stringify(precache, null, 2));
      writeFileSync(join(outDir, 'sw.js'), source);
    },
  };
}

export default defineConfig(({ command, mode }) => {
  // Prefix '' returns every env var, so only read the keys we mean to stamp.
  // Never spread this object into `define`, or secrets would end up in the bundle.
  const env = loadEnv(mode, '.', '');

  // Netlify sets COMMIT_REF when it builds from git; GIT_COMMIT covers local builds
  // that want the same stamp. Falls back to 'local' for a plain dev run.
  const buildId = (env.COMMIT_REF ?? env.GIT_COMMIT ?? 'local').slice(0, 7);

  return {
    // Relative base keeps the build portable (Netlify root, subpath, or local file server).
    base: './',
    define: {
      // Surfaced by src/version.ts, shown in the menu and reported by the test tools.
      __APP_VERSION__: JSON.stringify(pkgVersion),
      __BUILD_ID__: JSON.stringify(buildId),
      // The release codename Daniel sets in package.json, and when this bundle was built.
      __CODENAME__: JSON.stringify(codename ?? ''),
      __BUILD_TIME__: JSON.stringify(easternTime(new Date())),
      // Only the built game registers the service worker; the dev server always serves fresh code.
      __SERVICE_WORKER__: JSON.stringify(command === 'build'),
    },
    plugins: [serviceWorker()],
    build: {
      target: 'es2020',
      chunkSizeWarningLimit: 2000,
    },
    // GEMFALL owns ports 4770–4789 (see docs/DEVELOPING.md). This PC runs dev servers for other
    // projects too, so never fall back to Vite's defaults, and never hop to the next free port
    // (it could be another project's): strictPort makes a clash fail loudly instead.
    server: {
      host: true,
      port: 4770,
      strictPort: true,
    },
    preview: {
      host: true,
      port: 4771,
      strictPort: true,
    },
  };
});
