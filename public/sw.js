// TaskFlow service worker: shows push notifications and keeps the app opening offline.
const CACHE = 'taskflow-v2.1.0';
const SHELL = [
  '/', '/css/app.css', '/js/i18n.js', '/js/schedule.js', '/js/assistant.js',
  '/js/app/core.js', '/js/app/views.js', '/js/app/sheets.js', '/js/app/main.js',
  '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-192-matcha.png', '/icons/badge-96.png',
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Network first so updates show up right away; fall back to the cache when offline.
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  event.respondWith(
    fetch(event.request)
      .then(res => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(event.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(event.request, { ignoreSearch: true }).then(hit => hit || caches.match('/'))),
  );
});

async function tellClients(message) {
  const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  all.forEach(c => c.postMessage(message));
}

self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data && event.data.text() }; }
  const options = {
    body: data.body || '',
    tag: data.tag,
    renotify: !!data.tag,
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-96.png',
    data: { url: data.url || '/', token: data.token },
    timestamp: Date.now(),
  };
  // Buttons show up on Android and desktop; on iPhone, tapping opens the reminder instead.
  // The server sends their labels in the person's language.
  if (data.token) options.actions = data.actions || [{ action: 'done', title: '✓ Done' }, { action: 'snooze', title: '⏰ In 1 hour' }];
  event.waitUntil(Promise.all([
    self.registration.showNotification(data.title || 'TaskFlow', options),
    tellClients({ type: 'refresh' }),
  ]));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const { url = '/', token } = event.notification.data || {};

  if ((event.action === 'done' || event.action === 'snooze') && token) {
    event.waitUntil(
      fetch('/api/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, action: event.action, minutes: 60 }),
      }).then(() => tellClients({ type: 'refresh' })).catch(() => {}),
    );
    return;
  }

  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of all) {
      if ('focus' in client) {
        await client.focus();
        client.postMessage({ type: 'open', url });
        return;
      }
    }
    await self.clients.openWindow(url);
  })());
});
