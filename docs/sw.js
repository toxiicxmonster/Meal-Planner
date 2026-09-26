/* Offline support: the app itself and recipe photos are cached; GitHub and TheMealDB data calls always use the network. */
const VERSION = "meal-planner-v3";
const PHOTOS = "meal-planner-photos";
const SHELL = ["./", "index.html", "style.css", "core.js", "app.js", "manifest.webmanifest",
  "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== PHOTOS).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) {
    // App files: show the cached copy instantly, refresh it in the background.
    e.respondWith(caches.open(VERSION).then(async (cache) => {
      const cached = await cache.match(req, { ignoreSearch: true });
      const fresh = fetch(req).then((resp) => { if (resp.ok) cache.put(req, resp.clone()); return resp; }).catch(() => cached);
      return cached || fresh;
    }));
  } else if (req.destination === "image") {
    // Recipe photos: keep them for offline viewing.
    e.respondWith(caches.open(PHOTOS).then(async (cache) => {
      const cached = await cache.match(req);
      if (cached) return cached;
      const resp = await fetch(req);
      if (resp.ok || resp.type === "opaque") cache.put(req, resp.clone());
      return resp;
    }));
  }
});
