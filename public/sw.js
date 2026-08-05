// RINGO service worker — makes the app installable and playable offline
// (Pass & Play and vs Computer; online play needs the network anyway).
//
// Strategy: network-first with cache fallback. Online you always get the
// freshest files (matching the site's no-cache headers); offline you get
// the last version you played. Successful fetches refresh the cache as
// you go.

const CACHE = 'ringo-v1';

const CORE = [
  '/',
  '/index.html',
  '/style.css',
  '/manifest.json',
  '/js/main.js',
  '/js/game.js',
  '/js/ai.js',
  '/js/sound.js',
  '/js/confetti.js',
  '/js/config.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || !e.request.url.startsWith(self.location.origin)) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      // ignoreSearch so an offline "/?join=CODE" still opens the cached app.
      .catch(() => caches.match(e.request, { ignoreSearch: true })),
  );
});
