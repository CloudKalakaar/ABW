const CACHE_NAME = 'abw-tracker-v4';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './1000279021.png',
  './icon-180.png',
  './icon-192.png',
  './icon-512.png'
];

// Install — pre-cache app shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[SW] Pre-caching offline assets');
      return cache.addAll(ASSETS_TO_CACHE);
    }).then(() => self.skipWaiting())
  );
});

// Activate — purge old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            console.log('[SW] Removing old cache:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch — stale-while-revalidate for same-origin, passthrough for external
self.addEventListener('fetch', (event) => {
  if (!event.request.url.startsWith(self.location.origin)) return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) {
        // Serve stale, refresh in background
        fetch(event.request).then((fresh) => {
          if (fresh && fresh.status === 200) {
            caches.open(CACHE_NAME).then((c) => c.put(event.request, fresh));
          }
        }).catch(() => {});
        return cached;
      }
      // No cache — fetch and cache dynamically
      return fetch(event.request).then((resp) => {
        if (!resp || resp.status !== 200 || resp.type !== 'basic') return resp;
        const clone = resp.clone();
        caches.open(CACHE_NAME).then((c) => c.put(event.request, clone));
        return resp;
      });
    })
  );
});

// Manual skip-waiting trigger from app
self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});
