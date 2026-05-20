// BBC Dashboard — Service Worker
// Strategy:
//   index.html        → network-first (always fresh, fall back to cache if offline)
//   static assets     → cache-first (fonts, icons, manifests)
//   notifications     → handled via message channel (SCHEDULE / CANCEL / CANCEL_ALL / PING)

const CACHE_NAME = 'bbc-dashboard-v5';
const STATIC_ASSETS = [
  './manifest.json',
  './icon-192.png',
];

// ── Install ────────────────────────────────────────────────────────────────
self.addEventListener('install', event => {
  // Skip waiting so the new SW activates immediately on deploy
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS).catch(() => {}))
  );
});

// ── Activate ───────────────────────────────────────────────────────────────
self.addEventListener('activate', event => {
  // Delete any old caches from previous versions
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim()) // take control of all open pages immediately
  );
});

// ── Fetch ──────────────────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Only handle same-origin requests
  if (url.origin !== self.location.origin) return;

  const path = url.pathname;
  const isHTML = path.endsWith('/') || path.endsWith('.html') || path === self.location.pathname;

  if (isHTML) {
    // Network-first for HTML: always try to get the latest index.html
    // Falls back to cache only when offline
    event.respondWith(
      fetch(event.request, { cache: 'no-store' })
        .then(response => {
          // Cache the fresh response for offline fallback
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => caches.match(event.request)) // offline fallback
    );
  } else {
    // Cache-first for static assets (fonts, icons, manifests)
    event.respondWith(
      caches.match(event.request).then(cached => {
        if (cached) return cached;
        return fetch(event.request).then(response => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          }
          return response;
        }).catch(() => cached); // offline and not cached — nothing to serve
      })
    );
  }
});

// ── Notification scheduling ────────────────────────────────────────────────
const _timers = {};

self.addEventListener('message', event => {
  const data = event.data;
  if (!data || !data.type) return;

  if (data.type === 'PING') {
    event.ports[0]?.postMessage({ ok: true });
    return;
  }

  if (data.type === 'SCHEDULE') {
    const { id, title, body, fireAt } = data.reminder || {};
    if (!id || !fireAt) return;
    const delay = fireAt - Date.now();
    if (delay <= 0) return;
    clearTimeout(_timers[id]);
    _timers[id] = setTimeout(() => {
      self.registration.showNotification(title || 'BBC Dashboard', {
        body: body || '',
        icon: './icon-192.png',
        badge: './icon-192.png',
        tag: id,
        requireInteraction: false,
      });
      delete _timers[id];
    }, Math.min(delay, 2147483647)); // clamp to max setTimeout value
    event.ports[0]?.postMessage({ ok: true, id });
    return;
  }

  if (data.type === 'CANCEL') {
    if (data.id && _timers[data.id]) {
      clearTimeout(_timers[data.id]);
      delete _timers[data.id];
    }
    event.ports[0]?.postMessage({ ok: true });
    return;
  }

  if (data.type === 'CANCEL_ALL') {
    Object.keys(_timers).forEach(id => {
      clearTimeout(_timers[id]);
      delete _timers[id];
    });
    event.ports[0]?.postMessage({ ok: true });
    return;
  }
});

// ── Notification click ─────────────────────────────────────────────────────
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      if (clients.length > 0) {
        return clients[0].focus();
      }
      return self.clients.openWindow('./');
    })
  );
});
