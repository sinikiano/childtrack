const STATIC = ['/', '/login', '/style.css', '/app.js', '/login.js', '/manifest.webmanifest'];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open('ct-v1').then((c) => c.addAll(STATIC)));
  self.skipWaiting();
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== 'ct-v1').map((k) => caches.delete(k))))
  );
  self.clients.claim();
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.pathname.startsWith('/api/') || url.pathname.startsWith('/s/')) return;
  e.respondWith(
    caches.match(e.request).then((hit) => {
      if (hit) return hit;
      return fetch(e.request).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open('ct-v1').then((c) => c.put(e.request, copy));
        }
        return res;
      });
    })
  );
});
