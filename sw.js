/**
 * Service worker — caches the app shell, handles rest-timer notifications.
 *
 * The app talks to a Google Apps Script backend for all data (bootstrap,
 * addSession). We deliberately don't cache those API responses: weightlifting
 * data is the source of truth on the sheet, not in the browser, so we always
 * go to the network for it. The shell (HTML, manifest, icons) caches normally
 * so launching the installed app feels instant.
 *
 * For rest-timer notifications: the page calls
 * registration.showNotification() when the timer reaches 0. When the user
 * taps an action (Start next / +30s), this SW receives the click, focuses the
 * existing window, and posts a {type:'timer-action', action} message to it so
 * the page can advance the in-memory state.
 */

const VERSION = 'v3';
const CACHE = 'training-logger-' + VERSION;

const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-192.png',
  './icon-maskable-512.png',
  './icon-notif.png',
  './icon-badge.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Never cache Apps Script traffic — always hit network so the log reflects
  // the sheet's current state.
  if (url.hostname.endsWith('script.google.com') ||
      url.hostname.endsWith('googleusercontent.com')) {
    return;
  }

  // For navigations, try network first so new deploys show up immediately,
  // then fall back to cached shell if offline.
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  // Static assets: cache-first, network fallback.
  e.respondWith(
    caches.match(req).then((hit) =>
      hit || fetch(req).then((res) => {
        if (res && res.status === 200 && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      }).catch(() => hit)
    )
  );
});

// Rest-timer notification interactions.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const action = event.action || 'open';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    let client = all.find(c => c.url.includes(self.registration.scope)) || all[0];
    if (client) {
      try { await client.focus(); } catch (e) {}
      try { client.postMessage({ type: 'timer-action', action: action }); } catch (e) {}
    } else {
      // No open window — open one. The page will pick up where it left off
      // (state is in localStorage'd endpoint + transient memory). The action
      // can't be re-applied without state, but this at least brings the user
      // back to the app.
      await self.clients.openWindow('./');
    }
  })());
});
