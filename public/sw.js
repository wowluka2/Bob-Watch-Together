const CACHE = 'bwt-v3-shell-ui-6';
const SHELL = ['/', '/style.css', '/manifest.webmanifest'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)))));
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.pathname.startsWith('/api/') || url.pathname.startsWith('/video/') || url.pathname.startsWith('/quality/') || url.pathname.startsWith('/audio')) return;
  if (request.destination === 'image') {
    event.respondWith((async () => {
      try {
        const response = await fetch(request, { cache: 'reload' });
        if (response.ok || response.type === 'opaque') {
          const copy = response.clone();
          event.waitUntil(caches.open(CACHE).then(cache => cache.put(request, copy)));
        }
        return response;
      } catch {
        return (await caches.match(request)) || Response.error();
      }
    })());
    return;
  }
  if (request.mode === 'navigate' || ['/style.css', '/manifest.webmanifest'].includes(url.pathname)) {
    event.respondWith(fetch(request).then(response => {
      if (response.ok) {
        const copy = response.clone();
        caches.open(CACHE).then(cache => cache.put(request, copy));
      }
      return response;
    }).catch(async () => (await caches.match(request)) || Response.error()));
    return;
  }
  event.respondWith(caches.match(request).then(cached => cached || fetch(request)));
});
