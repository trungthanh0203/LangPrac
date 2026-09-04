// Service Worker cho app học Đức & Anh & Trung gộp chung 1 trang.
//
// Chiến lược cache tối ưu tốc độ:
// - Tài nguyên tĩnh ít đổi (icon, logo, manifest): "cache trước, mạng sau" (cache-first)
//   kèm âm thầm cập nhật lại cache ở nền (stale-while-revalidate) — mở app lần sau
//   gần như tức thì, không phải chờ mạng tải lại icon mỗi lần.
// - app.html (trang học thật) / languages.json: "mạng trước, cache sau"
//   (network-first) — luôn ưu tiên bản mới nhất khi có mạng, chỉ dùng bản
//   cache khi mất mạng. index.html (trang giới thiệu/landing) không cần
//   precache riêng — vẫn được phục vụ đúng qua nhánh network-first mặc định
//   ở cuối file (mọi GET cùng gốc không nằm trong 2 danh sách dưới).
// - Dữ liệu Supabase (từ vựng/ngữ pháp/tài khoản): KHÔNG đụng tới, luôn đi thẳng
//   ra mạng để đảm bảo chính xác, mới nhất.

const CACHE_NAME = "ilapra-v4";

const STATIC_ASSETS = [
  "/manifest.json",
  "/icons/icon-app-192.png",
  "/icons/icon-app-512.png",
  "/icons/icon-app-maskable-512.png",
  "/icons/apple-touch-icon-app.png",
  "/icons/logo.png",
];

const SHELL_ASSETS = [
  "/app.html",
  "/languages.json",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll([...STATIC_ASSETS, ...SHELL_ASSETS]))
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

function isStaticAsset(pathname) {
  return STATIC_ASSETS.some((p) => pathname.endsWith(p));
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Chỉ can thiệp GET cùng gốc — request tới Supabase (dữ liệu học, tài khoản)
  // hoặc CDN ngoài luôn đi thẳng ra mạng, không cache.
  if (req.method !== "GET" || url.origin !== self.location.origin) {
    return;
  }

  if (isStaticAsset(url.pathname)) {
    // Cache-first + cập nhật ngầm (stale-while-revalidate)
    event.respondWith(
      caches.open(CACHE_NAME).then((cache) =>
        cache.match(req).then((cached) => {
          const networkFetch = fetch(req)
            .then((res) => {
              cache.put(req, res.clone());
              return res;
            })
            .catch(() => cached);
          return cached || networkFetch;
        })
      )
    );
    return;
  }

  // Network-first cho phần vỏ app (HTML, languages.json)
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
