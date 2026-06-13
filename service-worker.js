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
    ).then(() => self.clients.claim())
     .then(() => _reArmAll())
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

// ── IndexedDB helpers ──────────────────────────────────────────────────────
// Reminders are persisted so they survive the SW being killed by the browser.
// On every SW startup we re-arm any entries whose fireAt is still in the future.
const IDB_NAME = 'bbc-dash-reminders';
const IDB_STORE = 'reminders';
const IDB_VERSION = 1;

function _idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = e => {
      e.target.result.createObjectStore(IDB_STORE, { keyPath: 'id' });
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = e => reject(e.target.error);
  });
}
function _idbPut(record) {
  return _idbOpen().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = e => reject(e.target.error);
  }));
}
function _idbDelete(id) {
  return _idbOpen().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = e => reject(e.target.error);
  }));
}
function _idbClear() {
  return _idbOpen().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = e => reject(e.target.error);
  }));
}
function _idbGetAll() {
  return _idbOpen().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readonly');
    const req = tx.objectStore(IDB_STORE).getAll();
    req.onsuccess = e => resolve(e.target.result || []);
    req.onerror = e => reject(e.target.error);
  }));
}

// ── Arm a single reminder in memory ───────────────────────────────────────
function _armTimer(reminder) {
  const { id, title, body, fireAt } = reminder;
  const delay = fireAt - Date.now();
  if (delay <= 0) {
    _idbDelete(id).catch(() => {});
    return;
  }
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
    _idbDelete(id).catch(() => {});
  }, Math.min(delay, 2147483647));
}

// ── Re-arm all persisted reminders on SW startup ───────────────────────────
function _reArmAll() {
  return _idbGetAll().then(records => {
    records.forEach(r => _armTimer(r));
  }).catch(() => {});
}

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
    if (fireAt - Date.now() <= 0) return;
    _idbPut({ id, title, body, fireAt }).then(() => _armTimer({ id, title, body, fireAt })).catch(() => {});
    event.ports[0]?.postMessage({ ok: true, id });
    return;
  }

  if (data.type === 'CANCEL') {
    if (data.id) {
      clearTimeout(_timers[data.id]);
      delete _timers[data.id];
      _idbDelete(data.id).catch(() => {});
    }
    event.ports[0]?.postMessage({ ok: true });
    return;
  }

  if (data.type === 'CANCEL_ALL') {
    Object.keys(_timers).forEach(id => {
      clearTimeout(_timers[id]);
      delete _timers[id];
    });
    _idbClear().catch(() => {});
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
