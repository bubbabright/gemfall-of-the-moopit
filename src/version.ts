/**
 * Build identity.
 *
 * `__APP_VERSION__` and `__BUILD_ID__` are stamped in by vite.config.ts at build
 * time. They exist so you can tell which build is actually running — the auto-deploy
 * pipeline makes it easy to lose track, and a deployed fix that still looks broken is
 * usually just a stale bundle in a cache.
 *
 * The `typeof` guards keep this importable from anywhere (including the engine
 * self-test and any tooling) even if the defines are absent.
 */

declare const __APP_VERSION__: string;
declare const __BUILD_ID__: string;
declare const __CODENAME__: string;
declare const __BUILD_TIME__: string;
declare const __DEV_SERVER__: boolean;

export const APP_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';
export const BUILD_ID = typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'local';
/** Release codename from package.json `codename`; empty until one is chosen. */
export const CODENAME = typeof __CODENAME__ === 'string' ? __CODENAME__ : '';
/** US Eastern to the minute, e.g. "2026-09-26 03:47 EDT"; the same format vite.config.ts stamps. */
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
 * Build time in US Eastern to the minute (see vite.config.ts). On the dev server the stamp
 * would be frozen at server start and go stale as code changes, so it shows the page-load time
 * there instead.
 */
export const BUILD_TIME = typeof __DEV_SERVER__ === 'boolean' && __DEV_SERVER__
  ? easternTime(new Date())
  : typeof __BUILD_TIME__ === 'string'
    ? __BUILD_TIME__
    : 'unbuilt';

/** Where the code lives; linked under the menu's version line. */
export const REPO_URL = 'https://github.com/bubbabright/gemfall-of-the-moopit';

/** e.g. "v0.2.0 · d07b4a8" — version first, then the commit it was built from. */
export const VERSION_LABEL = `v${APP_VERSION} · ${BUILD_ID}`;

/**
 * Full stamp, e.g. `v0.2.0 · d07b4a8 · "tulip" · 2026-09-26 03:47 EDT`. Shown at the bottom
 * of the menu, exposed as `window.gemfallVersion`, and printed by the playtest and scaling tools.
 */
export const BUILD_LABEL = [VERSION_LABEL, CODENAME && `"${CODENAME}"`, BUILD_TIME]
  .filter(Boolean)
  .join(' · ');
