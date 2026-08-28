// Service Worker cho app học Đức & Anh gộp chung 1 trang.
// Chỉ cache file tĩnh cùng gốc — KHÔNG cache dữ liệu Supabase, để từ vựng/ngữ pháp
// luôn hiển thị bản mới nhất khi có mạng.

const CACHE_NAME = "mrthanh-learn-v2";
const APP_SHELL = [
  "./index.html",
  "./manifest.json",
  "./icons/icon-app-192.png",
  "./icons/icon-app-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  if (req.method !== "GET" || url.origin !== self.location.origin) {
    return;
  }

  event.respondWith(
    fetch(req)
      .then((res) => {
        const resClone = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, resClone));
        return res;
      })
      .catch(() => caches.match(req))
  );
});
