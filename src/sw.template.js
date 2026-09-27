/**
 * GEMFALL service worker: keeps a copy of the game's own files so it opens offline once it
 * has been played. vite.config.ts fills in the file list and cache name at build time and
 * writes the result to dist/sw.js; the dev server never registers it.
 *
 * It only ever fetches from this site, the same files the page loads anyway. Nothing
 * leaves the device.
 */
const CACHE = 'gemfall-__CACHE_VERSION__';
const FILES = __PRECACHE_FILES__;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(FILES))
      .then(() => self.skipWaiting()),
  );
});

// A new build has a new cache name: drop the old copies once it takes over.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k.startsWith('gemfall-') && k !== CACHE).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    // The page itself: network first, so a new deploy shows up on the next launch.
    // Offline, fall back to the copy saved with this build.
    event.respondWith(fetch(request).catch(() => caches.match('./', { cacheName: CACHE })));
    return;
  }

  // Scripts, fonts and icons: this build's saved copy matches the page it came with. Anything
  // not saved (there shouldn't be anything) comes from the network.
  event.respondWith(caches.match(request, { cacheName: CACHE }).then((hit) => hit || fetch(request)));
});
