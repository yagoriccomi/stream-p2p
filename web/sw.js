// Service worker: makes the app installable (T07) and announces new versions (T14).
// Network-first so a deploy is picked up right away; the cache is only the offline fallback.
// Bump VERSION on every release: a changed sw.js is what triggers the "Nova versão" banner.
const VERSION = 'sp2p-v11';
const SHELL = ['/', '/styles.css', '/app.js', '/ui.js', '/stream.js', '/voice.js', '/sysaudio.js', '/session.js', '/manifest.webmanifest', '/icon.svg', '/icon-maskable.svg', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== VERSION) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('message', (e) => {
  if (e.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  const key = e.request.mode === 'navigate' ? '/' : url.pathname;
  if (!SHELL.includes(key)) return;
  e.respondWith((async () => {
    try {
      const res = await fetch(e.request);
      if (res.ok) (await caches.open(VERSION)).put(key, res.clone());
      return res;
    } catch {
      return (await caches.match(key)) ?? Response.error();
    }
  })());
});
